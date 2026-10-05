#!/usr/bin/env node
// notify-app-actions.test.js — Allow action wiring (session 3 of the
// notif-outbound-actions rollout).
//
// Two surfaces are covered :
//
//   (A) send() argv construction
//       Same stub-and-load pattern as notify-app-click.test.js — poison
//       child_process.spawn, require.cache the logger + host module, then
//       drive send:notification through a real EventEmitter and assert on
//       the captured argv.
//
//   (B) actions-inbox tail → outbound.jsonl
//       Directly exercises the exported `_test` seams (buildFocusTarget,
//       rememberPermissionContext, processInboxLine) so we can validate
//       the tail dispatch path without waiting on fs.watchFile polling.
//       This mirrors the pattern inbound-watch.test.js would use — the
//       state is module-scoped, so seeding via rememberPermissionContext
//       and asserting the outbound file grew is enough.
//
// Run : node .devcontainer/notify/tests/notify-app-actions.test.js
// Exits 0 on success ; throws + non-zero on failure.

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { EventEmitter } = require('events')

// -----------------------------------------------------------------------------
// Stub child_process BEFORE notify-app is required (same rationale as
// notify-app-click.test.js — top-level destructure captures references at
// load time).

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
// Sandbox HOME + a fake notif binary so getNotifPath resolves cleanly.

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-app-actions-'))
process.env.HOME = SANDBOX
delete process.env.NOTIF_BIN
delete process.env.XDG_DATA_HOME
const fakeNotif = path.join(SANDBOX, '.local', 'bin', 'notif')
fs.mkdirSync(path.dirname(fakeNotif), { recursive: true })
fs.writeFileSync(fakeNotif, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

// Fake workspace root — index.js passes this as `projectDir`. Both the
// actions inbox and outbound.jsonl paths are derived from it.
const PROJECT_DIR = path.join(SANDBOX, 'workspace')
fs.mkdirSync(path.join(PROJECT_DIR, '.devcontainer', 'tmp', 'logs'), { recursive: true })
const INBOX_PATH    = path.join(PROJECT_DIR, '.devcontainer', 'tmp', 'logs', 'notif-actions.jsonl')
const OUTBOUND_PATH = path.join(PROJECT_DIR, '.devcontainer', 'tmp', 'logs', 'claude-code-vscode-ext-outbound.jsonl')

process.on('exit', () => fs.rmSync(SANDBOX, { recursive: true, force: true }))

// -----------------------------------------------------------------------------
// Stub the shared logger.

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

// Force host detection to macos.

const hostPath = require.resolve('../lib/host')
require.cache[hostPath] = {
	id:       hostPath,
	filename: hostPath,
	loaded:   true,
	exports:  { getHostKind: () => 'macos' },
}

// -----------------------------------------------------------------------------
// Load the consumer, then start() with our sandbox projectDir.

const notifyApp = require('../lib/consumers/notify-app')
const bus = new EventEmitter()
const startResult = notifyApp.start({ bus, projectDir: PROJECT_DIR })
assert.strictEqual(
	startResult.status,
	'ok',
	`start() expected ok, got ${JSON.stringify(startResult)}`,
)
assert.strictEqual(
	startResult.diag.actions_inbox,
	INBOX_PATH,
	`start() diag expected actions_inbox=${INBOX_PATH}, got ${startResult.diag.actions_inbox}`,
)

// Discard register/set-icon noise from start().
spawnCalls.length     = 0
spawnSyncCalls.length = 0
warns.length          = 0
infos.length          = 0

// -----------------------------------------------------------------------------
// Helpers.

function makePermPayload({ sid, launchUrl, toolUseId, toolInput, eventType } = {}) {
	sid = sid || 'abcdef01-1234-5678-9012-345678901234'
	return {
		sid,
		eventType: eventType || 'permission_request',
		ts:        '2026-07-11T10:00:00.000Z',
		line: {
			sid,
			event:        eventType || 'permission_request',
			notif_id:     `perm-${sid.slice(0, 8)}-${Date.now()}`,
			tool_name:    'Bash',
			tool_use_id:  toolUseId || 'toolu_01ABC',
			tool_input:   toolInput || { command: 'ls -la' },
			...(launchUrl !== undefined ? { launchUrl } : {}),
		},
	}
}

function sendSpawns() {
	return spawnCalls.filter(c => c.args[0] === 'send')
}

function findOnAction(args) {
	const out = []
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--on-action') out.push(args[i + 1])
	}
	return out
}

function findOnClick(args) {
	const i = args.indexOf('--on-click')
	return i >= 0 ? args[i + 1] : null
}

// -----------------------------------------------------------------------------
// (A) argv construction cases.
// -----------------------------------------------------------------------------

