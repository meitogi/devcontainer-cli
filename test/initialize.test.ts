// End-to-end tests for `devc initialize` against a minimal fixture.
//
// These cover the branch the differential harness cannot reach: the
// interactive path. That harness runs both implementations with stdin not a
// TTY, which is what CI hits, but it means the Claude-mode prompt never fires
// there.
//
// It is NOT what a VS Code boot hits, contrary to what this comment claimed
// until 2026-10-06. Measured against Dev Containers 0.459.1 on macOS: VS Code
// runs initializeCommand as `/bin/sh -c <command>` under
// devContainersSpecCLI.js up, and the child sees stdin as a TTY (stdout not).
// So a real Reopen or Rebuild takes the interactive path, which is what makes
// asking a question from here work at all.
//
// The fixture is deliberately bare, and NOTIFY_DAEMON_DIR below keeps it that
// way: the package now ships its own notify/index.js, so without the override
// every dryRun:false test here would spawn a real daemon against its own scratch
// directory and leave it running after the directory is gone. Pointing the
// override at the fixture's absent notify/ restores the property these tests
// rely on — the spawn reports and returns instead of launching anything.
// Docker does need standing in for, since a missing docker is fatal by
// design and there is none inside this container; the stub records nothing and
// succeeds at everything, which drives the "image already present, no rebuild
// signal" path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { initialize, stamp } from '../src/commands/initialize.js'
import { DEFAULT_CLAUDE_CODE_VERSION } from '../src/lib/docker.js'
import type { HostProbe } from '../src/lib/platform.js'

// Relative to devcontainerDir, so it lands inside each fixture rather than on a
// fixed absolute path. `notify` and not a path that cannot exist: the test at
// "an unwritable notify queue does not fail the run" writes a real index.js there
// and needs the spawn to get as far as the queue mkdirSync.
process.env['NOTIFY_DAEMON_DIR'] = 'notify'

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

/** The boot id's shape, asserted rather than described. */
const BOOT_ID_RE = /^\d{8}T\d{6}Z$/

// D3. Pinned against a FIXED instant, not `new Date()`: a test that stamps "now"
// and reparses it passes in any time zone, including the local-time behaviour
// this replaces. The literal below is the very boot from EXISTING.md § 3 whose
// two halves were logged two hours apart — 07:37:43 UTC was what the container
// wrote while the host wrote 09:32:03. Only a UTC stamp can answer 073743 here,
// and this suite runs in a container whose TZ is empty.
test('stamp is UTC and fixed-width, so the boot id cannot drift with the host clock', () => {
	assert.equal(stamp(new Date('2026-10-06T07:37:43.000Z')), '20261006T073743Z')
	assert.match(stamp(new Date('2026-10-06T07:37:43.000Z')), BOOT_ID_RE)

	// Zero-padded in every field, which is what makes lexicographic order
	// chronological order — the property shell-init.sh:28-30 refuses `ls -t` for.
	assert.equal(stamp(new Date('2026-01-02T03:04:05.000Z')), '20260102T030405Z')
	assert.ok(
		stamp(new Date('2026-01-02T03:04:05.000Z')) < stamp(new Date('2026-01-02T03:04:06.000Z')),
		'one second later must sort later as a string',
	)

	// An instant that is a different DAY in a western zone and in UTC. If these
	// accessors ever go back to local time, this is the assertion that fails
	// wherever the suite runs, instead of only east of Greenwich.
	assert.equal(stamp(new Date('2026-10-06T00:30:00.000Z')), '20261006T003000Z')
})

test('a real run files its log under the boot id, and .boot-id hands that id over', async () => {
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

		const logs = join(devcontainerDir, 'tmp', 'logs')
		const entries = readdirSync(logs)
		const bootDirs = entries.filter((name) => BOOT_ID_RE.test(name))
		assert.equal(bootDirs.length, 1, `exactly one boot folder, got ${JSON.stringify(entries)}`)
		const bootId = bootDirs[0] as string

		// The file is the channel the container reads (D4), so its exact bytes
		// matter: one line, the id, a trailing newline — the shape writeHostOs
		// established and devc-hook's `tr -d '[:space:]'` expects.
		assert.equal(read(join(logs, '.boot-id')), `${bootId}\n`)

		// The leaf carries the same stamp as its folder: on the host side the boot
		// id IS initialize's own stamp. This is the host half of the two-hour gap
		// being closed — the container half is asserted in overlay.test.sh.
		assert.deepEqual(readdirSync(join(logs, bootId)).sort(), [`initialize-${bootId}.log`])

		// host-os does NOT move: cdp.mjs:103 resolves it flat, and so does
		// test/differential/run.mjs:182.
		assert.equal(read(join(logs, 'host-os')), 'linux\n')
	} finally {
		cleanup()
	}
})

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
			// Named on its own line rather than left to the tmp/logs/ assertion
			// above: a .boot-id written by a dry run would be adopted by the next
			// real boot and silently merge two boots into one folder.
			join(devcontainerDir, 'tmp', 'logs', '.boot-id'),
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

