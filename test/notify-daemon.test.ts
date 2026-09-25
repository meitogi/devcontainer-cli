// The daemon reads its configuration (NOTIFY_CHANNELS, NOTIFY_SOUND, the
// Discord webhook…) from its environment. initialize.sh gave it the project's
// whole .env through `set -a; source "$ENV_FILE"`; the port had lost that, so
// every daemon spawned by `devc initialize` booted on NOTIFY_CHANNELS=all —
// the opt-in `notify` binary never came up, the osascript fallback fired
// instead. Found on the first v3 boot of a real project (session 7.1).
//
// Since the package vendors the daemon, these also pin *which copy runs*. That
// is the whole point of the move: `devc migrate` carried a project's notify/
// verbatim and no copy bore a version marker, so one running 20 days stale was
// indistinguishable from the current build.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Logger } from '../src/lib/logger.js'
import { spawnNotifyDaemon, VENDORED_NOTIFY_DIR } from '../src/lib/notify-daemon.js'
import { CLI_VERSION } from '../src/lib/version.js'

/** A literal path or version, safe to embed in a RegExp. */
const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A stand-in daemon: claims the lockfile, writes the startup readback the real
// one writes, and records the environment it was given. It reads the queue from
// argv[2] exactly as index.js:203 does — the positional is what frees the real
// daemon from its cwd, so the fake must not quietly fall back to it.
const FAKE_DAEMON = `
const fs = require('node:fs'); const path = require('node:path')
const queue = process.argv[2]
fs.writeFileSync(path.join(queue, '.daemon.pid'), String(process.pid))
fs.writeFileSync(path.join(queue, 'seen-env.txt'), JSON.stringify({
  NOTIFY_CHANNELS: process.env.NOTIFY_CHANNELS ?? null,
  NOTIFY_SOUND: process.env.NOTIFY_SOUND ?? null,
  HOST_ONLY: process.env.HOST_ONLY ?? null,
}))
fs.writeFileSync(path.join(queue, '.daemon.startup'), 'STATUS notify ok\\nREADY pid=' + process.pid + ' channels=notify,discord\\n')
setTimeout(() => {}, 1500)
`

/** A project tree with its queue dir, and a logger writing to a real log file. */
function fixture(env: string) {
	const dir = mkdtempSync(join(tmpdir(), 'devc-notify-'))
	const devcontainerDir = join(dir, '.devcontainer')
	const queue = join(devcontainerDir, 'tmp', 'notify')
	mkdirSync(queue, { recursive: true })
	writeFileSync(join(devcontainerDir, '.env'), env)
	const logFile = join(dir, 'log')
	let text = ''
	const out = new PassThrough()
	out.on('data', (chunk: Buffer) => { text += chunk.toString() })
	const logger = Logger.create({ logFile, out, err: out, isTTY: false })
	return {
		dir,
		devcontainerDir,
		queue,
		logger,
		screen: () => text,
		logged: () => readFileSync(logFile, 'utf8'),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	}
}

/** Write a daemon at `<dir>/index.js`, creating the directory. */
function plantDaemon(dir: string, body = '') {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'index.js'), body)
	return join(dir, 'index.js')
}

/**
 * Run `fn` with NOTIFY_DAEMON_DIR absent from the ambient environment.
 *
 * The dogfood's own .devcontainer/.env sets it, and docker-compose puts that
 * file's keys into the container environment — so inside this container the
 * variable is set, and a test asserting "with no override, the vendored copy
 * wins" would silently assert the opposite.
 */
async function withNoOverride(fn: () => Promise<void>): Promise<void> {
	const previous = process.env['NOTIFY_DAEMON_DIR']
	delete process.env['NOTIFY_DAEMON_DIR']
	try {
		await fn()
	} finally {
		if (previous !== undefined) process.env['NOTIFY_DAEMON_DIR'] = previous
	}
}

