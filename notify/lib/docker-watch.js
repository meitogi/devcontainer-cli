// =============================================================================
// docker-watch — container-down detection → daemon shutdown signal
// =============================================================================
//
// Polls `docker ps -q --filter label=devcontainer.local_folder=<projectDir>`
// every intervalMs. Three conditions trigger a 'container:gone' bus emit
// (consumed by daemon.js to exit cleanly) :
//
//   1. Docker CLI exits non-zero  (rare — Docker Desktop misbehaving)
//   2. Docker CLI fails to spawn  (Docker Desktop not running, docker not on
//                                  PATH — happens if Docker Desktop quits)
//   3. Filter returns empty stdout (no running container matches our project
//                                  — the devcontainer was stopped)
//
// The emit carries `{ reason, status }` so consumers can render a precise
// diagnostic (e.g. the daemon_stopped desktop notification) instead of a
// generic "container gone".
//
// POST-WAKE GRACE : on subscribe to 'system:wake' (emitted by lib/sleep-watch.js
// when wall-clock drift suggests a system wake). For 30 s after a wake, any
// non-running probe result is silenced — Docker Desktop may need a few
// seconds to come back up after sleep, and an immediate exit on the first
// post-wake tick was the bug this grace fixes.
//
// Outside that 30 s window the behavior is unchanged : `initialize.sh`
// re-spawns the daemon at the next container open, so a real container-gone
// exit is at worst a 60 s gap before the next user action re-fires it.
//
// If `projectDir` is missing (e.g. daemon launched manually for debugging),
// the module logs a warning and disables the poll — daemon will then live
// until OS session ends or the user kills it.
// =============================================================================

const { spawnSync } = require('child_process')
const log = require('./log')

// -----------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// -----------------------------------------------------------------------------

// Post-wake grace window — ms tolerated after a 'system:wake' before
// container:gone is allowed to fire. 30 s covers Docker Desktop's typical
// resume-from-sleep cold start on macOS without bottling a real container
// shutdown for too long.
const POST_WAKE_GRACE_MS = 30_000

/**
 * Start the periodic docker poll. Schedules `probe()` every `intervalMs`
 * and emits 'container:gone' on the bus the first time the probe reports
 * anything other than `running` — at which point daemon.js exits cleanly.
 *
 * Subscribes to 'system:wake' from lib/sleep-watch.js : within
 * POST_WAKE_GRACE_MS of the last wake, non-running probe results are
 * logged but suppressed, giving Docker Desktop time to resume after a
 * system sleep.
 *
 * If `projectDir` is missing (e.g. the daemon was launched manually for
 * debugging), the poll is disabled and a warning is logged. The daemon
 * will then live until the OS session ends or the user kills it.
 *
 * The interval handle is unref'd so it doesn't keep the event loop alive
 * once everything else has shut down.
 *
 * @param {object} opts
 * @param {import('events').EventEmitter} opts.bus   emit target for 'container:gone', listens for 'system:wake'
 * @param {string} opts.projectDir                   absolute host path matching the devcontainer.local_folder label
 * @param {number} opts.intervalMs                   poll cadence in ms (60_000 in prod)
 * @returns {void}                                   schedules the poll, returns immediately
 */
function start({ bus, projectDir, intervalMs }) {
	if (!projectDir) {
		log.warn('[docker-watch] no projectDir passed — disabled (daemon will outlive container)')
		return
	}

	let graceUntil = 0
	bus.on('system:wake', ({ gapMs }) => {
		graceUntil = Date.now() + POST_WAKE_GRACE_MS
		log.info(`[docker-watch] system:wake (gap=${gapMs}ms) — grace ${POST_WAKE_GRACE_MS}ms before container:gone is allowed`)
	})

	const tick = () => {
		const r = probe(projectDir)
		if (r.status === 'running') return
		if (Date.now() < graceUntil) {
			log.info(`[docker-watch] ${r.detail} — within post-wake grace, skipping container:gone`)
			return
		}
		log.info(`[docker-watch] ${r.detail} — emitting container:gone`)
		bus.emit('container:gone', { reason: r.detail, status: r.status })
	}
	const handle = setInterval(tick, intervalMs)
	handle.unref?.()
	log.info(`[docker-watch] polling every ${intervalMs}ms for label=devcontainer.local_folder=${projectDir}`)
}

// -----------------------------------------------------------------------------
// INTERNAL
// -----------------------------------------------------------------------------

/**
 * Run one `docker ps -q --filter label=devcontainer.local_folder=<dir>`
 * probe. Synchronous (spawnSync) on purpose — the call is cheap (<100 ms
 * when Docker Desktop is responsive) and a sync call keeps the logic
 * trivial. If Docker hangs longer than 10 s, the timeout kicks in and
 * the result is reported as `error` (treated as "container gone" by
 * start()'s caller).
 *
 * Pure : no bus emit, no log side effects. Useful both inside the periodic
 * poll and for one-shot status checks in tests.
 *
 * @param {string} projectDir   absolute host path matching the devcontainer label
 * @returns {{ status: 'running'|'gone'|'error', detail: string, containerId?: string }}
 *          `running` → containerId is the docker id ;
 *          `gone`    → docker ran fine but the filter returned empty ;
 *          `error`   → docker CLI failed (binary missing, daemon stopped, timeout)
 */
function probe(projectDir) {
	const r = spawnSync('docker', [
		'ps', '-q',
		'--filter', `label=devcontainer.local_folder=${projectDir}`
	], { encoding: 'utf8', timeout: 10_000 })

	if (r.error)        return { status: 'error', detail: `docker CLI failed: ${r.error.message}` }
	if (r.status !== 0) return { status: 'error', detail: `docker exited ${r.status}` }
	const id = (r.stdout || '').trim()
	if (!id)            return { status: 'gone',  detail: 'no matching container' }
	return { status: 'running', detail: `container ${id} alive`, containerId: id }
}

module.exports = { start, probe }