test('the screen is one vocabulary, names both versions, and keeps recipes in the log', async () => {
	// Three things this pins, each of which was wrong at some point today.
	//
	// One vocabulary: the v2 script opened "=== DevContainer Setup ===" over a
	// section whose only content was "=== Claude Mode ===", and the first rewrite
	// added boxes on top of that. A frame, then loose text, then a frame.
	//
	// Both versions named. The panel used to show one opaque tag, and it derived
	// it from this package's own constants instead of reading the tree — so it
	// named an image that was never published the first time anyone looked.
	//
	// No emoji-presentation glyph reaches the screen: they stop taking colour and
	// start taking two columns, which is what the ASCII markers exist for.
	const { projectDir, devcontainerDir, cleanup } = fixture()
	const capture = captured()
	try {
		// A pin DEFAULT_BASE_VERSION would never produce, so a derivation cannot
		// pass this by accident.
		writeFileSync(
			join(devcontainerDir, 'Dockerfile'),
			'ARG BASE_IMAGE=ghcr.io/meitogi/devcontainer-sandbox:1.4.1-cc2.1.272\nFROM ${BASE_IMAGE}\n',
			'utf8',
		)
		const code = await withStubDocker(() =>
			withoutAmbientPin(() =>
				initialize({
					devcontainerDir,
					dryRun: false,
					cwd: projectDir,
					input: PIPED_STDIN(),
					probe: LINUX_PROBE,
					...capture,
				}),
			),
		)
		assert.equal(code, 0)
		const screen = capture.text()

		assert.match(screen, /^devc initialize \d+\.\d+\.\d+$/m, 'a plain title, no frame')
		assert.doesNotMatch(screen, /[╔╠╚║═]/, 'no box drawing')
		assert.doesNotMatch(screen, /=== /, 'no v2 section headers')

		assert.match(screen, /^ {4}sandbox {6}1\.4\.1$/m, 'the sandbox version the tree pins')
		assert.match(screen, /^ {4}claude code {2}2\.1\.272$/m, 'and the Claude Code version, named separately')
		assert.doesNotMatch(screen, /devcontainer-sandbox:1\.4\.1-cc2\.1\.272/, 'the ref itself stays out unless it deviates')
		// The exact mode, not the four-way alternation this used to accept: an
		// assertion that matches every possible value cannot catch a wrong one. The
		// mute docker stub answers `ps` with nothing (no container matched, so a
		// rebuild or a first build) and succeeds at `image inspect` (the base is
		// already here), which is `rebuild` and only `rebuild`.
		assert.match(screen, /^ {4}mode {9}rebuild$/m, 'which of the three starts this is')

		// Markers, and nothing that a terminal might render as an emoji.
		assert.match(screen, /^\[[+>!]\] /m, 'steps carry an ASCII marker')
		assert.doesNotMatch(screen, /[✓→⚠✗📖·—]/, 'no emoji-presentation or decorative glyph on screen')

		// The closing block is the opening one's twin: the same title-then-column
		// shape, so the screen has one device rather than a new one per section.
		assert.match(screen, /^ready, (all clear|\d+ warning)/m, 'a verdict that answers "must I read this"')
		assert.match(screen, /^\[\+\] claude {7}dev$/m, 'state rows all carry a marker, so the left edge is a column')
		assert.match(screen, /^ {4}log {10}\S/m, 'while log is a path, not a state that passed')
		// The closing sentence is the only line at column 0, and it is last: a run
		// that asks for Enter has not handed over until Enter is pressed.
		assert.match(screen, /\nVS Code is (building|reopening) the container\..*\n$/, 'the last line, unindented')

		// The regression, named: never send anyone to a file the template does not
		// ship. The closing block named it three times until this was written.
		assert.doesNotMatch(screen, /firewall-mode\.sh/)
		assert.doesNotMatch(screen, /devc firewall-mode basic/, 'recipes are log-only')

		// One level down now: the log lives in this boot's folder, not flat under
		// tmp/logs/ (D4). tmp/logs/ itself holds only .boot-id, host-os and the
		// boot directories.
		const logs = join(devcontainerDir, 'tmp', 'logs')
		const bootDir = join(logs, readdirSync(logs).find((name) => /^\d{8}T\d{6}Z$/.test(name)) ?? '')
		const logFile = join(bootDir, readdirSync(bootDir).find((name) => name.endsWith('.log')) ?? '')
		const logged = readFileSync(logFile, 'utf8')
		assert.match(logged, /devc firewall-mode basic/)
		assert.match(logged, /rm \.devcontainer\/tmp\/configured\/claude-mode/)
		assert.match(logged, /^=== devc initialize /m, 'the stamped header is log-only')
		assert.doesNotMatch(screen, /^=== devc initialize /m)
	} finally {
		cleanup()
	}
})