// Case A1 : permission_request + tool_use_id + launchUrl → Allow:file:<inbox>
// AND --on-click focus:open-a. NO Deny action (session 3 dropped Deny).

{
	const payload = makePermPayload({
		sid:       'a1a1a1a1-aaaa-bbbb-cccc-dddddddddddd',
		launchUrl: 'vscode://vscode-remote/dev-container+abc/workspace',
		toolUseId: 'toolu_01A1',
	})
	bus.emit('send:notification', payload)
	const sends = sendSpawns()
	assert.strictEqual(sends.length, 1, `A1: expected 1 send spawn, got ${sends.length}`)
	const onActions = findOnAction(sends[0].args)
	assert.deepStrictEqual(
		onActions,
		[`Allow:file:${INBOX_PATH}`],
		`A1: expected exactly one Allow action; got ${JSON.stringify(onActions)}`,
	)
	assert.strictEqual(
		findOnClick(sends[0].args),
		'focus:open-a://Visual Studio Code/vscode://vscode-remote/dev-container+abc/workspace',
		'A1: body-click DSL still built via buildFocusTarget helper',
	)
}

// Case A2 : permission_request WITHOUT tool_use_id → NO Allow action.
// (buildLine in hook.js only omits tool_use_id when the transcript event
// itself lacked it, which is a producer bug — Allow is unsafe without a
// requestId to pin to.)

spawnCalls.length = 0
{
	const payload = makePermPayload({
		sid:       'a2a2a2a2-aaaa-bbbb-cccc-dddddddddddd',
		launchUrl: 'vscode://vscode-remote/dev-container+def/workspace',
		toolUseId: '',
	})
	// Kill the tool_use_id so send() sees it as missing.
	delete payload.line.tool_use_id
	bus.emit('send:notification', payload)
	const sends = sendSpawns()
	assert.strictEqual(sends.length, 1, `A2: expected 1 send spawn, got ${sends.length}`)
	assert.deepStrictEqual(
		findOnAction(sends[0].args),
		[],
		'A2: no tool_use_id → no --on-action Allow',
	)
}

// Case A3 : `stop` event → no Allow action regardless of tool_use_id
// presence. Only permission_request / permission_prompt trigger it.

spawnCalls.length = 0
{
	const payload = makePermPayload({
		sid:       'a3a3a3a3-aaaa-bbbb-cccc-dddddddddddd',
		launchUrl: 'vscode://vscode-remote/dev-container+ghi/workspace',
		eventType: 'stop',
	})
	bus.emit('send:notification', payload)
	const sends = sendSpawns()
	assert.strictEqual(sends.length, 1, `A3: expected 1 send spawn, got ${sends.length}`)
	assert.deepStrictEqual(
		findOnAction(sends[0].args),
		[],
		'A3: stop event → no --on-action',
	)
}

// Case A4 : permission_prompt behaves like permission_request.

spawnCalls.length = 0
{
	const payload = makePermPayload({
		sid:       'a4a4a4a4-aaaa-bbbb-cccc-dddddddddddd',
		launchUrl: 'vscode://vscode-remote/dev-container+jkl/workspace',
		toolUseId: 'toolu_01A4',
		eventType: 'permission_prompt',
	})
	bus.emit('send:notification', payload)
	const sends = sendSpawns()
	assert.strictEqual(sends.length, 1, `A4: expected 1 send spawn, got ${sends.length}`)
	assert.deepStrictEqual(
		findOnAction(sends[0].args),
		[`Allow:file:${INBOX_PATH}`],
		`A4: permission_prompt should behave like permission_request`,
	)
}

// Case A5 : the --body actually handed to `notif send` is the smartText line.
//
// notify-app does not build its own text — it reuses notifier.render(). That is
// exactly why it needs an assertion rather than an assumption : this is the
// channel that puts an Allow button in the banner, so the body is what the user
// decides on. A `sed -i` on a tracked file must reach the argv with its target.

