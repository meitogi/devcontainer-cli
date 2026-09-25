// =============================================================================
// watcher — JSONL queue tail + per-session timer/debounce
// =============================================================================
//
// Sole producer of 'send:notification' on the bus. Reads
// .devcontainer/tmp/notify/*.jsonl incrementally, parses each event, arms a
// timer per session id, and emits when the timer fires.
//
// SESSION-LEVEL DEBOUNCE
//   Every Claude session has a `sid`. The watcher keeps at most ONE pending
//   timer per sid. Two events lead to the timer being cleared :
//
//     1. A `user_replied` event for that sid arrives BEFORE the timer fires
//        → see handleLine(), 'user_replied' branch. The notif is suppressed
//        entirely : it never reaches the bus, no channel sees it.
//
//     2. A new triggering event for the same sid arrives BEFORE the timer
//        fires → the pending timer is cleared and replaced by a fresh one
//        based on the new event ("latest wins"). Avoids double-notifs when
//        e.g. a stop is followed by another stop within 30 s.
//
//   POST-FIRE REMOVE is NOT supported in this version. Once the timer has
//   fired and a notif is on screen, a later `user_replied` cannot retract
//   it. Reason: macOS osascript / Windows WinRT raw toast don't expose a
//   reliable remove-by-id API without bringing in `terminal-notifier` or
//   BurntToast. Acceptable tradeoff given the delays (5-30 s) are usually
//   long enough to debounce the common follow-up case.
//
// JSONL SCHEMA (set by .devcontainer/skills/notify-queue/hook.js, session 1)
//   Every line is a JSON object with at least { ts, sid, event }. Per-event :
//     stop                → last_message_excerpt
//     notification        → notification_type, message
//     permission_request  → tool_name, tool_input, tool_use_id?
//     user_replied        → (no extras — cancel signal only)
//
// BUS PAYLOAD shape emitted on 'send:notification' (intentionally raw —
// channels own their formatting per event type) :
//   {
//     id:        string (monotonic, "evt-<N>" — daemon-lifetime unique),
//     sid:       string,
//     eventType: 'stop' | 'permission_request' | 'idle_prompt' |
//                'permission_prompt' | 'elicitation_dialog',
//     ts:        ISO string (from the JSONL line, else stamped now),
//     line:      the original parsed JSONL object
//   }
// The `notification` super-event is flattened into its subtype so each
// channel can key its TEMPLATES table on a single flat eventType.
//
// EVENT LIFECYCLE (custom consumers — see README "Custom timer" section) :
//   'receive:notification'    → fired immediately when an event passes the
//                                unmapped-eventType filter, BEFORE the
//                                EVENT_DELAYS_MS timer arms. Payload :
//                                { id, eventType, payload, receivedAt }.
//                                Use this to start your own timer with custom
//                                debounce policy.
//   'send:notification'       → fired AFTER the EVENT_DELAYS_MS timer expires.
//                                Standard consumers (notifier, sound, flash-win,
//                                discord) act here. Carries the same `id` as
//                                the earlier 'receive:notification', so a
//                                custom consumer can correlate.
//   'cancelled:notification'  → fired when a pending timer is cleared before
//                                firing (user_replied, tool_*, latest-wins
//                                replace, or out-of-band 'cancel:notification').
//                                Payload : { id, eventType, reason }. Use this
//                                to abort your own custom timer for the same id.
// =============================================================================

const fs = require('fs')
const path = require('path')
const log = require('./log')

// Daemon-lifetime-unique event id. Monotonic counter prefixed for readable
// log lines ("evt-1", "evt-2", …). Resets on daemon restart — IDs only need
// to correlate receive / cancelled / send within one daemon process.
let _eventCounter = 0
const nextEventId = () => `evt-${++_eventCounter}`

// -----------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// -----------------------------------------------------------------------------