/**
 * A stub `docker` that answers per subcommand and records every argv.
 *
 * `withStubDocker` above cannot reach the drift path at all: its mute `exit 0`
 * makes `docker ps` print nothing, so no container is ever found and there is
 * nothing running whose base version could disagree with the pin. This one
 * takes the technique from creds-volumes.test.ts — stub first on PATH, a `case`
 * per subcommand, argv appended to a trace file — and parameterises the two
 * answers the drift check turns on.
 */
interface DockerStub {
	/** What `docker ps -a -q --filter …` prints. Absent = no container matched. */
	containerId?: string
	/**
	 * What `docker inspect --format '{{index .Config.Labels …}}'` prints.
	 *
	 * Absent means the real thing's label-missing answer, which is an empty line
	 * and exit 0 — a Go template indexing a missing key yields the zero value.
	 */
	label?: string
	/** Non-zero from `docker inspect`, the way a silent daemon answers. */
	inspectFails?: boolean
}

async function withDockerStub<T>(stub: DockerStub, fn: (trace: () => string) => Promise<T>): Promise<T> {
	const binDir = mkdtempSync(join(tmpdir(), 'devc-bin-'))
	const tracePath = join(binDir, 'trace')
	// `printf '%s\\n'` and never an embedded newline in the value: bash's printf
	// does not expand escapes in its arguments, so a "\\n" written into the
	// string arrives as a literal backslash-n and the stub answers garbage.
	const script = `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(tracePath)}
case "$1" in
  ps) printf '%s\\n' ${JSON.stringify(stub.containerId ?? '')} ;;
  inspect) printf '%s\\n' ${JSON.stringify(stub.label ?? '')}; exit ${stub.inspectFails === true ? 1 : 0} ;;
esac
exit 0
`
	writeFileSync(join(binDir, 'docker'), script, { encoding: 'utf8', mode: 0o755 })
	const saved = process.env['PATH']
	process.env['PATH'] = `${binDir}:${saved ?? ''}`
	try {
		return await fn(() => (existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : ''))
	} finally {
		process.env['PATH'] = saved
		rmSync(binDir, { recursive: true, force: true })
	}
}

/** The pin the fixture's tree carries, read where compose reads it. */
const PINNED = '1.8.0'
function pinBaseImage(devcontainerDir: string, version = PINNED): void {
	writeFileSync(
		join(devcontainerDir, 'Dockerfile'),
		`ARG BASE_IMAGE=ghcr.io/meitogi/devcontainer-sandbox:${version}-cc2.1.280\nFROM \${BASE_IMAGE}\n`,
		'utf8',
	)
}