spawnCalls.length = 0
{
	const { permissionLine } = require('../lib/smart-text')
	const toolInput = {
		command:     `sed -i 's/a/b/' docs/how-i-work-with-claude/fr/patient-create.md`,
		description: 'Repoint the inbound anchors',
	}
	const payload = makePermPayload({
		sid:       'a5a5a5a5-aaaa-bbbb-cccc-dddddddddddd',
		launchUrl: 'vscode://vscode-remote/dev-container+mno/workspace',
		toolUseId: 'toolu_01A5',
		toolInput,
	})
	bus.emit('send:notification', payload)
	const sends = sendSpawns()
	assert.strictEqual(sends.length, 1, `A5: expected 1 send spawn, got ${sends.length}`)

	const args     = sends[0].args
	const bodyIdx  = args.indexOf('--body')
	assert.ok(bodyIdx >= 0, 'A5: --body must be present in the notif argv')
	const body     = args[bodyIdx + 1]
	const expected = permissionLine(payload.line)

	assert.strictEqual(body, expected, `A5: --body should be the smartText line, got ${JSON.stringify(body)}`)
	assert.ok(body.startsWith('Run · '), `A5: verb prefix missing from the body: ${body}`)
	assert.ok(body.includes('⚠'), `A5: the in-place rewrite must raise a warning: ${body}`)
	assert.ok(body.includes('patient-create.md'), `A5: the rewritten file must be named: ${body}`)
	assert.ok(!/ · \d\d:\d\d:\d\d$/.test(body), `A5: the timestamp footer should be gone: ${body}`)
	assert.ok(!body.includes('\n'), 'A5: the body must stay a single line')
}

// -----------------------------------------------------------------------------
// (B) inbox tail → outbound.jsonl.
// -----------------------------------------------------------------------------

// Case B1 : seed the context map with rememberPermissionContext, feed a
// synthetic action:Allow record through processInboxLine, and assert the
// outbound file grew by exactly one JSONL line with the expected schema.

{
	const { rememberPermissionContext, processInboxLine, permissionContext } = notifyApp._test
	const notifId   = 'perm-b1b1b1b1-9999'
	const sid       = 'b1b1b1b1-aaaa-bbbb-cccc-dddddddddddd'
	const toolUseId = 'toolu_01B1'
	const toolInput = { command: 'ls -la /etc' }

	rememberPermissionContext(notifId, sid, toolUseId, toolInput)
	assert.ok(permissionContext.has(notifId), 'B1: context populated on remember')

	// Ensure outbound file is empty for a clean diff.
	if (fs.existsSync(OUTBOUND_PATH)) fs.unlinkSync(OUTBOUND_PATH)

	processInboxLine({ notif_id: notifId, event: 'action:Allow' })

	assert.ok(!permissionContext.has(notifId), 'B1: context cleared after processing')
	assert.ok(fs.existsSync(OUTBOUND_PATH), 'B1: outbound file created')
	const lines = fs.readFileSync(OUTBOUND_PATH, 'utf8').split('\n').filter(Boolean)
	assert.strictEqual(lines.length, 1, `B1: expected 1 outbound line, got ${lines.length}`)
	const parsed = JSON.parse(lines[0])
	assert.deepStrictEqual(parsed, {
		cmd:                'tool_permission_response',
		sessionId:          sid,
		requestId:          toolUseId,
		behavior:           'allow',
		updatedInput:       toolInput,
		updatedPermissions: [],
	}, 'B1: outbound schema matches outbound-tester.js contract')
}

// Case B2 : unknown notif_id → outbound unchanged, warn logged.

{
	const { processInboxLine } = notifyApp._test
	const before = fs.existsSync(OUTBOUND_PATH) ? fs.readFileSync(OUTBOUND_PATH, 'utf8') : ''
	warns.length = 0
	processInboxLine({ notif_id: 'never-seen', event: 'action:Allow' })
	const after = fs.existsSync(OUTBOUND_PATH) ? fs.readFileSync(OUTBOUND_PATH, 'utf8') : ''
	assert.strictEqual(after, before, 'B2: outbound must not grow on unknown notif_id')
	const unknownWarns = warns.filter(w => w.includes('unknown notif_id'))
	assert.strictEqual(unknownWarns.length, 1, `B2: expected 1 unknown-notif_id warn, got ${unknownWarns.length}`)
}

// Case B3 : non-Allow event kinds are ignored (e.g. click on the same
// inbox file would land with event="click"). processInboxLine returns
// silently ; outbound unchanged.

{
	const { rememberPermissionContext, processInboxLine, permissionContext } = notifyApp._test
	rememberPermissionContext('perm-b3-3333', 'b3b3b3b3-aaaa-bbbb-cccc-dddddddddddd', 'toolu_01B3', { command: 'noop' })
	const before = fs.existsSync(OUTBOUND_PATH) ? fs.readFileSync(OUTBOUND_PATH, 'utf8') : ''
	processInboxLine({ notif_id: 'perm-b3-3333', event: 'click' })
	const after = fs.existsSync(OUTBOUND_PATH) ? fs.readFileSync(OUTBOUND_PATH, 'utf8') : ''
	assert.strictEqual(after, before, 'B3: click event must not produce outbound line')
	assert.ok(permissionContext.has('perm-b3-3333'), 'B3: context kept on unrelated event')
}

console.log('notify-app-actions.test.js — all assertions passed')