/**
 * Wire the watcher onto the bus. Sole producer of 'send:notification'.
 * Idempotent for the lifetime of the daemon process — index.js calls
 * once at boot.
 *
 * Setup steps :
 *   1. suppressBackfill() — set each existing *.jsonl's offset to its
 *      current size so we don't replay history.
 *   2. fs.watch() the queue directory ; on every change, drain new lines
 *      via readNewLines() and feed each to handleLine().
 *   3. Subscribe to 'cancel:notification' so out-of-band sources
 *      (inbound-watch) can cancel pending timers without exposing the
 *      internal `timers` map.
 *
 * The `state` module is OPTIONAL — passing it mirrors each handleLine()
 * decision into queue/state/pending.json + queue/state/actions.jsonl. Tests
 * that don't care about the audit files can omit it.
 *
 * @param {object} opts
 * @param {import('events').EventEmitter} opts.bus    receives 'send:notification' on each fire ; observed for 'cancel:notification'
 * @param {string} opts.queueDir                      absolute path to .devcontainer/tmp/notify/
 * @param {Object<string, number>} opts.delays        event-type → delay in ms (EVENT_DELAYS_MS)
 * @param {object} [opts.state]                       optional state-tracking module from lib/state.js
 * @returns {void}                                    starts watching, returns immediately
 */
function start({ bus, queueDir, delays, state }) {
	const offsets = new Map()   // file path  → last-read byte offset
	const timers  = new Map()   // session id → { timeout, eventType, payload }

	suppressBackfill(queueDir, offsets)

	fs.watch(queueDir, { persistent: true }, (_eventType, name) => {
		if (!name || !name.endsWith('.jsonl')) return
		const file = path.join(queueDir, name)
		for (const line of readNewLines(file, offsets)) {
			handleLine(line, { timers, bus, delays, state })
		}
	})

	// External cancel channel — used by lib/inbound-watch.js to cancel pending
	// timers from out-of-band signals (VS Code clicks, interrupts). Kept inside
	// the closure so it shares the same `timers` map without exposing it. The
	// container-side cancel paths in handleLine() (user_replied, tool_*) keep
	// firing independently — this is purely additive.
	bus.on('cancel:notification', ({ sid, kind, reason }) => {
		const pending = timers.get(sid)
		if (!pending) {
			// No pending timer — banner may already be dispatched (user took
			// >30s to click, so the timer fired first). Emit post-fire cancel
			// so notify-app can dismiss the delivered banner via `notif remove`.
			// No `kind === 'permission'` filter here : under the "1 banner per
			// sid" invariant only one banner exists, so any user action on the
			// sid legitimately dismisses it regardless of what event fired it.
			bus.emit('cancelled:notification', { sid, eventType: null, reason: `inbound-post-fire:${reason}` })
			return
		}
		if (kind === 'permission'
		 && pending.eventType !== 'permission_request'
		 && pending.eventType !== 'permission_prompt') return
		clearTimeout(pending.timeout)
		timers.delete(sid)
		log.info(`[watcher] cancel:notification ${sid.slice(0, 8)} — ${pending.eventType} cancelled (${reason})`)
		state?.cancelled({ sid, eventType: pending.eventType, cause: 'cancel:notification', kind, reason })
		// Include `sid` so notify-app.js can look up its `dispatched` map. Pre-fire
		// there's nothing dispatched yet, but keeping the shape consistent with
		// the post-fire emit above avoids future footguns.
		bus.emit('cancelled:notification', { id: pending.id, sid, eventType: pending.eventType, reason: `inbound:${reason}` })
	})

	log.info(`[watcher] watching ${queueDir} (delays: ${JSON.stringify(delays)})`)
}

// -----------------------------------------------------------------------------
// INTERNALS
// -----------------------------------------------------------------------------

/**
 * Set the read offset of every pre-existing `*.jsonl` to its current size so
 * the next readNewLines() call has nothing to replay. Critical for boot
 * correctness : without this, after a long container-down period the daemon
 * would dump dozens of stale notifs at once when it restarts.
 *
 * Best-effort : individual stat failures are silently ignored (the file may
 * disappear between readdir and stat), and an unreadable queueDir surfaces
 * as a warn log without throwing.
 *
 * @param {string} queueDir                 absolute path to the queue directory
 * @param {Map<string, number>} offsets     in-memory file-path → byte offset map (mutated)
 * @returns {void}                          populates offsets and logs a summary
 */
