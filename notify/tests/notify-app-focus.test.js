#!/usr/bin/env node
// notify-app-focus.test.js — focus-aware banner delay (session 4 of the
// notif-outbound-actions rollout).
//
// Two surfaces are covered :
//
//   (A) focus-debounce module standalone (getDebounceMs / arm / cancel).
//   (B) notify-app.send() gating on line.focused + onCancelled cleanup.
//
// Same stub-and-load pattern as notify-app-actions.test.js — poison
// child_process.spawn BEFORE the consumer is required, require.cache the
// logger + host module, drive send:notification through a real EventEmitter.
//
// Run : node .devcontainer/notify/tests/notify-app-focus.test.js
// Exits 0 on success ; throws + non-zero on failure.

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { EventEmitter } = require('events')

// -----------------------------------------------------------------------------
// Force a tiny debounce so live-timer cases resolve fast without mocking timers.
// Applied BEFORE any require() so the consumer picks it up at load time.

process.env.NOTIFY_FOCUS_DEBOUNCE_MS = '40'

// -----------------------------------------------------------------------------
// Stub child_process BEFORE notify-app is required.

const cp = require('child_process')
const spawnCalls = []
cp.spawn = (cmd, args) => {
	spawnCalls.push({ cmd, args })
	return { unref: () => {}, on: () => {}, stderr: null }
}
cp.spawnSync = () => ({ status: 0, signal: null, stdout: Buffer.from(''), stderr: Buffer.from('') })

