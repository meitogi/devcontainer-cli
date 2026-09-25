#!/usr/bin/env node
// =============================================================================
// notify daemon — host-side consumer of .devcontainer/tmp/notify/*.jsonl
// =============================================================================
//
// Spawned by .devcontainer/initialize.sh on container open/build. Watches the
// JSONL queue, applies a per-event delay + per-session debounce, and dispatches
// notifications through pluggable channels.
//
// ARCHITECTURE
//   watcher                       reads JSONL, manages timers, emits 'send:notification'
//   consumers/notifier            OS-native notif (osascript / WinRT toast / linux TODO)
//   consumers/discord-webhook     Discord webhook POST (optional, env-driven)
//   consumers/sound               OS-native bell or custom file (optional, env-driven)
//   consumers/flash-win           Windows taskbar flash on attention events
//   docker-watch                  polls `docker ps`; exits cleanly when the container is gone
//   locate                        resolves the queue dir from the launch context
//
//   All consumer modules wire onto a shared EventEmitter (`bus`). The
//   watcher is the SOLE producer of 'send:notification'. Consumers under
//   lib/consumers/ subscribe independently — any number, in any order,
//   without coordinating with each other.
//
// ADDING A NEW CONSUMER (e.g. Slack, ntfy.sh, signal-cli, custom IPC…)
//   1. Create lib/consumers/<channel>.js exporting { start({ bus, ...opts }) }.
//   2. Inside start(), subscribe to 'send:notification':
//
//        bus.on('send:notification', ({ sid, eventType, subtitle, body }) => {
//          // dispatch to your channel here — fire-and-forget, never throw
//        })
//
//   3. Require + start it below, next to the other consumers.
//
//   That's it. No changes to watcher / config / payload shape required.
//
// PAYLOAD SHAPE emitted on 'send:notification'
//   {
//     sid:       string  // Claude session id (debounce / grouping key)
//     eventType: string  // 'stop' | 'notification' | 'permission_request'
//     subtitle:  string  // short label — e.g. 'Stop', 'Permission request'
//     body:      string  // human-readable excerpt, capped ~200 chars upstream
//   }
//
// CLI
//   node index.js              # auto-locate via cwd (see lib/locate.js)
//   node index.js <queueDir>   # explicit queue dir override
//   env: NOTIFY_CHANNELS=all|csv-of(basic-notif,notify,sound,discord,flash)
//        (default=all — expands to every channel EXCEPT the opt-in `notify`)
//        NOTIFY_SOUND=default|<abs path>|off                    (default=default)
//        NOTIFY_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
//        NOTIFY_CLEANUP_MAX_AGE_HOURS=24                        (queue file TTL)
//   All sourced from .devcontainer/.env via initialize.sh's `set -a`
//   auto-export. See .devcontainer/.env.example for the documented section.
//
// SINGLE-INSTANCE + HEALTHCHECK
//   The daemon owns its lockfile (queue/.daemon.pid). A second `node index.js`
//   on the same devcontainer detects the first and exits 0. The pidfile's
//   mtime doubles as a liveness heartbeat (touched every 10 s ; >30 s = zombie).
//   On Unix, `kill -USR2 $(cat .daemon.pid)` forces an immediate mtime refresh —
//   useful as an active probe from a host script. See lib/lockfile.js.
// =============================================================================