function suppressBackfill(queueDir, offsets) {
	try {
		for (const name of fs.readdirSync(queueDir)) {
			if (!name.endsWith('.jsonl')) continue
			const file = path.join(queueDir, name)
			try { offsets.set(file, fs.statSync(file).size) } catch (_) {}
		}
		log.info(`[watcher] backfill suppressed for ${offsets.size} existing file(s)`)
	} catch (e) {
		log.warn(`[watcher] cannot read ${queueDir}: ${e.message}`)
	}
}

/**
 * Read every newly-appended COMPLETE line in `file` since the last call,
 * advance the offset, and return the parsed JSON objects (malformed lines
 * are warn-logged and dropped). A trailing partial line — bytes written
 * since the last LF — is left for the next change event ; the offset only
 * advances past the last LF observed.
 *
 * Truncate / rotate detection : when `size < prev`, the file was wiped or
 * replaced ; reset the offset to 0 and bail. The next change event will
 * pick up from byte 0 cleanly.
 *
 * UTF-8 safety : offsets are tracked in BYTES, not JS string indices.
 * Multi-byte chars (`…` = 3 bytes, emoji = 4 bytes) would corrupt the
 * offset if we used `.toString('utf8').lastIndexOf('\n')` — JS strings are
 * UTF-16 code units and the indices don't match the UTF-8 byte count of
 * the consumed prefix. The LF search runs on the raw Buffer and only the
 * complete-line slice is decoded ; any trailing partial bytes (which may
 * sit mid-character) stay in the file for the next read.
 *
 * @param {string} file                     absolute path to the *.jsonl
 * @param {Map<string, number>} offsets     in-memory file-path → byte offset map (mutated)
 * @returns {Array<object>}                 parsed JSONL events, empty array on no-new-data / read failure
 */
function readNewLines(file, offsets) {
	let size
	try { size = fs.statSync(file).size } catch (_) { return [] }
	const prev = offsets.get(file) || 0

	if (size <= prev) {
		if (size < prev) offsets.set(file, 0) // file was truncated / replaced
		return []
	}

	let buf
	try {
		const fd = fs.openSync(file, 'r')
		buf = Buffer.alloc(size - prev)
		fs.readSync(fd, buf, 0, buf.length, prev)
		fs.closeSync(fd)
	} catch (e) {
		log.warn(`[watcher] read ${file} failed: ${e.message}`)
		return []
	}

	// 0x0A = LF newline. Search the BYTE buffer, not the decoded string.
	const lastNlByte = buf.lastIndexOf(0x0A)
	if (lastNlByte < 0) return []  // no complete line yet — wait for next change
	offsets.set(file, prev + lastNlByte + 1)

	// Decode ONLY the complete-line slice. Any trailing partial bytes
	// (which may sit mid-character) are left in the file for the next
	// read to pick up cleanly from byte `prev + lastNlByte + 1`.
	const completeText = buf.slice(0, lastNlByte).toString('utf8')
	return completeText.split('\n').filter(Boolean).map((raw) => {
		try { return JSON.parse(raw) } catch (e) {
			log.warn(`[watcher] bad JSONL line in ${path.basename(file)}: ${e.message}`)
			return null
		}
	}).filter(Boolean)
}

