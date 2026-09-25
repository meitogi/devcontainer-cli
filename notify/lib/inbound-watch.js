// =============================================================================
// inbound-watch — tail VS Code extension inbound JSONL → cancel signals
// =============================================================================
//
// Tails .devcontainer/tmp/logs/claude-code-vscode-ext-inbound.jsonl (written by
// the user-action observer patch in the Claude Code VS Code extension) and
// emits 'cancel:notification' on the bus when the user takes an action that
// makes a pending notif obsolete.
//
// SIGNAL TABLE (sessionId top-level on all useful events — no channelId map)
//
//   tool_permission_response (allow/deny) → cancel-permission for sessionId
//   interrupt_claude                      → cancel-all         for sessionId
//   io_message + payload.message.type=user→ cancel-all         for sessionId
//   launch_claude + payload.resume        → cancel-all         for payload.resume
//
// ADDITIVE / FALLBACK
//
//   The container-side hooks in skills/notify-queue/hook.js stay the canonical
//   cancel source. This module is purely ADDITIVE :
//     - With the extension patch active → cancels arrive ~50 ms after click,
//       faster than tool_finished (waits for tool to complete) or tail-cancel.js
//       (~2 s transcript scan).
//     - Without the extension patch (file absent) → this module logs a clear
//       fallback message and stays in standby. Container hooks cover ~90 % of
//       the cases like before.
//
// FILE LIFECYCLE
//
//   .devcontainer/post-start.sh `rm -f`s the file at every container start.
//   We watch the PARENT directory (not the file directly), so we survive the
//   rm/recreate cycle. Truncate / shrink → reset offset to 0.
// =============================================================================

const fs = require('fs')
const path = require('path')
const log = require('./log')

// -----------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// -----------------------------------------------------------------------------

/**
 * Wire the inbound watcher onto the bus. Idempotent for the daemon's
 * lifetime — index.js invokes once at boot. Fire-and-forget : returns
 * nothing. The watcher attaches to the PARENT directory (not the file
 * directly) so it survives the rm/recreate cycle that post-start.sh
 * performs at every container boot.
 *
 * On startup, seek to end-of-file (offset = file size) so backfill from
 * a prior container run is ignored — we only react to NEW events. If the
 * file is absent, log a clear fallback message and stay in standby ;
 * container-side hooks remain the canonical cancel source.
 *
 * @param {object} opts
 * @param {import('events').EventEmitter} opts.bus   receives 'cancel:notification' emits
 * @param {string} opts.logFile                      absolute path to the inbound JSONL
 * @returns {void}                                   fire-and-forget
 */
function start({ bus, logFile }) {
	let offset = 0
	let attached = false

	const tryAttach = () => {
		try {
			offset = fs.statSync(logFile).size       // skip backfill — we only react to NEW events
			attached = true
			log.info(`[inbound-watch] attached to ${logFile} (offset=${offset})`)
		} catch (_) {
			log.info(`[inbound-watch] ${logFile} absent — fallback to container-side cancel hooks (no click-level cancel signals)`)
		}
	}

	const parentDir = path.dirname(logFile)
	const baseName  = path.basename(logFile)

	try {
		fs.watch(parentDir, { persistent: true }, (_evt, name) => {
			if (name !== baseName) return
			if (!attached) { tryAttach(); return }   // file appeared mid-run
			drain(logFile, () => offset, (v) => { offset = v }, bus)
		})
	} catch (e) {
		log.warn(`[inbound-watch] cannot watch ${parentDir}: ${e.message} — disabled`)
		return
	}

	tryAttach()
}

// -----------------------------------------------------------------------------
// INTERNALS
// -----------------------------------------------------------------------------

/**
 * Read every newly-appended COMPLETE line since the last call, advance the
 * offset to the last full-line boundary, parse each JSONL line, and dispatch
 * to handleInbound(). Same byte-safe UTF-8 pattern as watcher.readNewLines :
 * the LF search runs on the raw Buffer (not a decoded string) so multi-byte
 * UTF-8 characters at the read boundary cannot corrupt the offset.
 *
 * Truncate handling : if `size < prev` (post-start.sh wipe, mid-run rm), reset
 * offset to 0 and bail this tick — the next change event will pick up from 0.
 * Partial-line tail (no LF in the new bytes) is left for the next tick.
 *
 * @param {string} logFile                    absolute path to the inbound JSONL
 * @param {() => number} getOffset            returns the last drained byte offset
 * @param {(v: number) => void} setOffset     persists the new byte offset
 * @param {import('events').EventEmitter} bus emit target for parsed events
 * @returns {void}                            advances offset, emits via handleInbound
 */
