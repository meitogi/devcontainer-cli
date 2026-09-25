# notifier — click-back behavior & platform limitations

Companion document to [notifier.js](./notifier.js). What works on each
platform, what doesn't, and why. Specifically focused on what happens
when the user **clicks** the desktop notification.

## Session 8 note — split into two consumers

Since session 8 of the [notif-cli rollout](../../../../plans/notif-cli/ROLLOUT.md),
the desktop-notification path forks in two :

- **`basic-notif`** — this file. `osascript` on macOS, `powershell.exe`
  WinRT toast on Windows, `notify-send` stub on Linux. Registered as
  channel `basic-notif` in [index.js](../../index.js) and included in
  the default `NOTIFY_CHANNELS=all` expansion. Zero external
  dependency.
- **`notify`** — [notify-app.js](./notify-app.js). Standalone `notif`
  binary (see [apps/notifier/](../../../../apps/notifier/)). Registered
  as channel `notify` and **opt-in** — must be named explicitly in
  `NOTIFY_CHANNELS` (e.g. `NOTIFY_CHANNELS=notify,sound,discord`).
  Unlocks sender identity, per-notif dismiss (`notif remove`), and
  callback hooks. macOS-only in v0.2 ; Windows / Linux backends land
  in sessions 9 / 10.

When both channels are listed in `NOTIFY_CHANNELS`, `notify` wins and
`basic-notif` is dropped with a warning to avoid double-banners. See
[index.js](../../index.js) `parseChannels` for the exact logic.

## Payload contract (session 8+)

Every queue line written by [hook.js](../../../skills/notify-queue/hook.js)
carries two extra fields consumed by the `notify` channel :

| Field | Type | Value in v0.2 | Purpose |
|---|---|---|---|
| `sender` | string | always `default` | Passed to `notif send --sender X`. Reserved for future per-event routing (`claude` vs `npm-script` vs …). |
| `notif_id` | string | `<event>-<sid8>-<epoch-ms>` | Passed to `notif send --id Y`, remembered by `notify-app.js` in an in-memory `dispatched` Map, and passed back to `notif remove --id Y` on `cancelled:notification`. |

The `basic-notif` channel ignores both fields — osascript / WinRT have
no equivalent APIs. Adding them is idempotent : an older hook.js that
predates session 8 lets `notify-app.js` fall back to a locally-minted
`notif_id` (`fallback-<sid8>-<epoch-ms>`) with a one-shot warning line.

## Cancel-remove wiring (session 8+)

[watcher.js](../watcher.js) emits `cancelled:notification` on
`user_replied`, `tool_started`, `tool_finished`, and `tool_cancelled`.
Since session 8, every emission carries the `sid` so the `notify`
consumer can look up its `dispatched` Map and issue
`notif remove --sender X --id Y`. Pre-fire cancels (banner never
dispatched → nothing in the Map) are silent no-ops on both channels.

## At a glance

| Platform           | Toast emits | Click → app focus | Click → right window | Click → enter devcontainer |
|--------------------|-------------|-------------------|----------------------|----------------------------|
| macOS              | yes         | no                | no                   | no                         |
| Windows native     | yes         | no                | no                   | no                         |
| WSL → Windows      | yes         | no                | no                   | no                         |
| Linux native       | stub        | —                 | —                    | —                          |

## macOS

Dispatch goes through `osascript -e 'display notification ...'` — see
`sendMac` in [notifier.js](./notifier.js).

`display notification` has **no click handler at all** on modern macOS.
Clicking the banner either dismisses it or opens Notification Center —
it never activates the emitting app, regardless of bundle identity.

Reaching click activation on macOS would require switching the dispatch
to one of:
- `terminal-notifier` (third-party CLI, accepts `-activate <bundle-id>` and
  `-sender <bundle-id>` flags),
- a packaged `.app` bundle exposing an `NSUserNotificationCenterDelegate`,
- the modern UserNotifications framework via a Swift helper binary.

All three add a tool/dependency or a build step — not worth it as long
as click-back isn't a hard requirement.

