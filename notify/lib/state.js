// =============================================================================
// state — daemon-owned runtime state files for future tooling
// =============================================================================
//
// Surfaces two persistent files under queue/state/ so external consumers
// (status bars, dashboards, "what's pending right now" CLIs) can poll / watch
// the daemon's decisions without scraping daemon.log :
//
//   queue/state/pending.json   live snapshot of in-flight timers. Rewritten
//                              atomically on every ARM / REPLACE / CANCEL /
//                              FIRE. Reset to `pending: []` at boot.
//
//   queue/state/actions.jsonl  audit log of every outcome the watcher decides
//                              on. Truncated at boot (current daemon lifetime
//                              only), append-only during the run. One JSON
//                              object per line.
//
// LIFECYCLE
//   - init() at boot mkdir's queue/state/, writes an empty pending.json, and
//     truncates actions.jsonl to zero bytes. Both files reflect the CURRENT
//     daemon lifetime — historic actions from previous runs are dropped to
//     keep the file size bounded without a rotation policy.
//   - watcher.js calls armed() / replaced() / cancelled() / fired() /
//     unmapped() at the 5 decision points inside handleLine() + the external
//     bus.on('cancel:notification') handler.
//   - No rotation today. Out of scope until a real consumer asks for it.
//
// SCHEMAS (see notify/README.md for the human-readable doc)
//   pending.json :
//     { updated_at, pid, pending: [{ sid, eventType, armed_at, fire_at, delay_ms, payload }, …] }
//   actions.jsonl line :
//     { ts, action, sid, eventType, …action-specific keys }
//
//   `payload` is the raw parsed JSONL `line` from notify-queue/hook.js
//   buildLine — carries tool_name / tool_input / session_name /
//   last_message_excerpt / message / notification_type … per eventType.
//   Present on `armed` and `replaced` (pending.json + audit line) ; omitted
//   on `cancelled` / `fired` / `unmapped` (the matching `armed` is
//   searchable by sid + ts).
// =============================================================================

const fs = require('fs')
const path = require('path')
const { writeAtomic } = require('./atomic-write')

let pendingPath = ''
let actionsPath = ''
let ownPid      = 0
const pendingMap = new Map()  // sid → { sid, eventType, armed_at, fire_at, delay_ms, payload? }

/**
 * Boot the state module. Resolves the on-disk paths under queue/state/,
 * mkdir's the directory, clears the in-memory pendingMap, writes a fresh
 * empty pending.json and truncates actions.jsonl. Both files reflect the
 * CURRENT daemon lifetime only — historic actions from previous runs are
 * intentionally dropped to keep file size bounded without a rotation policy.
 *
 * @param {object} opts
 * @param {string} opts.queueDir   absolute path to the daemon's queue directory
 * @param {number} opts.pid        the daemon's own PID, recorded in pending.json
 * @returns {void}                 initialises module-level state
 */
function init({ queueDir, pid }) {
	ownPid      = pid
	const stateDir = path.join(queueDir, 'state')
	pendingPath = path.join(stateDir, 'pending.json')
	actionsPath = path.join(stateDir, 'actions.jsonl')
	fs.mkdirSync(stateDir, { recursive: true })
	pendingMap.clear()
	flushPending()
	// Truncate the action log to a fresh 0-byte file. Avoids unbounded growth
	// across daemon respawns and matches the pending.json semantics (both
	// files reflect the CURRENT daemon lifetime only).
	fs.writeFileSync(actionsPath, '')
}

/**
 * Current UTC time as an ISO 8601 string. Centralised so every state mutation
 * uses the same `Date.now()` resolution.
 *
 * @returns {string} `YYYY-MM-DDTHH:mm:ss.sssZ`
 */
function nowIso() {
	return new Date().toISOString()
}

/**
 * Atomically rewrite pending.json from the current pendingMap snapshot.
 * Called on every ARM / REPLACE / CANCEL / FIRE so external consumers
 * (status bars, dashboards) always observe a consistent state.
 *
 * @returns {void} writes pending.json via writeAtomic (tmp + rename)
 */
function flushPending() {
	const body = {
		updated_at: nowIso(),
		pid:        ownPid,
		pending:    [...pendingMap.values()]
	}
	writeAtomic(pendingPath, JSON.stringify(body, null, 2) + '\n')
}

/**
 * Append one JSON line to actions.jsonl with an auto-prepended `ts` field.
 * Plain appendFileSync — single-writer (the daemon) makes locking unneeded.
 *
 * @param {object} entry   action-specific keys; `ts` is prepended automatically
 * @returns {void}         appends one JSONL line to actions.jsonl
 */
function appendAction(entry) {
	fs.appendFileSync(actionsPath, JSON.stringify({ ts: nowIso(), ...entry }) + '\n')
}

