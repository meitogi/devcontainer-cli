#!/usr/bin/env node
// docker-watch-startup.test.js — the daemon must not shut down before the
// container has ever existed, as long as the open that creates it still runs.
//
// The daemon is spawned by initializeCommand, before the image build and
// before Docker Desktop's VM is necessarily up. Part A stubs `docker ps` with
// a scripted sequence and drives the real start() on a real bus with a 5 ms
// tick :
//
//   1. error (VM booting), gone (building), running, gone ; opener alive
//                                  → one emit, on the 4th probe.
//   2. gone forever ; opener alive  → no emit.
//   3. gone ; opener exited         → emit on the first probe : a failed or
//                                     cancelled open still lets the daemon exit.
//   4. gone ; no opener resolved    → emit on the first probe (0.8.1 behaviour).
//
// Part B runs launcher-watch's openerOf / isAlive on real processes and the
// real `ps`, so the stub in part A is no richer than what it stands for.
//
// Run : node notify/tests/docker-watch-startup.test.js
// Exits 0 on success ; throws + non-zero on failure.

const assert = require('assert')
const { EventEmitter } = require('events')

// Stub BEFORE docker-watch is required — it destructures spawnSync at load.
// Only `docker` is scripted ; `ps` (part B) goes to the real binary.
const cp = require('child_process')
const realSpawnSync = cp.spawnSync
let script = []
let probes = 0
cp.spawnSync = (cmd, ...rest) => {
	if (cmd !== 'docker') return realSpawnSync(cmd, ...rest)
	const step = script[Math.min(probes++, script.length - 1)]
	if (step === 'error')   return { error: new Error('Cannot connect to the Docker daemon') }
	if (step === 'running') return { status: 0, stdout: 'abc123\n' }
	return { status: 0, stdout: '' }
}

const log = require('../lib/log')
log.init(null)
const dockerWatch   = require('../lib/docker-watch')
const launcherWatch = require('../lib/launcher-watch')

// start() returns nothing and never clears its interval (daemon.js exits
// instead) : record the handles so each scenario stops its own poll.
const handles = []
const realSetInterval = global.setInterval
global.setInterval = (...args) => { const h = realSetInterval(...args); handles.push(h); return h }

const TICK = 5
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(steps, openerAlive, ticks) {
	script = steps
	probes = 0
	const bus = new EventEmitter()
	const gone = []
	bus.on('container:gone', (e) => { gone.push({ ...e, probe: probes }); bus.removeAllListeners() })
	dockerWatch.start({ bus, projectDir: '/Volumes/x/project', intervalMs: TICK, openerAlive })
	await wait(TICK * ticks + 20)
	while (handles.length) clearInterval(handles.pop())
	return gone
}

;(async () => {
	// The poll keeps ticking after an emit (daemon.js exits on it) ; the
	// listener is dropped on the first emit so a second one cannot count.
	let gone = await run(['error', 'gone', 'running', 'gone'], () => true, 6)
	assert.strictEqual(gone.length, 1, `scenario 1: expected one emit, got ${gone.length}`)
	assert.strictEqual(gone[0].probe, 4, `scenario 1: emitted on probe ${gone[0].probe}, expected 4`)
	assert.strictEqual(gone[0].status, 'gone')
	assert.strictEqual(gone[0].reason, 'no matching container')

	gone = await run(['gone'], () => true, 6)
	assert.strictEqual(gone.length, 0, 'scenario 2: emitted while the opener still runs')
	assert.ok(probes >= 3, `scenario 2: only ${probes} probes ran — the test did not exercise the wait`)

	gone = await run(['gone'], () => false, 3)
	assert.strictEqual(gone.length, 1, 'scenario 3: no emit once the opener exited')
	assert.strictEqual(gone[0].probe, 1, `scenario 3: emitted on probe ${gone[0].probe}, expected 1`)

	gone = await run(['gone'], undefined, 3)
	assert.strictEqual(gone.length, 1, 'scenario 4: no emit without an opener')
	assert.strictEqual(gone[0].probe, 1, `scenario 4: emitted on probe ${gone[0].probe}, expected 1`)

	// Part B. A child of this process stands for `devc initialize` : its first
	// non-shell ancestor is this node process, the opener.
	const child = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
	await wait(100)
	const opener = launcherWatch.openerOf(child.pid)
	assert.ok(opener, 'part B: openerOf resolved nothing')
	assert.strictEqual(opener.pid, process.pid, `part B: opener is ${opener.pid}, expected this process ${process.pid}`)
	assert.ok(opener.lstart, 'part B: no start time captured')
	assert.strictEqual(launcherWatch.isAlive(opener), true, 'part B: a running opener reads as dead')
	assert.strictEqual(launcherWatch.isAlive({ pid: process.pid, lstart: 'Thu Jan  1 00:00:00 1970' }), false,
		'part B: a recycled PID (different start time) reads as alive')

	const dead = { pid: child.pid, lstart: '' }
	child.kill()
	await new Promise((r) => child.on('exit', r))
	assert.strictEqual(launcherWatch.isAlive(dead), false, 'part B: an exited process reads as alive')

	console.log('docker-watch-startup: 4/4 scenarios + real-process checks pass')
	process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
