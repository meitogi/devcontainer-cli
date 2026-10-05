#!/usr/bin/env node
// notify-app-click.test.js — body-click --on-click argv injection for the
// focus:open DSL (session 2 of the notif-outbound-actions rollout).
//
// Stubs child_process.spawn / spawnSync + the shared logger + host detection
// so the consumer's `start()` returns ok on any OS. Then emits synthetic
// send:notification events on a real bus and asserts on the captured argv :
//
//   1. payload with a valid `launchUrl`  → argv contains
//      `['--on-click', 'focus:open-a://Visual Studio Code/<launchUrl>']`
//   2. two payloads WITHOUT launchUrl    → no --on-click on either send ;
//                                          the one-shot warn fires ONCE.
//   3. payload with a whitespace URL     → rejected at the JS boundary (no
//                                          --on-click), avoids handing a
//                                          malformed target to `notif`'s
//                                          inner parse_target.
//
// Run : node .devcontainer/notify/tests/notify-app-click.test.js
// Exits 0 on success ; throws + non-zero on failure.

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { EventEmitter } = require('events')

// -----------------------------------------------------------------------------
// Stub child_process BEFORE notify-app is required — the consumer's top-level
// `const { spawn, spawnSync } = require('child_process')` captures whatever
// the module has at that moment. Mutating cp.spawn on the shared cached
// module object works because notify-app hasn't destructured yet.

const cp = require('child_process')
const spawnCalls     = []
const spawnSyncCalls = []
cp.spawn = (cmd, args) => {
	spawnCalls.push({ cmd, args })
	return { unref: () => {}, on: () => {}, stderr: null }
}
cp.spawnSync = (cmd, args) => {
	spawnSyncCalls.push({ cmd, args })
	return { status: 0, signal: null, stdout: Buffer.from(''), stderr: Buffer.from('') }
}

// -----------------------------------------------------------------------------
// Sandbox HOME + a fake notif binary so getNotifPath resolves to ~/.local/bin.

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-app-click-'))
process.env.HOME = SANDBOX
delete process.env.NOTIF_BIN
delete process.env.XDG_DATA_HOME
const fakeNotif = path.join(SANDBOX, '.local', 'bin', 'notif')
fs.mkdirSync(path.dirname(fakeNotif), { recursive: true })
fs.writeFileSync(fakeNotif, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
process.on('exit', () => fs.rmSync(SANDBOX, { recursive: true, force: true }))

// -----------------------------------------------------------------------------
// Stub the shared logger — assertions check the count of missing-launchUrl
// warns. We poison require.cache BEFORE notify-app loads so its top-level
// `require('../log')` picks up our stub. resolve() gives us the same absolute
// path notify-app itself will resolve to.

const warns = []
const infos = []
const logPath = require.resolve('../lib/log')
require.cache[logPath] = {
	id:       logPath,
	filename: logPath,
	loaded:   true,
	exports: {
		init:  () => {},
		info:  (msg) => infos.push(msg),
		warn:  (msg) => warns.push(msg),
		error: (msg) => warns.push(msg),
	},
}

// -----------------------------------------------------------------------------
// Force host detection to macos so the consumer proceeds instead of returning
// skipped for a linux runtime. Same require.cache trick as the logger.

const hostPath = require.resolve('../lib/host')
require.cache[hostPath] = {
	id:       hostPath,
	filename: hostPath,
	loaded:   true,
	exports:  { getHostKind: () => 'macos' },
}

// -----------------------------------------------------------------------------
// Now load the consumer under test and wire it up.

const notifyApp = require('../lib/consumers/notify-app')
const bus = new EventEmitter()
const startResult = notifyApp.start({ bus })
assert.strictEqual(
	startResult.status,
	'ok',
	`start() expected ok, got ${JSON.stringify(startResult)}`,
)

// Discard whatever start()'s register/set-icon path did — from here we
// only care about send/remove spawns and post-start warns.
spawnCalls.length     = 0
spawnSyncCalls.length = 0
warns.length          = 0

// -----------------------------------------------------------------------------
// Helpers

function makePayload({ sid, launchUrl } = {}) {
	sid = sid || 'abcdef01-1234-5678-9012-345678901234'
	return {
		sid,
		eventType: 'stop',
		ts:        '2026-07-11T10:00:00.000Z',
		line: {
			sid,
			event:                'stop',
			notif_id:             `stop-${sid.slice(0, 8)}-123`,
			last_message_excerpt: 'test',
			...(launchUrl !== undefined ? { launchUrl } : {}),
		},
	}
}

function sendSpawns() {
	return spawnCalls.filter(c => c.args[0] === 'send')
}

function findOnClick(args) {
	const i = args.indexOf('--on-click')
	return i >= 0 ? args[i + 1] : null
}

// -----------------------------------------------------------------------------
// Case 1 : payload with a valid `launchUrl` produces the DSL --on-click arg.

{
	bus.emit('send:notification', makePayload({
		sid:       '11111111-aaaa-bbbb-cccc-dddddddddddd',
		launchUrl: 'vscode://vscode-remote/dev-container+abc/workspace',
	}))
	const sends = sendSpawns()
	assert.strictEqual(sends.length, 1, `expected 1 send spawn, got ${sends.length}`)
	assert.strictEqual(
		findOnClick(sends[0].args),
		'focus:open-a://Visual Studio Code/vscode://vscode-remote/dev-container+abc/workspace',
		'valid launchUrl must produce the DSL --on-click arg',
	)
	const missingWarns = warns.filter(w => w.includes('no valid launchUrl'))
	assert.strictEqual(missingWarns.length, 0, 'no warn on valid launchUrl')
}

// -----------------------------------------------------------------------------
// Case 2 : two payloads WITHOUT launchUrl → no --on-click on either ; the
// one-shot warn fires exactly ONCE across both emissions.

spawnCalls.length = 0
warns.length      = 0
{
	bus.emit('send:notification', makePayload({ sid: '22222222-aaaa-bbbb-cccc-dddddddddddd' }))
	bus.emit('send:notification', makePayload({ sid: '33333333-aaaa-bbbb-cccc-dddddddddddd' }))
	const sends = sendSpawns()
	assert.strictEqual(sends.length, 2, `expected 2 send spawns, got ${sends.length}`)
	for (const s of sends) {
		assert.strictEqual(findOnClick(s.args), null, 'missing launchUrl → no --on-click')
	}
	const missingWarns = warns.filter(w => w.includes('no valid launchUrl'))
	assert.strictEqual(
		missingWarns.length,
		1,
		`expected exactly 1 missing-launchUrl warn across 2 events, got ${missingWarns.length}: ${JSON.stringify(warns)}`,
	)
}

// -----------------------------------------------------------------------------
// Case 3 : whitespace / control-char in launchUrl → rejected at JS boundary.
// No --on-click added. No new warn (one-shot already fired in case 2).

spawnCalls.length = 0
warns.length      = 0
{
	bus.emit('send:notification', makePayload({
		sid:       '44444444-aaaa-bbbb-cccc-dddddddddddd',
		launchUrl: 'has space',
	}))
	const sends = sendSpawns()
	assert.strictEqual(sends.length, 1, `expected 1 send spawn, got ${sends.length}`)
	assert.strictEqual(
		findOnClick(sends[0].args),
		null,
		'whitespace launchUrl must be rejected — no --on-click passed to notif',
	)
}

console.log('notify-app-click.test.js — all assertions passed')
