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
import { DEFAULT_BASE_VERSION } from '../src/lib/docker.js'
import { init, type InitOptions } from '../src/commands/init.js'
import { readEnvFile } from '../src/lib/env-file.js'
import { extPatchesConfigPath, readExtPatchesConfig, writeExtPatchesConfig } from '../src/lib/machine-config.js'
import { maskedLine } from '../src/lib/prompts.js'
import type { RepoListing } from '../src/lib/github.js'
import type { HostProbe } from '../src/lib/platform.js'

// A devcontainer exports EXT_PATCHES_TOKEN, and alone it now opts `--yes` into
// the patchers: every test starts without it and sets it where it means to.
delete process.env['EXT_PATCHES_TOKEN']

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
		// The registry is never reached from a test: the template's pin, as offline.
		resolveBase: async () => ({ version: DEFAULT_BASE_VERSION, source: 'default', reason: 'test' }),
		// Nor is api.github.com: a token's repos come from the test, or not at all.
		listRepos: async () => ({ error: 'test: no GitHub' }),
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

/** A fake GitHub: the token it was asked about, and the listing it answers. */
function github(listing: RepoListing): ((token: string) => Promise<RepoListing>) & { tokens: string[] } {
	const tokens: string[] = []
	const listRepos = async (token: string): Promise<RepoListing> => {
		tokens.push(token)
		return listing
	}
	return Object.assign(listRepos, { tokens })
}

const ONE_VOLUME = (): { name: string; projects: string[] }[] => [{ name: 'claude-creds-old', projects: [] }]

function questionsOf(ask: { asked: string[] }): string[] {
	return ask.asked.map((question) => question.trim().split(' [')[0] ?? '')
}