/**
 * Apply one parsed JSONL event to the timer map. Six decision branches
 * (each mirrored into state.js for the audit log) :
 *
 *   1. CANCEL — `user_replied` clears any pending timer for this sid.
 *      The user is back, every queued notif is now obsolete.
 *   2. CANCEL — `tool_started` / `tool_finished` / `tool_cancelled` clear
 *      pending permission_request / permission_prompt timers only. Other
 *      event classes (Stop / Idle) stay armed because the tool lifecycle
 *      doesn't tell us the user is engaging more broadly.
 *   3. UNMAPPED — eventType has no entry in `delays` ; logged + audited,
 *      no timer change.
 *   4. SUPPRESS — `permission_prompt` arriving while a `permission_request`
 *      is pending for the same sid ; dropped as a duplicate of the same
 *      dialog (see the branch comment), no timer change.
 *   5. REPLACE — a pending timer for this sid already exists ; clear it
 *      and arm a fresh one based on the new event ("latest wins").
 *   6. ARM — no previous timer ; setTimeout(delays[type]) and store.
 *
 * The raw parsed `line` is passed as `payload` into `state.armed` and
 * `state.replaced` so pending.json + actions.jsonl expose the full
 * notification payload to external consumers, not just the timer
 * bookkeeping.
 *
 * The `notification` super-event is flattened to its `notification_type`
 * sub-string (idle_prompt / permission_prompt / elicitation_dialog) so
 * the rest of the pipeline only sees flat event types.
 *
 * @param {object} line                          parsed JSONL event
 * @param {string} line.sid                      session UUID
 * @param {string} line.event                    raw event class from the hook
 * @param {object} ctx
 * @param {Map<string, { timeout: any, eventType: string, payload: object }>} ctx.timers
 *                                               per-sid pending timer registry (mutated)
 * @param {import('events').EventEmitter} ctx.bus   target for the deferred 'send:notification'
 * @param {Object<string, number>} ctx.delays    event-type → delay in ms
 * @param {object} [ctx.state]                   optional state-tracking module from lib/state.js
 * @returns {void}                               may arm / replace / cancel a timer ; emits later via setTimeout
 */
