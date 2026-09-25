// =============================================================================
// launcher-watch — host-side launcher liveness probe (Phase 2 POC : observation-only)
// =============================================================================
//
// Receives the bash $PPID captured by initialize.sh just before `nohup … &`
// (typically the devcontainer CLI / VS Code helper that invoked the script).
// Walks up the process tree skipping any shell / nohup layers to land on the
// first "real" ancestor (long-lived process — VS Code main, node CLI, etc.),
// captures its start time for anti-PID-recycling, then probes `kill -0` every
// `intervalMs` ms.
//
// In Phase 2 (this version) the probe outcomes are LOGGED ONLY — no bus emit,
// no shutdown trigger. The goal is to validate the choice of watched ancestor
// against a real session before wiring `launcher:gone` into the shutdown path
// (Phase 3).
//
// If no usable launcher PID is provided (≤ 1, or process gone before walk),
// the module is disabled and logs a warning. Daemon lifecycle then relies on
// docker-watch + signals only — same as today.
//
// NOTE — Windows-native Node (no WSL) : there is no `/usr/bin/ps` on the PATH
// and no /proc. Every `spawnSync('ps', …)` call below returns empty stdout,
// so `commOf` / `ppidOf` / `lstartOf` yield "" and the ancestor walk falls
// through to the "no usable launcher PID" branch — module disables itself
// without throwing. Daemon then runs in observation-only mode, same fallback
// as a missing launcher PID on POSIX. WSL Linux Node sees /proc + ps and
// behaves like native Linux. No code branch needed — the empty-string return
// is the degradation path.
// =============================================================================

const { spawnSync } = require('child_process')
const log = require('./log')

// Matches the bare command name as returned by `ps -o comm=` on either BSD
// (macOS — often `/bin/zsh`) or procps (Linux/WSL — bare `zsh`). Skipped when
// walking up : we want a non-shell ancestor.
const SHELL_RE = /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh|dash|nohup|fish)$/

// Minimum age (in seconds) for an ancestor candidate. Any process younger
// than this is considered ephemeral (typical case : VS Code Code Helper
// (Plugin) spawned specifically to run `initializeCommand`) and we walk up.
// 60 s is enough to skip Rebuild/Reload-triggered helpers while not
// overshooting common dev shells.
const MIN_ANCESTOR_AGE_SEC = 60

function commOf(pid) {
	const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' })
	return (r.stdout || '').trim()
}
function ppidOf(pid) {
	const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' })
	const n = Number((r.stdout || '').trim())
	return Number.isFinite(n) && n > 0 ? n : 0
}
function lstartOf(pid) {
	const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
	return (r.stdout || '').trim()
}
function etimeOf(pid) {
	const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' })
	return (r.stdout || '').trim()
}

// Parse `ps -o etime=` output : "[[dd-]hh:]mm:ss" → seconds. Same format
// on macOS (BSD ps) and Linux (procps), so portable as-is.
function parseEtimeSec(s) {
	if (!s) return NaN
	const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
	if (!m) return NaN
	const [, d, h, mm, ss] = m
	return ((Number(d || 0) * 24 + Number(h || 0)) * 60 + Number(mm)) * 60 + Number(ss)
}

// Walk up from `startPid` skipping shells/nohup AND ephemeral processes
// (younger than MIN_ANCESTOR_AGE_SEC). Returns the first stable ancestor,
// or `startPid` if the walk dies. Each candidate considered is logged
// (SHELL / TOO-YOUNG / PICK) for diagnostic visibility.
function pickAncestor(startPid) {
	let cur = startPid
	for (let depth = 0; depth < 15 && cur > 1; depth++) {
		const comm = commOf(cur)
		if (!comm) return cur
		const etime = etimeOf(cur)
		const ageSec = parseEtimeSec(etime)
		const isShell = SHELL_RE.test(comm)
		const tooYoung = Number.isFinite(ageSec) && ageSec < MIN_ANCESTOR_AGE_SEC
		const decision = isShell ? 'SHELL' : tooYoung ? 'TOO-YOUNG' : 'PICK'
		log.info(`[launcher-watch] walk depth=${depth} pid=${cur} comm="${comm}" etime="${etime}" ageSec=${ageSec} → ${decision}`)
		if (!isShell && !tooYoung) return cur
		const next = ppidOf(cur)
		if (!next) return cur
		cur = next
	}
	return startPid
}

/**
 * Start the periodic launcher liveness probe.
 *
 * @param {object} opts
 * @param {import('events').EventEmitter} opts.bus   reserved for Phase 3 (`launcher:gone` emit)
 * @param {number} opts.launcherPid                  PID handed to the daemon (typically $PPID from initialize.sh, or process.ppid in interactive mode)
 * @param {number} opts.intervalMs                   poll cadence in ms (5_000 in prod POC)
 */
function start({ bus, launcherPid, intervalMs }) {
	if (!launcherPid || launcherPid <= 1) {
		log.warn('[launcher-watch] no usable launcher PID — disabled')
		return
	}
	const watchedPid = pickAncestor(launcherPid)
	const watchedComm = commOf(watchedPid)
	const expectedLstart = lstartOf(watchedPid)
	log.info(`[launcher-watch] start=${launcherPid} → watching pid=${watchedPid} comm="${watchedComm}" lstart="${expectedLstart}" interval=${intervalMs}ms (observation-only)`)

	let signalled = false
	const tick = () => {
		if (signalled) return
		let alive = false
		try { process.kill(watchedPid, 0); alive = true } catch (_) {}
		if (!alive) {
			log.info(`[launcher-watch] pid=${watchedPid} GONE (would emit launcher:gone)`)
			signalled = true
			return
		}
		const lstart = lstartOf(watchedPid)
		if (expectedLstart && lstart && lstart !== expectedLstart) {
			log.info(`[launcher-watch] pid=${watchedPid} RECYCLED (lstart now="${lstart}", was "${expectedLstart}", would emit launcher:gone)`)
			signalled = true
		}
	}
	const handle = setInterval(tick, intervalMs)
	handle.unref?.()
}

module.exports = { start }