test('the daemon is spawned with the project .env in its environment, .env winning over the host', async () => {
	const f = fixture('# comment\nNOTIFY_DAEMON_DIR=notify\nNOTIFY_CHANNELS=notify,discord\nNOTIFY_SOUND=off\n')
	plantDaemon(join(f.devcontainerDir, 'notify'), FAKE_DAEMON)
	const previous = process.env['NOTIFY_SOUND']
	process.env['NOTIFY_SOUND'] = 'host-value'
	process.env['HOST_ONLY'] = 'kept'
	try {
		await spawnNotifyDaemon({
			logger: f.logger,
			devcontainerDir: f.devcontainerDir,
			projectDir: f.dir,
			dryRun: false,
			settleMs: 400,
			startupPollMs: 50,
			startupPollAttempts: 40,
		})
		const seenFile = join(f.queue, 'seen-env.txt')
		assert.ok(existsSync(seenFile), `daemon did not run: ${f.screen()}`)
		const seen = JSON.parse(readFileSync(seenFile, 'utf8')) as Record<string, string | null>
		assert.equal(seen['NOTIFY_CHANNELS'], 'notify,discord', 'the .env channel list reaches the daemon')
		assert.equal(seen['NOTIFY_SOUND'], 'off', '.env wins over the host environment, as `source` did')
		assert.equal(seen['HOST_ONLY'], 'kept', 'the host environment is inherited, not replaced')
		// The readback is a diagnostic: the log carries it, the screen shows the
		// per-channel lines instead.
		assert.match(f.logged(), /channels=notify,discord/)
		assert.doesNotMatch(f.screen(), /channels=notify,discord/)
		assert.match(f.logged(), /\[-\] notify skipped|\[✓\] notify ok/)
		assert.doesNotMatch(f.screen(), /\[-\] notify skipped|\[✓\] notify ok/)
	} finally {
		if (previous === undefined) delete process.env['NOTIFY_SOUND']; else process.env['NOTIFY_SOUND'] = previous
		delete process.env['HOST_ONLY']
		f.cleanup()
	}
})

// The three below stop at --dry-run: notify-daemon.ts logs the entrypoint it
// resolved and returns before spawning anything. That line is the whole
// observable, and it costs no process.

test('NOTIFY_DAEMON_DIR selects the daemon, relative to .devcontainer or absolute', async () => {
	const f = fixture('NOTIFY_DAEMON_DIR=notify\n')
	plantDaemon(join(f.devcontainerDir, 'notify'))
	try {
		const spawn = { logger: f.logger, devcontainerDir: f.devcontainerDir, projectDir: f.dir, dryRun: true }
		await spawnNotifyDaemon(spawn)
		assert.match(f.screen(), /would spawn notify\/index\.js \(NOTIFY_DAEMON_DIR=notify\)/)

		// The absolute form, pointing outside the tree — the shape a machine-local
		// checkout of the daemon takes.
		const elsewhere = join(f.dir, 'elsewhere')
		plantDaemon(elsewhere)
		writeFileSync(join(f.devcontainerDir, '.env'), `NOTIFY_DAEMON_DIR=${elsewhere}\n`)
		await spawnNotifyDaemon(spawn)
		const abs = literal(elsewhere)
		assert.match(f.screen(), new RegExp(`would spawn ${abs}/index\\.js \\(NOTIFY_DAEMON_DIR=${abs}\\)`))
	} finally {
		f.cleanup()
	}
})

test('with no override the vendored copy wins, even when the project ships its own', async () => {
	// The regression this whole change exists for. A v2 tree carries notify/ and
	// `devc migrate` used to leave it there; it must no longer be what runs.
	const f = fixture('')
	plantDaemon(join(f.devcontainerDir, 'notify'))
	try {
		await withNoOverride(async () => {
			await spawnNotifyDaemon({
				logger: f.logger,
				devcontainerDir: f.devcontainerDir,
				projectDir: f.dir,
				dryRun: true,
			})
		})
		assert.match(f.screen(), new RegExp(`would spawn ${literal(VENDORED_NOTIFY_DIR)}/index\\.js`))
		assert.doesNotMatch(f.screen(), /would spawn notify\/index\.js/)
		// The version marker no copy used to carry.
		assert.match(f.screen(), new RegExp(`\\(vendored @meitogi/devcontainer-cli@${literal(CLI_VERSION)}\\)`))
	} finally {
		f.cleanup()
	}
})

test('an override with no index.js warns and names it, rather than falling back', async () => {
	// Falling back would be the silent-downgrade this change removes: the tree
	// that asked for its own daemon would get the packaged one without a word.
	const f = fixture('NOTIFY_DAEMON_DIR=notify\n')
	try {
		const report = await spawnNotifyDaemon({
			logger: f.logger,
			devcontainerDir: f.devcontainerDir,
			projectDir: f.dir,
			dryRun: true,
		})
		assert.equal(report?.state, 'warn')
		assert.match(report?.why ?? '', /no index\.js at .*\/notify\/index\.js \(NOTIFY_DAEMON_DIR=notify\)/)
		assert.match(report?.why ?? '', /unset NOTIFY_DAEMON_DIR/)
		assert.doesNotMatch(f.screen(), /would spawn/)
	} finally {
		f.cleanup()
	}
})
