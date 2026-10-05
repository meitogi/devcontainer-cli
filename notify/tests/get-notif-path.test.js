#!/usr/bin/env node
// get-notif-path.test.js — resolution order for notify-app::getNotifPath.
//
// Runs the 8 candidate branches (NOTIF_BIN → $XDG_DATA_HOME → ~/.local/bin →
// ~/bin → /usr/local/bin → /opt/homebrew/bin → $PATH scan → vendor fallback)
// plus the all-missing case. Uses a per-test temp $HOME so real disk state
// can't leak into the assertions. Absolute paths (Homebrew, arbitrary $PATH
// entries) can't be sandboxed — the terminal "all missing" case only
// asserts `null` when we neutralise $PATH too.
//
// Run: node .devcontainer/notify/tests/get-notif-path.test.js
// Exits 0 on success ; throws + non-zero on failure.

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const { getNotifPath } = require('../lib/consumers/notify-app')

// Snapshot the env slots we mutate so the test process leaves nothing behind.
const SNAPSHOT_ENV = {
	NOTIF_BIN:      process.env.NOTIF_BIN,
	XDG_DATA_HOME:  process.env.XDG_DATA_HOME,
	HOME:           process.env.HOME,
	PATH:           process.env.PATH,
}
function restoreEnv() {
	for (const [k, v] of Object.entries(SNAPSHOT_ENV)) {
		if (v === undefined) delete process.env[k]
		else                 process.env[k] = v
	}
}
process.on('exit', restoreEnv)

// Fresh sandbox $HOME + $XDG_DATA_HOME per test — old candidates never carry
// over. Directory is nuked at the top of each case for full isolation.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-app-test-'))
function resetSandbox() {
	fs.rmSync(SANDBOX, { recursive: true, force: true })
	fs.mkdirSync(SANDBOX, { recursive: true })
}
process.on('exit', () => fs.rmSync(SANDBOX, { recursive: true, force: true }))

function touch(p) {
	fs.mkdirSync(path.dirname(p), { recursive: true })
	fs.writeFileSync(p, '#!/bin/sh\necho stub\n', { mode: 0o755 })
}

function clearEnv() {
	delete process.env.NOTIF_BIN
	delete process.env.XDG_DATA_HOME
}

// 1. NOTIF_BIN env wins over every other candidate.
{
	resetSandbox()
	clearEnv()
	process.env.HOME = SANDBOX
	const explicit  = path.join(SANDBOX, 'somewhere', 'notif-explicit')
	const dotLocal  = path.join(SANDBOX, '.local', 'bin', 'notif')
	touch(explicit)
	touch(dotLocal)                                // decoy — must NOT win
	process.env.NOTIF_BIN = explicit
	assert.strictEqual(getNotifPath(), explicit, 'NOTIF_BIN must win over ~/.local/bin')
}

// 2. XDG_DATA_HOME/notif/notif wins when NOTIF_BIN is unset.
{
	resetSandbox()
	clearEnv()
	process.env.HOME = SANDBOX
	process.env.XDG_DATA_HOME = path.join(SANDBOX, 'xdg')
	const xdg      = path.join(SANDBOX, 'xdg', 'notif', 'notif')
	const dotLocal = path.join(SANDBOX, '.local', 'bin', 'notif')
	touch(xdg)
	touch(dotLocal)                                // decoy — lower priority
	assert.strictEqual(getNotifPath(), xdg, 'XDG_DATA_HOME must win over ~/.local/bin')
}

// 3. ~/.local/bin/notif wins when the two above are missing.
{
	resetSandbox()
	clearEnv()
	process.env.HOME = SANDBOX
	const dotLocal = path.join(SANDBOX, '.local', 'bin', 'notif')
	const homeBin  = path.join(SANDBOX, 'bin', 'notif')
	touch(dotLocal)
	touch(homeBin)                                 // decoy — lower priority
	assert.strictEqual(getNotifPath(), dotLocal, '~/.local/bin/notif must win over ~/bin/notif')
}

// 4. ~/bin/notif wins when the previous three are missing.
{
	resetSandbox()
	clearEnv()
	process.env.HOME = SANDBOX
	const homeBin = path.join(SANDBOX, 'bin', 'notif')
	touch(homeBin)
	assert.strictEqual(getNotifPath(), homeBin)
}

// 5. All candidates missing → null. Neutralise $PATH so the terminal $PATH
// scan can't match a real system `notif` binary and skew the assertion.
{
	resetSandbox()
	clearEnv()
	process.env.HOME = SANDBOX
	process.env.PATH = ''
	assert.strictEqual(getNotifPath(), null, 'no explicit + empty PATH → null')
}

// 6. $PATH scan finds notif when explicit candidates miss. Uses the sandbox
// as a fake bin dir so the scan is deterministic on any host.
{
	resetSandbox()
	clearEnv()
	process.env.HOME = SANDBOX
	const pathBin = path.join(SANDBOX, 'somewhere-on-path', 'notif')
	touch(pathBin)
	process.env.PATH = path.dirname(pathBin)
	assert.strictEqual(getNotifPath(), pathBin, '$PATH scan finds sandboxed notif')
}

// 7. Explicit candidates beat $PATH scan even when both exist.
{
	resetSandbox()
	clearEnv()
	process.env.HOME = SANDBOX
	const dotLocal = path.join(SANDBOX, '.local', 'bin', 'notif')
	const pathBin  = path.join(SANDBOX, 'somewhere-on-path', 'notif')
	touch(dotLocal)
	touch(pathBin)
	process.env.PATH = path.dirname(pathBin)
	assert.strictEqual(getNotifPath(), dotLocal, '~/.local/bin/notif wins over $PATH scan')
}

console.log('get-notif-path.test.js — all assertions passed')