function drain(logFile, getOffset, setOffset, bus) {
	let size
	try { size = fs.statSync(logFile).size } catch (_) { return }
	const prev = getOffset()

	if (size < prev) {
		setOffset(0)
		log.info('[inbound-watch] file truncated — offset reset')
		return
	}
	if (size === prev) return

	let buf
	try {
		const fd = fs.openSync(logFile, 'r')
		buf = Buffer.alloc(size - prev)
		fs.readSync(fd, buf, 0, buf.length, prev)
		fs.closeSync(fd)
	} catch (e) {
		log.warn(`[inbound-watch] read ${logFile} failed: ${e.message}`)
		return
	}

	// 0x0A = LF. Search the BYTE buffer (multi-byte UTF-8 safe).
	const lastNlByte = buf.lastIndexOf(0x0A)
	if (lastNlByte < 0) return                      // no complete line yet
	setOffset(prev + lastNlByte + 1)

	const complete = buf.slice(0, lastNlByte).toString('utf8')
	for (const raw of complete.split('\n')) {
		if (!raw) continue
		let evt
		try { evt = JSON.parse(raw) }
		catch (e) {
			log.warn(`[inbound-watch] bad JSONL line: ${e.message}`)
			continue
		}
		handleInbound(evt, bus)
	}
}

/**
 * Dispatch one parsed inbound event. See the file-header SIGNAL TABLE for
 * the full mapping. All cancels are additive over the container-side hooks ;
 * a duplicate emit on a sid whose timer already fired is a harmless no-op.
 *
 * Emitted shape on the bus :
 *   { sid: string, kind: 'all' | 'permission', reason: string }
 *
 * Special case : `launch_claude` with `payload.resume` carries the sid in
 * `payload.resume`, NOT in top-level `sessionId` — the field doesn't exist
 * on launch events. Events without a resolvable sid are silently dropped.
 *
 * @param {object} evt   parsed JSONL event
 * @param {import('events').EventEmitter} bus   emit target
 * @returns {void}       may emit 0 or 1 'cancel:notification' events
 */
function handleInbound(evt, bus) {
	// launch_claude with resume = user re-opening an existing session. Special
	// path : the sid lives in payload.resume, NOT in top-level sessionId.
	if (evt.type === 'launch_claude' && evt.payload && evt.payload.resume) {
		const sid = evt.payload.resume
		log.info(`[inbound-watch] launch_claude resume ${sid.slice(0, 8)} — cancel-all`)
		bus.emit('cancel:notification', { sid, kind: 'all', reason: 'launch_claude/resume' })
		return
	}

	const sid = evt.sessionId
	if (!sid) return                                // ignore non-session noise

	if (evt.type === 'interrupt_claude') {
		log.info(`[inbound-watch] interrupt_claude ${sid.slice(0, 8)} — cancel-all`)
		bus.emit('cancel:notification', { sid, kind: 'all', reason: 'interrupt_claude' })
		return
	}

	if (evt.type === 'response') {
		const r = evt.payload && evt.payload.response
		if (r && r.type === 'tool_permission_response') {
			const behavior = (r.result && r.result.behavior) || '?'
			log.info(`[inbound-watch] tool_permission_response ${sid.slice(0, 8)} (${behavior}) — cancel-permission`)
			bus.emit('cancel:notification', { sid, kind: 'permission', reason: `tool_permission_response/${behavior}` })
		}
		return
	}

	// io_message + user text submission — redundant with the container-side
	// user_replied hook (UserPromptSubmit). Kept as a safety net : if that
	// hook misfires (settings corrupt, container killed mid-write, etc.) the
	// inbound log still surfaces the signal. If the container hook fires first
	// and clears the timer, the second cancel here is a harmless no-op.
	if (evt.type === 'io_message') {
		const m = evt.payload && evt.payload.message
		if (m && m.type === 'user') {
			log.info(`[inbound-watch] io_message user ${sid.slice(0, 8)} — cancel-all (fallback for user_replied)`)
			bus.emit('cancel:notification', { sid, kind: 'all', reason: 'io_message/user' })
		}
	}
}

module.exports = { start }
