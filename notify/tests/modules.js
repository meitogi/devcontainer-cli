#!/usr/bin/env node
// =============================================================================
// test-modules — host-side per-module test runner
// =============================================================================
//
// Run this FROM THE HOST (Mac / Windows terminal), at the project root or
// inside .devcontainer/. Each command exercises one daemon module in
// isolation so you can confirm it works without spinning up the full
// daemon process.
//
// USAGE
//   node .devcontainer/notify/tests/modules.js <module>
//
// MODULES
//   discord-webhook  POST a test message to NOTIFY_DISCORD_WEBHOOK_URL
//   notifier         Fire one OS desktop notification (osascript / WinRT / linux TODO)
//   sound            Play one sound through the native player (afplay / SoundPlayer / paplay)
//   docker-watch     One-shot `docker ps` probe — prints running / gone / error
//   watcher          Watch the queue for ~10 s with short delays, print events as they fire
//   all              Run all sequentially (~15 s)
//
// ENV
//   NOTIFY_DISCORD_WEBHOOK_URL  read from process.env. If unset, the test
//                               attempts to source it from .devcontainer/.env
//                               so you don't have to export it manually.
//
// EXIT CODE
//   0   test ran (channel may still report a warning — check stderr)
//   1   test failed hard (e.g. docker-watch returned 'error')
//   2   bad CLI args
// =============================================================================

const fs   = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const log         = require('../lib/log')
const watcher     = require('../lib/watcher')
const notifier    = require('../lib/consumers/notifier')
const webhook     = require('../lib/consumers/discord-webhook')
const sound       = require('../lib/consumers/sound')
const dockerWatch = require('../lib/docker-watch')
const { locateQueueDir, readProjectName } = require('../lib/locate')

const queueDir   = locateQueueDir()
// queueDir = <project>/.devcontainer/tmp/notify → projectDir is 3 levels up
const projectDir = path.resolve(queueDir, '..', '..', '..')

// Default raw bus payload used by the notifier + webhook tests. Mirrors
// what watcher.js emits in production : { sid, eventType, ts, line }.
// Each channel runs its own TEMPLATES table over this payload, so the
// test exercises the EXACT path the daemon would take for a real Stop
// turn.
//
// To exercise a different event type, change `eventType` and adapt
// `line` to the matching JSONL shape (see watcher.js for the schema).
const DEFAULT_PAYLOAD = {
	sid:       'test-modules-aabbccdd-1234',
	eventType: 'stop',
	ts:        new Date().toISOString(),
	line:      { last_message_excerpt: 'synthetic test from test-modules.js' }
}

// Logger writes to stderr only (no file) — we keep the test runner output
// distinct from the production daemon.log.
log.init(null)

// -----------------------------------------------------------------------------
// CLI dispatch
// -----------------------------------------------------------------------------

const MODULES = {
	'discord-webhook': testWebhook,
	'webhook':         testWebhook,   // legacy alias
	'notifier':        testNotifier,
	'sound':           testSound,
	'docker-watch':    testDockerWatch,
	'watcher':         testWatcher,
	'all':             testAll
}

async function main() {
	const mod = process.argv[2]
	if (!mod || mod === 'help' || mod === '--help' || mod === '-h') return printHelp(!!mod)

	const fn = MODULES[mod]
	if (!fn) {
		console.error(`✗ unknown module: ${mod}`)
		return printHelp(false)
	}

	console.log(`▸ ${mod} — queueDir=${queueDir} projectDir=${projectDir}\n`)
	const code = await fn()
	process.exit(code | 0)
}

// -----------------------------------------------------------------------------
// 1) webhook — POST to Discord, log status
// -----------------------------------------------------------------------------