## Windows (native and WSL via interop)

Dispatch builds a WinRT toast XML and pipes it to `powershell.exe` —
see `sendWindows` in [notifier.js](./notifier.js). The AUMID
`Microsoft.VisualStudioCode` ([constants.js](../constants.js)) gives
the toast VS Code's icon and brand identity, **but AUMID alone does NOT
grant click activation** for classic Win32 installs of VS Code (no COM
activator class is registered by the installer — that's a UWP/Store-app
feature). The toast XML currently carries no `launch` attribute, so
**clicking the toast does nothing** on either native Windows or WSL.

To get click activation, the toast would need:

```xml
<toast activationType="protocol" launch="vscode://…">
  ...
</toast>
```

A POC adding this was prototyped and reverted. Two limitations made it
not worth shipping in its initial form — both documented below for the
next attempt.

### Limitation F1 — Focus stealing prevention

When VS Code is **already running** with the target workspace open, the URI
handler dispatches the focus request via single-instance IPC. The existing
VS Code process then calls `SetForegroundWindow` on its own window. **Windows
blocks the foreground grab** because by the time the IPC roundtrip completes,
the brief foreground privilege inherited from the user's click has expired.

Visible symptom: VS Code's workspace window moves to the top of VS Code's
own z-order (you can see it among other VS Code windows), but the
**previously focused app keeps the actual foreground** (terminal, browser, …).
The taskbar entry for VS Code flashes orange — that's Windows' "I couldn't
focus, here's a hint" fallback.

