// End-to-end: `devc init` against scratch directories, through the same seams
// `devc initialize` uses — `ask` for the questions, `out`/`err` so nothing
// reaches the test runner's IPC channel, `discover` and `installer` so no
// docker daemon or registry is needed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { init, type InitOptions } from '../src/commands/init.js'
import { readDevcontainerJson, readStitchuCustomizations } from '../src/lib/devcontainer-json.js'
import { readEnvFile } from '../src/lib/env-file.js'
import type { HostProbe } from '../src/lib/platform.js'

const LINUX_PROBE: HostProbe = { platform: 'linux', env: {}, procVersion: 'Linux version 6.12.76-linuxkit' }

function scratch(name = 'demo-app'): { dir: string; cleanup: () => void } {
	const parent = mkdtempSync(join(tmpdir(), 'devc-init-'))
	const dir = join(parent, name)
	mkdirSync(dir)
	return { dir, cleanup: () => rmSync(parent, { recursive: true, force: true }) }
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

interface Run {
	code: number
	out: string
	err: string
	installs: string[][]
}

async function runInit(dir: string, overrides: Partial<InitOptions> = {}): Promise<Run> {
	const out = sink()
	const err = sink()
	const installs: string[][] = []
	const code = await init({
		cwd: dir,
		yes: true,
		dryRun: false,
		input: PIPE(),
		out,
		err,
		probe: LINUX_PROBE,
		discover: () => [],
		installer: async (_projectDir, argv) => {
			installs.push([...argv])
			return 0
		},
		...overrides,
	})
	return { code, out: out.text(), err: err.text(), installs }
}

function tree(dir: string): string[] {
	const out: string[] = []
	const walk = (path: string, prefix: string): void => {
		for (const name of readdirSync(path).sort()) {
			const abs = join(path, name)
			const rel = prefix.length === 0 ? name : `${prefix}/${name}`
			if (statSync(abs).isDirectory()) walk(abs, rel)
			else out.push(rel)
		}
	}
	walk(dir, '')
	return out
}

function contents(dir: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const path of tree(dir)) out[path] = readFileSync(join(dir, path), 'utf8')
	return out
}

test('--yes scaffolds the tree, the manifest, and runs the install', async () => {
	const { dir, cleanup } = scratch()
	try {
		const run = await runInit(dir)
		assert.equal(run.code, 0, run.err)
		const files = tree(dir)
		assert.ok(files.includes('.devcontainer/devcontainer.json'))
		assert.ok(files.includes('.devcontainer/.env'))
		assert.ok(files.includes('.devcontainer/hooks/post-start.d/README.md'))
		assert.ok(files.includes('.claude/settings.local.json'))
		assert.ok(files.includes('package.json'))
		assert.ok(files.includes('.gitignore'))
		assert.ok(files.includes('LESSONS.md'), 'symlink is listed by readdir')
		assert.ok(!files.includes('.devcontainer/initialize.sh'), 'the CLI supersedes the script')
		assert.ok(!files.includes('.devcontainer/README.md'))

		const json = join(dir, '.devcontainer', 'devcontainer.json')
		assert.ok(readDevcontainerJson(json) !== null)
		assert.ok(Object.keys(readStitchuCustomizations(json)).length > 0)
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['DC_PROJECT'], 'demo-app')
		assert.equal(env['CLAUDE_CREDS_VOLUME'], 'claude-creds-shared', 'no volume discovered → the new-volume default')
		const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
		assert.match(manifest.devDependencies['@meitogi/devcontainer-cli'] ?? '', /^\^0\./)
		assert.deepEqual(run.installs, [['npm', 'install']])
		assert.match(run.out, /Reopen in Container/)
		assert.doesNotMatch(run.out, /1\. npm install/, 'installed already, so not a next step')
	} finally {
		cleanup()
	}
})

