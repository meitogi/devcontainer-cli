// `devc notify send` and the daemon decision `devc initialize` makes: the
// exact queue line (key order, caps), the real CLI on a temp .devcontainer,
// and the panel row for every mode and queue state.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	buildSendLine,
	capText,
	decideNotify,
	MARKER_FRESH_MS,
	parseDaemonMode,
	readQueueSignals,
	type QueueSignals,
} from '../src/lib/notify-queue.js'
import { PACKAGE_ROOT } from '../src/lib/version.js'

const TS = '2026-10-14T08:18:00.000Z'

test('send line: exact JSON, contract key order, trimmed, title optional', () => {
	assert.equal(
		JSON.stringify(buildSendLine({ message: 'Nightly build finished — 3 failures', title: 'CI', sid: 'abc-1' }, TS)),
		`{"v":1,"ts":"${TS}","sid":"abc-1","event":"send","producer":"devc","message":"Nightly build finished — 3 failures","title":"CI"}`,
	)
	assert.equal(
		JSON.stringify(buildSendLine({ message: '  done \n', title: '  ', sid: 'm' }, TS)),
		`{"v":1,"ts":"${TS}","sid":"m","event":"send","producer":"devc","message":"done"}`,
	)
})

test('send line: 200 / 64 code points, … when cut, a surrogate pair never split', () => {
	assert.equal(capText('a'.repeat(200), 200), 'a'.repeat(200))
	assert.equal(capText('🔔'.repeat(250), 200), `${'🔔'.repeat(199)}…`)
	const line = buildSendLine({ message: 'é'.repeat(300), title: 't'.repeat(70), sid: 's' }, TS)
	assert.equal(line.message, `${'é'.repeat(199)}…`)
	assert.equal(line.title, `${'t'.repeat(63)}…`)
})

function devc(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'bin', 'devc.mjs'), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
	return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