async function testWebhook() {
	const url = process.env.NOTIFY_DISCORD_WEBHOOK_URL || readEnvFile().NOTIFY_DISCORD_WEBHOOK_URL
	if (!url) {
		console.warn('⚠ NOTIFY_DISCORD_WEBHOOK_URL not set (process.env or .devcontainer/.env)')
		console.warn('  Add it to .devcontainer/.env, or:  NOTIFY_DISCORD_WEBHOOK_URL=https://… node test-modules.js discord-webhook')
		return 1
	}

	console.log(`  POSTing to ${url.replace(/(\/api\/webhooks\/\d+\/).+/, '$1<token-redacted>')} ...`)

	const bus = new EventEmitter()
	webhook.start({ bus, url })

	// Wait one tick so webhook.start has registered the listener
	await sleep(50)
	bus.emit('send:notification', DEFAULT_PAYLOAD)

	// Give the request 3 s to complete before we exit
	await sleep(3000)
	console.log('✓ POST sent — check your Discord channel for the test message')
	return 0
}

// -----------------------------------------------------------------------------
// 2) notifier — fire one OS notif
// -----------------------------------------------------------------------------

async function testNotifier() {
	console.log(`  Platform: ${process.platform}`)
	const bus = new EventEmitter()
	// Mirror daemon.js — read project name from devcontainer.json so the
	// test fires the real production template.
	const projectName = readProjectName(projectDir)
	notifier.start({ bus, projectName })

	await sleep(process.platform === 'win32' ? 1500 : 100) // Windows AUMID probe needs time

	bus.emit('send:notification', DEFAULT_PAYLOAD)

	const rendered = notifier.render(DEFAULT_PAYLOAD)
	console.log(`✓ Notification fired — eventType="${DEFAULT_PAYLOAD.eventType}", project="${projectName}"`)
	console.log(`  title:    ${rendered.title}`)
	console.log(`  subtitle: ${rendered.subtitle}`)
	console.log(`  body:     ${rendered.body}`)
	console.log('  (macOS: source label = "Script Editor". Windows: AUMID-discovered VS Code icon.)')
	await sleep(2000)
	return 0
}

// -----------------------------------------------------------------------------
// 3) sound — play one notification sound through the native player
// -----------------------------------------------------------------------------

async function testSound() {
	const cfg = process.env.NOTIFY_SOUND || readEnvFile().NOTIFY_SOUND || 'default'
	console.log(`  Platform: ${process.platform}`)
	console.log(`  NOTIFY_SOUND: ${cfg}`)

	const bus = new EventEmitter()
	sound.start({ bus, sound: cfg })

	await sleep(100)
	bus.emit('send:notification', DEFAULT_PAYLOAD)

	console.log('✓ Sound dispatched — you should hear a notification chime')
	await sleep(2000)
	return 0
}

// -----------------------------------------------------------------------------
// 4) docker-watch — one-shot probe
// -----------------------------------------------------------------------------

async function testDockerWatch() {
	const r = dockerWatch.probe(projectDir)
	console.log(`  filter:  label=devcontainer.local_folder=${projectDir}`)
	console.log(`  status:  ${r.status}`)
	console.log(`  detail:  ${r.detail}`)
	if (r.containerId) console.log(`  container: ${r.containerId}`)

	if (r.status === 'running') {
		console.log('\n✓ Container is up — docker-watch would NOT emit container:gone here')
		return 0
	}
	if (r.status === 'gone') {
		console.log('\n⚠ Container is not running — docker-watch would emit container:gone')
		return 0
	}
	console.log('\n✗ docker CLI error — docker-watch would emit container:gone (defensive)')
	return 1
}

// -----------------------------------------------------------------------------
// 5) watcher — short-delay watch loop, print events
// -----------------------------------------------------------------------------

