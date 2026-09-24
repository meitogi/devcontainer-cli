// End-to-end tests for `devc initialize` against a minimal fixture.
//
// These cover the branch the differential harness cannot reach: the
// interactive path. That harness runs both implementations with stdin not a
// TTY, which is the right choice — it is what CI and a VS Code rebuild hit —
// but it means the Claude-mode prompt never fires there.
//
// The fixture is deliberately bare. No notify/index.js means the daemon spawn
// returns immediately — a property of the code under test, not a stub bolted
// on. Docker does need standing in for, since a missing docker is fatal by
// design and there is none inside this container; the stub records nothing and
// succeeds at everything, which drives the "image already present, no rebuild
// signal" path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { initialize } from '../src/commands/initialize.js'
import { DEFAULT_CLAUDE_CODE_VERSION } from '../src/lib/docker.js'
import type { HostProbe } from '../src/lib/platform.js'

const LINUX_PROBE: HostProbe = { platform: 'linux', env: {}, procVersion: 'Linux version 6.12.76-linuxkit' }

/**
 * Run `fn` with CLAUDE_CODE_VERSION absent from the ambient environment.
 *
 * initialize() resolves the pin as `process.env` overlaid with the .env file,
 * and this container exports CLAUDE_CODE_VERSION because the image bakes it.
 * Without this, a test asserting "the default gets written" reads back the
 * container's own pin instead — which is exactly what happened: the assertion
 * agreed with DEFAULT_CLAUDE_CODE_VERSION by coincidence, and only diverged
 * once the default moved.
 */
async function withoutAmbientPin<T>(fn: () => Promise<T>): Promise<T> {
	const saved = process.env['CLAUDE_CODE_VERSION']
	delete process.env['CLAUDE_CODE_VERSION']
	try {
		return await fn()
	} finally {
		if (saved !== undefined) process.env['CLAUDE_CODE_VERSION'] = saved
	}
}

function fixture(): { projectDir: string; devcontainerDir: string; cleanup: () => void } {
	const projectDir = mkdtempSync(join(tmpdir(), 'devc-init-'))
	const devcontainerDir = join(projectDir, '.devcontainer')
	mkdirSync(join(devcontainerDir, 'firewall'), { recursive: true })
	// devcontainer.json is what identifies the directory as a devcontainer at
	// all — without it the command refuses before writing anything.
	writeFileSync(join(devcontainerDir, 'devcontainer.json'), '{ "name": "fixture" }\n', 'utf8')
	return { projectDir, devcontainerDir, cleanup: () => rmSync(projectDir, { recursive: true, force: true }) }
}

/** Marks the run interactive. Never read from — `ask` supplies the answers. */
const TTY_STDIN = (): NodeJS.ReadableStream & { isTTY?: boolean } =>
	Object.assign(new PassThrough(), { isTTY: true })

const PIPED_STDIN = (): NodeJS.ReadableStream & { isTTY?: boolean } =>
	Object.assign(new PassThrough(), { isTTY: false })

/**
 * Answers queued in order, and a record of what was actually asked.
 *
 * An exhausted queue returns '' — the same thing a user pressing Enter gives,
 * so a test that under-supplies answers reports a wrong value rather than
 * hanging.
 */
function answering(...answers: string[]): ((question: string) => Promise<string>) & { asked: string[] } {
	const asked: string[] = []
	let index = 0
	const ask = async (question: string): Promise<string> => {
		asked.push(question)
		return answers[index++] ?? ''
	}
	return Object.assign(ask, { asked })
}

/**
 * Run with a stub `docker` first on PATH.
 *
 * `mode` is passed to writeFileSync rather than shelled out to chmod, which is
 * blocklisted in this environment anyway.
 */
async function withStubDocker<T>(fn: () => Promise<T>): Promise<T> {
	const binDir = mkdtempSync(join(tmpdir(), 'devc-bin-'))
	writeFileSync(join(binDir, 'docker'), '#!/bin/bash\nexit 0\n', { encoding: 'utf8', mode: 0o755 })
	const saved = process.env['PATH']
	process.env['PATH'] = `${binDir}:${saved ?? ''}`
	try {
		return await fn()
	} finally {
		process.env['PATH'] = saved
		rmSync(binDir, { recursive: true, force: true })
	}
}