test('interactive: an empty token then an empty repo skips ref and the remember prompt, GitHub never asked', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		const listRepos = github({ repos: ['acme/patches'] })
		const ask = answering('', '', '', '', '', '', '', '', '')
		const run = await runInit(dir, { yes: false, input: TTY(), ask, discover: () => [], listRepos })
		assert.equal(run.code, 0, run.err)
		const questions = questionsOf(ask)
		assert.ok(questions.includes('Extension patchers access token (empty to skip, ctrl-R reveals):'))
		assert.ok(questions.includes('Extension patchers repository (owner/name, empty to skip)'))
		assert.ok(!questions.some((question) => question.startsWith('Ref')))
		assert.ok(!questions.some((question) => question.startsWith('Remember')))
		assert.deepEqual(listRepos.tokens, [])
		assert.equal(readExtPatchesConfig(), null)
		assert.equal(readEnvFile(join(dir, '.devcontainer', '.env'))['EXT_PATCHES_REPO'], undefined)
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('interactive: an empty token still takes a typed public repo', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		// stack, id, name, creds volume, cc, token (empty), repo, ref (Enter=auto), remember=n, proceed=y
		const ask = answering('', '', '', '', '', '', 'acme/patches', '', 'n', 'y')
		const run = await runInit(dir, { yes: false, input: TTY(), ask, discover: ONE_VOLUME })
		assert.equal(run.code, 0, run.err)
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['EXT_PATCHES_REPO'], 'acme/patches')
		assert.equal(env['EXT_PATCHES_TOKEN'], '')
		assert.equal(readExtPatchesConfig(), null)
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('interactive: a token that reads one repo takes it without asking, writes .env, and remembers on confirm', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		const listRepos = github({ repos: ['acme/claude-ext-patchs'] })
		// stack, id, name, creds volume, cc, token, ref (Enter=auto), remember=y, proceed=y
		const ask = answering('', '', '', '', '', 'tok-123', '', 'y', 'y')
		const run = await runInit(dir, { yes: false, input: TTY(), ask, discover: ONE_VOLUME, listRepos })
		assert.equal(run.code, 0, run.err)
		assert.deepEqual(listRepos.tokens, ['tok-123'])
		assert.ok(!questionsOf(ask).some((question) => question.startsWith('Extension patchers repository')))
		assert.match(run.out, /Token reads one repo: acme\/claude-ext-patchs/)
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['EXT_PATCHES_REPO'], 'acme/claude-ext-patchs')
		assert.equal(env['EXT_PATCHES_REF'], undefined, 'Enter on the ref question leaves it auto: the line stays commented')
		assert.equal(env['EXT_PATCHES_TOKEN'], 'tok-123')
		assert.deepEqual(readExtPatchesConfig(), { repo: 'acme/claude-ext-patchs', ref: '', token: 'tok-123' })
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('interactive: a token that reads a few repos lists them, the ext-patch one by default', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		const listRepos = github({ repos: ['acme/app', 'acme/claude-ext-patchs', 'acme/web'] })
		// stack, id, name, creds volume, cc, token, repo choice (Enter=default), ref, remember=n, proceed=y
		const ask = answering('', '', '', '', '', 'tok-123', '', '', 'n', 'y')
		const run = await runInit(dir, { yes: false, input: TTY(), ask, discover: ONE_VOLUME, listRepos })
		assert.equal(run.code, 0, run.err)
		assert.ok(questionsOf(ask).includes('Extension patchers repository'))
		assert.match(run.out, /2\. acme\/claude-ext-patchs\s+← default/)
		assert.match(run.out, /4\. Other \(type owner\/name\)/)
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['EXT_PATCHES_REPO'], 'acme/claude-ext-patchs')
		assert.equal(env['EXT_PATCHES_TOKEN'], 'tok-123')
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('interactive: "Other" in the list asks for the repo by name', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		const listRepos = github({ repos: ['acme/app', 'acme/web'] })
		// …, token, choice 3 = Other, typed repo, ref, remember=n, proceed=y
		const ask = answering('', '', '', '', '', 'tok-123', '3', 'other/patches', '', 'n', 'y')
		const run = await runInit(dir, { yes: false, input: TTY(), ask, discover: ONE_VOLUME, listRepos })
		assert.equal(run.code, 0, run.err)
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['EXT_PATCHES_REPO'], 'other/patches')
		assert.equal(env['EXT_PATCHES_TOKEN'], 'tok-123')
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('interactive: past 20 repos the best candidate is the typed default', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		const repos: string[] = []
		for (let i = 0; i < 30; i++) repos.push(`acme/repo-${i}`)
		repos[17] = 'acme/vscode-ext-patches'
		const ask = answering('', '', '', '', '', 'tok-123', '', '', 'n', 'y')
		const run = await runInit(dir, { yes: false, input: TTY(), ask, discover: ONE_VOLUME, listRepos: github({ repos }) })
		assert.equal(run.code, 0, run.err)
		assert.match(run.out, /30 repos visible/)
		assert.ok(ask.asked.some((question) => question.includes('Extension patchers repository (owner/name, empty to skip) [acme/vscode-ext-patches]')))
		assert.equal(readEnvFile(join(dir, '.devcontainer', '.env'))['EXT_PATCHES_REPO'], 'acme/vscode-ext-patches')
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('interactive: GitHub refusing the token says why and falls back to typing the repo, token kept', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		const listRepos = github({ error: 'GitHub refused this token (401)' })
		const ask = answering('', '', '', '', '', 'tok-123', 'acme/patches', '', 'n', 'y')
		const run = await runInit(dir, { yes: false, input: TTY(), ask, discover: ONE_VOLUME, listRepos })
		assert.equal(run.code, 0, run.err)
		assert.match(run.out, /✗ GitHub refused this token \(401\)/)
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['EXT_PATCHES_REPO'], 'acme/patches')
		assert.equal(env['EXT_PATCHES_TOKEN'], 'tok-123')
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

/** EXT_PATCHES_TOKEN set for the duration of `body`, restored to unset after. */
async function withEnvToken<T>(token: string, body: () => Promise<T>): Promise<T> {
	process.env['EXT_PATCHES_TOKEN'] = token
	try {
		return await body()
	} finally {
		delete process.env['EXT_PATCHES_TOKEN']
	}
}

test('non-interactive with EXT_PATCHES_TOKEN alone, reading one repo: written with that repo', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		const listRepos = github({ repos: ['acme/claude-ext-patchs'] })
		const run = await withEnvToken('env-tok', () => runInit(dir, { listRepos }))
		assert.equal(run.code, 0, run.err)
		assert.deepEqual(listRepos.tokens, ['env-tok'])
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['EXT_PATCHES_REPO'], 'acme/claude-ext-patchs')
		assert.equal(env['EXT_PATCHES_TOKEN'], 'env-tok')
		assert.equal(readExtPatchesConfig(), null)
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('non-interactive with EXT_PATCHES_TOKEN alone, reading several repos: scaffolded without patchers, the list on stderr', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		const run = await withEnvToken('env-tok', () => runInit(dir, { listRepos: github({ repos: ['acme/a', 'acme/b'] }) }))
		assert.equal(run.code, 0, run.err)
		assert.match(run.err, /extension patchers skipped — EXT_PATCHES_TOKEN is set but it reads 2 repos \(acme\/a, acme\/b\); pass --ext-patches-repo/)
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['EXT_PATCHES_REPO'], undefined)
		assert.equal(env['EXT_PATCHES_TOKEN'], undefined)
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('non-interactive with EXT_PATCHES_TOKEN alone, GitHub unreachable: scaffolded without patchers, the reason on stderr', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		const run = await withEnvToken('env-tok', () => runInit(dir, { listRepos: github({ error: 'api.github.com did not answer in time' }) }))
		assert.equal(run.code, 0, run.err)
		assert.match(run.err, /could not be listed \(api\.github\.com did not answer in time\)/)
		assert.equal(readEnvFile(join(dir, '.devcontainer', '.env'))['EXT_PATCHES_REPO'], undefined)
	} finally {
		cleanup()
		home.cleanup()
	}
})

test('an invalid repo shape is rejected and re-asked', async () => {
	const home = fakeHome()
	const { dir, cleanup } = scratch()
	try {
		// …, token (empty), repo (bad, then good), ref, remember=n, proceed=n
		const ask = answering('', '', '', '', '', '', 'not-a-repo', 'acme/patches', '', 'n', 'n')
		const run = await runInit(dir, { yes: false, input: TTY(), ask, discover: ONE_VOLUME })
		assert.equal(run.code, 0, run.err)
		assert.match(run.out, /expected owner\/name/)
		assert.match(run.out, /Ext-patches   : acme\/patches @ auto/)
	} finally {
		cleanup()
		home.cleanup()
	}
})