test('drift, non-interactive: the pin and the running version are both named, and nothing blocks', async () => {
	// The 2026-10-06 incident, as a test. The panel says what the tree pins; the
	// container is two patch versions behind it; and on this path there is nobody
	// to ask, so the run reports and hands over rather than stopping a boot that
	// is going to happen anyway.
	const { projectDir, devcontainerDir, cleanup } = fixture()
	const capture = captured()
	try {
		pinBaseImage(devcontainerDir)
		const code = await withDockerStub({ containerId: 'c0ffee123456', label: '1.7.1' }, (trace) =>
			withoutAmbientPin(async () => {
				const result = await initialize({
					devcontainerDir,
					dryRun: false,
					cwd: projectDir,
					input: PIPED_STDIN(),
					ask: neverAsked,
					probe: LINUX_PROBE,
					...capture,
				})
				// The label is read off the container the probe already found, not
				// from a second `docker ps` of its own.
				assert.match(trace(), /^inspect --format \{\{index \.Config\.Labels "org\.stitchu\.base\.version"\}\} c0ffee123456$/m)
				assert.equal((trace().match(/^ps -a -q --filter/gm) ?? []).length, 1, 'one container probe, not two')
				return result
			}),
		)

		assert.equal(code, 0, 'a non-interactive run reports and hands over')
		const screen = capture.text()
		assert.match(screen, /^ {4}mode {9}reopen$/m, 'only a reopen can drift')
		assert.match(screen, /^\[!\] the container runs base 1\.7\.1, but this tree pins 1\.8\.0$/m)
		// The closing panel carries it as one subject, with the consequence hung
		// under the label rather than split into a row of its own.
		assert.match(screen, /^\[!\] base version pin 1\.8\.0, running 1\.7\.1$/m)
		assert.match(screen, /^ {17}Rebuild Container to adopt 1\.8\.0$/m)
		assert.match(screen, /^ready, 1 warning: base version$/m, 'the verdict names it rather than counting it')
	} finally {
		cleanup()
	}
})

test('no drift when the container runs exactly what the tree pins', async () => {
	const { projectDir, devcontainerDir, cleanup } = fixture()
	const capture = captured()
	try {
		pinBaseImage(devcontainerDir)
		const code = await withDockerStub({ containerId: 'c0ffee123456', label: PINNED }, () =>
			withoutAmbientPin(() =>
				initialize({
					devcontainerDir,
					dryRun: false,
					cwd: projectDir,
					input: PIPED_STDIN(),
					ask: neverAsked,
					probe: LINUX_PROBE,
					...capture,
				}),
			),
		)
		assert.equal(code, 0)
		const screen = capture.text()
		assert.doesNotMatch(screen, /base version/)
		assert.match(screen, /^ready, all clear$/m)
	} finally {
		cleanup()
	}
})

// The two ways the label cannot be read, which must look identical from here:
// an image built before the label existed answers with an empty line and exit 0,
// and a daemon that will not talk answers non-zero. Neither is a drift, and
// reporting one would send someone into a rebuild they do not need.
for (const [name, stub] of [
	['an image from before the label', { containerId: 'c0ffee123456' }],
	['a daemon that will not answer', { containerId: 'c0ffee123456', inspectFails: true }],
] as const) {
	test(`silent on ${name}`, async () => {
		const { projectDir, devcontainerDir, cleanup } = fixture()
		const capture = captured()
		try {
			pinBaseImage(devcontainerDir)
			const code = await withDockerStub(stub, () =>
				withoutAmbientPin(() =>
					initialize({
						devcontainerDir,
						dryRun: false,
						cwd: projectDir,
						input: PIPED_STDIN(),
						ask: neverAsked,
						probe: LINUX_PROBE,
						...capture,
					}),
				),
			)
			assert.equal(code, 0)
			const screen = capture.text()
			assert.doesNotMatch(screen, /base version/)
			assert.doesNotMatch(screen, /runs base/)
			assert.match(screen, /^ready, all clear$/m)
		} finally {
			cleanup()
		}
	})
}

test('no container, no drift — there is nothing running to disagree with the pin', async () => {
	// A first build or a rebuild creates the container from the pin, so a label
	// read off some other container would be a fact about nothing.
	const { projectDir, devcontainerDir, cleanup } = fixture()
	const capture = captured()
	try {
		pinBaseImage(devcontainerDir)
		const code = await withDockerStub({ label: '1.7.1' }, (trace) =>
			withoutAmbientPin(async () => {
				const result = await initialize({
					devcontainerDir,
					dryRun: false,
					cwd: projectDir,
					input: PIPED_STDIN(),
					ask: neverAsked,
					probe: LINUX_PROBE,
					...capture,
				})
				assert.doesNotMatch(trace(), /^inspect --format/m, 'the label is never even asked for')
				return result
			}),
		)
		assert.equal(code, 0)
		assert.doesNotMatch(capture.text(), /base version/)
	} finally {
		cleanup()
	}
})

