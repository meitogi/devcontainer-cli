# VM smoke harness — Node.js daemon + replay fixtures on a bare VM

This doc explains how to exercise the [notify daemon](../index.js) and the
[`notify-app` consumer](../lib/consumers/notify-app.js) on a Windows or Linux
virtual machine that has **no Docker, no VS Code hook stream, no devcontainer**.
It is the verification playbook prefix for every W1→W5 and L1→L5 milestone in
the `notifier-cross-platform` rollout — once you have a working `notif` binary
on the VM, the steps below drive end-to-end banners through the same code
path the devcontainer uses on macOS.

The harness is intentionally minimal : the daemon is host-agnostic already
(see [`lib/host.js`](../lib/host.js)), and the replay runner
([`replay-fixture.js`](./replay-fixture.js)) writes canonical JSONL lines
into the daemon's queue directory just like the Claude Code hook would.
`fs.watch` picks them up ; the notify-app consumer spawns
`notif send …` ; the OS renders the banner. No extra infrastructure needed.

---

## 1. Prerequisites on the VM

- **Node.js 18 or newer** on PATH (`node --version`). The daemon exits at
  boot on Node < 18 with a clear error.
- **`notif` binary** on PATH, or reachable through one of the resolution
  paths in `getNotifPath()` at
  [`notify-app.js:291-317`](../lib/consumers/notify-app.js#L291-L317).
  In priority order the consumer checks : the `NOTIF_BIN` env override,
  `$XDG_DATA_HOME/notif/notif`, `~/.local/bin/notif`, `~/bin/notif`,
  `/usr/local/bin/notif`, `/opt/homebrew/bin/notif`, then every entry on
  `$PATH`, then the daemon's bundled `vendor/notif` fallback.
  - **Windows** — after W1 you'll have `apps\notifier\target\release\notif.exe`.
    Copy or symlink it to `%LOCALAPPDATA%\notif\notif.exe` and add that dir
    to PATH, or set `NOTIF_BIN=<abs-path>` for a one-shot boot.
  - **Linux** — after L1 you'll have `apps/notifier/target/release/notif`.
    `ln -sf "$PWD/apps/notifier/target/release/notif" ~/.local/bin/notif`
    is enough on Ubuntu 24.04 (`~/.local/bin` is on PATH via `~/.profile`).
- **A checkout of the repo** on the VM (Parallels Shared Folders, `git clone`,
  or scp). The daemon expects the workspace layout to be intact — it locates
  its queue via [`lib/locate.js`](../lib/locate.js) starting from the current
  working directory, so run all commands with the repo root as CWD.

**Not required** : Docker, VS Code, the devcontainer, a running Claude Code
session, or any GUI. A plain Terminal is enough.

---

## 2. Boot the daemon standalone

The daemon runs a Docker liveness poll by default (used inside the
devcontainer to exit cleanly when the container stops). On a VM there is
no container to watch, so disable the poll with `NOTIFY_DOCKER_POLL_MS=0` :

**Linux / macOS shell** :
```bash
NOTIFY_DOCKER_POLL_MS=0 node .devcontainer/notify/index.js
```

**Windows PowerShell** :
```powershell
$env:NOTIFY_DOCKER_POLL_MS = "0"
node .devcontainer\notify\index.js
```

Expected log lines (visible on stdout and in `.devcontainer/tmp/notify/daemon.log`) :

```
daemon started — platform=<darwin|win32|linux> host=<macos|windows|linux> pid=<n> project="<name>" queue=<abs>
[docker-watch] disabled via NOTIFY_DOCKER_POLL_MS=0
[notify-app] notif binary resolved at <abs-path>
STATUS notify ok host=<host> notif=<abs-path> sender=claude-code ...
READY pid=<n> channels=notify,...
```

If you see `STATUS notify skipped reason=notif-binary-not-found` instead,
the daemon booted correctly but `notif` isn't discoverable — fix the PATH
or set `NOTIF_BIN` and restart.

**What's off vs. devcontainer mode** :
- No Docker liveness watch — the daemon will not self-terminate ; stop it
  with Ctrl-C or `kill`.
- No VS Code hook stream — the pending-perms bridge in
  [`lib/inbound-watch.js`](../lib/inbound-watch.js) logs a one-line
  fallback and stays in standby. Fixture replay is the only producer.

**What's still on** : the `fs.watch` on
`.devcontainer/tmp/notify/*.jsonl`, which is all the smoke harness needs.

---

## 3. Inject a single canonical fixture (one-shot)

Open a second terminal (leave the daemon running in the first) :

```bash
node .devcontainer/notify/tests/replay-fixture.js permission_request 1
```

[`replay-fixture.js`](./replay-fixture.js) reads
[`fixtures/permission_request/1.jsonl`](./fixtures/permission_request/1.jsonl),
substitutes a fresh `sid` (UUID) and `ts` (now), then writes the result to
`.devcontainer/tmp/notify/<sid>.jsonl`. The running daemon picks it up
within a few `fs.watch` ticks.

Expected on the VM : a system banner reading
> **Claude Code**
> Bash — php vendor/bin/phinx migrate
> Run pending Phinx migrations
> [ Allow ]

The `[ Allow ]` action button only appears for
`permission_request` / `permission_prompt` fixtures that carry a
`tool_use_id`. Other fixtures produce banner-only notifications.

To replay any other fixture :
```bash
node .devcontainer/notify/tests/replay-fixture.js <type> [num]     # → fixtures/<type>/<num>.jsonl
node .devcontainer/notify/tests/replay-fixture.js <path.jsonl>     # any absolute or relative path
```

---

## 4. Replay a full captured session (realistic timing)

`replay-fixture.js` fires one synthetic event and stops — great for a
smoke check on the notify-app dispatch, useless for anything timing-
sensitive. For end-to-end validation of the focus-debounce arm/fire/cancel
lifecycle, inbound cancel signals racing queue events, or long-idle
behavior, use [`replay-session.js`](./replay-session.js) with one of the
three real-capture session fixtures shipped under
[`fixtures/sessions/`](./fixtures/sessions/) :

| Slug                | Queue span | Queue · Inbound · Pending-perms | Use case                                                                    |
|---------------------|------------|---------------------------------|-----------------------------------------------------------------------------|
| `a-permission-rich` | 109 min    | 317 · 170 · 20                  | 32 `permission_request` events — dense action-button flow.                  |
| `b-balanced`        | 125 min    | 236 · 160 · 20                  | 10 `permission_request` over a typical dev session. Default choice.         |
| `c-long-idle`       | 508 min    | 361 · 250 · 30                  | ~8 h with long idle gaps — validates focus-debounce over sparse activity.   |

Queue span is the `first_ts` → `last_ts` gap of the queue stream (read
from each fixture's `meta.json`). The merged timeline (queue + inbound +
pending-perms) usually extends 30-70 % beyond that ; the exact merged
span + projected wall-time is printed by `replay-session.js` at boot.

### Basic invocation

```bash
node .devcontainer/notify/tests/replay-session.js b-balanced
```

Replays the balanced fixture at 10× speed with waits capped at 5 s (both
defaults) — the ~220 min merged timeline finishes in ~4-5 min of wall
time (the script prints the exact projection at boot). The three streams
— queue events, VS Code extension inbound signals, pending-perms focus
snapshots — are merged into a single timeline sorted by `ts`, then each
event is written to the same path the live devcontainer uses :

- Queue events → `.devcontainer/tmp/notify/<fresh-sid>.jsonl` (daemon watches via `fs.watch`).
- Inbound → `.devcontainer/tmp/logs/claude-code-vscode-ext-inbound.jsonl` (appended).
- Pending-perms → `.devcontainer/tmp/logs/claude-code-vscode-ext-pending-perms.jsonl` (appended).

Every occurrence of the captured `sid` / `sessionId` is rewritten to a
fresh UUID per invocation (string-level replacement, so deeply nested
fields like `payload.request.sessionId` are also caught). Every `ts` is
rewritten to current wall clock time.

### Speed and delay controls

```bash
node .devcontainer/notify/tests/replay-session.js b-balanced --speed 1
# real-time — mirrors production pacing exactly (long !).

node .devcontainer/notify/tests/replay-session.js b-balanced --speed 100 --max-delay-ms 200
# burst — good for CI-style regression smoke.

node .devcontainer/notify/tests/replay-session.js c-long-idle --max-delay-ms 2000
# snappier ~8 h — collapses long idles to ≤ 2 s waits.
```

- `--speed N` scales captured inter-event delays (default `10`).
- `--max-delay-ms MS` caps individual waits (default `5000`) so a captured
  long idle doesn't stall the smoke run.
- `--min-delay-ms MS` floors individual waits — useful for visible pacing
  when `--speed` alone would burst too fast to eyeball.

### Interactive step-through

```bash
node .devcontainer/notify/tests/replay-session.js b-balanced -i
```

Waits for a keypress between events (raw-mode stdin, no dep) :

| Key                   | Action                                       |
|-----------------------|----------------------------------------------|
| `n` / Enter / space   | Fire the next event.                         |
| `a`                   | Switch to auto (timed) mode from here on.    |
| `s`                   | Skip this event (do not write it).           |
| `q` / Ctrl+C          | Quit.                                        |

Use this to probe a specific point in a real captured flow — advance to
the `permission_request` you want to inspect, then let auto mode play the
rest.

### Dry-run and isolated outputs

```bash
node .devcontainer/notify/tests/replay-session.js b-balanced --dry-run
```

Prints the full merged timeline without writing anywhere. Cheapest way to
audit the sequence of events a fixture will produce before committing to
a real replay.

For fully isolated smokes (no risk of appending to the real
`.devcontainer/tmp/logs/` files that VS Code may be reading) :

```bash
node .devcontainer/notify/tests/replay-session.js b-balanced \
  --queue-dir /tmp/smoke/queue \
  --inbound-log /tmp/smoke/inbound.jsonl \
  --pending-perms-log /tmp/smoke/pending-perms.jsonl
```

Pair with `--no-inbound` and/or `--no-pending-perms` to skip either
sibling stream entirely (queue-only replay, useful when the daemon under
test doesn't have the inbound-watch bridge wired).

### Known limitation

The 8-char sid prefix embedded in `notif_id` fields (`<event>-<sid[0:8]>-<epoch-ms>`)
is NOT rewritten — the full UUID is caught by string replacement but the
short prefix is too generic to safely regex. Rapid consecutive replays of
the same fixture can produce colliding `notif_id`s (the epoch-ms is
frozen in the fixture). Not a blocker for smoke ; if it bites you, add a
`sleep 1` between replays or file a follow-up to add the `notif_id`
rewrite.

---

## 5. Verify user interaction landed

When you click **Allow** on a permission banner, `notif` appends a JSONL
record to the actions inbox and the notify-app consumer's tail watcher
picks it up. Tail the file in a third terminal :

```bash
tail -f .devcontainer/tmp/logs/notif-actions.jsonl
```

Expected new line after each click, shape :
```json
{"notif_id":"<id>","event":"action:Allow","sender":"claude-code","ts":"<iso-8601>"}
```

For body-click (not action-button), the click is dispatched via
`focus:open-a://Visual Studio Code/<launchUrl>` at
[`notify-app.js:373-379`](../lib/consumers/notify-app.js#L373-L379). On a
bare VM the launchUrl is missing from every fixture, so body-clicks are a
silent no-op by design — that's the "session-1 producer contract" logged
in the daemon output. This is expected and does not indicate a bug.

---

## 6. Fixture matrix — what each single-fixture replay triggers

Rows below cover the one-shot synthetic fixtures loaded by
[`replay-fixture.js`](./replay-fixture.js) (§3) — the multi-event captured
session fixtures loaded by [`replay-session.js`](./replay-session.js) (§4)
are documented in that section's table instead. All single-fixtures share
a one-line JSONL schema ; see any file under
[`fixtures/`](./fixtures/) for the exact shape.

| Fixture directory   | Effect on replay                                                                                                                                    |
|---------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| `permission_request` | Banner with the tool description and an **Allow** action button. Clicking Allow writes to `notif-actions.jsonl`. Best fixture for the click-through smoke. |
| `permission_prompt`  | Banner with the prompt message. No Allow button (fixture omits `tool_use_id`). Body-click focuses VS Code if `launchUrl` is set (bare VM : no-op).       |
| `stop`               | Banner rendering the session's `last_message_excerpt` as body. No action button.                                                                     |
| `notification`       | Generic banner. Fixture 1 exercises the "unmapped `notification_type`" warning path.                                                                 |
| `elicitation_dialog` | Banner surfacing an `AskUserQuestion` prompt. No action button.                                                                                      |
| `idle_prompt`        | Banner surfacing the idle-prompt message. No action button.                                                                                          |
| `tool_started`       | First half of the tool-lifecycle pair. On its own : silent (daemon arms a deferred banner and waits).                                                |
| `tool_finished`      | Cancel signal — the daemon emits `cancelled:notification` on the bus, which dismisses any banner previously dispatched for that sid.                 |
| `tool_cancelled`     | Same cancel semantics as `tool_finished`.                                                                                                            |
| `user_replied`       | Cancel signal (user replied in the Claude Code UI). Same effect as above.                                                                            |

**Sequence-dependent fixtures** : `tool_started` alone will not produce a
visible banner (or produces a delayed one, depending on the fixture's
`focused` flag) ; the daemon expects a matching `tool_finished` /
`tool_cancelled` / `user_replied` line on the same `sid` to clear it.
`replay-fixture.js` rewrites `sid` per invocation, so replaying
`tool_started` then `tool_finished` in two separate commands does **not**
pair them — the second gets a fresh sid. Two ways out : (a) hand-craft a
JSONL file with a shared sid and pass it via
`replay-fixture.js <path.jsonl>`, or (b) use `replay-session.js` (§4)
which preserves matched sids across every event of a captured session,
which is precisely what makes it the right tool for cancel-path smoke.

---

## 7. What fixture replay covers — and what it doesn't

The parity contract for the `notif` binary is **4 callback events**
(click / action / dismiss / timeout) × **4 callback kinds**
(hook / url / file / focus:open) = **16 combinations**.

Both `replay-fixture.js` and `replay-session.js` drive the same daemon,
and the daemon only ever emits **2 of the 16** combos
(see [`notify-app.js:332-416`](../lib/consumers/notify-app.js#L332-L416)) :

| Callback event | Callback kind    | Triggered by                                                         |
|----------------|------------------|----------------------------------------------------------------------|
| `--on-click`   | `focus:open-a://` | every queue line with a valid `launchUrl`                             |
| `--on-action`  | `file:`           | `permission_request` / `permission_prompt` lines with `tool_use_id`   |

The other 14 combinations (all dismiss / timeout events, plus hook / url
callback kinds on click and action) are **not** produced by the daemon and
cannot be reached through either replay tool. They are covered by the
**direct `notif` invocations** in the W1→W5 (Windows) and L1→L5 (Linux)
verification playbooks — see the PowerShell / bash blocks in the approved
rollout plan and mirrored in each session's prompt.

What each replay tool adds on top of that shared surface :
- **`replay-fixture.js`** — one synthetic event, no timing. Fastest way
  to smoke a specific queue-line shape.
- **`replay-session.js`** — a full merged timeline (queue + inbound +
  pending-perms) with realistic pacing. The right tool for anything
  touching focus-debounce, inbound cancel races, or long-idle behavior
  — the flows a single-event fixture can't exercise.

Rule of thumb :
- **Replay tools** = daemon → notif integration path.
- **Direct `notif` commands** = notif → OS callback path.

Both must be green for a milestone to be considered done.

---

## 8. Running the unit tests on the VM

`.devcontainer/notify/package.json` currently has no `scripts` section, so
`npm test` is a no-op. Invoke each test file directly with `node` :

```bash
node .devcontainer/notify/tests/notify-app-focus.test.js
node .devcontainer/notify/tests/notify-app-actions.test.js
node .devcontainer/notify/tests/notify-app-click.test.js
node .devcontainer/notify/tests/get-notif-path.test.js
node .devcontainer/notify/tests/watcher-perm-dedup.test.js
```

Each script exits 0 on success and throws with non-zero on failure. These
tests use in-process stubs and do not spawn `notif`, so they are safe to
run without a binary installed.

---

## 9. Common pitfalls

- **Linux over SSH** — no D-Bus session bus, so `Notify` calls fail
  silently. Fix : run from the desktop Terminal, or prepend `eval $(dbus-launch --sh-syntax)`.
- **Focus Assist (Windows) / Do Not Disturb (macOS) / GNOME "show-banners"** —
  banners are silently swallowed by the OS. Toggle them off in system
  settings before smoke-testing. On GNOME :
  `gsettings get org.gnome.desktop.notifications show-banners`.
- **Missing `notif` binary** — the daemon boots fine and reports
  `STATUS notify skipped reason=notif-binary-not-found` in the status
  line. Fix the discovery paths from §1 or set `NOTIF_BIN=<abs-path>`.
- **Daemon already running** — `.devcontainer/tmp/notify/.daemon.pid`
  is a single-instance lockfile ; a second `node index.js` will exit 0
  with `another daemon already running (pid=N) — exiting`. Kill the
  first instance or wait for its 30 s heartbeat to expire (stale
  lockfiles are auto-reclaimed).
- **`NOTIFY_CHANNELS=all` skips the notify consumer** — `all` expands to
  every channel EXCEPT the opt-in `notify` one (see `ALL_EXCLUDES` at
  [`index.js:122`](../index.js#L122)). To run the notify-app path on the
  VM, either set `NOTIFY_CHANNELS=notify` explicitly, or add it to a
  CSV : `NOTIFY_CHANNELS=basic-notif,notify,sound`.
- **Wayland focus** — the `focus:open-a://` callback needs the
  compositor to honor `xdg-activation-v1` (GNOME 46+, KWin 6+, Sway).
  Older LXDE / XFCE may fall back to the X11 `wmctrl` path — install
  `wmctrl` if it's missing (`sudo apt install wmctrl`).
- **`replay-session.js` appends to the live logs by default** — the
  `--inbound-log` and `--pending-perms-log` defaults point at the
  standard `.devcontainer/tmp/logs/claude-code-vscode-ext-*.jsonl` files.
  If the VS Code extension is actively reading those (devcontainer up,
  session live), a replay can inject events the extension will treat as
  real. On a VM smoke there's nothing to interfere with, so the
  defaults are fine ; on a live devcontainer, override both with
  temp paths (see §4 "Custom output paths").
- **Session fixtures contain real captured content** — the JSONL under
  `fixtures/sessions/*/` is extracted from real Claude Code sessions
  (task descriptions, user messages, tool inputs). Fine for internal
  smoke ; do not mirror the fixture dir into a public repo without
  redacting first.
