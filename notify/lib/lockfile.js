// =============================================================================
// lockfile — single-instance guard + liveness heartbeat via .daemon.pid
// =============================================================================
//
// Re-uses the pidfile as both PID storage AND liveness heartbeat :
//   - file CONTENT = "<pid>\n" (written once at acquire)
//   - file MTIME   = bumped every intervalMs by startHeartbeat (fs.utimes —
//                    touch-only, no content rewrite)
//
// One file, two signals : no extra .daemon.heartbeat to ignore in .gitignore.
//
// acquire({ pidFile, staleMs }) → { acquired:true } | { acquired:false, pid }
//
//   - no pidfile                          → write our PID, acquired:true
//   - PID alive                           → ALWAYS REPLACE : SIGTERM, wait 2 s
//                                            for graceful exit, SIGKILL fallback,
//                                            then claim. Garantit que le nouveau
//                                            code prend le relais à chaque
//                                            initialize.sh (reload / rebuild).
//                                            Trade-off : timers debounce en
//                                            cours sont perdus — OK pour ce
//                                            daemon (état trivial, regenérable).
//   - PID dead (ESRCH)                    → claim with discovery enriched log
//                                            (death window via mtime gap)
//
// `staleMs` n'est plus utilisé depuis le passage à always-replace (l'ancien
// path "alive + stale → SIGKILL" est couvert par le SIGTERM + SIGKILL fallback
// de always-replace). Gardé dans la signature pour backward-compat avec
// index.js qui le passe toujours via HEARTBEAT_STALE_MS.
//
// Le retour { acquired:false, pid } n'est plus jamais émis non plus —
// always-replace claim systématiquement. Le filet `if (!lock.acquired)` dans
// index.js reste comme sécurité défensive.
//
// SIGUSR2 (Unix only) is wired in index.js, not here — the handler just calls
// fs.utimesSync(pidFile, now, now) directly.
// =============================================================================

const fs = require('fs')
const { spawnSync } = require('child_process')
const log = require('./log')
const { getHostKind } = require('./host')

// WSL : Linux Node spawned from a Windows-side shell. taskkill.exe is
// reachable via WSL interop and is the only kill that lands on a
// Windows-spawned sibling daemon (Linux process.kill can't see it).
const isWslInterop = process.platform === 'linux' && getHostKind() === 'windows'

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

/**
 * Acquire the single-instance lock by claiming the pidfile. Always-replace
 * semantics : if a previous daemon is alive, SIGTERM it, wait up to 2 s for
 * a graceful exit, SIGKILL on timeout, then claim the slot. This guarantees
 * a fresh `initialize.sh` always lands the new code — at the cost of losing
 * any debounce timers from the previous run (acceptable : the daemon's state
 * is trivial and regenerable).
 *
 * The `{ acquired:false, pid }` return shape is kept in the signature for
 * defensive code in index.js but is never produced today (always-replace).
 * See the file header for the full rationale.
 *
 * @param {object} opts
 * @param {string} opts.pidFile   absolute path to the pidfile (also used as heartbeat)
 * @param {number} opts.staleMs   legacy parameter, no longer consulted (kept for ABI)
 * @returns {{ acquired: boolean, pid?: number }}
 *          `{ acquired:true }` on success ; defensive false-case never produced today
 */
function acquire({ pidFile, staleMs }) {
	const existingPid = readPid(pidFile)
	if (existingPid === null) {
		writePid(pidFile)
		return { acquired: true }
	}

	if (isAlive(existingPid)) {
		log.info(`[lockfile] previous pid ${existingPid} alive — replacing`)
		killStaleDaemon(existingPid)
		writePid(pidFile)
		return { acquired: true }
	}

	// ESRCH — PID dead → discovery enrichi avec death window
	const gap = Math.round((Date.now() - mtimeMs(pidFile)) / 1000)
	log.info(`[lockfile] previous pid ${existingPid} dead — last heartbeat ${gap}s ago — claiming slot`)
	writePid(pidFile)
	return { acquired: true }
}

/**
 * Start the periodic mtime bump on the pidfile. utimesSync touches mtime
 * only — does not rewrite content, so the stored PID stays stable for the
 * lifetime of the daemon. The mtime gap between now and `pidFile`'s mtime
 * is what `acquire()` reads later to compute a "death window" diagnostic.
 *
 * The returned stop() must be called from the shutdown path (SIGTERM /
 * SIGINT / 'container:gone' / uncaughtException) — see index.js. Without
 * it, the interval would keep the event loop alive after release().
 *
 * @param {object} opts
 * @param {string} opts.pidFile      absolute path to the pidfile
 * @param {number} opts.intervalMs   heartbeat period in ms (typically HEARTBEAT_INTERVAL_MS)
 * @returns {() => void}             stop() to clear the heartbeat interval
 */
function startHeartbeat({ pidFile, intervalMs }) {
	const tick = () => {
		const now = new Date()
		try { fs.utimesSync(pidFile, now, now) }
		catch (e) { log.warn(`[lockfile] heartbeat utimes failed: ${e.message}`) }
	}
	const handle = setInterval(tick, intervalMs)
	handle.unref?.()
	log.info(`[lockfile] heartbeat every ${intervalMs}ms on ${pidFile}`)
	return () => clearInterval(handle)
}

