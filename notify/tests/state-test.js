#!/usr/bin/env node
// state-test.js — assertions for lib/state.js payload pass-through.
//
// Run: `node .devcontainer/notify/tests/state-test.js`
// Exits 0 on success, throws + non-zero on failure.

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const state = require('../lib/state')

// Spin up an isolated queue dir under tmpdir/ so this test never touches the
// real .devcontainer/tmp/notify/state/ files.
const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-state-test-'))
const stateDir = path.join(queueDir, 'state')
const pendingPath = path.join(stateDir, 'pending.json')
const actionsPath = path.join(stateDir, 'actions.jsonl')

state.init({ queueDir, pid: 99999 })

// Helpers -----------------------------------------------------------------

const readPending = () => JSON.parse(fs.readFileSync(pendingPath, 'utf8'))
const readActions = () => fs.readFileSync(actionsPath, 'utf8')
	.split('\n').filter(Boolean).map((s) => JSON.parse(s))

// 1. armed({ payload }) mirrors the payload into pending.json + audit line.
const sid = 'abc12345-test-0001'
const permLine = {
	ts:             '2026-06-13T10:00:00.000Z',
	sid,
	event:          'permission_request',
	session_name:   'state-payload session',
	tool_use_id:    'toolu_abc123',
	tool_name:      'Bash',
	tool_input:     { command: 'ls -la' }
}
state.armed({ sid, eventType: 'permission_request', delayMs: 30000, payload: permLine })

const afterArm = readPending()
assert.strictEqual(afterArm.pending.length, 1, 'one pending entry after armed')
const armedEntry = afterArm.pending[0]
assert.strictEqual(armedEntry.sid, sid)
assert.strictEqual(armedEntry.eventType, 'permission_request')
assert.strictEqual(armedEntry.delay_ms, 30000)
assert.deepStrictEqual(armedEntry.payload, permLine,
	'pending.json carries the full payload verbatim')

const armedActions = readActions()
assert.strictEqual(armedActions.length, 1, 'one audit line after armed')
assert.strictEqual(armedActions[0].action, 'armed')
assert.deepStrictEqual(armedActions[0].payload, permLine,
	'armed audit line carries the payload')

// 2. replaced({ payload }) overwrites pending.json + emits a replaced line.
const stopLine = {
	ts:                    '2026-06-13T10:00:05.000Z',
	sid,
	event:                 'stop',
	session_name:          'state-payload session',
	last_message_excerpt:  'Tests passing, PR ready'
}
state.replaced({
	sid,
	prevEventType: 'permission_request',
	newEventType: 'stop',
	delayMs:      30000,
	payload:      stopLine
})

const afterReplace = readPending()
assert.strictEqual(afterReplace.pending.length, 1, 'still one pending entry after replaced')
const replacedEntry = afterReplace.pending[0]
assert.strictEqual(replacedEntry.eventType, 'stop')
assert.deepStrictEqual(replacedEntry.payload, stopLine,
	'pending.json now carries the NEW payload')

const replacedActions = readActions()
assert.strictEqual(replacedActions.length, 2, 'two audit lines after replaced')
assert.strictEqual(replacedActions[1].action, 'replaced')
assert.strictEqual(replacedActions[1].prevEventType, 'permission_request')
assert.strictEqual(replacedActions[1].newEventType, 'stop')
assert.deepStrictEqual(replacedActions[1].payload, stopLine,
	'replaced audit line carries the new payload')

// 3. cancelled({ ... }) removes pending entry, no payload field on the audit line.
state.cancelled({ sid, eventType: 'stop', cause: 'user_replied' })

const afterCancel = readPending()
assert.strictEqual(afterCancel.pending.length, 0, 'pending entry removed after cancelled')

const cancelActions = readActions()
assert.strictEqual(cancelActions.length, 3)
assert.strictEqual(cancelActions[2].action, 'cancelled')
assert.ok(!('payload' in cancelActions[2]),
	'cancelled audit line carries no payload (by design)')

// 4. fired({ ... }) removes pending entry, no payload field on the audit line.
const sid2 = 'def67890-test-0002'
state.armed({
	sid:       sid2,
	eventType: 'stop',
	delayMs:   30000,
	payload:   { ts: '2026-06-13T10:01:00.000Z', sid: sid2, event: 'stop', last_message_excerpt: 'short stop' }
})
state.fired({ sid: sid2, eventType: 'stop' })

const afterFire = readPending()
assert.strictEqual(afterFire.pending.length, 0, 'pending entry removed after fired')

const fireActions = readActions()
assert.strictEqual(fireActions[fireActions.length - 1].action, 'fired')
assert.ok(!('payload' in fireActions[fireActions.length - 1]),
	'fired audit line carries no payload (by design)')

// 5. End-to-end : a realistic permission_request line round-trips faithfully
//    (including nested tool_input fields).
state.init({ queueDir, pid: 99999 })  // reset state for a clean assertion
const sid3 = 'cafe1234-test-0003'
const realistic = {
	ts:           '2026-06-13T10:02:00.000Z',
	sid:          sid3,
	event:        'permission_request',
	session_name: 'My DevContainer session',
	tool_use_id:  'toolu_xyz',
	tool_name:    'Bash',
	tool_input:   {
		command:     'echo "hello, world — café"',
		description: 'Print a greeting'
	}
}
state.armed({ sid: sid3, eventType: 'permission_request', delayMs: 5000, payload: realistic })
const roundTrip = readPending().pending[0].payload
assert.deepStrictEqual(roundTrip, realistic,
	'realistic permission_request line round-trips verbatim through pending.json')
assert.strictEqual(roundTrip.tool_input.command, 'echo "hello, world — café"',
	'nested tool_input.command preserves UTF-8 verbatim')

// Cleanup -----------------------------------------------------------------

fs.rmSync(queueDir, { recursive: true, force: true })

console.log('state-test.js — all assertions passed')
