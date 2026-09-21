// The ext-patches wizard: machine-level config storage, the masked-prompt
// pure logic, and the `devc init` question sequence — through the same
// `ask`/`out`/`discover`/`installer` seams init.test.ts uses. The ctrl-R
// raw-mode keypress wiring itself is not driven here — it needs a real TTY,
// and the pure `maskedLine` function it's built on is what's tested instead.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { init, type InitOptions } from '../src/commands/init.js'
import { readEnvFile } from '../src/lib/env-file.js'
import { extPatchesConfigPath, readExtPatchesConfig, writeExtPatchesConfig } from '../src/lib/machine-config.js'
import { maskedLine } from '../src/lib/prompts.js'
import type { HostProbe } from '../src/lib/platform.js'

const LINUX_PROBE: HostProbe = { platform: 'linux', env: {}, procVersion: 'Linux version 6.12.76-linuxkit' }

function scratch(): { dir: string; cleanup: () => void } {
	const parent = mkdtempSync(join(tmpdir(), 'devc-ext-patches-'))
	const dir = join(parent, 'demo-app')
	mkdirSync(dir)
	return { dir, cleanup: () => rmSync(parent, { recursive: true, force: true }) }
}

/** A temp $XDG_CONFIG_HOME, restored on cleanup — machine-config.ts reads it at call time. */
function fakeHome(): { cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'devc-xdg-'))
	const original = process.env['XDG_CONFIG_HOME']
	process.env['XDG_CONFIG_HOME'] = dir
	return {
		cleanup: () => {
			if (original === undefined) delete process.env['XDG_CONFIG_HOME']
			else process.env['XDG_CONFIG_HOME'] = original
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

function sink(): Writable & { text: () => string } {
	const chunks: string[] = []
	const stream = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			chunks.push(chunk.toString())
			callback()
		},
	})
	return Object.assign(stream, { text: () => chunks.join('') })
}

const TTY = (): NodeJS.ReadableStream & { isTTY?: boolean } => Object.assign(new PassThrough(), { isTTY: true })
const PIPE = (): NodeJS.ReadableStream & { isTTY?: boolean } => Object.assign(new PassThrough(), { isTTY: false })

function answering(...answers: string[]): ((question: string) => Promise<string>) & { asked: string[] } {
	const asked: string[] = []
	let index = 0
	const ask = async (question: string): Promise<string> => {
		asked.push(question)
		return answers[index++] ?? ''
	}
	return Object.assign(ask, { asked })
}

async function runInit(dir: string, overrides: Partial<InitOptions> = {}) {
	const out = sink()
	const err = sink()
	const code = await init({
		cwd: dir,
		yes: true,
		dryRun: false,
		input: PIPE(),
		out,
		err,
		probe: LINUX_PROBE,
		discover: () => [],
		installer: async () => 0,
		...overrides,
	})
	return { code, out: out.text(), err: err.text() }
}

// === maskedLine — the pure logic behind the ctrl-R reveal toggle ==========

test('maskedLine stars out the value unless revealed', () => {
	assert.equal(maskedLine('secret-token', false), '************')
	assert.equal(maskedLine('secret-token', true), 'secret-token')
	assert.equal(maskedLine('', false), '')
})

// === machine-config.ts — the ~/.config/devc/ext-patches.env store =========

test('extPatchesConfigPath honours XDG_CONFIG_HOME', () => {
	const home = fakeHome()
	try {
		assert.equal(extPatchesConfigPath(), join(process.env['XDG_CONFIG_HOME'] as string, 'devc', 'ext-patches.env'))
	} finally {
		home.cleanup()
	}
})

test('readExtPatchesConfig returns null when nothing was ever saved', () => {
	const home = fakeHome()
	try {
		assert.equal(readExtPatchesConfig(), null)
	} finally {
		home.cleanup()
	}
})

test('writeExtPatchesConfig round-trips through readExtPatchesConfig, at mode 600', () => {
	const home = fakeHome()
	try {
		writeExtPatchesConfig({ repo: 'acme/patches', ref: 'cc2.1.272-r1', token: 'shhh' })
		const path = extPatchesConfigPath()
		assert.ok(existsSync(path))
		assert.equal(statSync(path).mode & 0o777, 0o600)
		assert.deepEqual(readExtPatchesConfig(), { repo: 'acme/patches', ref: 'cc2.1.272-r1', token: 'shhh' })
	} finally {
		home.cleanup()
	}
})

test('a saved but empty repo reads back as null', () => {
	const home = fakeHome()
	try {
		writeExtPatchesConfig({ repo: '', ref: '', token: '' })
		assert.equal(readExtPatchesConfig(), null)
	} finally {
		home.cleanup()
	}
})

// === devc init wizard flow ==================================================

