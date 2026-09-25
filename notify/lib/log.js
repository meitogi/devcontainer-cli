// Shared logger — append-only to daemon.log, also mirrored to stderr.
// On startup, truncate to last 100 KB if file > 1 MB (cheap rotation).
const fs = require('fs')

let logFile = null

/**
 * Initialise the shared logger. Captures the absolute log path so subsequent
 * line() calls append to it, and performs a one-shot rotation : if the file
 * already exceeds 1 MB at startup, the tail 100 KB is kept and the rest
 * discarded. Cheap implementation on purpose — read-buffer + truncating
 * write — because the daemon only respawns occasionally and a full log
 * rotation framework would be overkill.
 *
 * Idempotent across the daemon's lifetime — call it once from index.js
 * before any other lib emits log lines.
 *
 * @param {string} file   absolute path to daemon.log
 * @returns {void}        sets the module-level logFile and may rotate
 */
function init(file) {
	logFile = file
	try {
		const s = fs.statSync(file)
		if (s.size > 1024 * 1024) {
			const buf = fs.readFileSync(file)
			fs.writeFileSync(file, buf.slice(buf.length - 100 * 1024))
			line('info', '[log] rotated daemon.log (kept last 100 KB)')
		}
	} catch (_) { /* file may not exist yet — first write creates it */ }
}

/**
 * Emit one log line at the requested level. Format :
 *   `<ISO-8601 ts> [<level>] <msg>\n`
 *
 * After init() has run, the line is appended to the configured logFile
 * ONLY — not also mirrored to stderr. The reason : initialize.sh redirects
 * the daemon's stderr to the same log file (`>> "$logfile" 2>&1`), so
 * mirroring would duplicate every entry. Before init() runs, or in
 * direct-test contexts with no logFile, falls back to process.stderr so
 * the line isn't lost.
 *
 * Append failures are swallowed — the daemon must never crash on a log
 * I/O hiccup (full disk, ENOSPC, momentary permission loss).
 *
 * @param {string} level   short label rendered inside `[]` (e.g. 'info', 'warn', 'error')
 * @param {string} msg     log message body
 * @returns {void}         writes one line, never throws
 */
function line(level, msg) {
	const out = `${new Date().toISOString()} [${level}] ${msg}\n`
	// Si init() a tourné on n'écrit qu'au fichier — initialize.sh redirige
	// déjà stderr vers ce même fichier (`>> "$logfile" 2>&1`), donc dupliquer
	// via process.stderr.write produit chaque ligne 2× dans daemon.log.
	// Fallback stderr seulement si pas de logFile (test direct hors daemon).
	if (logFile) {
		try { fs.appendFileSync(logFile, out) } catch (_) { /* swallow — never crash on log failure */ }
	} else {
		process.stderr.write(out)
	}
}

module.exports = {
	init,
	info:  (msg) => line('info',  msg),
	warn:  (msg) => line('warn',  msg),
	error: (msg) => line('error', msg)
}