function handleLine(line, { timers, bus, delays, state }) {
	const { sid, event } = line
	if (!sid || !event) return

	const sid8 = sid.slice(0, 8)

	// --- CANCEL PATH (user_replied) ---
	// user_replied = the user submitted a new prompt. ANY pending notif
	// (Stop / Permission / Idle) is now obsolete — the user is back.
	if (event === 'user_replied') {
		const pending = timers.get(sid)
		if (pending) {
			clearTimeout(pending.timeout)
			timers.delete(sid)
			log.info(`[watcher] user_replied   ${sid8} — CANCELLED pending ${pending.eventType}`)
			state?.cancelled({ sid, eventType: pending.eventType, cause: 'user_replied' })
			bus.emit('cancelled:notification', { id: pending.id, sid, eventType: pending.eventType, reason: 'user_replied' })
		} else {
			log.info(`[watcher] user_replied   ${sid8} — no pending timer (already fired or never armed) — signalling post-fire cancel to consumers`)
			// Post-fire cancel : the notif already fired ; consumers (notify-app)
			// maintain their own "dispatched" state to dismiss the delivered banner.
			// Without this bus emission, `notif remove` never fires and the
			// banner lingers in Notification Center until the user swipes it.
			bus.emit('cancelled:notification', { sid, eventType: null, reason: 'user_replied' })
		}
		return
	}

	// --- CANCEL PATH (tool lifecycle signals) ---
	// Three events signal "user resolved the permission dialog" :
	//   tool_started   — PreToolUse fires before the tool runs. Empirically
	//                    fires BEFORE PermissionRequest in Claude Code, so
	//                    by itself it's too early. Kept as a no-op safeguard.
	//   tool_finished  — PostToolUse fires after the tool completes (Allow
	//                    path only — PostToolUse doesn't fire on Cancel).
	//                    Latency = tool execution duration ; for slow tools
	//                    this can exceed our perm delay.
	//   tool_cancelled — synthetic event written by tail-cancel.js (skill
	//                    side) when the transcript shows "user rejected"
	//                    pattern. Catches the Cancel path within ~2 s of
	//                    click — the only way since Claude Code has no
	//                    "PermissionDenied" hook.
	//
	// All three cancel pending perm-related timers for this sid. Other
	// event types (Stop, Idle) stay armed — they signal user inactivity,
	// which the click doesn't override.
	if (event === 'tool_started' || event === 'tool_finished' || event === 'tool_cancelled') {
		const pending = timers.get(sid)
		if (pending && (pending.eventType === 'permission_request' || pending.eventType === 'permission_prompt')) {
			clearTimeout(pending.timeout)
			timers.delete(sid)
			log.info(`[watcher] ${event.padEnd(14)} ${sid8} — CANCELLED pending ${pending.eventType}`)
			state?.cancelled({ sid, eventType: pending.eventType, cause: event })
			bus.emit('cancelled:notification', { id: pending.id, sid, eventType: pending.eventType, reason: event })
		} else if (event === 'tool_cancelled' || event === 'tool_finished') {
			// Post-fire cancel : the permission notif already fired and the user
			// closed the loop — either by denying (`tool_cancelled` via
			// tail-cancel.js's transcript scan) or by approving+running the tool
			// to completion (`tool_finished` via PostToolUse). Either way the
			// banner is stale and must be dismissed via `notif remove` to keep
			// the "1 delivered banner per sid" invariant.
			// `tool_started` (PreToolUse) stays a no-op : it fires while the user
			// is still deciding, and dismissing then would kill the banner
			// mid-decision.
			bus.emit('cancelled:notification', { sid, eventType: null, reason: event })
		}
		return
	}

	// Flatten the `notification` super-event into its sub-types so channels
	// can key their templates on a single flat string (idle_prompt /
	// permission_prompt / elicitation_dialog / stop / permission_request).
	const eventType = (event === 'notification') ? (line.notification_type || 'notification') : event

	const delayMs = delays[eventType]
	if (typeof delayMs !== 'number') {
		log.info(`[watcher] ${event.padEnd(14)} ${sid8} — unmapped eventType "${eventType}", skipped`)
		state?.unmapped({ sid, eventType })
		return
	}

	// --- SUPPRESS PATH (duplicate permission signal) ---
	// Claude Code emits TWO events for a single permission dialog : the
	// `PermissionRequest` hook at T+0 (tool_name + tool_input + tool_use_id)
	// and a generic `Notification` / permission_prompt ~6 s later, carrying
	// only "Claude needs your permission to use X". Under "latest wins" the
	// generic one always displaced the rich one, so the banner that actually
	// fired lost the smart-text body, lost the Allow button (gated on
	// tool_use_id in notify-app.js, absent from the Notification payload)
	// and restarted its delay from T+6.
	//
	// permission_prompt stays armable on its own — it's the fallback when
	// PermissionRequest doesn't fire — it just no longer displaces a richer
	// permission_request already pending for the same sid.
	if (eventType === 'permission_prompt') {
		const pending = timers.get(sid)
		if (pending && pending.eventType === 'permission_request') {
			log.info(`[watcher] permission_prompt ${sid8} — SUPPRESSED, richer permission_request already pending`)
			state?.suppressed({ sid, eventType, pendingEventType: pending.eventType })
			return
		}
	}

	// --- ARM / REPLACE PATH ---
	// Mint the event id first so receive:notification fires with it BEFORE
	// any cancellation of a prior pending timer (consumers expect the
	// new event's receive: before the prior event's cancelled:).
	const id = nextEventId()
	const ts = line.ts || new Date().toISOString()
	const payload = { id, sid, eventType, ts, line }

	bus.emit('receive:notification', { id, eventType, payload, receivedAt: Date.now() })

	// Drop any previous pending timer for this sid (latest wins).
	const existing = timers.get(sid)
	if (existing) {
		clearTimeout(existing.timeout)
		log.info(`[watcher] ${eventType.padEnd(14)} ${sid8} — REPLACED previous ${existing.eventType} timer`)
		state?.replaced({ sid, prevEventType: existing.eventType, newEventType: eventType, delayMs, payload: line })
		bus.emit('cancelled:notification', { id: existing.id, sid, eventType: existing.eventType, reason: `replaced-by-${eventType}` })
	} else {
		state?.armed({ sid, eventType, delayMs, payload: line })
	}

	const timeout = setTimeout(() => {
		timers.delete(sid)
		log.info(`[watcher] FIRE ${eventType.padEnd(9)} ${sid8} — emitting send:notification`)
		state?.fired({ sid, eventType })
		bus.emit('send:notification', payload)
	}, delayMs)
	timeout.unref?.()
	timers.set(sid, { timeout, eventType, payload, id })

	log.info(`[watcher] ${eventType.padEnd(14)} ${sid8} — ARMED ${delayMs}ms timer (id=${id})`)
}

module.exports = { start }