// --- Node 18+ requirement ---
// ES5-safe block — this runs BEFORE any require() of lib/*.js, which contains
// `?.` / `??` (Node 14+). Parse-wise, this file itself only needs Node 12.5+
// (numeric separators). On Node < 18 we exit with a clear message instead of
// letting downstream requires throw a cryptic SyntaxError.
var _NODE_MAJOR = parseInt(process.versions.node.split('.')[0], 10)
if (_NODE_MAJOR < 18) {
	console.error('[notify daemon] Node 18+ required, got ' + process.versions.node)
	console.error('                Upgrade via nvm: nvm install --lts && nvm use --lts')
	process.exit(1)
}

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const log            = require('./lib/log')
const host           = require('./lib/host')
const watcher        = require('./lib/watcher')
const state          = require('./lib/state')
const { writeAtomic } = require('./lib/atomic-write')
const notifier       = require('./lib/consumers/notifier')
const notifyApp      = require('./lib/consumers/notify-app')
const discordWebhook = require('./lib/consumers/discord-webhook')
const sound          = require('./lib/consumers/sound')
const flashWin       = require('./lib/consumers/flash-win')
const dockerWatch    = require('./lib/docker-watch')
const launcherWatch  = require('./lib/launcher-watch')
const sleepWatch     = require('./lib/sleep-watch')
const lockfile       = require('./lib/lockfile')
const cleanup        = require('./lib/cleanup')
const inboundWatch   = require('./lib/inbound-watch')
const { locateQueueDir, readProjectName } = require('./lib/locate')
const { EVENT_DELAYS_MS } = require('./lib/constants')

// -----------------------------------------------------------------------------
// CHANNEL REGISTRY — maps NOTIFY_CHANNELS names to consumer modules.
// Object insertion order = expansion order for `NOTIFY_CHANNELS=all`, so the
// status file lines come out in this same order.
//
// Two macOS-native dispatchers live here and are mutually exclusive :
//   - `basic-notif`  osascript / WinRT toast / linux-stub — the historical
//                    fallback, zero external dependency. Always in `all`.
//   - `notify`       standalone `notif` binary (apps/notifier/) — session 8+
//                    unlocks sender identity + dismiss API + callbacks.
//                    OPT-IN : excluded from `all`, activate by naming it
//                    explicitly (e.g. NOTIFY_CHANNELS=notify,sound,discord).
// When both appear in NOTIFY_CHANNELS, `notify` wins with a warning — they'd
// otherwise fire twice per event on macOS.
// -----------------------------------------------------------------------------
const CHANNEL_REGISTRY = {
	'basic-notif': notifier,
	notify:        notifyApp,
	sound:         sound,
	discord:       discordWebhook,
	flash:         flashWin
}

// Channels NOT included when the user asks for `all`. Opt-in only.
const ALL_EXCLUDES = new Set(['notify'])

// NOTIFY_CHANNELS parser. `all` (or empty) expands to every registered name
// EXCEPT the opt-in ones (see ALL_EXCLUDES). Explicit CSV opts them in.
// CSV is trimmed + deduped — pathological `basic-notif,basic-notif,sound`
// won't double-subscribe (every consumer's bus.on() would fire twice per
// event otherwise).
//
// Mutual exclusion : when `basic-notif` AND `notify` both appear, drop
// `basic-notif` with a warning — they'd otherwise both dispatch on macOS.
const parseChannels = (raw) => {
	let list
	if (!raw || raw === 'all') {
		list = Object.keys(CHANNEL_REGISTRY).filter(k => !ALL_EXCLUDES.has(k))
	} else {
		list = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))]
	}
	if (list.includes('basic-notif') && list.includes('notify')) {
		log.warn('[boot] NOTIFY_CHANNELS lists both "basic-notif" and "notify" — dropping "basic-notif" to avoid double-dispatch')
		list = list.filter(k => k !== 'basic-notif')
	}
	return list
}

// Format a STATUS line from a consumer's { status, diag } return value.
// Shape : `STATUS <name> <status> k1=v1 k2=v2` — line-based, awk-parseable.
const formatStatus = (name, result) => {
	const diag = result.diag || {}
	const kv = Object.keys(diag).map(k => `${k}=${diag[k]}`).join(' ')
	return `STATUS ${name} ${result.status}${kv ? ' ' + kv : ''}`
}

// Status file is written via the shared atomic-write helper. `writeAtomic`
// goes through a `.tmp` sibling + renameSync — initialize.sh's polling loop
// never reads a partial file. Same primitive is reused by lib/state.js for
// queue/state/pending.json.
const writeStatusFile = (filePath, lines) => {
	writeAtomic(filePath, lines.join('\n') + '\n')
}

