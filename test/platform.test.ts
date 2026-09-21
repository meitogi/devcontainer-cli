// HOST_KIND classification. Every input is injected, so the whole matrix runs
// on one machine — which matters, because the interesting cases are the two
// Windows shims nobody can test from a Linux container.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectHostKind, isBareWin32, isSupported, type HostProbe } from '../src/lib/platform.js'

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