/** Run with PATH blanked, so `which docker` cannot resolve anything. */
async function withoutDocker<T>(fn: () => Promise<T>): Promise<T> {
	const saved = process.env['PATH']
	process.env['PATH'] = ''
	try {
		return await fn()
	} finally {
		process.env['PATH'] = saved
	}
}

/** Fails loudly if anything prompts — used where nothing should. */
const neverAsked = async (question: string): Promise<string> => {
	throw new Error(`unexpected prompt: ${question}`)
}

/**
 * A sink for everything the command prints.
 *
 * Not cosmetic. Letting these tests write to the real stdout puts hundreds of
 * lines through the node:test runner's IPC channel, which corrupts its frames
 * and aborts the file with "Unable to deserialize cloned data" — intermittently,
 * and more often right after a rebuild. Capturing the output also makes it
 * assertable.
 */
function captured(): { out: NodeJS.WritableStream; err: NodeJS.WritableStream; text(): string } {
	let buffer = ''
	const sink = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			buffer += chunk.toString('utf8')
			callback()
		},
	})
	return { out: sink, err: sink, text: () => buffer }
}

const read = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null)

test('non-interactive: writes the defaults and syncs the proxy variables', async () => {
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		const code = await withoutAmbientPin(() => withStubDocker(() =>
			initialize({
				devcontainerDir,
				dryRun: false,
				cwd: projectDir,
				input: PIPED_STDIN(),
				probe: LINUX_PROBE,
				...captured(),
			}),
		))

		assert.equal(code, 0)
		assert.equal(read(join(devcontainerDir, 'tmp', 'configured', 'claude-mode')), 'CLAUDE-dev.md\n')
		assert.equal(read(join(devcontainerDir, 'firewall', 'default-mode')), 'strict\n')
		assert.equal(read(join(devcontainerDir, 'tmp', 'logs', 'host-os')), 'linux\n')

		// strict keeps the proxy/CA variables, in the bash order.
		assert.equal(
			read(join(devcontainerDir, '.env')),
			[
				`CLAUDE_CODE_VERSION=${DEFAULT_CLAUDE_CODE_VERSION}`,
				'HTTPS_PROXY=http://127.0.0.1:8080',
				'HTTP_PROXY=http://127.0.0.1:8080',
				'NO_PROXY=localhost,127.0.0.0/8,host.docker.internal,.local',
				'NODE_EXTRA_CA_CERTS=/var/lib/mitmproxy/mitmproxy-ca-cert.pem',
				'',
			].join('\n'),
		)

		// The seeded files the image build COPYs.
		for (const seeded of ['firewall/domains.local.txt', 'firewall/ports.txt']) {
			assert.ok(existsSync(join(devcontainerDir, seeded)), `${seeded} seeded`)
		}
		assert.ok(existsSync(join(devcontainerDir, 'firewall', 'policy.local.d')), 'policy.local.d created')
		assert.ok(existsSync(join(projectDir, '.vscode', 'settings.json')), '.vscode stub created')
	} finally {
		cleanup()
	}
})

test('a first interactive run now reaches the Claude-mode prompt', async () => {
	// This test used to assert the opposite, and it was faithful to the bash
	// script: on a fresh setup both flags were absent, prompt_auth ran, and
	// prompt_auth itself wrote MODE_FLAG (initialize.sh:526). By the time the
	// next line tested `[ ! -f "$MODE_FLAG" ]` the file existed, so the only
	// real question in the wizard was skipped and the "Press Enter" pause never
	// fired — the wizard asked nobody anything.
	//
	// The GitHub Auth step is gone, so nothing seeds MODE_FLAG behind our back
	// and the prompt fires where it always should have.
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		// Answers the mode prompt, then the "Press Enter to continue..." pause.
		const code = await withStubDocker(() =>
			initialize({ devcontainerDir, dryRun: false, cwd: projectDir, input: TTY_STDIN(), ask: answering('2'), probe: LINUX_PROBE, ...captured() }),
		)
		assert.equal(code, 0)
		assert.equal(read(join(devcontainerDir, 'tmp', 'configured', 'claude-mode')), 'CLAUDE-reviewer.md\n')
		// The retired flag must not come back by a side door.
		assert.equal(existsSync(join(devcontainerDir, 'tmp', 'configured', 'auth')), false)
	} finally {
		cleanup()
	}
})