function scratch(): { root: string; dc: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), 'devc-notify-'))
	const dc = join(root, '.devcontainer')
	mkdirSync(dc)
	return { root, dc, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** The single line of a queue file, its ts checked then normalised. */
function lineOf(file: string): string {
	const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
	assert.equal(lines.length, 1, file)
	const o = JSON.parse(lines[0] as string) as Record<string, unknown>
	assert.match(String(o['ts']), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
	o['ts'] = 'TS'
	return JSON.stringify(o)
}

test('devc notify send (real binary): appends the exact line under <devcontainerDir>/tmp/notify, prints the file', () => {
	const { root, dc, cleanup } = scratch()
	try {
		const r = devc(root, 'notify', 'send', 'Deploy', 'done', '--title', 'Prod', '--sid=abc-1', '--devcontainer-dir', dc)
		const file = join(dc, 'tmp', 'notify', 'abc-1.jsonl')
		assert.deepEqual([r.status, r.stdout, r.stderr], [0, `${file}\n`, ''])
		assert.equal(lineOf(file), '{"v":1,"ts":"TS","sid":"abc-1","event":"send","producer":"devc","message":"Deploy done","title":"Prod"}')
		// The default .devcontainer from the cwd, and a fresh UUID sid.
		assert.equal(devc(root, 'notify', 'send', '--', '-dash').status, 0)
		const names = readdirSync(join(dc, 'tmp', 'notify')).filter((n) => n !== 'abc-1.jsonl')
		assert.equal(names.length, 1)
		assert.match(names[0] as string, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/)
		assert.equal(JSON.parse(readFileSync(join(dc, 'tmp', 'notify', names[0] as string), 'utf8')).message, '-dash')
	} finally {
		cleanup()
	}
})

test('devc notify: usage errors exit 2 with the reason and write nothing ; an unwritable queue exits 1', () => {
	const { root, dc, cleanup } = scratch()
	try {
		const cases: [string[], RegExp][] = [
			[['notify', 'send'], /a message is required/],
			[['notify', 'send', '  '], /a message is required/],
			[['notify', 'send', 'hi', '--body', 'x'], /unknown option "--body"/],
			[['notify', 'push', 'hi'], /unknown subcommand "push"/],
			[['notify', 'send', 'hi', '--sid', '../x'], /--sid must match/],
			[['notify', 'send', 'hi', '--sid', '.daemon'], /--sid must match/],
			[['notify', 'send', 'hi', '--title'], /--title requires a value/],
		]
		for (const [args, why] of cases) {
			const r = devc(root, ...args)
			assert.equal(r.status, 2, args.join(' '))
			assert.match(r.stderr, why, args.join(' '))
		}
		assert.deepEqual(readdirSync(dc), [], 'nothing written')
		mkdirSync(join(dc, 'tmp'))
		writeFileSync(join(dc, 'tmp', 'notify'), '')
		const r = devc(root, 'notify', 'send', 'hi')
		assert.equal(r.status, 1)
		assert.match(r.stderr, /could not append to/)
		const help = devc(root, 'notify', '--help')
		assert.equal(help.status, 0)
		assert.match(help.stdout, /^  devc notify send <message> \[options\]$/m)
		assert.match(devc(root, '--help').stdout, /^  notify send <message> +Send a notification/m)
	} finally {
		cleanup()
	}
})

const NOW = 1_800_000_000_000
const none: QueueSignals = { markerTs: null, markerVersion: null, livePid: null }
const ext: QueueSignals = { markerTs: NOW - 3_600_000, markerVersion: '0.0.1', livePid: null }

test('NOTIFY_DAEMON: auto by default, on / off, anything else flagged', () => {
	assert.equal(parseDaemonMode(undefined), 'auto')
	assert.equal(parseDaemonMode(''), 'auto')
	assert.equal(parseDaemonMode(' Auto '), 'auto')
	assert.equal(parseDaemonMode('ON'), 'on')
	assert.equal(parseDaemonMode('off'), 'off')
	assert.deepEqual(parseDaemonMode('1'), { invalid: '1' })
})

test('daemon decision: every mode against every queue state, exact rows', () => {
	assert.deepEqual(decideNotify('auto', none, NOW), { spawn: true, note: null }, 'never saw the extension → today\'s daemon')
	assert.deepEqual(decideNotify('auto', { ...ext, markerTs: NOW - MARKER_FRESH_MS - 1 }, NOW), { spawn: true, note: null }, 'stale marker')
	assert.deepEqual(decideNotify('auto', { ...ext, markerTs: NOW - MARKER_FRESH_MS }, NOW), { spawn: false, row: { value: 'VS Code extension 0.0.1', state: 'ok', why: null } }, '7 days exactly')
	assert.deepEqual(decideNotify('auto', ext, NOW), { spawn: false, row: { value: 'VS Code extension 0.0.1', state: 'ok', why: null } })
	assert.deepEqual(decideNotify('auto', { ...ext, markerVersion: null }, NOW), { spawn: false, row: { value: 'VS Code extension', state: 'ok', why: null } })
	assert.deepEqual(decideNotify('auto', { ...ext, livePid: 4242 }, NOW), {
		spawn: false,
		row: {
			value: 'VS Code extension 0.0.1',
			state: 'warn',
			why: 'a notify daemon from an earlier boot is still running (pid 4242) — the extension stands by until it stops; stop it: kill -TERM 4242',
		},
	})
	assert.deepEqual(decideNotify('on', ext, NOW), { spawn: true, note: null }, 'on spawns even with the extension')
	assert.deepEqual(decideNotify('off', none, NOW), { spawn: false, row: { value: 'off (NOTIFY_DAEMON=off)', state: 'ok', why: null } })
	assert.deepEqual(decideNotify('off', { ...none, livePid: 0 }, NOW), {
		spawn: false,
		row: {
			value: 'off (NOTIFY_DAEMON=off)',
			state: 'warn',
			why: 'a notify daemon from an earlier boot is still running (unreadable pid) — the extension stands by until it stops; stop it: kill the process named in .devcontainer/tmp/notify/.daemon.pid',
		},
	})
	assert.deepEqual(decideNotify({ invalid: 'yes' }, none, NOW), { spawn: true, note: 'NOTIFY_DAEMON=yes is not auto, on or off — read as auto' })
	assert.deepEqual(decideNotify({ invalid: 'yes' }, ext, NOW), {
		spawn: false,
		row: { value: 'VS Code extension 0.0.1', state: 'warn', why: 'NOTIFY_DAEMON=yes is not auto, on or off — read as auto' },
	})
})

test('queue signals: marker ts (else its mtime), version, a pid only while fresh', () => {
	const { dc, cleanup } = scratch()
	const q = join(dc, 'tmp', 'notify')
	try {
		assert.deepEqual(readQueueSignals(q, NOW), none, 'no queue directory')
		mkdirSync(q, { recursive: true })
		writeFileSync(join(q, '.extension.json'), JSON.stringify({ version: '0.0.1', ts: NOW - 5 }))
		writeFileSync(join(q, '.daemon.pid'), '4242\n')
		const now = Date.now()
		assert.deepEqual(readQueueSignals(q, now), { markerTs: NOW - 5, markerVersion: '0.0.1', livePid: 4242 })
		utimesSync(join(q, '.daemon.pid'), new Date(now - 31_000), new Date(now - 31_000))
		assert.equal(readQueueSignals(q, now).livePid, null, 'a pid file untouched for 31 s is a dead daemon')
		writeFileSync(join(q, '.extension.json'), 'not json')
		utimesSync(join(q, '.extension.json'), new Date(NOW - 9), new Date(NOW - 9))
		assert.deepEqual(readQueueSignals(q, now), { markerTs: NOW - 9, markerVersion: null, livePid: null })
	} finally {
		cleanup()
	}
})
