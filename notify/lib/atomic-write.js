// =============================================================================
// atomic-write — write a file via tmp + rename so readers never see a partial
// =============================================================================
//
// `fs.renameSync` is atomic on POSIX (rename(2)) and on Windows NTFS
// (MoveFileEx with MOVEFILE_REPLACE_EXISTING). A reader polling the target
// path therefore observes either the previous content or the new content —
// never a half-written byte buffer.
//
// Two callers today :
//   - index.js writes queue/.daemon.startup (channel readback)
//   - lib/state.js writes queue/state/pending.json (in-flight timer snapshot)
//
// Caller owns string formatting (JSON.stringify, newline-joined lines, etc.).
// =============================================================================

const fs = require('fs')

/**
 * Atomically replace `filePath` with `contents` via the standard tmp +
 * rename dance. Writes the bytes to `<filePath>.tmp` first, then renames
 * it onto the target. POSIX `rename(2)` and Windows `MoveFileEx` (called
 * by Node's `renameSync`) are atomic — a concurrent reader observes
 * either the previous content or the new content, never a partial write.
 *
 * Caller owns the string formatting (JSON.stringify, newline-joined lines,
 * etc.) — this helper is byte-level only.
 *
 * @param {string} filePath              absolute path to the file to write
 * @param {string|Buffer} contents       data to write (passed verbatim to fs.writeFileSync)
 * @returns {void}                       writes the file ; throws on filesystem errors
 */
function writeAtomic(filePath, contents) {
	const tmp = filePath + '.tmp'
	fs.writeFileSync(tmp, contents)
	// Windows NTFS occasionally throws EBUSY / EPERM / ENOENT on renameSync
	// when another process holds the target open (antivirus scan, a second
	// daemon flushing concurrently, Defender real-time scan). The contention
	// window is sub-second ; a tiny sync-spin retry survives it without
	// changing the function's sync contract. POSIX rename(2) doesn't surface
	// these codes — the loop is a no-op on Mac + native Linux.
	let attempts = 0
	while (true) {
		try { fs.renameSync(tmp, filePath); return }
		catch (e) {
			const transient = process.platform === 'win32'
				&& ['EBUSY', 'EPERM', 'ENOENT'].includes(e.code)
				&& attempts < 3
			if (!transient) throw e
			attempts++
			const until = Date.now() + 10
			while (Date.now() < until) { /* spin */ }
		}
	}
}

module.exports = { writeAtomic }