test('interactive: answering 2 selects the reviewer flavour', async () => {
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		// Second line answers the "Press Enter to continue..." pause.
		const code = await withStubDocker(() =>
			initialize({ devcontainerDir, dryRun: false, cwd: projectDir, input: TTY_STDIN(), ask: answering('2'), probe: LINUX_PROBE, ...captured() }),
		)
		assert.equal(code, 0)
		assert.equal(read(join(devcontainerDir, 'tmp', 'configured', 'claude-mode')), 'CLAUDE-reviewer.md\n')
	} finally {
		cleanup()
	}
})

test('interactive: an empty answer defaults to dev', async () => {
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		const code = await withStubDocker(() =>
			initialize({ devcontainerDir, dryRun: false, cwd: projectDir, input: TTY_STDIN(), ask: answering(''), probe: LINUX_PROBE, ...captured() }),
		)
		assert.equal(code, 0)
		assert.equal(read(join(devcontainerDir, 'tmp', 'configured', 'claude-mode')), 'CLAUDE-dev.md\n')
	} finally {
		cleanup()
	}
})

test('a missing docker is no longer fatal — the version pin lands, the probe is skipped', async () => {
	// The local base build was the only step that could not proceed without
	// docker; with the image pulled by compose there is nothing left to build,
	// so a missing docker just skips the rebuild-vs-reopen probe. The bash
	// ordering guarantee survives in its new form: the .env pin lands before the
	// probe, so it is present even on a docker-less host.
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		const code = await withoutAmbientPin(() => withoutDocker(() =>
			initialize({
				devcontainerDir,
				dryRun: false,
				cwd: projectDir,
				input: PIPED_STDIN(),
				probe: LINUX_PROBE,
				...captured(),
			}),
		))
		assert.equal(code, 0)
		assert.match(
			read(join(devcontainerDir, '.env')) ?? '',
			new RegExp(`^CLAUDE_CODE_VERSION=${DEFAULT_CLAUDE_CODE_VERSION.replace(/\./g, '\\.')}$`, 'm'),
		)
	} finally {
		cleanup()
	}
})

test('a second run re-prompts nothing and leaves the flags alone', async () => {
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		await withStubDocker(() =>
			initialize({ devcontainerDir, dryRun: false, cwd: projectDir, input: TTY_STDIN(), ask: answering('2'), probe: LINUX_PROBE, ...captured() }),
		)
		// No answers queued: if anything prompted, the run would hang or default.
		const code = await withStubDocker(() =>
			initialize({ devcontainerDir, dryRun: false, cwd: projectDir, input: TTY_STDIN(), ask: neverAsked, probe: LINUX_PROBE, ...captured() }),
		)
		assert.equal(code, 0)
		assert.equal(read(join(devcontainerDir, 'tmp', 'configured', 'claude-mode')), 'CLAUDE-reviewer.md\n')
	} finally {
		cleanup()
	}
})

test('a manual edit of firewall/default-mode re-aligns .env on the next run', async () => {
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		await withStubDocker(() =>
			initialize({
				devcontainerDir,
				dryRun: false,
				cwd: projectDir,
				input: PIPED_STDIN(),
				probe: LINUX_PROBE,
				...captured(),
			}),
		)
		assert.match(read(join(devcontainerDir, '.env')) ?? '', /HTTPS_PROXY=/)

		// basic clears the four variables — the idempotent re-sync bash does at
		// initialize.sh:647.
		writeFileSync(join(devcontainerDir, 'firewall', 'default-mode'), 'basic\n', 'utf8')
		await withStubDocker(() =>
			initialize({
				devcontainerDir,
				dryRun: false,
				cwd: projectDir,
				input: PIPED_STDIN(),
				probe: LINUX_PROBE,
				...captured(),
			}),
		)
		const env = read(join(devcontainerDir, '.env')) ?? ''
		for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) {
			assert.doesNotMatch(env, new RegExp(`^${key}=`, 'm'), `${key} cleared in basic`)
		}
		assert.match(env, /^CLAUDE_CODE_VERSION=/m, 'unrelated keys survive')
	} finally {
		cleanup()
	}
})