test('a second run over its own output changes nothing and preserves a hand-edited .env', async () => {
	const { dir, cleanup } = scratch()
	try {
		assert.equal((await runInit(dir)).code, 0)
		const envFile = join(dir, '.devcontainer', '.env')
		writeFileSync(envFile, `${readFileSync(envFile, 'utf8')}MY_OWN=1\n`, 'utf8')
		const before = contents(dir)
		const again = await runInit(dir)
		assert.equal(again.code, 0, again.err)
		assert.match(again.out, /scaffolded by this CLI — nothing to re-scaffold/)
		assert.match(again.out, /Nothing to do\./)
		assert.deepEqual(contents(dir), before)
		assert.deepEqual(again.installs, [], 'no install on a re-run')
	} finally {
		cleanup()
	}
})

test('a re-run adds a missing file and reports edited managed files without touching them', async () => {
	const { dir, cleanup } = scratch()
	try {
		assert.equal((await runInit(dir)).code, 0)
		rmSync(join(dir, '.devcontainer', 'skills', 'disabled.txt'))
		writeFileSync(join(dir, '.devcontainer', '.dockerignore'), 'mine\n', 'utf8')
		const again = await runInit(dir)
		assert.equal(again.code, 0)
		assert.match(again.out, /\+ \.devcontainer\/skills\/disabled\.txt/)
		assert.match(again.out, /1 managed file\(s\) differ/)
		assert.equal(readFileSync(join(dir, '.devcontainer', '.dockerignore'), 'utf8'), 'mine\n')
		assert.ok(existsSync(join(dir, '.devcontainer', 'skills', 'disabled.txt')))
	} finally {
		cleanup()
	}
})

// Every other test here injects `ask`, which leaves `readlineAsk` unused — so
// none of them ever exercised the real interface. That seam hid a defect: the
// state-2 path returned its promise without awaiting it, so the `finally`
// closed readline while the question was pending, the answer was never read
// and node exited 13 on an unsettled await. This test drives the genuine
// readline over a TTY-shaped stream; with the defect it times out.
test('the state-2 confirmation is read from a real readline, not a stubbed seam', { timeout: 5000 }, async () => {
	const { dir, cleanup } = scratch()
	try {
		assert.equal((await runInit(dir)).code, 0)
		const missing = join(dir, '.devcontainer', 'skills', 'disabled.txt')
		rmSync(missing)

		const out = sink()
		const err = sink()
		const input = Object.assign(new PassThrough(), { isTTY: true })
		const running = init({
			cwd: dir,
			yes: false,
			dryRun: false,
			input,
			out,
			err,
			probe: LINUX_PROBE,
			discover: () => [],
			installer: async () => 0,
		})
		input.write('y\n')

		assert.equal(await running, 0, err.text())
		assert.match(out.text(), /Add the missing files\? \[Y\/n\]:/)
		assert.ok(existsSync(missing), 'the answer was read and acted on')
	} finally {
		cleanup()
	}
})

