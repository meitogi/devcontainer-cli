#!/usr/bin/env node
// =============================================================================
// test-notifs — synthetic event driver for the notify daemon
// =============================================================================
//
// Run this FROM INSIDE the devcontainer. Appends JSONL events to
// .devcontainer/tmp/notify/<sid>.jsonl with test session ids ; the host
// daemon (running on the host, watching the same dir via the /workspace
// bind mount) picks them up and fires real desktop notifications.
//
// USAGE
//   node .devcontainer/notify/tests/notifs.js <type> [cancel]
//
// TYPES
//   stop         fire Stop event              → notif after ~30 s
//   perm         fire permission_request      → notif after ~5 s
//   idle         fire notification/idle       → notif immediate (0 s)
//   perm-prompt  fire notification/perm       → notif after ~5 s
//   elicit       fire notification/elicit     → notif after ~5 s
//   v2           fire Stop w/ <!-- notif: --> → notif after ~30 s, body = tag
//   all          fire every type sequentially → ~35 s total runtime
//
// OPTION
//   cancel       append after type → fires user_replied 2 s after the event,
//                expect NO notif (pre-fire debounce kicks in).
//
//   Example :
//     node test-notifs.js stop          # expect a Stop notif in ~30 s
//     node test-notifs.js stop cancel   # expect NO notif (cancelled by user_replied)
//     node test-notifs.js idle          # expect immediate "Idle" notif
//     node test-notifs.js all           # fire one of each, watch the parade
//
// PREREQ : the daemon must be running on the host. Verify with :
//   cat /workspace/.devcontainer/tmp/notify/.daemon.pid
//   tail -f /workspace/.devcontainer/tmp/notify/daemon.log    # on the host
// =============================================================================

const fs = require('fs')
const path = require('path')
const { locateQueueDir } = require('../lib/locate')

// Same auto-detect as the daemon — works whether the user runs from the
// project root, from .devcontainer/, or with an explicit path as last arg.
const QUEUE_DIR = locateQueueDir(process.argv[4])

// -----------------------------------------------------------------------------
// SCENARIO TABLE
//
// Each entry knows how to build a single triggering event line. The driver
// adds the common fields (ts, sid) and appends. `desc` is printed to the
// console so the user knows what to expect.
// -----------------------------------------------------------------------------
// Delays below are the daemon's defaults — they're not enforced by the
// test (the running daemon owns the timing). If you tune DELAYS in
// daemon.js, the actual wait time changes here but the `desc` text
// stays accurate as documentation of the default behaviour.
const SCENARIOS = {
	stop: {
		desc:  'eventType=stop                → notif after ~30 s (notifier subtitle "Stop")',
		event: () => ({
			event: 'stop',
			last_message_excerpt: 'test-notifs.js synthetic stop — V1 heuristic body'
		})
	},
	perm: {
		desc:  'eventType=permission_request  → notif after ~5 s  (notifier subtitle "Permission · Bash")',
		event: () => ({
			event: 'permission_request',
			tool_name: 'Bash',
			tool_input: '{"command":"echo test-notifs"}'
		})
	},
	idle: {
		desc:  'eventType=idle_prompt         → notif IMMEDIATE   (0 s delay, "Idle — Claude is waiting")',
		event: () => ({
			event: 'notification',
			notification_type: 'idle_prompt',
			message: 'test-notifs.js synthetic idle prompt'
		})
	},
	'perm-prompt': {
		desc:  'eventType=permission_prompt   → notif after ~5 s  ("Permission prompt")',
		event: () => ({
			event: 'notification',
			notification_type: 'permission_prompt',
			message: 'test-notifs.js synthetic permission_prompt'
		})
	},
	elicit: {
		desc:  'eventType=elicitation_dialog  → notif after ~5 s  ("Question")',
		event: () => ({
			event: 'notification',
			notification_type: 'elicitation_dialog',
			message: 'test-notifs.js synthetic elicitation_dialog'
		})
	},
	v2: {
		desc:  'Stop with explicit "Recap line wins" body → notif after ~30 s',
		event: () => ({
			event: 'stop',
			// last_message_excerpt is what hook.js writes after excerptV2 parses
			// the assistant message's `**Recap** — …` line. We emit it directly
			// here for testing — we're bypassing the hook, so we set the final
			// field value as if V2 already extracted it.
			last_message_excerpt: 'Recap line wins'
		})
	}
}

// -----------------------------------------------------------------------------
// CLI ENTRY POINT
// -----------------------------------------------------------------------------