test('a project still on direct-tcp-allow.txt is not given a second ports file', async () => {
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		// ports.txt was called direct-tcp-allow.txt until 2026-08-10. Seeding the
		// new name next to the old one would leave the firewall reading one file
		// and ignoring the other — the rules a human wrote silently not applied.
		mkdirSync(join(devcontainerDir, 'firewall'), { recursive: true })
		writeFileSync(join(devcontainerDir, 'firewall', 'direct-tcp-allow.txt'), 'host:9222\n', 'utf8')

		await withStubDocker(() =>
			initialize({
				devcontainerDir,
				dryRun: false,
				cwd: projectDir,
				input: PIPED_STDIN(),
				probe: LINUX_PROBE,
				...captured(),
			}),
		)

		assert.ok(!existsSync(join(devcontainerDir, 'firewall', 'ports.txt')), 'no second ports file created')
		assert.equal(read(join(devcontainerDir, 'firewall', 'direct-tcp-allow.txt')), 'host:9222\n', 'the old file is left alone')
	} finally {
		cleanup()
	}
})

test('an unsupported host is refused by name before anything is written', async () => {
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		const code = await initialize({
			devcontainerDir,
			dryRun: false,
			cwd: projectDir,
			input: PIPED_STDIN(),
			probe: { platform: 'win32', env: { MSYSTEM: 'CYGWIN_NT-10.0' }, procVersion: null },
			...captured(),
		})
		assert.equal(code, 1)
		assert.equal(existsSync(join(devcontainerDir, 'tmp', 'logs')), false, 'nothing written')
	} finally {
		cleanup()
	}
})

test('dry-run writes nothing at all', async () => {
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		const code = await withStubDocker(() =>
			initialize({
				devcontainerDir,
				dryRun: true,
				cwd: projectDir,
				input: PIPED_STDIN(),
				probe: LINUX_PROBE,
				...captured(),
			}),
		)
		assert.equal(code, 0)
		for (const path of [
			join(devcontainerDir, '.env'),
			join(devcontainerDir, 'tmp', 'configured', 'claude-mode'),
			join(devcontainerDir, 'tmp', 'logs'),
			join(projectDir, '.vscode'),
		]) {
			assert.equal(existsSync(path), false, `${path} must not exist after a dry run`)
		}
		// The one pre-existing file must be untouched, not truncated.
		assert.equal(read(join(devcontainerDir, 'firewall', 'default-mode')), null)
	} finally {
		cleanup()
	}
})

test('a padded answer still selects the reviewer flavour, like bash read', () => {
	// Not a divergence, despite looking like one. `read -p "..." CLAUDE_MODE`
	// strips leading and trailing IFS whitespace before assigning, so bash
	// compares "2" against "2" for an input of "2 ". Verified against real bash:
	//   printf '2 \n' | bash -c 'read -p p: M; [ "$M" = 2 ] && echo match'
	// The port's .trim() reproduces that; without it the two would diverge.
	assert.equal('2 '.trim(), '2')
	assert.equal('\t2\t'.trim(), '2')
})

test('a padded answer produces the same flag file as an unpadded one', async () => {
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		const code = await withStubDocker(() =>
			initialize({
				devcontainerDir,
				dryRun: false,
				cwd: projectDir,
				input: TTY_STDIN(),
				ask: answering('  2  '),
				probe: LINUX_PROBE,
				...captured(),
			}),
		)
		assert.equal(code, 0)
		assert.equal(read(join(devcontainerDir, 'tmp', 'configured', 'claude-mode')), 'CLAUDE-reviewer.md\n')
	} finally {
		cleanup()
	}
})

test('an unwritable notify queue does not fail the run', async () => {
	// `spawn_notify_daemon || true` (initialize.sh:656). The daemon is a
	// convenience; a container must still come up without it.
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		// Pre-seed the mode flag so nothing prompts. writeFlag() creates its own
		// parents in the code under test; a raw writeFileSync does not.
		mkdirSync(join(devcontainerDir, 'tmp', 'configured'), { recursive: true })
		writeFileSync(join(devcontainerDir, 'tmp', 'configured', 'claude-mode'), 'CLAUDE-dev.md\n', 'utf8')
		mkdirSync(join(devcontainerDir, 'notify'), { recursive: true })
		writeFileSync(join(devcontainerDir, 'notify', 'index.js'), '', 'utf8')
		// A regular file where the queue directory has to go: mkdirSync throws
		// ENOTDIR, exactly as an unwritable mount point would. The queue lives
		// under tmp/ now, while the entrypoint stays at notify/index.js.
		writeFileSync(join(devcontainerDir, 'tmp', 'notify'), '', 'utf8')

		const code = await withStubDocker(() =>
			initialize({
				devcontainerDir,
				dryRun: false,
				cwd: projectDir,
				input: TTY_STDIN(),
				ask: neverAsked,
				probe: LINUX_PROBE,
				...captured(),
			}),
		)
		assert.equal(code, 0, 'the run still succeeds')
		assert.equal(read(join(devcontainerDir, 'firewall', 'default-mode')), 'strict\n')
	} finally {
		cleanup()
	}
})

