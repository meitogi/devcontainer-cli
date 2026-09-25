// =============================================================================
// cleanup — boot-time purge of stale per-session JSONL files
// =============================================================================
//
// Runs once at daemon start (before watcher.start), removing any
// `<sid>.jsonl` whose mtime is older than `maxAgeMs`. Pure mtime check —
// no docker exec, no transcript inspection. Rationale :
//
//   - The hook appends to `<sid>.jsonl` on every Claude event for that
//     session → mtime tracks the last real activity.
//   - A session deleted by the user (or simply abandoned) stops receiving
//     events → mtime ages out → file is deleted at the next boot.
//   - The daemon is respawned by initialize.sh on every container open,
//     so "boot only" cleanup runs often enough in practice. If the daemon
//     lives for days without rebuild, kill it to force a new cycle.
//
// Threshold is tunable via env (NOTIFY_CLEANUP_MAX_AGE_HOURS in .env),
// resolved upstream in index.js and passed in as `maxAgeMs`.
//
// Strictly synchronous + idempotent. Runs BEFORE watcher.start, so there
// is no race with armed timers (none exist yet at this point).
// =============================================================================

const fs   = require('fs')
const path = require('path')
const log  = require('./log')

/**
 * Scan `queueDir` and unlink every `*.jsonl` whose mtime is older than
 * `maxAgeMs`. Pure mtime check, no docker exec, no transcript inspection
 * (see the file header for the rationale). Runs synchronously BEFORE
 * watcher.start so there is no race with armed timers — none exist yet.
 *
 * Best-effort : individual stat/unlink failures are logged at warn level
 * but never thrown, so a single permission glitch on one file can't abort
 * the daemon boot. An unreadable queueDir is also tolerated (warn + bail).
 *
 * Emits a single summary log line at the end with the count of removed
 * files, the human-readable threshold, and the total scanned.
 *
 * @param {object} opts
 * @param {string} opts.queueDir   absolute path to the queue directory
 * @param {number} opts.maxAgeMs   max mtime age in ms ; files older are removed
 * @returns {void}                 unlinks stale files and logs a summary
 */
function run({ queueDir, maxAgeMs }) {
	let names
	try {
		names = fs.readdirSync(queueDir)
	} catch (e) {
		log.warn(`[cleanup] cannot read ${queueDir}: ${e.message}`)
		return
	}

	const now           = Date.now()
	const ageHoursLabel = (maxAgeMs / 3_600_000).toFixed(2).replace(/\.?0+$/, '')
	let removed = 0

	for (const name of names) {
		if (!name.endsWith('.jsonl')) continue
		const file = path.join(queueDir, name)
		let mtimeMs
		try { mtimeMs = fs.statSync(file).mtimeMs }
		catch (e) { log.warn(`[cleanup] stat ${name} failed: ${e.message}`); continue }

		const ageMs = now - mtimeMs
		if (ageMs <= maxAgeMs) continue

		try {
			fs.unlinkSync(file)
			removed++
			const ageHours = (ageMs / 3_600_000).toFixed(1)
			log.info(`[cleanup] removed ${name} (mtime age = ${ageHours}h)`)
		} catch (e) {
			log.warn(`[cleanup] unlink ${name} failed: ${e.message}`)
		}
	}

	log.info(`[cleanup] ${removed} file(s) removed (threshold = ${ageHoursLabel}h, scanned ${names.length})`)
}

module.exports = { run }