test('interactive: leaving the repo empty skips ref, token and the remember prompt', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		const ask = answering('', '', '', '', '', '', '')
		const run = await runInit(dir, { yes: false, input: TTY(), ask, discover: () => [] })
		assert.equal(run.code, 0, run.err)
		const questions = ask.asked.map((question) => question.trim().split(' [')[0] ?? '')
		assert.ok(questions.includes('Extension patchers repository (owner/name, empty to skip)'))
		assert.ok(!questions.some((question) => question.startsWith('Ref')))
		assert.ok(!questions.some((question) => question.startsWith('Access token')))
		assert.ok(!questions.some((question) => question.startsWith('Remember')))
		assert.equal(readExtPatchesConfig(), null)
		assert.equal(readEnvFile(join(dir, '.devcontainer', '.env'))['EXT_PATCHES_REPO'], undefined)
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('interactive: a filled-in repo asks ref and token, writes .env, and remembers on confirm', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		// discover() returns one existing volume so the default creds-volume
		// choice lands on it, not on "New shared volume…" (which would consume
		// an extra answer slot for its own name sub-prompt).
		// stack, id, name, creds volume, cc, repo, ref (Enter=default), token, remember=y, proceed=y
		const ask = answering('', '', '', '', '', 'acme/patches', '', 'tok-123', 'y', 'y')
		const run = await runInit(dir, {
			yes: false,
			input: TTY(),
			ask,
			discover: () => [{ name: 'claude-creds-old', projects: [] }],
		})
		assert.equal(run.code, 0, run.err)
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['EXT_PATCHES_REPO'], 'acme/patches')
		assert.match(env['EXT_PATCHES_REF'] as string, /^cc.+-r1$/)
		assert.equal(env['EXT_PATCHES_TOKEN'], 'tok-123')
		const saved = readExtPatchesConfig()
		assert.equal(saved?.repo, 'acme/patches')
		assert.equal(saved?.token, 'tok-123')
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('interactive: an existing machine config offers one reuse confirmation and recomputes ref', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		writeExtPatchesConfig({ repo: 'acme/patches', ref: 'cc9.9.9-r1', token: 'saved-tok' })
		// stack, id, name, creds volume, cc, reuse=y, proceed=y
		const ask = answering('', '', '', '', '', 'y', 'y')
		const run = await runInit(dir, { yes: false, input: TTY(), ask, discover: () => [] })
		assert.equal(run.code, 0, run.err)
		const questions = ask.asked.map((question) => question.trim().split(' [')[0] ?? '')
		assert.ok(questions.some((question) => question.startsWith('Reuse ext-patches config from acme/patches?')))
		assert.ok(!questions.some((question) => question.startsWith('Extension patchers repository')))
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['EXT_PATCHES_REPO'], 'acme/patches')
		assert.equal(env['EXT_PATCHES_TOKEN'], 'saved-tok')
		assert.notEqual(env['EXT_PATCHES_REF'], 'cc9.9.9-r1')
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('non-interactive --yes with no flags: no prompt, nothing written to the machine config or .env', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		const run = await runInit(dir)
		assert.equal(run.code, 0, run.err)
		assert.equal(readExtPatchesConfig(), null)
		assert.equal(!existsSync(extPatchesConfigPath()), true)
		assert.equal(readEnvFile(join(dir, '.devcontainer', '.env'))['EXT_PATCHES_REPO'], undefined)
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('non-interactive with --ext-patches-repo/--ext-patches-ref and EXT_PATCHES_TOKEN: written, machine config untouched', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	const originalToken = process.env['EXT_PATCHES_TOKEN']
	process.env['EXT_PATCHES_TOKEN'] = 'env-tok'
	try {
		const run = await runInit(dir, { extPatchesRepo: 'acme/patches', extPatchesRef: 'cc1.0.0-r2' })
		assert.equal(run.code, 0, run.err)
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['EXT_PATCHES_REPO'], 'acme/patches')
		assert.equal(env['EXT_PATCHES_REF'], 'cc1.0.0-r2')
		assert.equal(env['EXT_PATCHES_TOKEN'], 'env-tok')
		assert.equal(readExtPatchesConfig(), null)
	} finally {
		if (originalToken === undefined) delete process.env['EXT_PATCHES_TOKEN']
		else process.env['EXT_PATCHES_TOKEN'] = originalToken
		cleanup()
		home.cleanup()
	}
})

test('an invalid repo shape is rejected and re-asked', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		// discover() returns one existing volume so the default creds-volume
		// choice lands on it rather than "New shared volume…", which would
		// otherwise consume an extra answer slot for its own name sub-prompt.
		const ask = answering('', '', '', '', '', 'not-a-repo', 'acme/patches', '', '', 'n', 'n')
		const run = await runInit(dir, {
			yes: false,
			input: TTY(),
			ask,
			discover: () => [{ name: 'claude-creds-old', projects: [] }],
		})
		assert.equal(run.code, 0, run.err)
		assert.match(run.out, /expected owner\/name/)
	} finally {
		cleanup()
		home.cleanup()
	}
})