async function testWatcher() {
	const bus = new EventEmitter()
	const fired = []
	bus.on('send:notification', (p) => {
		fired.push(p)
		// Preview the notifier's rendered template (most informative for a
		// dev-time check) ; channels do the real rendering downstream.
		const r = notifier.render(p)
		console.log(`  EVENT  ${p.eventType.padEnd(20)}  sid=${p.sid.slice(0, 16)}…  ▸  ${r.subtitle} · ${r.body.slice(0, 80)}`)
	})

	// Short delays so the test finishes in ~10 s even if a stop event arrives.
	// Keys match daemon.js DELAYS — flat eventTypes (no `notification_` prefix).
	const DELAYS = {
		stop:                1500,
		permission_request:   500,
		idle_prompt:            0,
		permission_prompt:    500,
		elicitation_dialog:   500
	}
	watcher.start({ bus, queueDir, delays: DELAYS })

	console.log(`  Watcher running with TEST delays: ${JSON.stringify(DELAYS)}`)
	console.log('  Watching for 10 s — in another terminal, fire an event :')
	console.log('    node .devcontainer/notify/tests/notifs.js idle')
	console.log('    node .devcontainer/notify/tests/notifs.js perm')
	console.log('')

	// Auto-fire one synthetic event after 2 s so the test is self-contained
	// (user doesn't have to do anything to get a result).
	setTimeout(() => {
		const sid  = `test-modules-watcher-${Date.now().toString(36)}`
		const file = path.join(queueDir, `${sid}.jsonl`)
		const line = { ts: new Date().toISOString(), sid, event: 'notification', notification_type: 'idle_prompt', message: 'self-test from test-modules.js' }
		console.log('  → auto-firing one synthetic idle_prompt event...')
		fs.appendFileSync(file, JSON.stringify(line) + '\n')
		setTimeout(() => fs.rmSync(file, { force: true }), 5000)
	}, 2000)

	await sleep(10_000)
	console.log(`\n✓ Watcher saw ${fired.length} event(s) in 10 s`)
	return fired.length > 0 ? 0 : 1
}

// -----------------------------------------------------------------------------
// 6) all — chain
// -----------------------------------------------------------------------------

async function testAll() {
	let rc = 0
	for (const name of ['docker-watch', 'discord-webhook', 'notifier', 'sound', 'watcher']) {
		console.log(`\n══ ${name} ═══════════════════════════════════════════════`)
		const code = await MODULES[name]()
		rc = rc | (code | 0)
	}
	console.log(`\n══ all done ═══════════════════════════════════════════════`)
	return rc
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

// Minimal `.devcontainer/.env` parser — used by the webhook + sound tests so
// we don't pull in dotenv. Handles KEY=VALUE lines, ignores comments and blanks,
// strips surrounding quotes if present.
function readEnvFile() {
	const envFile = path.join(projectDir, '.devcontainer', '.env')
	const out = {}
	let raw
	try { raw = fs.readFileSync(envFile, 'utf8') } catch (_) { return out }
	for (const line of raw.split('\n')) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i)
		if (!m) continue
		let val = m[2]
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1)
		}
		out[m[1]] = val
	}
	return out
}

function printHelp(noModuleSpecified) {
	console.log(`
test-modules — host-side per-module test runner

Usage:
  node .devcontainer/notify/tests/modules.js <module>

Modules:
  discord-webhook  POST a test message to NOTIFY_DISCORD_WEBHOOK_URL (Discord)
  notifier         Fire one OS desktop notification
  sound            Play one notification sound (NOTIFY_SOUND=default|<path>)
  docker-watch     One-shot probe of the devcontainer's running state
  watcher          Self-fire a test event through the queue watcher (~10 s)
  all              Run all sequentially

Env:
  NOTIFY_DISCORD_WEBHOOK_URL    read from env, falls back to .devcontainer/.env
  NOTIFY_SOUND                  default|<abs path>|off — falls back to .devcontainer/.env

Examples:
  node .devcontainer/notify/tests/modules.js notifier
  node .devcontainer/notify/tests/modules.js sound
  node .devcontainer/notify/tests/modules.js docker-watch
  node .devcontainer/notify/tests/modules.js discord-webhook
  node .devcontainer/notify/tests/modules.js all
`)
	process.exit(noModuleSpecified ? 0 : 2)
}

main().catch((err) => {
	console.error('✗ test runner crashed:', err.stack || err.message || err)
	process.exit(1)
})