test('a v2 tree is refused with exit 1 and nothing written', async () => {
	const { dir, cleanup } = scratch()
	try {
		mkdirSync(join(dir, '.devcontainer'))
		writeFileSync(join(dir, '.devcontainer', 'devcontainer.json'), '{}', 'utf8')
		writeFileSync(join(dir, '.devcontainer', 'Dockerfile.base'), 'FROM node\n', 'utf8')
		writeFileSync(join(dir, '.devcontainer', '.configured-setup'), 'VERSION="2.1.0"\n', 'utf8')
		const before = tree(dir)
		const run = await runInit(dir)
		assert.equal(run.code, 1)
		assert.match(run.err, /^devc init: refusing — .*v2 layout made by install\.sh/m)
		assert.doesNotMatch(run.err, /\/workspace\//)
		assert.deepEqual(tree(dir), before)
	} finally {
		cleanup()
	}
})

test("another tool's devcontainer is refused", async () => {
	const { dir, cleanup } = scratch()
	try {
		mkdirSync(join(dir, '.devcontainer'))
		writeFileSync(join(dir, '.devcontainer', 'devcontainer.json'), '{ "image": "mcr.microsoft.com/devcontainers/base" }', 'utf8')
		const run = await runInit(dir)
		assert.equal(run.code, 1)
		assert.match(run.err, /without a customizations\.stitchu-devc block/)
	} finally {
		cleanup()
	}
})

test('stdin not a terminal without --yes is a usage error', async () => {
	const { dir, cleanup } = scratch()
	try {
		const run = await runInit(dir, { yes: false })
		assert.equal(run.code, 2)
		assert.match(run.err, /--yes/)
		assert.ok(!existsSync(join(dir, '.devcontainer')))
	} finally {
		cleanup()
	}
})

test('invalid flag values are usage errors, checked before anything is written', async () => {
	const { dir, cleanup } = scratch()
	try {
		assert.equal((await runInit(dir, { projectId: 'Bad_Slug' })).code, 2)
		assert.equal((await runInit(dir, { displayName: 'has "quotes"' })).code, 2)
		assert.equal((await runInit(dir, { credsVolume: '-bad' })).code, 2)
		assert.equal((await runInit(dir, { stack: 'cobol' })).code, 2)
		assert.equal((await runInit(dir, { claudeCodeVersion: 'latest' })).code, 2)
		assert.ok(!existsSync(join(dir, '.devcontainer')))
	} finally {
		cleanup()
	}
})

test('--yes with a directory name that sanitises to nothing falls back to "devcontainer"', async () => {
	const { dir, cleanup } = scratch('___')
	try {
		const run = await runInit(dir)
		assert.equal(run.code, 0, run.err)
		assert.equal(readEnvFile(join(dir, '.devcontainer', '.env'))['DC_PROJECT'], 'devcontainer')
	} finally {
		cleanup()
	}
})

test('flags override the defaults and reach the files', async () => {
	const { dir, cleanup } = scratch()
	try {
		const run = await runInit(dir, {
			projectId: 'custom-id',
			displayName: 'Custom Name',
			credsVolume: 'none',
			stack: 'php',
			claudeCodeVersion: '2.1.220',
		})
		assert.equal(run.code, 0, run.err)
		const env = readEnvFile(join(dir, '.devcontainer', '.env'))
		assert.equal(env['DC_PROJECT'], 'custom-id')
		assert.equal(env['CLAUDE_CREDS_VOLUME'], undefined)
		assert.equal(env['BASE_IMAGE'], 'ghcr.io/meitogi/devcontainer-sandbox:1.2.0-cc2.1.220')
		assert.equal(readDevcontainerJson(join(dir, '.devcontainer', 'devcontainer.json'))?.['name'], 'Custom Name — Claude Code Sandbox')
		assert.match(readFileSync(join(dir, '.devcontainer', 'claude', 'CLAUDE-project.md'), 'utf8'), /Default stack\*\* : PHP/)
		assert.match(run.out, /stacks\/php\.md/)
	} finally {
		cleanup()
	}
})

test('--dry-run writes nothing and installs nothing', async () => {
	const { dir, cleanup } = scratch()
	try {
		const run = await runInit(dir, { dryRun: true })
		assert.equal(run.code, 0)
		assert.match(run.out, /Would write:/)
		assert.deepEqual(tree(dir), [])
		assert.deepEqual(run.installs, [])
	} finally {
		cleanup()
	}
})

test('--no-install leaves the install as the first next step', async () => {
	const { dir, cleanup } = scratch()
	try {
		const run = await runInit(dir, { install: false })
		assert.equal(run.code, 0)
		assert.deepEqual(run.installs, [])
		assert.match(run.out, /1\. npm install/)
	} finally {
		cleanup()
	}
})

test('interactive: the questions come in order, the most shared volume is the default, Enter takes defaults', async () => {
	const { dir, cleanup } = scratch()
	try {
		const ask = answering('', '', '', '', '', '', '', '')
		const run = await runInit(dir, {
			yes: false,
			input: TTY(),
			ask,
			discover: () => [
				{ name: 'claude-creds-shared', projects: ['alpha', 'beta'] },
				{ name: 'claude-creds-alpha', projects: ['alpha'] },
			],
		})
		assert.equal(run.code, 0, run.err)
		const questions = ask.asked.map((question) => question.trim().split(' [')[0])
		assert.deepEqual(questions, [
			'Stack',
			'Project id',
			'Display name',
			'Claude credentials volume',
			'Claude Code line',
			'Extension patchers repository (owner/name, empty to skip)',
			'Proceed?',
			'Install @meitogi/devcontainer-cli locally now (npm install)?',
		])
		assert.match(run.out, /shared by 2 projects \(alpha, beta\)/)
		assert.match(run.out, /used by 1 project \(alpha\)/)
		assert.match(run.out, /Detected: Node\.js|Detected: nothing recognisable/)
		assert.equal(readEnvFile(join(dir, '.devcontainer', '.env'))['CLAUDE_CREDS_VOLUME'], 'claude-creds-shared')
		assert.deepEqual(run.installs, [['npm', 'install']])
	} finally {
		cleanup()
	}
})

test('interactive: an invalid slug is re-asked, a new volume is named, and "n" at the summary aborts cleanly', async () => {
	const { dir, cleanup } = scratch()
	try {
		// stack (Enter), id (bad, then good), name (Enter), volume: option 2 = new…, then its name,
		// cc (Enter), ext-patches repo (Enter = skip), proceed: n
		const ask = answering('', 'Bad Slug', 'good-slug', '', '2', 'claude-creds-team', '', '', 'n')
		const run = await runInit(dir, {
			yes: false,
			input: TTY(),
			ask,
			discover: () => [{ name: 'claude-creds-old', projects: [] }],
		})
		assert.equal(run.code, 0, run.err)
		assert.match(run.out, /cannot start or end with/)
		assert.match(run.out, /Project id    : good-slug/)
		assert.match(run.out, /Creds volume  : claude-creds-team/)
		assert.match(run.out, /Aborted — nothing written/)
		assert.deepEqual(tree(dir), [])
	} finally {
		cleanup()
	}
})

test('interactive: three invalid answers abandon the prompt with exit 2', async () => {
	const { dir, cleanup } = scratch()
	try {
		const run = await runInit(dir, { yes: false, input: TTY(), ask: answering('', 'A', 'B', 'C') })
		assert.equal(run.code, 2)
		assert.match(run.err, /after 3 attempts/)
		assert.deepEqual(tree(dir), [])
	} finally {
		cleanup()
	}
})

test('an existing package.json gains the devDependency without being reformatted', async () => {
	const { dir, cleanup } = scratch()
	try {
		const original = '{\n    "name": "theirs",\n    "version": "1.0.0",\n    "devDependencies": {\n        "typescript": "^5.0.0"\n    }\n}\n'
		writeFileSync(join(dir, 'package.json'), original, 'utf8')
		const run = await runInit(dir)
		assert.equal(run.code, 0, run.err)
		const after = readFileSync(join(dir, 'package.json'), 'utf8')
		assert.match(after, /^        "@meitogi\/devcontainer-cli": "\^0\.[0-9.]+",\n        "typescript": "\^5\.0\.0"$/m)
		assert.equal(after.replace(/^        "@meitogi\/devcontainer-cli": "[^"]+",\n/m, ''), original)
		assert.match(run.out, /~ package\.json/)
	} finally {
		cleanup()
	}
})

test('an unreadable package.json is left alone, the line to add is printed, no install runs', async () => {
	const { dir, cleanup } = scratch()
	try {
		writeFileSync(join(dir, 'package.json'), '{ not json', 'utf8')
		const run = await runInit(dir)
		assert.equal(run.code, 0)
		assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{ not json')
		assert.match(run.err, /package\.json left alone: the file is not valid JSON/)
		assert.match(run.err, /"@meitogi\/devcontainer-cli": "\^/)
		assert.deepEqual(run.installs, [])
	} finally {
		cleanup()
	}
})

test('a failed install is reported and left as the first next step', async () => {
	const { dir, cleanup } = scratch()
	try {
		const run = await runInit(dir, { installer: async () => 1 })
		assert.equal(run.code, 0)
		assert.match(run.err, /npm exited with 1/)
		assert.match(run.out, /1\. npm install/)
	} finally {
		cleanup()
	}
})

test('a missing target directory is a usage error', async () => {
	const { dir, cleanup } = scratch()
	try {
		const run = await runInit(dir, { targetDir: 'nope' })
		assert.equal(run.code, 2)
	} finally {
		cleanup()
	}
})