/**
 * Record a freshly-armed in-flight timer. Stores it in pendingMap, flushes
 * pending.json, and emits an `armed` audit line. fire_at is computed from
 * the caller-provided delay (now + delayMs).
 *
 * @param {object} evt
 * @param {string} evt.sid         session ID (Claude Code session UUID or short form)
 * @param {string} evt.eventType   event class label (e.g. 'permission_request')
 * @param {number} evt.delayMs     debounce delay in ms; fire_at = now + delayMs
 * @param {object} [evt.payload]   raw parsed JSONL `line` (notify-queue/hook.js buildLine).
 *                                 Mirrored into pending.json and the audit line so an external
 *                                 consumer can render / route from state alone.
 * @returns {void}                 mutates pendingMap, flushes pending.json, appends to actions.jsonl
 */
function armed({ sid, eventType, delayMs, payload }) {
	const armed_at = nowIso()
	const fire_at  = new Date(Date.now() + delayMs).toISOString()
	pendingMap.set(sid, { sid, eventType, armed_at, fire_at, delay_ms: delayMs, payload })
	flushPending()
	appendAction({ action: 'armed', sid, eventType, delayMs, fireAt: fire_at, payload })
}

/**
 * Replace an existing in-flight timer with a new event type for the same sid.
 * Used by the debounce/upgrade path in watcher.handleLine() when a higher-
 * priority event class arrives before the previous one fires.
 *
 * @param {object} evt
 * @param {string} evt.sid              session ID
 * @param {string} evt.prevEventType    event class previously armed for this sid
 * @param {string} evt.newEventType     event class taking over
 * @param {number} evt.delayMs          debounce delay in ms for the new timer
 * @param {object} [evt.payload]        raw parsed JSONL `line` for the NEW event ; mirrored into
 *                                      pending.json and the audit line (overrides the prior payload).
 * @returns {void}                      mutates pendingMap, flushes pending.json, appends to actions.jsonl
 */
function replaced({ sid, prevEventType, newEventType, delayMs, payload }) {
	const armed_at = nowIso()
	const fire_at  = new Date(Date.now() + delayMs).toISOString()
	pendingMap.set(sid, { sid, eventType: newEventType, armed_at, fire_at, delay_ms: delayMs, payload })
	flushPending()
	appendAction({ action: 'replaced', sid, prevEventType, newEventType, delayMs, fireAt: fire_at, payload })
}

/**
 * Record a cancellation (timer never fires). The cause label categorises why
 * (e.g. 'tool_finished', 'container:gone', 'inbound:cancel'). Extra keys are
 * spread into the audit line for downstream debugging.
 *
 * @param {object} evt
 * @param {string} evt.sid         session ID
 * @param {string} evt.eventType   event class being cancelled
 * @param {string} evt.cause       short cancellation reason label
 * @param {object} [evt.extras]    additional keys (rest-spread) to record in the audit line
 * @returns {void}                 removes from pendingMap, flushes pending.json, appends to actions.jsonl
 */
function cancelled({ sid, eventType, cause, ...extras }) {
	pendingMap.delete(sid)
	flushPending()
	appendAction({ action: 'cancelled', sid, eventType, cause, ...extras })
}

/**
 * Record that a timer fired and notified. The corresponding pendingMap entry
 * is removed so the next pending.json snapshot reflects the post-fire state.
 *
 * @param {object} evt
 * @param {string} evt.sid         session ID
 * @param {string} evt.eventType   event class that fired
 * @returns {void}                 removes from pendingMap, flushes pending.json, appends to actions.jsonl
 */
function fired({ sid, eventType }) {
	pendingMap.delete(sid)
	flushPending()
	appendAction({ action: 'fired', sid, eventType })
}

/**
 * Record an unmapped event (no channel routing matched). pendingMap is left
 * untouched — no timer was ever armed for this event.
 *
 * @param {object} evt
 * @param {string} evt.sid         session ID
 * @param {string} evt.eventType   event class that had no channel mapping
 * @returns {void}                 appends one 'unmapped' line to actions.jsonl
 */
function unmapped({ sid, eventType }) {
	appendAction({ action: 'unmapped', sid, eventType })
}

/**
 * Record an event dropped as a duplicate of the timer already pending for
 * this sid. pendingMap is left untouched — the pending timer keeps running
 * with its original fire_at.
 *
 * @param {object} evt
 * @param {string} evt.sid                session ID
 * @param {string} evt.eventType          event class that was dropped
 * @param {string} evt.pendingEventType   event class holding the pending timer
 * @returns {void}                        appends one 'suppressed' line to actions.jsonl
 */
function suppressed({ sid, eventType, pendingEventType }) {
	appendAction({ action: 'suppressed', sid, eventType, pendingEventType })
}

module.exports = { init, armed, replaced, cancelled, fired, unmapped, suppressed }