// -----------------------------------------------------------------------------
// CONFIG — tune here. All values in milliseconds.
// Keys = the flat eventType the watcher emits on the bus.
// Per-event delays live in lib/constants.js (EVENT_DELAYS_MS) — see WHY there.
// -----------------------------------------------------------------------------
// NOTIFY_DOCKER_POLL_MS override : >0 changes the docker-watch tick interval,
// 0 disables docker-watch entirely. Useful during launcher-watch POC to
// isolate which signal triggers shutdown (set to 1800000 for 30 min, or 0
// to fully delegate lifecycle to launcher-watch + signals).
const DOCKER_POLL_MS        = process.env.NOTIFY_DOCKER_POLL_MS !== undefined ? Number(process.env.NOTIFY_DOCKER_POLL_MS) : 60_000
const HEARTBEAT_INTERVAL_MS = 10_000  // touch .daemon.pid mtime every 10 s — liveness signal
const HEARTBEAT_STALE_MS    = 30_000  // 3× interval — daemon considered zombie above this

// Cleanup au boot : supprime les *.jsonl non touchés depuis N heures.
// Override .env via NOTIFY_CLEANUP_MAX_AGE_HOURS (parseFloat → fractions OK).
// Pas de tick périodique — le daemon est respawné à chaque ouverture de container.
const CLEANUP_MAX_AGE_HOURS = parseFloat(process.env.NOTIFY_CLEANUP_MAX_AGE_HOURS) || 24
const CLEANUP_MAX_AGE_MS    = CLEANUP_MAX_AGE_HOURS * 3_600_000

