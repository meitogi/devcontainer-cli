# notify — desktop notification bridge

Read-only bridge between the Claude Code hooks running inside the
devcontainer and the user's desktop. The container only **emits**
raw JSONL events ; a host-side Node daemon **consumes** the queue,
applies a per-event delay + per-session debounce, and dispatches
through pluggable consumers (OS notification, optional Discord
webhook, optional sound, optional Windows taskbar flash). Notifications
fire on the host without leaving the container's terminal-only world.

## Run

```bash
node .devcontainer/notify/index.js
```

Normally `initialize.sh` launches this automatically at devcontainer open ;
run manually only for debugging. Logs land in `queue/daemon.log`. An optional
queue dir override is accepted as argv[2] (rarely needed — `lib/locate.js`
auto-discovers from cwd).

## Table of contents

- [Run](#run)
- [Add a consumer](#add-a-consumer)
- [Architecture](#architecture)
- [Outbound control channel](#outbound-control-channel) — external auto-answer for permission prompts
- [OS setup](#os-setup)
- [Channels](#channels)
- [Troubleshooting](#troubleshooting)
- [Out of scope](#out-of-scope)

---

## Add a consumer

A consumer is one file under [lib/consumers/](lib/consumers/) that
subscribes to the shared event bus and dispatches notifications to its
channel (Slack, ntfy.sh, signal-cli, internal HTTP, …). All four shipped
consumers ([notifier.js](lib/consumers/notifier.js),
[discord-webhook.js](lib/consumers/discord-webhook.js),
[sound.js](lib/consumers/sound.js),
[flash-win.js](lib/consumers/flash-win.js)) follow the same shape — copy
one and edit.

### Contract

Every consumer module exports a single function :

```js
module.exports = {
	start({ bus, projectName }) {
		// 1. read env / decide eligibility ; bail out with `skipped` or
		//    `fail` BEFORE wiring `bus.on(...)` if the channel can't run.
		// 2. subscribe to 'send:notification'.
		// 3. return { status, diag }.
	}
}
```

The orchestrator ([index.js](index.js)) calls `start()` once at boot.
The return value drives the per-channel readback line written to
`queue/.daemon.startup` (see [Architecture](#architecture)).

```
status ∈ { 'ok', 'skipped', 'fail' }
diag   = { …short kebab-case key/value pairs, e.g. reason: 'no-webhook' }
```

| status | meaning | example diag |
|---|---|---|
| `ok` | wired on the bus, will dispatch | `platform=darwin` · `webhook=…****abcd` · `mode=default resolved=/System/Library/Sounds/Glass.aiff` |
| `skipped` | deliberately disabled — no config, wrong platform, user opted out | `reason=no-webhook` · `reason=non-windows` · `reason=user-disabled` |
| `fail` | tried to run but couldn't | `reason=no-linux-sound-found` · `reason=unsupported-platform` |

Canonical examples (read these before adding a new channel) :

- [notifier.js `start()`](lib/consumers/notifier.js) — `ok` with
  `diag.platform`, plus `diag.aumid` on Windows ; `skipped` on Linux
  (the platform implementation is a stub).
- [discord-webhook.js `start()`](lib/consumers/discord-webhook.js) —
  optional env-var pattern, returns `skipped reason=no-webhook` when
  the URL is unset, otherwise `ok` with a token-redacted webhook.
- [sound.js `start()`](lib/consumers/sound.js) — the most complete
  example with all three terminal states ; `resolveSpec()` runs once
  at boot so the per-event dispatch is a pure spawn.
- [flash-win.js `start()`](lib/consumers/flash-win.js) — platform-gated
  skip outside win32 with `reason=non-windows`.

### `send:notification` payload

The watcher is the SOLE producer of `send:notification`. It emits one
payload per timer fire — channels do their own per-event-type formatting
from `line`. Shape per [watcher.js:36-46](lib/watcher.js#L36-L46) :

```js
{
	id:        string,    // 'evt-<N>' monotonic, daemon-lifetime unique ;
	                      // same id as the earlier 'receive:notification' for this event
	sid:       string,    // Claude session id (debounce + grouping key)
	eventType: 'stop' | 'permission_request' | 'idle_prompt'
	         | 'permission_prompt' | 'elicitation_dialog'
	         | 'daemon_stopped',
	ts:        string,    // ISO 8601 ; from the JSONL line, else stamped now
	line:      object     // the original parsed JSONL event from the queue
}
```

The `line` carries the per-event-type extras documented in the JSONL
schema header in [watcher.js:29-34](lib/watcher.js#L29-L34) :

| eventType | useful `line.*` fields |
|---|---|
| `stop` | `last_message_excerpt` (the recap line from §"Recap convention" below) |
| `permission_request` | `tool_name`, `tool_input`, `tool_use_id?` |
| `permission_prompt` | `message` |
| `elicitation_dialog` | `message` |
| `idle_prompt` | `message` |
| `daemon_stopped` | `last_message_excerpt` (the shutdown reason — see `container:gone` / `uncaughtException` below) |

`line.session_name` is set when the skill has a custom session label
(otherwise consumers fall back to the first 8 chars of `sid`).

The watcher produces every eventType **except** `daemon_stopped`, which is
forged by [index.js](index.js)' `fireDaemonStopped()` helper at shutdown
(container:gone / uncaughtException paths) so the user gets a desktop
notification when the daemon dies unexpectedly. `osascript` is spawned
detached, so the OS notif still appears even though the daemon exits
immediately afterwards.

### `receive:notification` payload

Fired by the watcher **immediately** when a JSONL event passes the
unmapped-eventType filter — **before** the `EVENT_DELAYS_MS` debounce
timer arms. Use this to start your own custom timer with a debounce
policy independent of the default per-eventType delays.

```js
{
	id:         string,    // 'evt-<N>' — same id as the eventual send: or cancelled:
	eventType:  string,    // same flat values as send:notification
	payload:    object,    // identical to send:notification's payload (id, sid, eventType, ts, line)
	receivedAt: number     // Date.now() at the moment the event passed the watcher's gate
}
```

**Difference vs `send:notification`** :

| Aspect | `receive:notification` | `send:notification` |
|---|---|---|
| When | Instantly, on event arrival | After `EVENT_DELAYS_MS[eventType]` (5–30 s) |
| Cancellable | Yes — followed by `cancelled:notification` if a later event supersedes / cancels | No — once fired, the consumer must dispatch |
| Use case | Custom timer / debounce policy, audit log, latency measurement | Standard channels (toast, sound, flash, discord) |
| Suppression | Listener has no veto — runs alongside the standard timer | — |

`receive:notification` is **purely additive** : it does NOT suppress the
standard `EVENT_DELAYS_MS` timer or any standard consumer. Both your
custom logic and the standard `send:notification` path will fire. See
the "Custom timer" worked example below for the parallel-coexist pattern
and a sketch of how to suppress the standard fire via id-tracking.

### `cancelled:notification` payload

Fired by the watcher when a pending `EVENT_DELAYS_MS` timer is cleared
**before firing**. Four trigger paths : `user_replied`, `tool_*`
lifecycle signals on permission timers, latest-wins REPLACE (a newer
event for the same sid superseded the prior one), and the inbound
`cancel:notification` from [inbound-watch.js](lib/inbound-watch.js).

```js
{
	id:        string,    // matches the earlier receive:notification id
	eventType: string,    // same flat values as send:notification
	reason:    string     // see table below
}
```

| `reason` | trigger |
|---|---|
| `user_replied` | the user submitted a new prompt — pending notif is obsolete |
| `tool_started` / `tool_finished` / `tool_cancelled` | tool-lifecycle signal cancelled a permission-related timer |
| `replaced-by-<newEventType>` | a newer event for the same sid superseded this one (latest-wins) |
| `inbound:<reason>` | out-of-band cancel from VS Code (see `cancel:notification` below for the inbound reason vocabulary) |

Custom consumers that started their own timer on `receive:notification`
must subscribe to `cancelled:notification` and abort the matching timer
by id, otherwise the custom action will fire on an obsolete event.

### Custom timer — bypass `EVENT_DELAYS_MS`

The `receive:notification` → (debounce) → `send:notification` OR
`cancelled:notification` triad lets a custom consumer run its own timer
policy independent of `EVENT_DELAYS_MS`. Sketch :

```js
// lib/consumers/fast-discord.js — fire after 5 s instead of the default 30 s
module.exports = {
	start({ bus }) {
		const pending = new Map()  // id → setTimeout handle

		bus.on('receive:notification', ({ id, eventType, payload }) => {
			const t = setTimeout(() => {
				pending.delete(id)
				myCustomDispatch(payload)
			}, 5000)
			pending.set(id, t)
		})

		bus.on('cancelled:notification', ({ id }) => {
			const t = pending.get(id)
			if (t) {
				clearTimeout(t)
				pending.delete(id)
			}
		})

		return { status: 'ok', diag: { delay_ms: 5000 } }
	}
}
```

This consumer runs **in parallel** with the standard `send:notification`
consumers — when the standard 30 s timer also expires, the user gets
both your custom dispatch AND the standard channels firing. That's
usually what you want for an alternative surface (faster Discord ping
alongside the OS toast).

To **replace** rather than augment, track which ids your custom timer
has already fired and short-circuit the matching `send:notification` :

```js
const fired = new Set()

bus.on('receive:notification', ({ id, payload }) => {
	setTimeout(() => {
		fired.add(id)
		myCustomDispatch(payload)
	}, 5000)
})

bus.on('send:notification', ({ id, ...rest }) => {
	if (fired.has(id)) { fired.delete(id); return }   // already fired by custom timer
	standardDispatch({ id, ...rest })
})
```

`receive` / `send` / `cancelled` all carry the same `id`, so correlation
is exact even across multiple concurrent sessions.

### `cancel:notification` payload

External cancel signals (VS Code clicks) emitted by
[inbound-watch.js](lib/inbound-watch.js) when the user takes an action
that makes a pending notif obsolete :

```js
{
	sid:    string,
	kind:   'all' | 'permission',  // 'permission' = only permission_request/_prompt
	reason: string                 // kebab-case tag, see SIGNAL TABLE in inbound-watch.js
}
```

The watcher consumes these on `bus.on('cancel:notification', …)` and
clears the matching pending timer. New consumers do not need to handle
this event — it never reaches them (the watcher swallows it by
suppressing the `send:notification` it would have emitted).

### Channel registry + `NOTIFY_CHANNELS`

[index.js:98-103](index.js#L98-L103) maps a public channel name to its
consumer module :

```js
const CHANNEL_REGISTRY = {
	toast:   notifier,
	sound:   sound,
	discord: discordWebhook,
	flash:   flashWin
}
```

The active set is filtered by the `NOTIFY_CHANNELS` env var
([index.js:108-112](index.js#L108-L112)) :

| `NOTIFY_CHANNELS` | active channels |
|---|---|
| unset or `all` | every key in `CHANNEL_REGISTRY` |
| CSV (e.g. `toast,sound`) | only listed names, trimmed + deduped |
| unknown name in CSV | emits a `STATUS <name> fail reason=unknown-channel` line, other channels keep going |

Registering a new channel :

1. Drop the consumer file in `lib/consumers/<channel>.js`.
2. Require it in [index.js](index.js) next to the other consumers.
3. Add the key to `CHANNEL_REGISTRY`.
4. Optional : add the name to the `NOTIFY_CHANNELS` doc line in
   [.env.example](../.env.example).

Insertion order in `CHANNEL_REGISTRY` is the readback order — keep the
order matching the user-facing priority.

### Worked example — bus consumer

The simplest possible consumer. Subscribes, formats from `line`,
fire-and-forget :

```js
// lib/consumers/ntfy.js
const https = require('https')
const log = require('../log')

module.exports = {
	start({ bus }) {
		const topic = process.env.NOTIFY_NTFY_TOPIC
		if (!topic) return { status: 'skipped', diag: { reason: 'no-topic' } }

		bus.on('send:notification', ({ sid, eventType, line }) => {
			const body = line.last_message_excerpt || line.message || eventType
			const req = https.request({
				host: 'ntfy.sh',
				path: `/${encodeURIComponent(topic)}`,
				method: 'POST'
			}, () => {})
			req.on('error', (e) => log.warn(`[ntfy] ${e.message}`))
			req.end(body)
		})

		return { status: 'ok', diag: { topic } }
	}
}
```

### Worked example — JSONL reader (external to the daemon)

`queue/state/actions.jsonl` is the audit log. A status bar / dashboard
script can `tail -f` it without ever touching the bus :

```bash
tail -F .devcontainer/notify/queue/state/actions.jsonl | jq -c '
	select(.action == "fired") | {sid, eventType, ts}
'
```

### Worked example — webhook fork

To send to a second Discord-style endpoint, duplicate
[discord-webhook.js](lib/consumers/discord-webhook.js), rename the env
var (`NOTIFY_MS_TEAMS_WEBHOOK_URL`), and adjust the render shape. The
redaction helper + truncation policy can be reused as-is.

### Recap convention

Claude is instructed (via [CLAUDE-dev.md §14](../claude/CLAUDE-dev.md))
to append a short recap line at the end of "Stop" turns :

```
**Recap** — deployment ready, all tests green
```

The notify-queue hook ([hook.js](../skills/notify-queue/hook.js))
extracts the text after the dash via `excerptV2()` and stores it as
`last_message_excerpt` in the JSONL event. If absent, the hook falls
back to a markdown-heuristic excerpt of the first usable line
(`excerptV1`).

---

## Architecture

```
   ┌──────── DEVCONTAINER ────────┐   ┌─────────── HOST ────────────┐

    Claude Code   hook.js                index.js  ◀── initialize.sh
    Stop / Notif  appends                 │           (spawns daemon
    PermReq / …   JSONL line              │            detached)
                      ▼                   ▼
                  queue/<sid>.jsonl   bus = new EventEmitter
                      │                   ▲
                      └────fs.watch───────┤
                                          │
                       watcher.handleLine ┼─ 'send:notification'
                       (5-branch decision)│        │
                                          │        ▼
                                          │  ┌─────┬─────┬─────┬─────┐
                                          │  ▼     ▼     ▼     ▼
                                          │ toast sound discord flash
                                          │  ▲     ▲     ▲     ▲
                                          │ osa   afplay https Win32
                                          │ scrpt SoundP POST  Flash
                                          │ WinRT paplay       Window
                                          │ Linux …            Ex
                                          │
        inbound-watch.handleInbound ──'cancel:notification'
        (tails VS Code ext JSONL)         │
                                          │
        skills/notify-queue/hook.js ──container-side cancels
        (user_replied / tool_*)           │
   ──────────────────────────────────────────────────────────────────
```

The bus is a plain `EventEmitter`. Any number of consumers can listen,
in any order, without coordinating with each other. See the contract
docstring at the top of [index.js](index.js).

### Queue directory layout

```
.devcontainer/notify/queue/
├── <sid>.jsonl              ← runtime event queue (one per Claude session)
│                              append-only ; the hook writes, the watcher tails.
├── daemon.log               ← daemon log (rotated at boot if > 1 MB → keep tail 100 KB)
├── .daemon.pid              ← single-instance pidfile + heartbeat (mtime touched every 10 s)
├── .daemon.startup          ← per-channel readback, written atomically once at boot
└── state/
    ├── pending.json         ← live timer snapshot, atomic-rewritten on every ARM/REPLACE/CANCEL/FIRE
    └── actions.jsonl        ← audit log of every outcome (truncated at boot, append-only during run)
```

Both `state/` files are documented at the top of
[lib/state.js](lib/state.js). Format reference :

```jsonc
// state/pending.json
{
	"updated_at": "2026-06-06T15:00:00.000Z",
	"pid": 12345,
	"pending": [
		{
			"sid":       "abc12345-…",
			"eventType": "stop",
			"armed_at":  "2026-06-06T14:59:30.000Z",
			"fire_at":   "2026-06-06T15:00:00.000Z",
			"delay_ms":  30000,
			"payload": {
				"ts":                    "2026-06-06T14:59:30.000Z",
				"sid":                   "abc12345-…",
				"event":                 "stop",
				"session_name":          "Build host notification daemon",
				"last_message_excerpt":  "Tests passing, PR ready"
			}
		}
	]
}
```

```jsonc
// state/actions.jsonl — one JSON object per line
{"ts":"…","action":"armed","sid":"abc…","eventType":"stop","delayMs":30000,"fireAt":"…","payload":{"ts":"…","sid":"abc…","event":"stop","session_name":"…","last_message_excerpt":"…"}}
{"ts":"…","action":"replaced","sid":"abc…","prevEventType":"stop","newEventType":"stop","delayMs":30000,"fireAt":"…","payload":{"ts":"…","sid":"abc…","event":"stop","session_name":"…","last_message_excerpt":"…"}}
{"ts":"…","action":"cancelled","sid":"abc…","eventType":"stop","cause":"user_replied"}
{"ts":"…","action":"fired","sid":"abc…","eventType":"stop"}
{"ts":"…","action":"unmapped","sid":"abc…","eventType":"unknown_event"}
```

The `action` enum maps directly to the 5 branches in
[watcher.handleLine](lib/watcher.js) below.

The `payload` field on `armed` / `replaced` entries (both
`pending.json` and `actions.jsonl`) is the raw parsed JSONL `line`
from [notify-queue/hook.js `buildLine`](../skills/notify-queue/hook.js) —
verbatim, no truncation. Per-event it carries `last_message_excerpt`
(stop), `tool_name`/`tool_input`/`tool_use_id?` (permission_request),
or `notification_type`/`message` (notification), plus the optional
`session_name`. This lets external consumers (status bars,
dashboards, alternative renderers) render or route from `pending.json`
alone, without re-reading the source queue file. `cancelled` /
`fired` / `unmapped` lines omit `payload` — the matching `armed` is
searchable in `actions.jsonl` by `sid + ts`.

### `watcher.handleLine` — 5-branch decision

[lib/watcher.js](lib/watcher.js) tails each `<sid>.jsonl` and decides
what to do per line. Five mutually-exclusive branches :

| Branch | Trigger | Effect |
|---|---|---|
| **CANCEL** (user_replied) | line `event === 'user_replied'` | clear ANY pending timer for the sid ; the notif is suppressed entirely |
| **CANCEL** (tool lifecycle) | line `event ∈ { tool_started, tool_finished, tool_cancelled }` | clear ONLY `permission_request` / `permission_prompt` pending for the sid ; other types stay armed |
| **UNMAPPED** | `delays[eventType]` is not a number | log + audit, no timer change |
| **REPLACE** | a pending timer already exists for the sid | clear it, arm a fresh one based on the new event ("latest wins") |
| **ARM** | no pending timer for the sid | `setTimeout(delays[eventType])` ; on fire → emit `send:notification` |

The watcher keeps at most ONE timer per sid. Post-fire remove is NOT
supported — once the notif is on screen, a later `user_replied` cannot
retract it (the OS doesn't expose a reliable remove-by-id API without
extra dependencies). Acceptable tradeoff because the 30 s default delay
already absorbs the common "user comes back within seconds" path. See
the header comment in [lib/watcher.js](lib/watcher.js) for the WHY.

### Cancel paths

Two independent cancel sources, both feeding the bus. Additive — when
one is missing, the other keeps the daemon ~90 % effective :

| Source | Latency | Triggers |
|---|---|---|
| Container-side hooks ([skills/notify-queue/hook.js](../skills/notify-queue/hook.js)) | ~50 ms after the hook fires | `user_replied`, `tool_started`, `tool_finished`, `tool_cancelled` events appended to the JSONL → caught by `watcher.handleLine`'s CANCEL branches |
| Host-side inbound watch ([lib/inbound-watch.js](lib/inbound-watch.js)) | ~50 ms after the user click | tails the VS Code extension inbound JSONL ; emits `cancel:notification` on the bus |

The inbound-watch SIGNAL TABLE (from the file header) :

| Inbound event | Cancel signal |
|---|---|
| `tool_permission_response` (allow / deny) | `cancel-permission` for `sessionId` |
| `interrupt_claude` | `cancel-all` for `sessionId` |
| `io_message` + `payload.message.type === 'user'` | `cancel-all` for `sessionId` (redundant safety net for `user_replied`) |
| `launch_claude` + `payload.resume` | `cancel-all` for `payload.resume` (user came back to that session) |

The inbound JSONL is written by the user-action-observer patch under
[.devcontainer/claude/vscode-ext-patchs/](../claude/vscode-ext-patchs/).
If the file is absent at startup, `inbound-watch` logs a clear fallback
message and stays in standby ; the container-side hooks alone keep the
daemon working.

### Sibling logs — outbound control channel

The extension patches co-write three other JSONL files under
[../logs/](../logs/), not consumed by notify but useful to know about
when debugging permission flow :

| File | Producer | Consumer | Purpose |
|---|---|---|---|
| `claude-code-vscode-ext-inbound.jsonl` | `user-action-observer.py` patch (webview→ext chokepoint) | `notify` inbound-watch, `outbound-tester` | Every webview→ext message with `{ts, source:"user-action", sessionId, channelId, pid, type, payload}`. Records user clicks (allow/deny), typed messages, session state transitions. |
| `claude-code-vscode-ext-pending-perms.jsonl` | `outbound-action-injector.py` patch (Comms.sendRequest instrumentation) | `outbound-tester list`, external controllers | Perm requests tracker : `{ts, sessionId, channelId, requestId, toolName, inputs, focused, active, settled:false}` on request ; `{ts, sessionId, channelId, requestId, focused, active, settled:true, outcome}` on resolve. `focused` / `active` are `vscode.window.state` snapshots at record time — proxied from the client GUI so they reflect actual host-side window focus (external controller can use them to decide whether to auto-answer or wait for a human). Also `{ts, ev:"session_boot"}` at each extension host init — the tester uses that as cutoff for stale entries from crashed/reloaded sessions. |
| `claude-code-vscode-ext-outbound.jsonl` | External controller (usually [../claude/outbound-tester.js](../claude/outbound-tester.js)) | Extension host file-watcher (200 ms poll) | Command line per JSONL entry, e.g. `{cmd:"tool_permission_response", sessionId, requestId, behavior:"allow", updatedInput, updatedPermissions}`. Watcher looks up the target panel via `sessionPanels.get(sessionId)` and postMessages a `simulated_click` to the webview, which resolves the pending Gn via `Q.accept()`/`Q.reject()` (see [../claude/vscode-ext-patchs/webview-simulated-click.py](../claude/vscode-ext-patchs/webview-simulated-click.py) for the webview side). |
| `claude-code-vscode-ext-watcher-debug.jsonl` | Same watcher, gated by `DEBUG=1` (or `CLAUDE_OUTBOUND_DEBUG`) | Manual `tail -f` during troubleshooting | Granular flow tracing : `watcher_started`, `change`, `parsed`, `lookup_hit`, `lookup_miss` (with `knownSids`), `post`, `parse_fail`, etc. No-op when the env flag is off. |

The extension is patched by `run-all.sh` at container build. Detailed
workflow + failure modes for these patches live in
[../../vendor/anthropic.claude-code/CLAUDE.md](../../vendor/anthropic.claude-code/CLAUDE.md).

**Managing the logs.** All four files are append-only, no rotation :

- **Boot wipe** — `post-start.sh` truncates the four `.jsonl` at each
  container start. Fresh sessions start empty.
- **Reset mid-session** — `> .devcontainer/logs/<file>.jsonl` from
  terminal. Safe : the extension holds no fd on the debug/outbound
  files (opens per-write) ; inbound + pending-perms handle truncation
  gracefully (the watcher resets `pos` when `sz < pos`).
- **`session_boot` cutoff** — `pending-perms.jsonl` gets a
  `{ev:"session_boot", ts}` line at each extension host init.
  `outbound-tester list` filters records before the latest boot ; you
  don't have to wipe manually just because you reloaded. Fallback : if
  no boot marker present, records older than 30 min are treated as
  fossilized.
- **`watcher-debug.jsonl` opt-in** — writer is a no-op unless
  `DEBUG=1` (or `CLAUDE_OUTBOUND_DEBUG`) is set in the extension
  host's env. Set it in [../devcontainer.json](../devcontainer.json)'s
  `remoteEnv` or [../.env](../.env) if the file exists.
- **Growth watch** — `inbound.jsonl` is the noisy one (~1 line per
  webview interaction). Typical session : a few MB. If it starts
  eating disk, wipe it — nothing downstream depends on old history.

### Lifecycle + healthcheck

[lib/lockfile.js](lib/lockfile.js) owns `queue/.daemon.pid`. One file,
two signals :

- **Content** = `<pid>\n`, written once at startup.
- **mtime**   = bumped every 10 s by [lib/lockfile.startHeartbeat](lib/lockfile.js).
  If the event loop is blocked, mtime stops advancing.

Stale threshold : 30 s (3 × heartbeat). The default `acquire()` policy
is **always-replace** : if a prior daemon is alive, the new one sends
SIGTERM, spin-waits 2 s for graceful exit, falls back to SIGKILL, then
claims the slot ([lib/lockfile.js:66-100](lib/lockfile.js#L66-L100)).

**Active probe (Unix)** : `kill -USR2 $(cat .daemon.pid)` — the handler
in [index.js:184-190](index.js#L184-L190) immediately bumps the pidfile
mtime. The caller waits a tick and confirms mtime moved :

```bash
PID=$(cat .devcontainer/notify/queue/.daemon.pid)
BEFORE=$(stat -c %Y .devcontainer/notify/queue/.daemon.pid 2>/dev/null \
		 || stat -f %m .devcontainer/notify/queue/.daemon.pid)  # macOS BSD stat
kill -USR2 "$PID" && sleep 0.2
AFTER=$(stat -c %Y .devcontainer/notify/queue/.daemon.pid 2>/dev/null \
		|| stat -f %m .devcontainer/notify/queue/.daemon.pid)
[ "$AFTER" -gt "$BEFORE" ] && echo "daemon is reactive" || echo "daemon NOT responding"
```

On Windows native there is no SIGUSR2 — rely on passive freshness
(mtime within 30 s = alive).

The daemon also exits cleanly when `docker ps` reports the container is
gone — 60 s poll in [lib/docker-watch.js](lib/docker-watch.js), three
trigger conditions documented in its header (CLI exits non-zero, CLI
fails to spawn, filter returns empty stdout). On exit the daemon emits
a `daemon_stopped` notification through the bus, so the user gets a
desktop toast carrying the precise reason (`docker CLI failed: …`,
`no matching container`, etc.) instead of a silent disappearance.

**Sleep / wake resilience.** [lib/sleep-watch.js](lib/sleep-watch.js)
watches the wall clock for drift — when the host wakes from sleep, the
next `setInterval` tick shows a jump well above the nominal period, and
the module emits `'system:wake'` on the bus. `docker-watch` listens and
opens a 30 s grace window during which non-running probe results are
swallowed instead of triggering `container:gone`. This covers the case
where Docker Desktop is still resuming after a Mac sleep / wake cycle
and the daemon would otherwise exit on the first post-wake poll.

### Queue directory resolution

[lib/locate.js](lib/locate.js) resolves the queue dir from the launch
context. Three rules ([lib/locate.js:30-48](lib/locate.js#L30-L48)) :

1. Explicit argv : `node index.js <queueDir>` → returned as-is.
2. cwd basename = `.devcontainer` → `cwd/notify/queue`.
3. cwd contains `.devcontainer/` → `cwd/.devcontainer/notify/queue`.

Anything else throws with an actionable message — no silent guessing.

---

## Outbound control channel

Reciprocal to the inbound observation stream : a way for an **external
controller** (host script, agent, MCP tool) to inject responses into
Claude Code permission prompts as if the user had clicked — bypassing
the modal UI when auto-answering is safe. Runs entirely inside the same
`.devcontainer/logs/` directory as the notify inbound / desktop-toast
pipeline ; not consumed by the notify daemon itself, but sits in the
same infrastructure and shares the extension-patch machinery.

The channel handles `tool_permission_response` today. Extending it to
other webview widgets (AskUserQuestion single-select / multi-select,
ExitPlanMode, etc.) follows the same pattern — see
[Adding a new outbound cmd](#adding-a-new-outbound-cmd) below.

### Data flow

```
                        writes                       polls, 200 ms
  external controller ────────► outbound.jsonl ──────────────► extension host
    (outbound-tester.js                                        (setupPanel
     or any tool)                                               file-watcher)
                                                                     │
                                                                     │ this.sessionPanels.get(sessionId)
                                                                     ▼
                                                                  target panel
                                                                     │
                                                                     │ panel.webview.postMessage(
                                                                     │   {type:"from-extension",
                                                                     │    message:{type:"simulated_click",
                                                                     │             requestId, result}})
                                                                     ▼
                                                                webview intercept
                                                                     │
                                                                     │ this.permissionRequests.value
                                                                     │   .find(q => q._reqId === requestId)
                                                                     │ Q.accept(input, perms)  or  Q.reject(msg, false)
                                                                     ▼
                                                              Q.onResolved fires
                                                                     │
                                                                     │ send({type:"tool_permission_response", result})
                                                                     │ + drop Q from permissionRequests signal
                                                                     ▼
                                                          extension receives response
                                                          via the standard chokepoint
                                                          → inbound.jsonl gets a
                                                            `source:"user-action"`
                                                            line indistinguishable
                                                            from a real click
```

The extension-side promise for the perm request resolves, the tool runs,
the UI prompt dismisses atomically. Zero orphan states.

### Cmd protocol

Every outbound line is a single JSON object with a `cmd` discriminator.
Extra fields per cmd type.

**`tool_permission_response`** — currently the only cmd type.

```json
{
  "cmd": "tool_permission_response",
  "sessionId": "effef380-59b1-4018-af95-8d8beb88e7f2",
  "requestId": "826f7870b1c2542f308c08f21d35ff8e",
  "behavior": "allow",
  "updatedInput":  { … },
  "updatedPermissions": []
}
```

- `sessionId` — the **SDK session UUID** (stable, matches
  `PanelManager.sessionPanels` key). Do NOT put the channelId here —
  the extension watcher's `sessionPanels.get(sessionId)` would miss.
- `requestId` — the wire perm request id (32 hex chars). Matched inside
  the webview against `Gn._reqId` (stashed by the injection patches on
  each new Gn). `channelId` on Gn is a different id space and cannot
  be used for lookup.
- `behavior` — `"allow"` | `"deny"`.
- `updatedInput` — for `allow`, the actual input the tool will run with
  (echo the pending record's `inputs` unless you're rewriting).
- `updatedPermissions` — for `allow`, typically `[]` (grants that would
  update the workspace allowlist ; leave empty for one-off answers).
- For `deny`, add `"message": "…"` and optionally `"interrupt": true`
  (rejects with an abort signal). Default message is `"denied"`.

Unknown `cmd` values are logged as `unknown_cmd` and dropped ; adding a
new cmd type is a code change (see below).

### Extension-side implementation

Three injection functions in
[../claude/vscode-ext-patchs/outbound-action-injector.py](../claude/vscode-ext-patchs/outbound-action-injector.py) :

- **`patch_watcher`** — anchors at the top of `PanelManager.setupPanel(z,K,V,N){`.
  Singleton-guarded by `this._outboundStarted` (one interval per PanelManager
  instance, per window session). 200 ms poll on `outbound.jsonl` starting
  at `pos = 0` (reads any lines the writer put down before the watcher
  came up ; on truncate resets to 0). Each parsed cmd walks
  `this.sessionPanels.get(cmd.sessionId)` to find the target
  panel, then `panel.webview.postMessage({type:"from-extension",
  message:{type:"simulated_click", requestId, result}})`.
- **`patch_sendrequest`** — anchors inside `Comms.sendRequest(z,K,V)`.
  Two spots : right after `let N=fn()` (writes the pending record) and
  inside the `outstandingRequests.set(N,{resolve:(Z)=>{x(Z)})` callback
  (writes the settle record). Records include `focused` + `active`
  from `vscode.window.state` — proxied from the client GUI, so consumers
  see actual host-side window focus.
- **`patch_track_session_id`** — anchors at
  `else if(z.request.type==="update_session_state")return this.onSessionStateChanged?.(…)`
  in `Comms.fromClient`. Stores `this._currentSessionId = <msg>.request.sessionId || this._currentSessionId`
  via comma-operator (no control flow change). Ensures the SDK UUID is
  available to the pending / settle log injections — the sendRequest's
  first arg is the chat channelId, NOT the sessionId, so we can't get
  the UUID from there.

Debug tracing via `DEBUG=1` or `CLAUDE_OUTBOUND_DEBUG` env var — writes
per-event lines to `watcher-debug.jsonl` (see [Sibling logs](#cancel-paths)
above). No-op when unset ; safe to leave the flag on for extended debug
sessions.

### Webview-side implementation

Three injection functions in
[../claude/vscode-ext-patchs/webview-simulated-click.py](../claude/vscode-ext-patchs/webview-simulated-click.py).
The core mechanic : tag each Gn permission-request instance with its
wire requestId at creation time, then have the message intercept look up
by that requestId.

- **`patch_perm_request_id_callsite`** — inside
  `processRequestInner`, the `case "tool_permission_request"` arm calls
  `handleToolPermissionRequest($.channelId, $.request, Z)`. We inject a
  4th arg `$.requestId`.
- **`patch_perm_request_id_tag`** — inside `handleToolPermissionRequest`,
  right after `let Q=new Gn($,eV(Z.toolName),…)`, we splice
  `Q._reqId=arguments[3];`. Uses `arguments[3]` rather than a formal
  param so nothing else calling this method with 3 args breaks.
- **`patch_message_intercept`** — inside the top-level
  `window.addEventListener("message",(G)=>{…})` in class `Xz1 extends zn`.
  Handles `_m?.type==="simulated_click"` : walks
  `this.permissionRequests.value.find(q => q?._reqId === _rid)`, calls
  `Q.accept(updatedInput, updatedPermissions)` or `Q.reject(message, false)`.
  `console.log` traces are always on (webview devtools only, opt-in
  via `Cmd+Shift+P → Developer: Open Webview Developer Tools`).

Why not match by `Q.channelId` : Gn's `channelId` is the chat channel
id (per-panel), NOT the wire request id. Multiple simultaneous prompts
would collide.

### CLI

[../claude/outbound-tester.js](../claude/outbound-tester.js) — pure
Node, zero deps. Subcommands :

- **`list [--json]`** — reads pending-perms.jsonl, filters records
  before the latest `session_boot` marker (or older than 30 min if no
  marker), groups by requestId (last-write-wins), returns those still
  `settled:false`. Tabular : `sid8 | chan | rid8 | foc | tool | inputs | age`.
  `foc` = `F` (focused), `A` (active but not focused), `-` (neither),
  `?` (pre-focus-patch record).
- **`send <token> allow|deny [--input '<json>'] [--message '<text>'] [--sid <sid>]`** —
  writes a `tool_permission_response` line to outbound.jsonl. `token`
  can be a full 32-hex requestId (bypasses lookup) or any prefix of
  requestId / sessionId / channelId. Unique-match required — ambiguity
  fails loud with the candidate list. `--input` overrides `updatedInput`
  (JSON), `--message` overrides the deny message.

Examples :

```
node .devcontainer/claude/outbound-tester.js list
node .devcontainer/claude/outbound-tester.js send effef380 allow
node .devcontainer/claude/outbound-tester.js send 826f allow --input '{"command":"ls"}'
node .devcontainer/claude/outbound-tester.js send effef380 deny --message "not now"
```

### Adding a new outbound cmd

Say you want to auto-answer `AskUserQuestion` prompts (single-select
radio, multi-select checkbox). Full checklist :

1. **Recon.** Grep
   `vendor/anthropic.claude-code/v<VER>/pretty/webview-index.js` +
   `.../extension.js` for the class that owns the pending prompt.
   Identify :
   - The instance class (analog of `Gn`).
   - The wire request id (which arg gets passed to the constructor).
   - The terminal method (`.accept()` / `.reject()` analog).
   - The array signal holding pending instances (analog of
     `this.permissionRequests`).
2. **Extension-side.** No new injection needed — the existing watcher
   dispatches on `cmd.cmd` and forwards `simulated_click` messages with
   any `cmd.data`. Just extend the JSON shape :
   ```
   {cmd: "ask_user_response", sessionId, requestId, answer: {…}}
   ```
   Encode single-select as `{pick: "label"}`, multi-select as
   `{pick: ["a","b"]}`, text as `{text: "…"}`. Keep it simple ; the
   webview intercept validates.
3. **Webview-side, three patches (mirror of perm-request) :**
   a. **Tag** — after the pending instance is created, splice
   `instance._reqId = arguments[<N>];`.
   b. **Callsite** — pass `$.requestId` as the extra arg into the
   handler that creates the instance.
   c. **Intercept branch** — inside the existing
   `if(_m?.type==="simulated_click")` block, add another
   `else if(_m?.type==="ask_user_response")` branch that walks the
   right array signal by `_reqId` and calls the terminal method.
4. **Marker discipline.** Bump to a new
   `notify-queue-webview-<name>-v1` marker for each patch. Never
   overload existing markers (idempotence check would misfire).
5. **CLI.** Add a subcommand or flag to
   [../claude/outbound-tester.js](../claude/outbound-tester.js) :
   ```
   node outbound-tester.js answer <token> --pick "option-label"
   ```
   Reuse `resolvePending()` for the token → record match ;
   compose the new cmd JSON ; append.
6. **Test.** Reload window, trigger the new prompt type, use the CLI,
   watch `watcher-debug.jsonl` (`DEBUG=1`) for `parsed` / `lookup_hit`
   / `post` events, watch webview devtools for
   `[webview-…] received / matched / fired` traces.
7. **Docs.** Update the Cmd protocol section above with the new shape.
   Update the Extension / Webview implementation subsections with the
   new injection anchors. Update this checklist if you find a new
   pattern worth codifying.

### Adding a new consumer

Not related to the outbound channel — the outbound channel is
**push-only** (outside → extension). If you want to react in-container
to inbound events (user clicks, session state changes), write a notify
consumer that subscribes to the shared bus (see
[Add a consumer](#add-a-consumer)) and reads
`.devcontainer/logs/claude-code-vscode-ext-inbound.jsonl` via
[lib/inbound-watch.js](lib/inbound-watch.js).

### Troubleshooting

Symptom → probe → likely cause. Runs on the state visible via
`.devcontainer/logs/` alone ; no live extension inspection needed.

| Symptom | Probe | Likely cause |
|---|---|---|
| `outbound-tester send` succeeds but click doesn't fire | Enable `DEBUG=1`, reload window, retry, `tail watcher-debug.jsonl`. Look for `lookup_miss` with `knownSids`. | If miss : `sessionId` in outbound.jsonl doesn't match a `sessionPanels` key. Usually means the tester read a stale `pending-perms.jsonl` (pre-boot marker) or the `_currentSessionId` tracker missed an `update_session_state`. Trigger a new perm request, retry with the fresh rid. |
| Debug shows `lookup_hit` + `post posted:true` but click still absent | Open webview devtools on target panel. Look for `[webview-sim-click] received` / `no pending Gn for requestId=…` | If `received` but `no pending Gn` : webview intercept ran but the Gn tag injection is missing (marker not present in installed `webview/index.js`). Re-run `run-all.sh`. If neither log appears : intercept regex didn't match after a version bump ; check the `patch_message_intercept` anchor in [../claude/vscode-ext-patchs/webview-simulated-click.py](../claude/vscode-ext-patchs/webview-simulated-click.py). |
| `list` shows stale entries with `age > 30m` | `grep session_boot pending-perms.jsonl` | If no marker : the extension host didn't restart since the last patch bump, OR the `pending-perms.jsonl` was manually appended to and the marker was stripped. Reload window, the watcher writes a fresh marker on init. |
| Records missing `focused` / `active` | Check the file's marker : `grep notify-queue-outbound-perm-log pending-perms.jsonl`'s producer (`.js`, not `.jsonl`) | If the record is pre-focus-patch (before this section landed), it just doesn't have those fields — `list` shows `?`. New records after reload get them. |
| `node --check` fails on the installed `extension.js` after a patch bump | Check for LF-inside-string : `python3 -c "import re; c=open('/home/node/.vscode-server/…/extension.js').read(); print(len(list(re.finditer(r'\n\"', c))))"` | Almost always the `\n` → LF corruption trap documented in [../../vendor/anthropic.claude-code/CLAUDE.md](../../vendor/anthropic.claude-code/CLAUDE.md) piège #1. Re-deploy from `v<VER>-pristine` and re-run patches. |

---

## OS setup

### macOS — enable osascript notifications (one-time)

macOS gates notifications per-app based on the bundle that posts them.
`osascript` posts under **"Script Editor"** (in English) / **"Éditeur de
script"** (in French) — and by default that app has **no notification
permission**, so all `display notification` calls fire silently. Symptom :
nothing shows on screen, no error in the daemon log, `osascript` exits 0.

You only need to do this **once per Mac user account**. Steps :

1. Open the **Script Editor** app (Spotlight → "Script Editor", or
   `open -a "Script Editor"` from a terminal).
2. Paste this one-liner into a new document :

   ```applescript
   display notification "first-run permission test" with title "Claude Code"
   ```

3. Hit ⌘R (or the Play button) to run it.
4. macOS pops up a prompt : **"Script Editor would like to deliver
   notifications…"** → click **Allow**.
5. Verify in **System Settings → Notifications → Script Editor** :
   "Allow notifications" is now ON. Style "Alerts" or "Banners" both
   work — "None" silently swallows everything.

After this, any `osascript display notification` from anywhere
(including the daemon) will surface. Quick re-test :

```bash
osascript -e 'display notification "ping" with title "Claude Code"'
```

If that doesn't show up, re-check the System Settings permission. "Do
Not Disturb" / Focus modes also suppress everything — toggle off to
confirm.

### Windows — AUMID

Toasts are posted under an Application User Model ID. The default is
`Microsoft.VisualStudioCode` ([lib/constants.js:64](lib/constants.js#L64)),
which gives the toast VS Code's icon + activation context.

If you run **VS Code Insiders** or a Squirrel install, override
`WINDOWS_AUMID` in [lib/constants.js](lib/constants.js) to
`Microsoft.VisualStudioCodeInsiders` or the Squirrel GUID. Discover
your AUMID with [tests/find-aumid.js](tests/find-aumid.js).

### Windows via WSL — interop routing

If `initialize.sh` runs under WSL (VS Code launched from a WSL2
distro), the spawned Node binary is the **Linux** Node, not the
Windows one — `process.platform === 'linux'`. The daemon would
otherwise fall into the linux-not-implemented stub.

[lib/host.js](lib/host.js) detects WSL via three layered signals
(`WSL_INTEROP` env, `WSL_DISTRO_NAME` env, `/proc/version` substring
match) and reports `getHostKind() === 'windows'`. All three consumers
(notifier, sound, flash-win) then take the Windows branch — spawning
`powershell.exe` directly, which WSL routes to the Windows-side
PowerShell through interop.

The notifier additionally probes `powershell.exe -NoProfile -Command
exit 0` at boot. If interop is disabled (WSL1 without it, or a
broken setup), the notifier reports `skipped reason=wsl-no-powershell`
instead of crashing per-notif.

Verify on your WSL machine with :

```bash
node .devcontainer/notify/tests/host-detect.js
```

Expected on WSL2 :

```
kind         = windows
wslInterop   = true
wslDistro    = Ubuntu      # (or your distro)
powershell.exe probe ... ok
```

**WAV path gotcha.** If you set `NOTIFY_SOUND=/path/to/bell.wav` on
WSL, the path is passed to `Media.SoundPlayer` *as-is*. Paths under
`/mnt/c/...` work transparently. Paths under the WSL VHDX root
(`/home/...`) won't play — translate with `wslpath -w` before
exporting the env var, e.g. `NOTIFY_SOUND=$(wslpath -w ~/bell.wav)`.

### Linux — current state

The OS-native notification path is a stub
([lib/consumers/notifier.js](lib/consumers/notifier.js) `sendLinux`).
The notifier consumer returns `skipped reason=linux-not-implemented`.
A drop-in `notify-send -a <title> <subtitle> <body>` (from
`libnotify-bin`) is the obvious replacement — left for the first Linux
user who needs it.

Sound on Linux also depends on the distro — see the [sound channel](#sound-channel)
section.

### Node 18+ on the host

The daemon uses optional chaining (`?.`), nullish coalescing (`??`)
and modern `fs` APIs. `initialize.sh` checks `node --version` and
prints a clear hint if too old ; the daemon itself does a second
ES5-safe check at boot ([index.js:62-72](index.js#L62-L72)) so manual
runs (`node index.js`) fail fast on Node < 18.

### `.devcontainer/.env` — opt-in env vars

Per [.env.example](../.env.example) :

```
NOTIFY_CHANNELS=all                   # or CSV : toast,sound,flash,discord
NOTIFY_SOUND=default                  # default | /abs/path.wav | off
NOTIFY_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<channel_id>/<token>
NOTIFY_CLEANUP_MAX_AGE_HOURS=24       # queue/*.jsonl TTL, parseFloat (fractions OK)
```

`initialize.sh` sources `.env` with `set -a` (auto-export), so the
daemon inherits these variables through the spawn. The file is
gitignored — credentials stay local.

### `preferredNotifChannel` recommendation

After verifying the daemon fires correctly, set both your Claude
settings files to `notifications_disabled` :

- `/workspace/.claude/settings.local.json`
- `/home/node/.claude/settings.json`

```json
{
	"preferredNotifChannel": "notifications_disabled"
}
```

Why : Claude Code's built-in `idle_prompt` bell fires 60 s after a
turn ends. If you leave `preferredNotifChannel` at `terminal_bell`,
you get both the built-in bell AND the custom notif from this bridge
— a double-ring. Disabling the built-in channel cleans this up. The
setting is **not flipped automatically** — it stays under your
control.

---

## Channels

The four shipped channels, all under [lib/consumers/](lib/consumers/).
Each subscribes to `send:notification` independently — failures in one
never block the others.

### toast — OS-native notification

[lib/consumers/notifier.js](lib/consumers/notifier.js).

| Platform | Mechanism | Status on boot |
|---|---|---|
| macOS | `osascript -e 'display notification …'` | `ok platform=darwin` |
| Windows | WinRT toast via inline PowerShell + AUMID `Microsoft.VisualStudioCode` | `ok platform=win32 aumid=Microsoft.VisualStudioCode` |
| Linux | logging stub, no notification surfaced | `skipped reason=linux-not-implemented` |

Fires on every event type. Per-event title / subtitle / body shape is
in the `TEMPLATES` object near
[lib/consumers/notifier.js](lib/consumers/notifier.js#L174) :
`title = brandTitle()` (`Claude Code · <project>`), `subtitle =
session label or first-8 of sid`, `body = action hint · message · time`.
The label per event type is in
[lib/constants.js:TYPE_LABELS](lib/constants.js#L31-L37) — `stop` is
`null` because the recap line already self-describes.

### sound — audio cue

[lib/consumers/sound.js](lib/consumers/sound.js). Opt-in via
`NOTIFY_SOUND` :

| `NOTIFY_SOUND` | Resolved player |
|---|---|
| unset or `default` | macOS: `afplay /System/Library/Sounds/Glass.aiff` · Windows: PowerShell `[System.Media.SystemSounds]::Asterisk` · Linux: first existing of [LINUX_SOUND_CANDIDATES](lib/constants.js#L110-L114) played via paplay / aplay / ffplay |
| `<abs path>` | macOS `afplay <path>` (WAV/AIFF/MP3/M4A) · Windows `Media.SoundPlayer <path>` (WAV only) · Linux `paplay` / `aplay` / `ffplay <path>` |
| `off` | channel `skipped reason=user-disabled` |

Format recommendation for custom files : **WAV** — the only format
all three platform players accept. macOS accepts AIFF/MP3/M4A in
addition ; Linux `paplay` accepts OGG.

Three terminal states (see
[lib/consumers/sound.js:35-69](lib/consumers/sound.js#L35-L69)) :

| status | reason tag |
|---|---|
| `ok` | `mode=default resolved=<cmd-or-path>` or `mode=custom resolved=<abs-path>` |
| `skipped` | `user-disabled` |
| `fail` | `file-not-found` · `unsupported-platform` · `no-linux-sound-found` · `no-linux-player` |

Linux caveat : no audio file ships with every distro. The probe order
is GNOME/KDE `freedesktop` first, then ALSA — absent on minimal
Alpine / Debian-minimal / headless servers. If none found, the channel
logs `[sound] no … sound asset found` and stays silent. Custom-path
mode bypasses this probe. Each playback is spawned detached + unref'd
— the daemon never blocks waiting for the sound to finish.

### discord — webhook POST

[lib/consumers/discord-webhook.js](lib/consumers/discord-webhook.js).
Opt-in via `NOTIFY_DISCORD_WEBHOOK_URL`. Native `https` — no NPM
dependency.

Status on boot :

| status | diag |
|---|---|
| `ok` | `webhook=https://discord.com/api/webhooks/<channel_id>/****<last4>` (token-redacted) |
| `skipped` | `reason=no-webhook` |

The redaction policy matches the URL against
[DISCORD_WEBHOOK_URL_RE](lib/constants.js#L124), keeps the prefix +
channel ID (public), masks the token as `****<last4>`. The masked
form appears everywhere the webhook surfaces (terminal readback,
`daemon.log`) — only the channel ID + last-4-of-token is visible, so
log correlation across daemon restarts stays possible without leaking
the secret.

Render output is a Markdown body per event type, capped at 1900 chars
and truncated to 1893 to reserve room for a closing fence
([DISCORD_TRUNCATION_LIMITS](lib/constants.js#L98-L102)). Unbalanced
code fences are closed defensively so a truncated body never breaks
the channel feed's rendering.

### flash — Windows taskbar flash

[lib/consumers/flash-win.js](lib/consumers/flash-win.js). Windows-only ;
status outside win32 is `skipped reason=non-windows`.

Fires only on the attention events listed in
[FLASH_EVENT_TYPES](lib/constants.js#L68-L73) :

- `permission_request`
- `permission_prompt`
- `idle_prompt`
- `elicitation_dialog`

`stop`, `tool_started`, `tool_finished` are deliberately excluded — too
chatty for a yank-the-eye flash.

Mechanism : spawned PowerShell uses `FlashWindowEx` via P/Invoke. The
window is discovered by enumerating visible windows owned by `Code.exe`
processes, preferring titles containing the project name (case-
insensitive substring), falling back to the first visible VS Code
window. Flags `FLASHW_ALL | FLASHW_TIMERNOFG` mean caption + taskbar
flash continuously until the user brings the window to the foreground.

---

## Troubleshooting

### Daemon log

```
.devcontainer/notify/queue/daemon.log
```

Append-only during a daemon lifetime ; rotated once at boot if larger
than 1 MB (keeps the last 100 KB). Format :
`<ISO timestamp> [<level>] <message>` ([lib/log.js](lib/log.js)).

```bash
tail -F .devcontainer/notify/queue/daemon.log
```

### Audit log

```
.devcontainer/notify/queue/state/actions.jsonl
```

Truncated at boot — covers the CURRENT daemon lifetime only. Every
ARM / REPLACE / CANCEL / FIRE / UNMAPPED decision lands here as a
JSONL line, immediately useful when "the notif never fired" :

```bash
# Did the watcher see the event?
grep '"sid":"abc12345-' .devcontainer/notify/queue/state/actions.jsonl

# What was decided on the last 20 events?
tail -20 .devcontainer/notify/queue/state/actions.jsonl | jq -c '.'
```

If the sid appears only as `unmapped`, the eventType is missing from
[EVENT_DELAYS_MS](lib/constants.js#L44-L53). If it appears as `armed`
but never `fired`, look for a `cancelled` line with the same sid.

### Common failure modes

| Symptom | Where to look |
|---|---|
| No notif at all | Daemon reactive? See the [active probe](#lifecycle--healthcheck) above. If `ps -p $(cat queue/.daemon.pid)` is empty, restart via Rebuild Container or `node index.js`. If the process exists but mtime is stale (> 30 s old), the daemon is stuck — `kill -9 $PID` then restart. |
| Daemon spawn failed | `cat queue/daemon.log` — look for `node not found on host PATH`, `cannot auto-locate notify/queue`, or `[FATAL] notify daemon boot failed: …`. |
| OS notif missing on macOS (first run) | `osascript` fires silently until you allow "Script Editor" once — see [OS setup → macOS](#macos--enable-osascript-notifications-one-time). Quick check : `osascript -e 'display notification "ping" with title "Claude Code"'`. |
| OS notif missing on macOS (later) | System Settings → Notifications → Script Editor → "Allow notifications" ON. Also check Do Not Disturb / Focus modes. |
| OS notif missing on Windows | Test with `node tests/modules.js notifier`. Check the AUMID line in `daemon.log` — should resolve to "Visual Studio Code", not "Microsoft.Windows.Explorer". |
| Discord webhook 401/404 | URL revoked or wrong. Re-issue a webhook in Discord channel settings and update `.devcontainer/.env`. |
| Sound channel silent (Linux) | Check `daemon.log` for `[sound] no freedesktop/alsa sound asset found` — install `sound-theme-freedesktop` (apt/dnf) or set `NOTIFY_SOUND=/abs/path.wav`. |
| Sound channel silent (custom path) | Check `daemon.log` for `[sound] file not found: …` — path must be absolute and the file readable. WAV only on Windows. |
| Daemon exits immediately | `daemon.log` shows `container gone` — Docker Desktop quit or the container is down. Start Docker Desktop and reopen the container. |
| Double-ring (bell + notif) | Set `preferredNotifChannel: "notifications_disabled"` — see [OS setup](#preferrednotifchannel-recommendation). |
| Queue-dir auto-locate fails | `daemon.log` shows `cannot auto-locate notify/queue from cwd=…`. Pass an explicit path : `node index.js /abs/path/to/queue`. The three resolution rules are in [Architecture → Queue directory resolution](#queue-directory-resolution). |

### Force-restart recipe

```bash
# Stop the running daemon (graceful — it unlinks .daemon.pid on SIGTERM)
kill $(cat .devcontainer/notify/queue/.daemon.pid)

# Re-spawn detached (nohup survives terminal close ; disown alone doesn't)
cd /path/to/Portal42-POS
nohup node .devcontainer/notify/index.js \
	>> .devcontainer/notify/queue/daemon.log 2>&1 &
disown
```

Override the queue dir for isolated debug (uses a separate pidfile, so
it won't collide with the auto-spawned daemon) :

```bash
node .devcontainer/notify/index.js /tmp/my-test-queue
```

### Manual tests

Two complementary runners under [tests/](tests/) :

```bash
# Host-side per-module test (run on Mac / Windows terminal, not in container)
node .devcontainer/notify/tests/modules.js <module>
# modules: discord-webhook · notifier · sound · docker-watch · watcher · all

# Container-side synthetic event driver (run inside the devcontainer)
node .devcontainer/notify/tests/notifs.js <type> [cancel]
# types: stop · perm · idle · perm-prompt · elicit · v2 · all
# append `cancel` to fire a user_replied 2 s later and expect NO notif
```

[tests/PROMPTS.md](tests/PROMPTS.md) lists real-world prompts that
trigger each event type end-to-end.

---

## Out of scope

- **Interactive Allow/Deny via notif buttons** — sibling plan
  `claude-code-ext-supercharge`.
- **`terminal-notifier` upgrade on macOS** for click-to-focus + group /
  remove — opt-in via `brew install`, daemon auto-detects. Not
  implemented yet.
- **Linux `notify-send` impl** — there's a `// TODO` in
  [lib/consumers/notifier.js](lib/consumers/notifier.js). Drop-in when
  a Linux user shows up.
- **Per-event sound** — current sound channel plays the same chime on
  every event. A `SOUNDS_BY_EVENT` table analogous to the notifier's
  `TEMPLATES` would be the obvious shape if needed later.