/**
 * Best-effort cleanup of the pidfile. Swallows ENOENT — by the time the
 * shutdown path runs, another daemon may already have always-replaced us
 * and deleted our pidfile. Any other unlink error is logged at warn level
 * but not thrown ; shutdown must proceed regardless.
 *
 * @param {object} opts
 * @param {string} opts.pidFile   absolute path to the pidfile
 * @returns {void}                attempts to unlink pidFile, never throws
 */
function release({ pidFile }) {
	try { fs.unlinkSync(pidFile) }
	catch (e) {
		if (e.code !== 'ENOENT') log.warn(`[lockfile] release unlink failed: ${e.message}`)
	}
}

// -----------------------------------------------------------------------------
// INTERNAL
// -----------------------------------------------------------------------------

/**
 * Cross-platform liveness check via `process.kill(pid, 0)` — signal 0 is the
 * POSIX "does this PID exist" probe, and libuv emulates it on Windows. ESRCH
 * means the process is gone ; EPERM means it's alive but owned by another
 * user (we treat that as alive — safer to back off than to evict a foreign
 * process that happens to reuse the PID number).
 *
 * @param {number} pid   PID to probe
 * @returns {boolean}    true if the PID maps to a live process (or EPERM owner)
 */
function isAlive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return e.code === 'EPERM'
	}
}

/**
 * Cross-platform stale-daemon kill. Three host shapes :
 *   - win32 native             : `taskkill /F /PID` — the detached + hidden
 *                                 daemon doesn't process WM_CLOSE reliably,
 *                                 so we go straight to hard-kill.
 *   - WSL with Windows sibling : `taskkill.exe /F /PID` via WSL interop ; if
 *                                 it fails (target is actually Linux Node
 *                                 spawned from WSL) we fall through to POSIX.
 *   - POSIX (Mac / Linux)      : SIGTERM, sync-spin 2 s for graceful exit,
 *                                 SIGKILL fallback — historical behaviour,
 *                                 lets the daemon flush state files before
 *                                 the next instance overwrites them.
 *
 * @param {number} pid   PID of the previous daemon
 * @returns {boolean}    true if pid is no longer alive after the attempt
 */
function killStaleDaemon(pid) {
	if (process.platform === 'win32') {
		const r = spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' })
		if (r.status === 0) return true
		log.warn(`[lockfile] taskkill /F /PID ${pid} failed (status ${r.status}) — overwriting pidfile anyway`)
		return false
	}
	if (isWslInterop) {
		const r = spawnSync('taskkill.exe', ['/F', '/PID', String(pid)], { stdio: 'ignore' })
		if (r.status === 0) return true
		// taskkill.exe didn't find the PID — target may be a Linux-Node sibling.
		// Fall through to the POSIX path below.
	}
	try { process.kill(pid, 'SIGTERM') }
	catch (e) {
		log.warn(`[lockfile] SIGTERM failed for ${pid}: ${e.message}`)
		return false
	}
	const deadline = Date.now() + 2000
	while (Date.now() < deadline && isAlive(pid)) { /* spin */ }
	if (isAlive(pid)) {
		log.warn(`[lockfile] pid ${pid} didn't exit after SIGTERM 2s — SIGKILL`)
		try { process.kill(pid, 'SIGKILL') } catch (_) {}
	}
	return !isAlive(pid)
}

/**
 * Read and parse the PID stored in the pidfile. Returns null for any failure
 * mode — missing file, unreadable bytes, non-numeric content, or non-positive
 * integer. Callers treat null as "no previous owner" and claim the slot.
 *
 * @param {string} pidFile   absolute path to the pidfile
 * @returns {number|null}    parsed PID > 0, or null when no usable PID is stored
 */
function readPid(pidFile) {
	try {
		const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
		return pid > 0 ? pid : null
	} catch (_) { return null }
}

/**
 * Write the current process's PID to the pidfile (one line, trailing \n).
 * Sync on purpose — acquire() is sync end-to-end so callers can reason about
 * the lock state immediately. Will throw if the parent directory is missing
 * or unwritable ; acquire() does not catch, the daemon bails loud.
 *
 * @param {string} pidFile   absolute path to the pidfile
 * @returns {void}           writes `${process.pid}\n` to pidFile
 */
function writePid(pidFile) {
	fs.writeFileSync(pidFile, `${process.pid}\n`)
}

/**
 * Read the pidfile's last-modified time in epoch milliseconds. Used by
 * acquire() to compute the "death window" gap when a dead PID is found —
 * the difference between now and the last heartbeat tells operators how
 * long the previous daemon has been gone.
 *
 * @param {string} pidFile   absolute path to the pidfile
 * @returns {number}         mtime in ms since the epoch, or 0 if stat fails
 */
function mtimeMs(pidFile) {
	try { return fs.statSync(pidFile).mtimeMs }
	catch (_) { return 0 }
}

module.exports = { acquire, startHeartbeat, release }
