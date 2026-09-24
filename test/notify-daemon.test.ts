// The daemon reads its configuration (NOTIFY_CHANNELS, NOTIFY_SOUND, the
// Discord webhook…) from its environment. initialize.sh gave it the project's
// whole .env through `set -a; source "$ENV_FILE"`; the port had lost that, so
// every daemon spawned by `devc initialize` booted on NOTIFY_CHANNELS=all —
// the opt-in `notify` binary never came up, the osascript fallback fired
// instead. Found on the first v3 boot of a real project (session 7.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Logger } from '../src/lib/logger.js'
import { spawnNotifyDaemon } from '../src/lib/notify-daemon.js'

// A stand-in daemon: claims the lockfile, writes the startup readback the
// real one writes, and records the environment it was given.
const FAKE_DAEMON = `
const fs = require('node:fs'); const path = require('node:path')
const queue = path.join(process.cwd(), '.devcontainer', 'tmp', 'notify')
fs.writeFileSync(path.join(queue, '.daemon.pid'), String(process.pid))
fs.writeFileSync(path.join(queue, 'seen-env.txt'), JSON.stringify({
  NOTIFY_CHANNELS: process.env.NOTIFY_CHANNELS ?? null,
  NOTIFY_SOUND: process.env.NOTIFY_SOUND ?? null,
  HOST_ONLY: process.env.HOST_ONLY ?? null,
}))
fs.writeFileSync(path.join(queue, '.daemon.startup'), 'STATUS notify ok\\nREADY pid=' + process.pid + ' channels=notify,discord\\n')
setTimeout(() => {}, 1500)
`

test('the daemon is spawned with the project .env in its environment, .env winning over the host', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'devc-notify-'))
	const devcontainerDir = join(dir, '.devcontainer')
	const queue = join(devcontainerDir, 'tmp', 'notify')
	mkdirSync(queue, { recursive: true })
	// The entrypoint stays at notify/index.js; only the queue moved under tmp/.
	mkdirSync(join(devcontainerDir, 'notify'), { recursive: true })
	writeFileSync(join(devcontainerDir, 'notify', 'index.js'), FAKE_DAEMON)
	writeFileSync(join(devcontainerDir, '.env'), '# comment\nNOTIFY_CHANNELS=notify,discord\nNOTIFY_SOUND=off\n')
	const out = new PassThrough()
	let text = ''
	out.on('data', (chunk: Buffer) => { text += chunk.toString() })
	const logger = Logger.create({ logFile: join(dir, 'log'), silentSink: true, out, err: out, isTTY: false })
	const previous = process.env['NOTIFY_SOUND']
	process.env['NOTIFY_SOUND'] = 'host-value'
	process.env['HOST_ONLY'] = 'kept'
	try {
		await spawnNotifyDaemon({ logger, devcontainerDir, projectDir: dir, dryRun: false, settleMs: 400, startupPollMs: 50, startupPollAttempts: 40 })
		const seenFile = join(queue, 'seen-env.txt')
		assert.ok(existsSync(seenFile), `daemon did not run: ${text}`)
		const seen = JSON.parse(readFileSync(seenFile, 'utf8')) as Record<string, string | null>
		assert.equal(seen['NOTIFY_CHANNELS'], 'notify,discord', 'the .env channel list reaches the daemon')
		assert.equal(seen['NOTIFY_SOUND'], 'off', '.env wins over the host environment, as `source` did')
		assert.equal(seen['HOST_ONLY'], 'kept', 'the host environment is inherited, not replaced')
		assert.match(text, /channels=notify,discord/)
	} finally {
		if (previous === undefined) delete process.env['NOTIFY_SOUND']; else process.env['NOTIFY_SOUND'] = previous
		delete process.env['HOST_ONLY']
		rmSync(dir, { recursive: true, force: true })
	}
})