test('drift, answered yes: the run refuses, non-zero, and says the error is the refusal', async () => {
	// The hand-back mechanism, measured on 2026-10-06 against Dev Containers
	// 0.459.1: a non-zero initializeCommand makes `devContainersSpecCLI.js up`
	// fail outright — once, no retry — before any container work happens. So this
	// exit IS the rebuild request, and the CLI never stops or removes anything.
	const { projectDir, devcontainerDir, cleanup } = fixture()
	const capture = captured()
	const ask = answering('y')
	try {
		pinBaseImage(devcontainerDir)
		const code = await withDockerStub({ containerId: 'c0ffee123456', label: '1.7.1' }, () =>
			withoutAmbientPin(() =>
				initialize({
					devcontainerDir,
					dryRun: false,
					cwd: projectDir,
					input: TTY_STDIN(),
					ask,
					probe: LINUX_PROBE,
					...capture,
				}),
			),
		)

		assert.equal(code, 1, 'the only non-zero this command returns from its body')
		const screen = capture.text()
		// The question text is only in `asked`: `ask` is injected here, so nothing
		// writes the prompt to the capture the way a real readline would.
		assert.match(screen, /^\[!\] Stopping so VS Code can rebuild - the container runs base 1\.7\.1, not 1\.8\.0\.$/m)
		// The user is about to see a failed-initializeCommand error; saying so is
		// the difference between a refusal and a crash.
		assert.match(screen, /VS Code will report a failed initializeCommand\. That is this refusal, not a fault\./)
		assert.match(screen, /Dev Containers: Rebuild Container/)
		// Nothing past the refusal ran: no closing verdict, no Claude-mode prompt,
		// no hand-over sentence for a boot that is not happening.
		assert.doesNotMatch(screen, /^ready, /m)
		assert.doesNotMatch(screen, /VS Code is (building|reopening)/)
		assert.deepEqual(
			ask.asked.map((question) => question.trim()),
			['Rebuild the container to adopt 1.8.0? [y/N]'],
			'the question defaults to no, and nothing was asked after it',
		)
	} finally {
		cleanup()
	}
})

test('drift, answered no: the run carries on and the verdict keeps the trace', async () => {
	const { projectDir, devcontainerDir, cleanup } = fixture()
	const capture = captured()
	// The drift question, then the Claude mode, then the Enter that hands over.
	const ask = answering('n', '2', '')
	try {
		pinBaseImage(devcontainerDir)
		const code = await withDockerStub({ containerId: 'c0ffee123456', label: '1.7.1' }, () =>
			withoutAmbientPin(() =>
				initialize({
					devcontainerDir,
					dryRun: false,
					cwd: projectDir,
					input: TTY_STDIN(),
					ask,
					probe: LINUX_PROBE,
					...capture,
				}),
			),
		)

		assert.equal(code, 0)
		const screen = capture.text()
		assert.doesNotMatch(screen, /Stopping so VS Code can rebuild/)
		assert.match(screen, /^\[!\] base version pin 1\.8\.0, running 1\.7\.1$/m)
		assert.match(screen, /^ {17}Rebuild Container to adopt 1\.8\.0$/m)
		// Two, because this fixture ships no notify daemon — the point is that the
		// verdict names the drift rather than folding it into a count.
		assert.match(screen, /^ready, 2 warnings: notify, base version$/m)
		assert.match(screen, /^\[\+\] claude {7}reviewer$/m, 'and the rest of the run happened')
		assert.match(ask.asked[0] ?? '', /Rebuild the container to adopt 1\.8\.0\?/)
		assert.equal(ask.asked.length, 3, 'drift, then Claude mode, then the hand-over pause')
	} finally {
		cleanup()
	}
})

test('drift under --dry-run: reported, never asked, never fatal', async () => {
	// A dry run reports every decision and writes nothing. Blocking on a question
	// or refusing would make it do something, which is the one thing it must not.
	const { projectDir, devcontainerDir, cleanup } = fixture()
	const capture = captured()
	const ask = answering('')
	try {
		pinBaseImage(devcontainerDir)
		const code = await withDockerStub({ containerId: 'c0ffee123456', label: '1.7.1' }, () =>
			withoutAmbientPin(() =>
				initialize({
					devcontainerDir,
					dryRun: true,
					cwd: projectDir,
					input: TTY_STDIN(),
					ask,
					probe: LINUX_PROBE,
					...capture,
				}),
			),
		)
		assert.equal(code, 0)
		const screen = capture.text()
		assert.match(screen, /^\[!\] the container runs base 1\.7\.1, but this tree pins 1\.8\.0$/m)
		assert.match(screen, /^\[!\] base version pin 1\.8\.0, running 1\.7\.1$/m)
		for (const question of ask.asked) assert.doesNotMatch(question, /Rebuild the container/)
	} finally {
		cleanup()
	}
})
