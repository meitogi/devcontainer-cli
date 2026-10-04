// Guards the invariant that `tool_started` (PreToolUse) is INERT in the
// vendored notify daemon.
//
// The daemon the package ships predated the fix: handleLine() cancelled a
// pending permission timer on `tool_started`, on the premise that PreToolUse
// means "the user clicked Allow". It does not — PreToolUse fires BEFORE the
// dialog opens. Measured over a full queue history, 501 / 501
// permission_request events were preceded by their own tool_started within
// 200 ms and none followed one.
//
// What the cancel actually caught was a SIBLING tool from the same parallel
// tool block starting up: Claude emits several tool calls in one message, and
// when one needs approval while another is auto-allowed, the auto-allowed
// one's PreToolUse killed the banner of the one still waiting. The cancel is
// keyed on the session id alone, with no notion of which tool the pending
// permission belongs to. Recorded impact before the fix: 66 such cancels, 57
// of them with the permission still open, worst case 5 h without a single
// notification.
//
// The scenario runs in a CHILD PROCESS on purpose. watcher.start() installs a
// persistent fs.watch and returns no handle, so there is no way to close it
// from inside `node --test` — an in-process version would leave the runner
// hanging. notify-daemon.test.ts spawns its fake daemon for the same reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VENDORED_NOTIFY_DIR } from '../src/lib/notify-daemon.js'

// Replays the real hook ordering: a tool's own PreToolUse always lands just
// before the permission_request it belongs to, then the `after` events follow.
// Each assertion prints `OK <name>` so a failure names itself rather than
// collapsing into one opaque non-zero exit.
const DRIVER = String.raw`
const assert = require('node:assert')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { EventEmitter } = require('node:events')
const NOTIFY = process.argv[2]
const log = require(path.join(NOTIFY, 'lib', 'log'))
const watcher = require(path.join(NOTIFY, 'lib', 'watcher'))

const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devc-watcher-'))
log.init(path.join(queueDir, 'daemon.log'))

// Production delay is 30 s; 300 ms keeps the suite ~3 s.
const DELAY = 300
// fs.watch delivery is asynchronous — let each append drain before the next,
// otherwise ordering assertions go flaky.
const SETTLE = 60

const bus = new EventEmitter()
const fired = [], cancelled = [], unmapped = []
bus.on('send:notification', (p) => fired.push(p.sid))
bus.on('cancelled:notification', (p) => cancelled.push({ sid: p.sid, reason: p.reason }))
const noop = () => {}

watcher.start({
  bus, queueDir,
  state: { unmapped: (u) => unmapped.push(u), armed: noop, replaced: noop, cancelled: noop, fired: noop, suppressed: noop },
  delays: { stop: DELAY, permission_request: DELAY, permission_prompt: DELAY, elicitation_dialog: DELAY, idle_prompt: 0 },
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const emit = (sid, event) => fs.appendFileSync(
  path.join(queueDir, sid + '.jsonl'),
  JSON.stringify({ ts: new Date().toISOString(), sid, event }) + '\n')
const reasonsFor = (sid) => cancelled.filter((c) => c.sid === sid).map((c) => c.reason)

async function scenario(sid, armEvent, after) {
  emit(sid, 'tool_started')
  await sleep(SETTLE)
  emit(sid, armEvent)
  await sleep(SETTLE)
  for (const e of after) { emit(sid, e); await sleep(SETTLE) }
  await sleep(DELAY + 250)
}

async function main() {
  // 1. A sibling tool starting up must NOT cancel a pending permission.
  //    This is the regression the whole file exists for.
  await scenario('sibling-start', 'permission_request', ['tool_started'])
  assert.ok(fired.includes('sibling-start'), 'sibling tool_started must not cancel a pending permission_request')
  assert.deepStrictEqual(reasonsFor('sibling-start'), [], 'sibling tool_started emits no cancellation at all')
  console.log('OK sibling-permission_request-survives')

  // 2. Same for the Notification-flavoured variant.
  await scenario('sibling-prompt', 'permission_prompt', ['tool_started'])
  assert.ok(fired.includes('sibling-prompt'), 'sibling tool_started must not cancel a pending permission_prompt')
  console.log('OK sibling-permission_prompt-survives')

  // 3. The genuine cancel signals still work — the fix must not over-reach.
  for (const [sid, event] of [['cancel-finished','tool_finished'],['cancel-cancelled','tool_cancelled'],['cancel-replied','user_replied']]) {
    await scenario(sid, 'permission_request', [event])
    assert.ok(!fired.includes(sid), event + ' still cancels a pending permission_request')
    assert.ok(reasonsFor(sid).includes(event), event + ' reports itself as the cancel reason')
    console.log('OK ' + event + '-still-cancels')
  }

  // 4. Tool lifecycle never touches a stop timer — it signals user inactivity,
  //    which a tool starting or finishing does not override.
  await scenario('stop-untouched', 'stop', ['tool_started', 'tool_finished'])
  assert.ok(fired.includes('stop-untouched'), 'tool lifecycle events leave a pending stop timer alone')
  console.log('OK stop-timer-untouched')

  // 5. Post-fire dismissal survives: let the timer fire, THEN close the tool.
  //    The delivered banner must still be retracted via the bus.
  emit('post-fire', 'tool_started')
  await sleep(SETTLE)
  emit('post-fire', 'permission_request')
  await sleep(DELAY + 250)
  assert.ok(fired.includes('post-fire'), 'permission timer fires when nothing cancels it')
  emit('post-fire', 'tool_finished')
  await sleep(300)
  assert.ok(reasonsFor('post-fire').includes('tool_finished'), 'a banner that already fired is still dismissed post-fire')
  console.log('OK post-fire-dismissal')

  // 6. Being inert must not mean falling through to the ARM path, where
  //    tool_started would log as an unmapped eventType on every tool start.
  emit('bare-start', 'tool_started')
  await sleep(300)
  assert.deepStrictEqual(unmapped, [], 'tool_started never reaches the unmapped-eventType branch')
  console.log('OK tool_started-not-unmapped')

  fs.rmSync(queueDir, { recursive: true, force: true })
  console.log('ALL PASSED')
  process.exit(0)
}
main().catch((e) => { console.error(e.message); process.exit(1) })
`

test('tool_started is inert: a sibling tool start never cancels a pending permission banner', () => {
	const dir = mkdtempSync(join(tmpdir(), 'devc-watcher-driver-'))
	const driver = join(dir, 'driver.cjs')
	writeFileSync(driver, DRIVER)
	try {
		const out = execFileSync(process.execPath, [driver, VENDORED_NOTIFY_DIR], {
			encoding: 'utf8',
			timeout: 60_000,
		})
		// The two assertions the fix exists for, named so a regression says which.
		assert.match(out, /OK sibling-permission_request-survives/)
		assert.match(out, /OK sibling-permission_prompt-survives/)
		// And the three it must not have broken.
		assert.match(out, /OK tool_finished-still-cancels/)
		assert.match(out, /OK tool_cancelled-still-cancels/)
		assert.match(out, /OK user_replied-still-cancels/)
		// Plus the collateral the early return could have cost.
		assert.match(out, /OK stop-timer-untouched/)
		assert.match(out, /OK post-fire-dismissal/)
		assert.match(out, /OK tool_started-not-unmapped/)
		assert.match(out, /ALL PASSED/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