test('refuses a directory that is not a devcontainer, before writing anything', async () => {
	// The bash script could not reach this state: DEVCONTAINER_DIR came from
	// `dirname $0`, so the directory provably held the script and its siblings.
	// Accepting a path from the caller removes that guarantee.
	const projectDir = mkdtempSync(join(tmpdir(), 'devc-bare-'))
	try {
		const devcontainerDir = join(projectDir, '.devcontainer')
		mkdirSync(devcontainerDir, { recursive: true })
		const sink = captured()

		const code = await withStubDocker(() =>
			initialize({ devcontainerDir, dryRun: false, cwd: projectDir, input: PIPED_STDIN(), probe: LINUX_PROBE, ...sink }),
		)

		assert.equal(code, 1)
		assert.match(sink.text(), /has no devcontainer\.json/)
		assert.match(sink.text(), /devc init/, 'names the command that would fix it')
		// The failure mode this guards against is a half-mutated project.
		assert.deepEqual(readdirSync(devcontainerDir), [], 'nothing written into the target')
		assert.equal(existsSync(join(projectDir, '.vscode')), false, 'no .vscode stub either')
	} finally {
		rmSync(projectDir, { recursive: true, force: true })
	}
})

test('refuses a missing .devcontainer and says so', async () => {
	const projectDir = mkdtempSync(join(tmpdir(), 'devc-none-'))
	try {
		const sink = captured()
		const code = await initialize({
			devcontainerDir: join(projectDir, '.devcontainer'),
			dryRun: false,
			cwd: projectDir,
			input: PIPED_STDIN(),
			probe: LINUX_PROBE,
			...sink,
		})
		assert.equal(code, 1)
		assert.match(sink.text(), /No \.devcontainer at/)
		assert.deepEqual(readdirSync(projectDir), [], 'the project is untouched')
	} finally {
		rmSync(projectDir, { recursive: true, force: true })
	}
})

test('a project root resolves to its .devcontainer', async () => {
	// `--devcontainer-dir ../some-project` is the natural way to say it.
	const { projectDir, devcontainerDir, cleanup } = fixture()
	try {
		const code = await withStubDocker(() =>
			initialize({
				devcontainerDir: projectDir,
				dryRun: false,
				cwd: '/nonexistent',
				input: PIPED_STDIN(),
				probe: LINUX_PROBE,
				...captured(),
			}),
		)
		assert.equal(code, 0)
		assert.equal(read(join(devcontainerDir, 'firewall', 'default-mode')), 'strict\n')
	} finally {
		cleanup()
	}
})

test('nothing builds the base image — even when a Dockerfile.base is present', async () => {
	// The registry-image shape is the rule, not a branch: compose pulls the
	// published tag, and a leftover Dockerfile.base (the dogfood keeps one as an
	// escape hatch) must not resurrect the local build. The tracing stub records
	// every docker argv so the assertion is on what ran, not on a message.
	const { projectDir, devcontainerDir, cleanup } = fixture()
	const binDir = mkdtempSync(join(tmpdir(), 'devc-trace-'))
	const trace = join(binDir, 'trace.txt')
	writeFileSync(join(binDir, 'docker'), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(trace)}\nexit 0\n`, {
		encoding: 'utf8',
		mode: 0o755,
	})
	const savedPath = process.env['PATH']
	process.env['PATH'] = `${binDir}:${savedPath ?? ''}`
	try {
		writeFileSync(join(devcontainerDir, 'Dockerfile.base'), 'FROM scratch\n', 'utf8')
		const sink = captured()
		const code = await initialize({
			devcontainerDir,
			dryRun: false,
			cwd: projectDir,
			input: PIPED_STDIN(),
			probe: LINUX_PROBE,
			...sink,
		})
		assert.equal(code, 0)
		const argvs = read(trace) ?? ''
		assert.doesNotMatch(argvs, /^build\b/m, 'no docker build was spawned')
		assert.match(argvs, /^ps -a -q --filter/m, 'the reopen probe still ran')
		assert.doesNotMatch(sink.text(), /Building Claude Devcontainer Base/)
	} finally {
		process.env['PATH'] = savedPath
		rmSync(binDir, { recursive: true, force: true })
		cleanup()
	}
})
