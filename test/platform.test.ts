// HOST_KIND classification. Every input is injected, so the whole matrix runs
// on one machine — which matters, because the interesting cases are the two
// Windows shims nobody can test from a Linux container.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	detectHostKind,
	isBareWin32,
	isSupported,
	writeBootId,
	writeHostOs,
	type HostProbe,
} from '../src/lib/platform.js'

function probe(overrides: Partial<HostProbe>): HostProbe {
	return { platform: 'linux', env: {}, procVersion: null, ...overrides }
}

test('darwin is mac', () => {
	assert.equal(detectHostKind(probe({ platform: 'darwin' })), 'mac')
})

test('plain linux is linux', () => {
	assert.equal(detectHostKind(probe({ platform: 'linux', procVersion: 'Linux version 6.12.76' })), 'linux')
})

test('WSL_DISTRO_NAME marks wsl', () => {
	assert.equal(detectHostKind(probe({ env: { WSL_DISTRO_NAME: 'Ubuntu' } })), 'wsl')
})

test('WSL_INTEROP marks wsl', () => {
	assert.equal(detectHostKind(probe({ env: { WSL_INTEROP: '/run/WSL/8_interop' } })), 'wsl')
})

test('microsoft in /proc/version marks wsl even with no env markers', () => {
	assert.equal(
		detectHostKind(probe({ procVersion: 'Linux version 5.15.0-microsoft-standard-WSL2' })),
		'wsl',
	)
})

test('a linuxkit kernel is NOT wsl — that is Docker Desktop, not the host', () => {
	assert.equal(detectHostKind(probe({ procVersion: 'Linux version 6.12.76-linuxkit' })), 'linux')
})

test('MSYSTEM identifies Git Bash, which uname reported as MINGW*', () => {
	assert.equal(detectHostKind(probe({ platform: 'win32', env: { MSYSTEM: 'MINGW64' } })), 'gitbash')
	assert.equal(detectHostKind(probe({ platform: 'win32', env: { MSYSTEM: 'MSYS' } })), 'gitbash')
})

test('a Cygwin-shaped MSYSTEM is named rather than lumped into unknown', () => {
	// Synthetic input: real Cygwin does not reliably set MSYSTEM. Both kinds are
	// refused identically, so this pins the message, not the detection.
	assert.equal(detectHostKind(probe({ platform: 'win32', env: { MSYSTEM: 'CYGWIN' } })), 'cygwin')
	assert.equal(isSupported('cygwin'), false)
})

test('native Windows with no POSIX shim is unknown, and refused', () => {
	const bare = probe({ platform: 'win32', env: {} })
	assert.equal(detectHostKind(bare), 'unknown')
	assert.equal(isSupported('unknown'), false)
	assert.equal(isBareWin32(bare), true)
})

test('the four supported kinds are exactly mac, linux, wsl, gitbash', () => {
	assert.deepEqual(
		(['mac', 'linux', 'wsl', 'gitbash', 'cygwin', 'unknown'] as const).filter(isSupported),
		['mac', 'linux', 'wsl', 'gitbash'],
	)
})

// D4 — the boot id crosses host→container as a file, because neither containerEnv
// nor env_file reaches a reopen. These are the two writers that share tmp/logs/
// at its top level, and the one thing that must stay true of both is that each
// leaves exactly one line the other side can read without parsing.
test('writeBootId drops a single-line .boot-id, creating tmp/logs on the way', () => {
	const devcontainerDir = mkdtempSync(join(tmpdir(), 'devc-bootid-'))
	try {
		const target = writeBootId(devcontainerDir, '20261006T073743Z')

		assert.equal(target, join(devcontainerDir, 'tmp', 'logs', '.boot-id'))
		// Trailing newline, nothing else: devc-hook strips whitespace and then
		// matches the whole string against ^[0-9]{8}T[0-9]{6}Z$, so a second line
		// or a key=value wrapper would be rejected as malformed and the boot would
		// silently mint its own id instead of joining this one.
		assert.equal(readFileSync(target, 'utf8'), '20261006T073743Z\n')
		// The directory did not exist a moment ago — the helper owns its mkdir, so
		// callers never have to order themselves against the logger's.
		assert.ok(existsSync(join(devcontainerDir, 'tmp', 'logs')))
	} finally {
		rmSync(devcontainerDir, { recursive: true, force: true })
	}
})

test('writeBootId and writeHostOs are siblings, both flat in tmp/logs', () => {
	const devcontainerDir = mkdtempSync(join(tmpdir(), 'devc-bootid-'))
	try {
		const bootId = writeBootId(devcontainerDir, '20261006T073743Z')
		const hostOs = writeHostOs(devcontainerDir, 'mac')

		// host-os must NOT follow the phase logs into the boot folder: cdp.mjs:103
		// resolves it at tmp/logs/host-os and nothing tells it otherwise. A rewrite
		// of this layout that moves it breaks visual-loop for no gain.
		assert.equal(hostOs, join(devcontainerDir, 'tmp', 'logs', 'host-os'))
		assert.equal(join(bootId, '..'), join(hostOs, '..'))
		assert.equal(readFileSync(hostOs, 'utf8'), 'mac\n')
	} finally {
		rmSync(devcontainerDir, { recursive: true, force: true })
	}
})
