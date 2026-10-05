#!/usr/bin/env node
// watcher-perm-dedup.test.js — the permission_prompt SUPPRESS branch.
//
// Claude Code emits two events per permission dialog : the rich
// `PermissionRequest` hook at T+0, then a generic `Notification` /
// permission_prompt ~6 s later. "Latest wins" used to let the generic one
// displace the rich one, so the banner that fired carried
// "Claude needs your permission to use Bash" instead of the smart-text line,
// and lost its Allow button (gated on tool_use_id, absent from the
// Notification payload).
//
// Four cases, driven through the real fs.watch queue loop :
//
//   A. permission_request then permission_prompt → prompt suppressed, the
//      request fires with tool_name / tool_input / tool_use_id intact.
//   B. permission_prompt alone → still arms and fires (fallback preserved).
//   C. permission_prompt over a pending `stop` → still replaces (the guard
//      is narrow, it only defends permission_request).
//   D. permission_prompt after the request already fired → arms normally,
//      nothing pending to protect.
//
// Run : node .devcontainer/notify/tests/watcher-perm-dedup.test.js
// Exits 0 on success ; throws + non-zero on failure.

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { EventEmitter } = require('events')

// -----------------------------------------------------------------------------
// Stub the shared logger BEFORE watcher is required, and keep its lines —
// the SUPPRESSED branch is asserted on its log output too.

const infos = []
const logPath = require.resolve('../lib/log')
require.cache[logPath] = {
	id: logPath, filename: logPath, loaded: true,
	exports: {
		init:  () => {},
		info:  (m) => infos.push(m),
		warn:  (m) => infos.push(m),
		error: (m) => infos.push(m),
	},
}

const watcher = require('../lib/watcher')

// -----------------------------------------------------------------------------
// Harness.

const QUEUE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-perm-dedup-'))

// Short enough to keep the suite under a couple of seconds, long enough that
// the two events of a pair always land while the first timer is still armed
// (mirrors the production 30 000 ms delay vs the ~6 s inter-event gap).
const DELAY_MS = 400
const DELAYS = { permission_request: DELAY_MS, permission_prompt: DELAY_MS, stop: DELAY_MS }

const bus   = new EventEmitter()
const fired = []
bus.on('send:notification', (p) => fired.push(p))

// Same call shape as watcher.handleLine's `state?.x({...})` sites.
const stateCalls = []
const state = {
	armed:      (e) => stateCalls.push({ action: 'armed',      ...e }),
	replaced:   (e) => stateCalls.push({ action: 'replaced',   ...e }),
	cancelled:  (e) => stateCalls.push({ action: 'cancelled',  ...e }),
	fired:      (e) => stateCalls.push({ action: 'fired',      ...e }),
	unmapped:   (e) => stateCalls.push({ action: 'unmapped',   ...e }),
	suppressed: (e) => stateCalls.push({ action: 'suppressed', ...e }),
}

let seq = 0

/** Append one JSONL event to this sid's queue file, as hook.js would. */
function emit(sid, line) {
	seq++
	const full = { ts: new Date().toISOString(), sid, notif_id: `test-${seq}`, ...line }
	fs.appendFileSync(path.join(QUEUE_DIR, `${sid}.jsonl`), JSON.stringify(full) + '\n')
}

