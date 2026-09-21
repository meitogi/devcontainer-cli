// The dispatcher, through the real entry point in a child process — main()
// writes to the process's own stdout, which under node:test is the runner's
// IPC channel, so it is not called in-process here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../src/lib/version.js'

function devc(...args: string[]): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'bin', 'devc.mjs'), ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

test('--help lists init as a real command and the two stubs as not implemented', () => {
	const { status, stdout } = devc('--help')
	assert.equal(status, 0)
	assert.match(stdout, /^  init \[dir\] +Scaffold/m)
	assert.doesNotMatch(stdout, /init.*not implemented/)
	assert.match(stdout, /update .*\(not implemented\)/)
	assert.match(stdout, /@meitogi\/devcontainer-cli v0\./)
})

test('init --help exits 0; a bad flag, a missing value and a stray argument exit 2', () => {
	assert.equal(devc('init', '--help').status, 0)
	const bad = devc('init', '--bogus')
	assert.equal(bad.status, 2)
	assert.match(bad.stderr, /unknown option "--bogus"/)
	assert.equal(devc('init', '--project-id').status, 2)
	assert.equal(devc('init', 'a', 'b').status, 2)
})

test('init without --yes on a pipe exits 2 before writing anything', () => {
	const { status, stderr } = devc('init', '/nonexistent-dir-for-devc-test')
	assert.equal(status, 2)
	assert.match(stderr, /does not exist/)
})

test('the stubs still exit 1', () => {
	assert.equal(devc('update').status, 1)
	assert.equal(devc('doctor').status, 1)
	assert.equal(devc('doctor', '--help').status, 0)
})