// -----------------------------------------------------------------------------
// Sandbox HOME + a fake notif binary so getNotifPath resolves cleanly.

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-app-focus-'))
process.env.HOME = SANDBOX
delete process.env.NOTIF_BIN
delete process.env.XDG_DATA_HOME
const fakeNotif = path.join(SANDBOX, '.local', 'bin', 'notif')
fs.mkdirSync(path.dirname(fakeNotif), { recursive: true })
fs.writeFileSync(fakeNotif, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

const PROJECT_DIR = path.join(SANDBOX, 'workspace')
fs.mkdirSync(path.join(PROJECT_DIR, '.devcontainer', 'tmp', 'logs'), { recursive: true })

process.on('exit', () => fs.rmSync(SANDBOX, { recursive: true, force: true }))

// -----------------------------------------------------------------------------
// Stub the shared logger + force host detection to macos.

const infos = []
const warns = []
const logPath = require.resolve('../lib/log')
require.cache[logPath] = {
	id: logPath, filename: logPath, loaded: true,
	exports: {
		init:  () => {},
		info:  (m) => infos.push(m),
		warn:  (m) => warns.push(m),
		error: (m) => warns.push(m),
	},
}
const hostPath = require.resolve('../lib/host')
require.cache[hostPath] = {
	id: hostPath, filename: hostPath, loaded: true,
	exports: { getHostKind: () => 'macos' },
}

// -----------------------------------------------------------------------------
// Load modules.

const focusDebounce = require('../lib/focus-debounce')
const notifyApp     = require('../lib/consumers/notify-app')
const bus           = new EventEmitter()
const startResult   = notifyApp.start({ bus, projectDir: PROJECT_DIR })
assert.strictEqual(startResult.status, 'ok', `start() expected ok, got ${JSON.stringify(startResult)}`)

// Discard register/set-icon spawn noise from start().
spawnCalls.length = 0
infos.length      = 0
warns.length      = 0

// -----------------------------------------------------------------------------
// Helpers.

function makePayload({ sid, eventType, focused } = {}) {
	sid = sid || 'aaaaaaaa-1111-2222-3333-444444444444'
	const line = {
		sid,
		event:    eventType || 'stop',
		notif_id: `${eventType || 'stop'}-${sid.slice(0, 8)}-${Date.now()}`,
		sender:   'default',
	}
	if (eventType === 'stop') line.last_message_excerpt = 'test'
	if (focused !== undefined) line.focused = focused
	return { sid, eventType: eventType || 'stop', ts: '2026-07-12T10:00:00.000Z', line }
}

function sendSpawns() {
	return spawnCalls.filter(c => c.args[0] === 'send')
}

function waitMs(ms) {
	return new Promise(r => setTimeout(r, ms))
}

// -----------------------------------------------------------------------------
// All cases run sequentially inside an async main() — inter-case timer races
// would double-count spawn calls otherwise.

async function main() {

	// (A1) getDebounceMs env parsing — unset → default, 0 → off, valid → int, huge → clamp.
	assert.strictEqual(focusDebounce.getDebounceMs({}), focusDebounce.DEFAULT_DEBOUNCE_MS, 'A1: unset → default')
	assert.strictEqual(focusDebounce.getDebounceMs({ NOTIFY_FOCUS_DEBOUNCE_MS: '' }), focusDebounce.DEFAULT_DEBOUNCE_MS, 'A1: empty → default')
	assert.strictEqual(focusDebounce.getDebounceMs({ NOTIFY_FOCUS_DEBOUNCE_MS: '3000' }), 3000, 'A1: valid int')
	assert.strictEqual(focusDebounce.getDebounceMs({ NOTIFY_FOCUS_DEBOUNCE_MS: '0' }), 0, 'A1: 0 disables')
	assert.strictEqual(focusDebounce.getDebounceMs({ NOTIFY_FOCUS_DEBOUNCE_MS: '-5' }), 0, 'A1: negative disables')
	assert.strictEqual(focusDebounce.getDebounceMs({ NOTIFY_FOCUS_DEBOUNCE_MS: 'x' }), focusDebounce.DEFAULT_DEBOUNCE_MS, 'A1: garbage → default')
	assert.strictEqual(focusDebounce.getDebounceMs({ NOTIFY_FOCUS_DEBOUNCE_MS: '999999' }), focusDebounce.MAX_DEBOUNCE_MS, 'A1: huge clamped')

	// (A2) armDebounce fires onFire after delay.
	{
		let fired = 0
		focusDebounce.armDebounce('sid-a2', 20, () => { fired++ })
		assert.strictEqual(focusDebounce._test.timers.has('sid-a2'), true, 'A2: armed')
		await waitMs(60)
		assert.strictEqual(fired, 1, 'A2: onFire fired once')
		assert.strictEqual(focusDebounce._test.timers.has('sid-a2'), false, 'A2: entry cleared post-fire')
	}

	// (A3) cancelDebounce clears timer + prevents fire.
	{
		let fired = 0
		focusDebounce.armDebounce('sid-a3', 20, () => { fired++ })
		assert.strictEqual(focusDebounce.cancelDebounce('sid-a3'), true, 'A3: cancel returns true')
		assert.strictEqual(focusDebounce._test.timers.has('sid-a3'), false, 'A3: entry gone')
		await waitMs(60)
		assert.strictEqual(fired, 0, 'A3: onFire never called')
		assert.strictEqual(focusDebounce.cancelDebounce('sid-a3'), false, 'A3: cancel idempotent')
	}

	// (A4) re-arm on existing sid replaces the previous timer.
	{
		let fired = 0, latest = null
		focusDebounce.armDebounce('sid-a4', 20, () => { fired++; latest = 'first' })
		focusDebounce.armDebounce('sid-a4', 20, () => { fired++; latest = 'second' })
		await waitMs(60)
		assert.strictEqual(fired, 1, 'A4: latest wins')
		assert.strictEqual(latest, 'second', 'A4: latest callback ran')
	}

	// (B1) focused=false → immediate dispatch, no arm.
	spawnCalls.length = 0
	infos.length      = 0
	{
		const payload = makePayload({ sid: 'b1111111-0000-0000-0000-000000000000', eventType: 'stop', focused: false })
		bus.emit('send:notification', payload)
		assert.strictEqual(sendSpawns().length, 1, 'B1: 1 spawn')
		assert.strictEqual(focusDebounce._test.timers.has(payload.sid), false, 'B1: no arm')
		assert.ok(!infos.some(m => m.includes('focus-debounce ARM')), 'B1: no ARM log')
	}

	// (B2) line.focused missing → immediate dispatch.
	spawnCalls.length = 0
	{
		const payload = makePayload({ sid: 'b2222222-0000-0000-0000-000000000000', eventType: 'stop' })
		bus.emit('send:notification', payload)
		assert.strictEqual(sendSpawns().length, 1, 'B2: 1 spawn')
		assert.strictEqual(focusDebounce._test.timers.has(payload.sid), false, 'B2: no arm')
	}

	// (B3) focused=true → arm, no spawn ; wait timer → spawn fires.
	spawnCalls.length = 0
	infos.length      = 0
	{
		const sid = 'b3333333-0000-0000-0000-000000000000'
		bus.emit('send:notification', makePayload({ sid, eventType: 'stop', focused: true }))
		assert.strictEqual(sendSpawns().length, 0, 'B3: no spawn while armed')
		assert.strictEqual(focusDebounce._test.timers.has(sid), true, 'B3: armed')
		assert.ok(infos.some(m => m.includes('focus-debounce ARM')), 'B3: ARM log')
		await waitMs(80)
		assert.strictEqual(sendSpawns().length, 1, 'B3: spawn after timeout')
		assert.ok(infos.some(m => m.includes('focus-debounce FIRE')), 'B3: FIRE log')
		assert.strictEqual(focusDebounce._test.timers.has(sid), false, 'B3: entry cleared')
	}

	// (B4) focused=true → arm → cancelled:notification → no spawn.
	spawnCalls.length = 0
	infos.length      = 0
	{
		const sid = 'b4444444-0000-0000-0000-000000000000'
		bus.emit('send:notification', makePayload({ sid, eventType: 'permission_request', focused: true }))
		assert.strictEqual(focusDebounce._test.timers.has(sid), true, 'B4: armed')
		bus.emit('cancelled:notification', { sid, eventType: 'permission_request', reason: 'user_replied' })
		assert.strictEqual(focusDebounce._test.timers.has(sid), false, 'B4: cancelled')
		await waitMs(80)
		assert.strictEqual(sendSpawns().length, 0, 'B4: no spawn after cancel')
		assert.ok(infos.some(m => m.includes('focus-debounce CANCEL')), 'B4: CANCEL log')
	}

	// (B5) NOTIFY_FOCUS_DEBOUNCE_MS=0 → gate disabled ; focused=true fires direct.
	{
		const prev = process.env.NOTIFY_FOCUS_DEBOUNCE_MS
		process.env.NOTIFY_FOCUS_DEBOUNCE_MS = '0'
		try {
			spawnCalls.length = 0
			const sid = 'b5555555-0000-0000-0000-000000000000'
			bus.emit('send:notification', makePayload({ sid, eventType: 'stop', focused: true }))
			assert.strictEqual(sendSpawns().length, 1, 'B5: gate off → immediate spawn')
			assert.strictEqual(focusDebounce._test.timers.has(sid), false, 'B5: no arm')
		} finally {
			process.env.NOTIFY_FOCUS_DEBOUNCE_MS = prev
		}
	}

	// (B6) back-to-back send:notification same sid → latest wins.
	spawnCalls.length = 0
	infos.length      = 0
	{
		const sid = 'b6666666-0000-0000-0000-000000000000'
		bus.emit('send:notification', makePayload({ sid, eventType: 'notification', focused: true }))
		bus.emit('send:notification', makePayload({ sid, eventType: 'stop', focused: true }))
		assert.strictEqual(focusDebounce._test.timers.has(sid), true, 'B6: armed')
		await waitMs(80)
		assert.strictEqual(sendSpawns().length, 1, 'B6: only latest fires')
		assert.strictEqual(focusDebounce._test.timers.has(sid), false, 'B6: no lingering timer')
	}

	console.log('notify-app-focus.test.js — all assertions passed (A1-A4 module, B1-B6 send/cancel)')
}

main().catch(err => { console.error(err); process.exit(1) })