function main() {
	const [, , typeArg, modifier] = process.argv

	if (!typeArg || typeArg === 'help' || typeArg === '--help' || typeArg === '-h') {
		printHelp()
		process.exit(typeArg ? 0 : 2)
	}

	if (!fs.existsSync(QUEUE_DIR)) {
		console.error(`✗ queue dir not found: ${QUEUE_DIR}`)
		console.error('  (the daemon will create it at first spawn — try a Rebuild Container first)')
		process.exit(1)
	}

	checkDaemonPid()

	const cancel = modifier === 'cancel' || modifier === '--cancel'

	if (typeArg === 'all') return runAll(cancel)

	const scenario = SCENARIOS[typeArg]
	if (!scenario) {
		console.error(`✗ unknown type: ${typeArg}`)
		printHelp()
		process.exit(2)
	}

	runOne(typeArg, scenario, cancel)
}

// -----------------------------------------------------------------------------
// RUNNERS
// -----------------------------------------------------------------------------

// Fire one scenario and optionally a follow-up user_replied for the debounce
// test. Returns the sid so a caller can chain ; in single-scenario mode the
// process exits after the optional cancel is emitted.
function runOne(typeName, scenario, cancel) {
	const sid = makeSid(typeName)
	console.log(`\n▸ Scenario: ${typeName}${cancel ? ' (with cancel)' : ''}`)
	console.log(`  sid:      ${sid}`)
	console.log(`  expect:   ${cancel ? 'NO notif (user_replied cancels pending timer)' : scenario.desc}`)

	emit(sid, scenario.event())

	if (cancel) {
		setTimeout(() => {
			emit(sid, { event: 'user_replied' })
			console.log(`  → user_replied emitted for ${sid.slice(0, 12)}… (debounce should win)`)
		}, 2000)
	}
	return sid
}

// Fire every scenario back-to-back. Optionally appends a cancel for each.
// Doesn't block — events are timestamped, daemon's own timers take over.
function runAll(cancel) {
	const names = Object.keys(SCENARIOS)
	console.log(`\n▸ Running ALL ${names.length} scenarios${cancel ? ' (each with cancel)' : ''}`)
	console.log('  Watch your desktop ; events with short delays fire first.')
	console.log('  Total wait (no-cancel mode) : ~35 s for the Stop timers to elapse.\n')

	for (const name of names) runOne(name, SCENARIOS[name], cancel)

	console.log('\n  All events emitted. Done — daemon will fire on its own schedule.')
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

// Append one JSONL line to <queueDir>/<sid>.jsonl. Adds ts + sid to the
// caller's partial event. Atomic on POSIX while line length < 512 B.
function emit(sid, partial) {
	const line = { ts: new Date().toISOString(), sid, ...partial }
	const file = path.join(QUEUE_DIR, `${sid}.jsonl`)
	fs.appendFileSync(file, JSON.stringify(line) + '\n')
}

// Build a synthetic sid that's clearly a test artefact, scoped per scenario
// run so two consecutive `all` runs don't share state (would cancel each
// other through the per-sid debounce).
function makeSid(typeName) {
	const ts = Date.now().toString(36)
	return `test-${typeName}-${ts}`
}

// Best-effort daemon liveness probe. Doesn't block the test if it fails —
// just warns the user. The host-side `.daemon.pid` file is the canonical
// indicator ; we can't `kill -0` from inside the container (PID namespace
// differs from the host), so we just confirm the file exists and recent.
function checkDaemonPid() {
	const pidFile = path.join(QUEUE_DIR, '.daemon.pid')
	if (!fs.existsSync(pidFile)) {
		console.warn(`⚠ ${pidFile} not found — daemon may not be running on the host.`)
		console.warn('  Rebuild the container or check `tail .devcontainer/tmp/notify/daemon.log` on the host.')
		return
	}
	const pid = fs.readFileSync(pidFile, 'utf8').trim()
	console.log(`✓ daemon pid file present (pid ${pid})`)
}

function printHelp() {
	console.log(`
test-notifs — synthetic event driver for the notify daemon

Usage:
  node .devcontainer/notify/tests/notifs.js <type> [cancel]

Types:`)
	for (const [name, s] of Object.entries(SCENARIOS)) {
		console.log(`  ${name.padEnd(13)} ${s.desc}`)
	}
	console.log(`  all           fire every type sequentially (~35 s for full parade)

Option:
  cancel        emit a user_replied 2 s after the event → expect NO notif
                (tests the pre-fire debounce path)

Examples:
  node test-notifs.js idle               # immediate notif
  node test-notifs.js stop               # notif in ~30 s
  node test-notifs.js stop cancel        # NO notif (cancelled at +2 s)
  node test-notifs.js all                # one of each
  node test-notifs.js all cancel         # one of each, each cancelled

Prereq:
  Daemon must be running on the host. Check /workspace/.devcontainer/tmp/notify/.daemon.pid.
`)
}

main()