// -----------------------------------------------------------------------------
// BOOT — wrapped in try/catch so a synchronous failure (locate / readProjectName
// / log.init / lockfile.acquire / any module.start) writes a [FATAL] line to
// stderr before exit. Without this, a throw at boot dies via Node's default
// uncaught handler — which writes to stderr too, but the bash redirect from
// initialize.sh may have been lost in some host setups (nvm shims, etc.). The
// explicit line-buffered write here is robust and easy to grep for.
// -----------------------------------------------------------------------------
try {

// Parse argv : separate --launcher-pid=N flag from the optional positional
// <queueDir>. Flag absent → fall back to process.ppid (interactive mode :
// the shell that ran `node index.js` is what we watch).
const _argvFlags = {}
const _argvPositional = []
for (const a of process.argv.slice(2)) {
	if (a.startsWith('--launcher-pid=')) _argvFlags.launcherPid = Number(a.slice('--launcher-pid='.length))
	else _argvPositional.push(a)
}
const _launcherPidArg = Number.isFinite(_argvFlags.launcherPid) ? _argvFlags.launcherPid : process.ppid

// queueDir = <project>/.devcontainer/tmp/notify → projectDir is 3 levels up
const queueDir    = locateQueueDir(_argvPositional[0])
const projectDir  = path.resolve(queueDir, '..', '..', '..')
const projectName = readProjectName(projectDir)

log.init(path.join(queueDir, 'daemon.log'))
const hostKind = host.getHostKind()
const hostTag = (hostKind === 'windows' && process.platform === 'linux') ? 'windows (wsl)' : hostKind
log.info(`daemon started — platform=${process.platform} host=${hostTag} pid=${process.pid} project="${projectName}" queue=${queueDir}`)

// LOCKFILE — single-instance guard. Bail out if another daemon owns the slot
// (alive PID + heartbeat fresh). Stale zombies get SIGKILL'd on Unix.
const pidFile = path.join(queueDir, '.daemon.pid')
const lock = lockfile.acquire({ pidFile, staleMs: HEARTBEAT_STALE_MS })
if (!lock.acquired) {
	log.info(`another daemon already running (pid=${lock.pid}) — exiting`)
	process.exit(0)
}
const stopHeartbeat = lockfile.startHeartbeat({ pidFile, intervalMs: HEARTBEAT_INTERVAL_MS })

// Shutdown runs on any exit path — SIGTERM/SIGINT/SIGHUP, container:gone, uncaughtException.
// Idempotent : stopHeartbeat clears the interval, release unlinks the pidfile (ENOENT-safe).
// Renamed from `cleanup` to avoid shadowing the lib/cleanup module imported above.
const shutdown = () => {
	stopHeartbeat()
	lockfile.release({ pidFile })
}

// SIGUSR2 → force-refresh the pidfile mtime immediately. Available on every
// Unix flavor (Linux native, macOS, WSL2 — all report process.platform != 'win32').
// Windows native lacks SIGUSR2 ; the passive 10 s heartbeat covers that host.
if (process.platform !== 'win32') {
	process.on('SIGUSR2', () => {
		const now = new Date()
		try { fs.utimesSync(pidFile, now, now) } catch (_) {}
		log.info('SIGUSR2 — heartbeat refreshed')
	})
}
process.on('SIGTERM', () => { log.info('received SIGTERM — shutting down'); shutdown(); process.exit(0) })
process.on('SIGINT',  () => { log.info('received SIGINT — shutting down');  shutdown(); process.exit(0) })
// SIGHUP : NO-OP (log seul). `nohup` à initialize.sh:672 pose SIG_IGN
// avant exec, mais Node ÉCRASE cette disposition héritée dès qu'on
// appelle process.on('SIGHUP', ...) — un handler vide (no shutdown)
// rétablit l'ignore côté JS. Le daemon survit à la fermeture du
// terminal qui a lancé initialize.sh (Cmd-W sur Mac, VS Code Window
// Reload, "Press any key to close the terminal" puis fermeture auto).
// SIGTERM/SIGINT restent shutdown-triggering — intent explicite, eux.
process.on('SIGHUP',  () => log.info('SIGHUP ignored — daemon stays up'))

const bus = new EventEmitter()

// Forge a 'send:notification' event for daemon-lifecycle endings — wired into
// the container:gone and uncaughtException paths below. The payload reuses
// the existing notifier template shape so the daemon_stopped TEMPLATE entry
// in lib/consumers/notifier.js can render it. spawnDetached osascript on
// macOS survives the parent's process.exit(), so the OS notif still fires
// even though we exit immediately after this call.
const fireDaemonStopped = (reason) => {
	bus.emit('send:notification', {
		sid:       '00000000',
		eventType: 'daemon_stopped',
		ts:        new Date().toISOString(),
		line:      { session_name: projectName || 'daemon', last_message_excerpt: reason }
	})
}

// CLEANUP — purge stale *.jsonl before the watcher starts tracking offsets,
// so suppressBackfill only sees the surviving set. Synchronous, idempotent.
cleanup.run({ queueDir, maxAgeMs: CLEANUP_MAX_AGE_MS })

// SLEEP DETECTION — émet 'system:wake' sur saut de Date.now() ; consommé
// par docker-watch pour suppress container:gone pendant la grâce post-wake.
// Démarré avant watcher / dockerWatch pour qu'à la première seconde de vie
// du daemon, le drift watcher tourne déjà — pas de race possible.
sleepWatch.start({ bus })

// STATE — initialize queue/state/ (pending.json reset to empty + actions.jsonl
// truncated). Must run BEFORE watcher.start so the watcher's first event has
// a state surface to write into. See lib/state.js.
state.init({ queueDir, pid: process.pid })

// PRODUCER
watcher.start({ bus, queueDir, delays: EVENT_DELAYS_MS, state })

// CONSUMERS — each channel subscribes to 'send:notification' independently.
// Selection driven by NOTIFY_CHANNELS (default `all`). Each consumer's start()
// reads its own env config and returns { status, diag } — synthesized into a
// line-based status file (queue/.daemon.startup) consumed by initialize.sh
// for the terminal readback. See .devcontainer/.env.example for the env doc.
const requested   = parseChannels(process.env.NOTIFY_CHANNELS)
const statusLines = []
const activated   = []

for (const name of requested) {
	const mod = CHANNEL_REGISTRY[name]
	if (!mod) {
		statusLines.push(`STATUS ${name} fail reason=unknown-channel`)
		log.warn(`[boot] unknown channel "${name}" — ignored`)
		continue
	}
	const result = mod.start({ bus, projectName, projectDir })
	statusLines.push(formatStatus(name, result))
	if (result.status === 'ok') activated.push(name)
}

// Ordering guarantee (see plan §"Garantie de synchronisation") :
//   1. lockfile.acquire — .daemon.pid is present (already done above)
//   2. all consumers' start() have returned — statusLines is complete
//   3. writeStatusFile — .daemon.startup appears atomically
//   4. event loop starts (inboundWatch / dockerWatch wired below)
// When initialize.sh sees .daemon.startup, every reported channel is
// effectively subscribed on the bus — no race against in-flight `bus.on()`.
statusLines.push(`READY pid=${process.pid} channels=${activated.join(',')}`)
writeStatusFile(path.join(queueDir, '.daemon.startup'), statusLines)

// EXTRA CANCEL SOURCE — tail the VS Code extension inbound JSONL for fast
// click-level cancel signals (Allow/Deny, Interrupt, user text). Additive
// to the container-side cancel hooks (user_replied, tool_finished,
// tool_cancelled) — when the extension patch is missing, this module logs a
// fallback message and stays in standby.
inboundWatch.start({
	bus,
	logFile: path.join(projectDir, '.devcontainer/tmp/logs/claude-code-vscode-ext-inbound.jsonl')
})

// LIFECYCLE — exit cleanly when the devcontainer is gone. The container:gone
// payload carries the precise probe `reason` (e.g. `docker CLI failed: …`,
// `no matching container`) so the daemon_stopped notif tells the user what
// actually broke without forcing them to grep daemon.log.
if (DOCKER_POLL_MS > 0) {
	dockerWatch.start({
		bus,
		projectDir: hostKind === 'windows' ? `\\\\wsl.localhost\\${host.getHostSignals().wslDistro || 'Debian'}${projectDir.replace(/\//g, '\\')}` : projectDir,
		intervalMs: DOCKER_POLL_MS,
	})
} else log.info('[docker-watch] disabled via NOTIFY_DOCKER_POLL_MS=0')
launcherWatch.start({ bus, launcherPid: _launcherPidArg, intervalMs: 5_000 })
bus.on('container:gone', ({ reason } = {}) => {
	log.info('container gone — shutting down')
	fireDaemonStopped(reason || 'Docker container gone')
	shutdown()
	process.exit(0)
})

process.on('uncaughtException', (err) => {
	log.error(`uncaughtException: ${err.stack || err.message || err}`)
	fireDaemonStopped(`crash: ${err.message || err}`)
	shutdown()
	process.exit(1)
})

// Promises non gérées : Node n'exit pas par défaut, on log juste pour diag.
process.on('unhandledRejection', (reason) => {
	log.error(`unhandledRejection: ${reason && reason.stack || reason}`)
})

// Filet final : tire sur toute sortie synchrone (exit volontaire ou code
// d'erreur Node). NE tire PAS sur SIGKILL/SIGSTOP/host kill — c'est documenté
// Node, aucun workaround côté daemon. Le death window se déduit alors via
// `[lockfile] previous pid X dead — last heartbeat Ys ago` au prochain spawn.
process.on('exit', (code) => {
	log.info(`process exit code=${code}`)
})

} catch (e) {
	// Synchronous boot failure — write a clear [FATAL] line to stderr (captured
	// by initialize.sh's bash redirect to daemon.log) and exit non-zero.
	process.stderr.write(`[FATAL] notify daemon boot failed: ${e && e.stack || e}\n`)
	process.exit(1)
}