const permissionRequest = { event: 'permission_request', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'req-42' }
const permissionPrompt  = { event: 'notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** Poll `fn` every 20 ms until truthy or `timeout` elapses. */
async function waitFor(fn, timeout = 3000) {
	const deadline = Date.now() + timeout
	while (Date.now() < deadline) {
		if (fn()) return true
		await sleep(20)
	}
	return false
}

/** Events the watcher has acted on for this sid, in order. */
const actionsFor  = (sid) => stateCalls.filter(e => e.sid === sid)
/** Banners actually dispatched for this sid. */
const bannersFor  = (sid) => fired.filter(p => p.sid === sid)

// -----------------------------------------------------------------------------

async function main() {
	watcher.start({ bus, queueDir: QUEUE_DIR, delays: DELAYS, state })
	// fs.watch registration is synchronous, but give the event loop a tick
	// before the first append so no write races the watcher's first read.
	await sleep(50)

	// --- A. the production sequence : rich event first, generic 6 s later ---
	const sidA = 'aaaaaaaa-0000-0000-0000-000000000001'
	emit(sidA, permissionRequest)
	assert.ok(await waitFor(() => actionsFor(sidA).length >= 1), 'A: permission_request never armed')
	emit(sidA, permissionPrompt)
	assert.ok(await waitFor(() => actionsFor(sidA).length >= 2), 'A: permission_prompt never processed')

	const actionsA = actionsFor(sidA)
	assert.strictEqual(actionsA[0].action, 'armed', 'A: first action is armed')
	assert.strictEqual(actionsA[0].eventType, 'permission_request', 'A: armed on permission_request')
	assert.strictEqual(actionsA[1].action, 'suppressed', 'A: permission_prompt SUPPRESSED, not replaced')
	assert.strictEqual(actionsA[1].eventType, 'permission_prompt', 'A: suppressed event is the prompt')
	assert.strictEqual(actionsA[1].pendingEventType, 'permission_request', 'A: suppressed against the pending request')
	assert.ok(!actionsA.some(e => e.action === 'replaced'), 'A: no REPLACE happened')
	assert.ok(infos.some(m => m.includes('SUPPRESSED, richer permission_request already pending')), 'A: SUPPRESSED log line')

	assert.ok(await waitFor(() => bannersFor(sidA).length >= 1), 'A: no banner fired')
	const bannerA = bannersFor(sidA)[0]
	assert.strictEqual(bannerA.eventType, 'permission_request', 'A: the RICH event is what fires')
	assert.strictEqual(bannerA.line.tool_name, 'Bash', 'A: tool_name survives')
	assert.deepStrictEqual(bannerA.line.tool_input, { command: 'npm test' }, 'A: tool_input survives')
	// The Allow button in notify-app.js is gated on this field — its absence
	// is exactly what the pre-fix banner lost.
	assert.strictEqual(bannerA.line.tool_use_id, 'req-42', 'A: tool_use_id survives (Allow button gate)')
	assert.strictEqual(bannersFor(sidA).length, 1, 'A: exactly one banner')

	// --- B. prompt on its own — the PermissionRequest-didn't-fire fallback ---
	const sidB = 'bbbbbbbb-0000-0000-0000-000000000002'
	emit(sidB, permissionPrompt)
	assert.ok(await waitFor(() => bannersFor(sidB).length >= 1), 'B: standalone permission_prompt never fired')
	assert.strictEqual(bannersFor(sidB)[0].eventType, 'permission_prompt', 'B: fires as permission_prompt')
	assert.strictEqual(actionsFor(sidB)[0].action, 'armed', 'B: armed normally, not suppressed')

	// --- C. the guard is narrow : a pending `stop` is still replaceable ---
	const sidC = 'cccccccc-0000-0000-0000-000000000003'
	emit(sidC, { event: 'stop', last_message_excerpt: 'done' })
	assert.ok(await waitFor(() => actionsFor(sidC).length >= 1), 'C: stop never armed')
	emit(sidC, permissionPrompt)
	assert.ok(await waitFor(() => actionsFor(sidC).length >= 2), 'C: permission_prompt never processed')
	assert.strictEqual(actionsFor(sidC)[1].action, 'replaced', 'C: permission_prompt still REPLACES a pending stop')
	assert.ok(await waitFor(() => bannersFor(sidC).length >= 1), 'C: no banner fired')
	assert.strictEqual(bannersFor(sidC)[0].eventType, 'permission_prompt', 'C: prompt wins over stop')

	// --- D. prompt arriving after the request already fired ---
	const sidD = 'dddddddd-0000-0000-0000-000000000004'
	emit(sidD, permissionRequest)
	assert.ok(await waitFor(() => bannersFor(sidD).length >= 1), 'D: permission_request never fired')
	emit(sidD, permissionPrompt)
	assert.ok(await waitFor(() => bannersFor(sidD).length >= 2), 'D: permission_prompt never fired')
	assert.ok(!actionsFor(sidD).some(e => e.action === 'suppressed'), 'D: nothing pending, so nothing suppressed')
	assert.strictEqual(bannersFor(sidD)[1].eventType, 'permission_prompt', 'D: prompt arms on its own post-fire')

	console.log('watcher-perm-dedup.test.js — all assertions passed (A suppress, B fallback, C narrow guard, D post-fire)')
}

main()
	.then(() => { fs.rmSync(QUEUE_DIR, { recursive: true, force: true }); process.exit(0) })
	.catch((e) => { fs.rmSync(QUEUE_DIR, { recursive: true, force: true }); console.error(e); process.exit(1) })