This affects all single-instance Win32 apps that focus via IPC, not just
VS Code. Documented variants of the issue live under e.g.
[microsoft/vscode#42356](https://github.com/microsoft/vscode/issues/42356).

Cold-launch (VS Code not running) is **not** affected — the freshly
spawned `Code.exe` process inherits foreground rights directly from the
shell click and focuses correctly.

Possible workarounds, **none implemented**:
- Custom URI scheme (`claude-focus://…`) registered to a helper script that
  calls `FindWindow` + `SwitchToThisWindow` (not subject to focus-steal).
- Companion VS Code extension that listens on its own custom URI and
  calls into VS Code's window-focus API internally.
- `AllowSetForegroundWindow(<vscode-pid>)` from the toast-emitting
  PowerShell — but the grant is consumed on the next user input event,
  too early for the eventual click.

All add moving parts. Deferred until the UX cost outweighs the integration
cost.

### Limitation F2 — `vscode://file/...` opens the HOST folder, not the devcontainer

When the workspace is normally opened **inside a devcontainer**, the
current URI `vscode://file/<workspace-path>` opens the folder as a *plain
local* workspace, bypassing the devcontainer. The user has to re-trigger
"Reopen in Container" manually.

The correct URI to land directly inside the devcontainer follows the
format used by VS Code's `code --folder-uri` and reverse-engineered
by [vscli](https://github.com/michidk/vscli) (see
[workspace.rs](https://github.com/michidk/vscli/blob/main/src/workspace.rs)
and [uri.rs](https://github.com/michidk/vscli/blob/main/src/uri.rs)) :

```
vscode-remote://dev-container+<hex>/<container-folder>
```

with:
- `<container-folder>` = path **inside** the container (e.g. `/workspace`),
- `<hex>` = `hex(utf8(JSON.stringify({ hostPath, configFile })))`,
- `hostPath` = absolute **host** path of the workspace
  (e.g. `C:\Users\me\projects\foo`),
- `configFile` = serialized URI object
  `{ scheme: "file", path: "/C:/Users/me/projects/foo/.devcontainer/devcontainer.json", authority?: "..." }`.

Wrapped in the OS-registered `vscode://` scheme for use as a toast
`launch` attribute :

```
vscode://vscode-remote/dev-container+<hex>/<container-folder>
```

That URI is exactly what VS Code stores in its *Open Recent* list for
devcontainer workspaces (the `+` shown URL-encoded as `%2B`).

#### What's missing in the daemon

The daemon runs **inside the container** — it knows `/workspace` (the
container path) but **does not know** `C:\Users\me\projects\foo` (the host
path). Constructing the dev-container URI requires injecting the host
path via the devcontainer's `containerEnv`:

```jsonc
// .devcontainer/devcontainer.json
"containerEnv": {
  "LOCAL_WORKSPACE_FOLDER": "${localWorkspaceFolder}"
}
```

`${localWorkspaceFolder}` is a devcontainer variable resolved by VS Code
at container creation. With it set, the daemon could:

1. Read `process.env.LOCAL_WORKSPACE_FOLDER` at start.
2. Derive `configFile.path` from it (workspace + `/.devcontainer/devcontainer.json`,
   normalised to the `/C:/…` slash form VS Code expects).
3. Build the JSON, hex-encode it, prefix with
   `vscode://vscode-remote/dev-container+`, suffix with the container path
   (typically `/workspace`).
4. Emit that as the toast's `launch` attribute instead of the bare `vscode://file/…`.

Adds complexity (env var injection, URI builder, hex/JSON serialisation,
devcontainer.json change) to fix a UX paper cut, while the toast's text
already tells the user what happened.

## Toast sound (silent by design)

Both macOS and Windows can play a native chime when the toast appears
— controlled by the toast/notification API itself, separate from the
[`sound`](./sound.js) consumer. This codebase keeps the toast silent
on both platforms so the `sound` consumer is the **single source of
audio** per event :

- **macOS** : `display notification` is silent when no `sound name`
  parameter is given. We deliberately omit it in `sendMac`.
- **Windows** : the toast XML carries `<audio silent="true"/>`, which
  overrides the implicit `Notification.Default` chime. Without it,
  Windows users would hear two staggered sounds per event (toast
  default + `sound` consumer).

To re-enable a toast sound, the inline comments in `sendMac` and
`sendWindows` ([notifier.js](./notifier.js)) document the exact
one-line swap, with the list of valid identifiers :

| Platform | Built-in identifiers | Custom |
|---|---|---|
| macOS | Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink (no extension — names under `/System/Library/Sounds/`) | any path `afplay` can read |
| Windows | `ms-winsoundevent:Notification.{Default,IM,Mail,Reminder,SMS}` and the looping `Alarm{1-10}` / `Call{1-10}` variants | `file:///C:/path.wav` — WAV only, <10 s |

If you re-add a toast sound, **also disable the `sound` consumer**
(`NOTIFY_SOUND=off` or drop `sound` from `NOTIFY_CHANNELS`) to avoid
the doubled-chime that motivated this design in the first place.

## Picking this back up

Drop this file into a future Claude session as `@notifier.md` to resume.
This section bundles the artifacts a follow-up implementer needs to
restart without re-investigating from scratch.

### What was tried (POC v1, reverted)

A minimal POC added `activationType="protocol"` + `launch="vscode://…"`
to the toast. It worked end-to-end (the click did reach VS Code) but
ran into F1 and F2 immediately on a devcontainer workspace — so it was
reverted to keep main clean. The exact code, for a future rebase :

**`.devcontainer/notify/index.js`** — pass `projectDir` to each consumer at start :

```diff
-	const result = mod.start({ bus, projectName })
+	const result = mod.start({ bus, projectName, projectDir })
```

**`.devcontainer/notify/lib/consumers/notifier.js`** — accept `projectDir`,
build deep link, embed in toast :

```diff
 let projectName = ''
+let projectDir  = ''

-function start({ bus, projectName: pn = '' }) {
+function start({ bus, projectName: pn = '', projectDir: pd = '' }) {
 	projectName = pn
+	projectDir  = pd

+function buildVscodeLaunchUri() {
+	if (!projectDir) return ''
+	if (process.platform === 'win32') {
+		return `vscode://file/${encodeURI(projectDir.replace(/\\/g, '/'))}`
+	}
+	if (process.platform === 'linux') {
+		const distro = process.env.WSL_DISTRO_NAME
+		if (!distro) return ''
+		return `vscode://vscode-remote/wsl+${encodeURIComponent(distro)}${encodeURI(projectDir)}`
+	}
+	return ''
+}

 function sendWindows({ title, subtitle, body }) {
 	...
+	const launchUri = buildVscodeLaunchUri()
+	const toastAttrs = launchUri
+		? ` activationType="protocol" launch="${xmlEscape(launchUri)}"`
+		: ''
-	const xml = `<toast><visual>...</visual></toast>`
+	const xml = `<toast${toastAttrs}><visual>...</visual></toast>`
```

Smoke-tested by stubbing `child_process.spawn` and inspecting the
captured PowerShell script across four scenarios :

| Scenario | Toast XML emitted |
|---|---|
| native Win + path with space | `<toast activationType="protocol" launch="vscode://file/C:/Users/foo/my%20proj">` |
| WSL with `WSL_DISTRO_NAME=Ubuntu` | `<toast activationType="protocol" launch="vscode://vscode-remote/wsl+Ubuntu/workspace">` |
| WSL without distro | `<toast>` (graceful fallback) |
| `projectDir` empty | `<toast>` (graceful fallback) |

The mechanics were sound — but the UX was net-negative for
devcontainer users because of F2.

### Implementation path for F2 (devcontainer-aware deep link)

Goal : make the toast click open the workspace **inside the devcontainer**,
not the bare host folder. Steps :

1. **Inject the host workspace path into the container.**
   Edit `.devcontainer/devcontainer.json` — add to `containerEnv` :

   ```jsonc
   "containerEnv": {
     ...
     "LOCAL_WORKSPACE_FOLDER": "${localWorkspaceFolder}"
   }
   ```

   `${localWorkspaceFolder}` is resolved by VS Code at container creation
   to the host path (e.g. `C:\Users\me\projects\foo` on Windows host,
   `/Users/me/projects/foo` on macOS host). Requires container rebuild
   to take effect.

   Per project rules (CLAUDE-project.md), editing `devcontainer.json`
   needs the user's explicit request + 2 confirmations — get those
   first.

2. **Detect host platform from inside the container.** The daemon needs
   to know whether the host is Windows / macOS / Linux to format paths
   correctly. Two signals already available :
   - `process.env.WSL_DISTRO_NAME` set → host is Windows via WSL
   - `process.env.OSTYPE` or sniff the shape of `LOCAL_WORKSPACE_FOLDER`
     (`C:\...` → Windows, `/...` → POSIX host)

3. **Build the URI** in `notifier.js` (replace the `buildVscodeLaunchUri`
   from POC v1) with the dev-container format. Sketch :

   ```js
   const HOST = process.env.LOCAL_WORKSPACE_FOLDER || ''
   const CONTAINER_PATH = '/workspace' // or read projectDir

   function buildDevContainerUri() {
     if (!HOST) return ''
     // Build configFile URI object — same shape as VS Code internal URI.
     // On Windows host : leading slash + drive letter, backslashes → /
     const dcPath = `${HOST}\\.devcontainer\\devcontainer.json`
     const dcPathSlash = dcPath.replace(/\\/g, '/')
     const configFile = {
       scheme: 'file',
       path: process.platform === 'win32' || /^[A-Z]:/.test(HOST)
         ? `/${dcPathSlash}` // leading slash for Windows drive paths
         : dcPathSlash
     }
     const json = JSON.stringify({ hostPath: HOST, configFile })
     const hex = Buffer.from(json, 'utf8').toString('hex')
     return `vscode://vscode-remote/dev-container+${hex}${CONTAINER_PATH}`
   }
   ```

   Cross-check by comparing the output against what *Open Recent* shows
   for the same workspace in VS Code — they must match byte-for-byte
   modulo URL-encoding of `+` as `%2B`.

4. **Smoke-test by hex-decoding.** Useful one-liner :

   ```bash
   node -e "console.log(Buffer.from('<hex>', 'hex').toString('utf8'))"
   ```

   The JSON should look like (Windows host example) :

   ```json
   {
     "hostPath": "C:\\Users\\me\\projects\\foo",
     "configFile": {
       "scheme": "file",
       "path": "/C:/Users/me/projects/foo/.devcontainer/devcontainer.json"
     }
   }
   ```

5. **Reference implementation** — [vscli](https://github.com/michidk/vscli)
   does exactly this in Rust. Read these two files to confirm format
   stability and field shapes :
   - [src/workspace.rs](https://github.com/michidk/vscli/blob/main/src/workspace.rs) — lines around 251-262 build the URI
   - [src/uri.rs](https://github.com/michidk/vscli/blob/main/src/uri.rs) — `DevcontainerUriJson` / `FileUriJson` structs

### Implementation path for F1 (focus stealing, if it ever becomes a hard ask)

None of these is recommended for free — pick only when F2 is shipped
and the foreground gap genuinely bites in daily use. From cheapest to
most invasive :

- **Option A — Helper PS script via custom URI scheme.** Register a
  protocol like `claude-focus://` on the Windows host (one-time, via
  installer or manual `.reg`) pointing at a PowerShell script that does
  `FindWindow` + `SwitchToThisWindow`. The latter is not subject to
  focus-stealing prevention. Toast `launch` points at
  `claude-focus://<workspace-id>`. The script can also re-dispatch the
  dev-container URI for the actual workspace switch.

- **Option B — Companion VS Code extension.** Ship a tiny extension
  that registers its own URI handler (`vscode://anthropic.claude-code/focus?…`).
  The extension code runs *inside* VS Code's process so it has direct
  window-focus APIs and bypasses both the IPC roundtrip and Win32
  focus-stealing. Highest UX quality, also the heaviest commitment
  (publishing, versioning, install gate).

- **Option C — `AllowSetForegroundWindow` from the toast emitter.**
  Call the Win32 API from the same PowerShell that fires the toast,
  granting VS Code's PID foreground rights. **Won't work in practice**
  : the grant expires on the next user input event, which fires
  before the user clicks the toast.

### Verification checklist (when F1 / F2 land)

For the daemon-driven path, after restarting notify :

- **F2 cold case** : VS Code completely closed (`taskkill /IM Code.exe /F`).
  Trigger a notif. Click toast → VS Code opens, reconnects to the
  devcontainer, lands on the right folder. Focus is also correct (cold
  launch inherits foreground rights from the shell click).
- **F2 warm case** : VS Code already running on the devcontainer
  workspace. Trigger a notif. Click toast → workspace window rises in
  VS Code's z-order. Focus is *not* expected to work until F1 is also
  addressed.
- **F2 cross-workspace** : VS Code running on a *different* workspace.
  Click toast → new VS Code window opens on the right devcontainer
  workspace. Focus depends on whether the new window is a fresh
  process (good) or attaches to the existing one via IPC (subject to F1).
- **Standalone reproducer** : [tests/winrt-standalone.js](../../tests/winrt-standalone.js)
  is the fastest loop — edit its toast XML to mirror the new builder,
  copy to Windows host, `node winrt-standalone.js`, click.

## Linux native

`sendLinux` is a logging stub today. When a Linux user shows up, the
drop-in is one line :

```js
spawnDetached('notify-send', ['-a', title, subtitle, body])
```

`libnotify-bin` is pre-installed on GNOME / KDE / XFCE. Click activation
on `notify-send` is best-effort and varies by notification daemon — out
of scope for the stub.

## References

- [notifier.js](./notifier.js) — implementation
- [constants.js](../constants.js) — `WINDOWS_AUMID`, `BRAND_NAME`, `TYPE_LABELS`
- [vscli (michidk)](https://github.com/michidk/vscli) — Rust CLI, reference implementation of the dev-container URI format
- [Reverse engineering Microsoft's dev container CLI](https://blog.lohr.dev/launching-dev-containers) — companion article from the vscli author
- [microsoft/vscode#42356](https://github.com/microsoft/vscode/issues/42356) — focus-stealing tracking issue
