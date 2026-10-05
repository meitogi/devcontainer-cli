#!/usr/bin/env node
// =============================================================================
// replay-session — replay a captured Claude Code session against the daemon
// =============================================================================
//
// Takes a session fixture (queue + inbound + pending-perms JSONL streams,
// captured from a real Claude Code session) and plays it back to the running
// daemon with realistic inter-event timing. Rewrites the session identifier
// to a fresh UUID per invocation so replays don't collide.
//
// Fixture layout : tests/fixtures/sessions/<slug>/
//                    queue.jsonl          (Claude Code hook stream)
//                    inbound.jsonl        (VS Code extension → daemon signals)
//                    pending-perms.jsonl  (extension focus-state snapshots)
//                    meta.json            (source sid, duration, counts)
//
// USAGE
//   node replay-session.js <slug-or-path> [options]
//
//   Slugs are looked up in tests/fixtures/sessions/ ; a literal path with
//   a slash is treated verbatim (so external fixture dirs work).
//
// OPTIONS
//   --speed N               time scaling — 1 = real-time, 10 = 10x faster,
//                           100 = burst. Default 10.
//   --max-delay-ms MS       cap wait between consecutive events (default 5000)
//   --min-delay-ms MS       floor wait between events (default 0)
//   --interactive, -i       step through events one by one. Keys :
//                             n / Enter / space  → fire next event
//                             a                  → switch to auto (timed) mode
//                             s                  → skip this event (don't fire)
//                             q / Ctrl+C         → quit
//   --queue-dir PATH        where to write the queue file (default: sibling
//                           `../queue/` — the daemon's watched dir)
//   --inbound-log PATH      where to append inbound events (default: standard
//                           `.devcontainer/tmp/logs/claude-code-vscode-ext-inbound.jsonl`)
//   --pending-perms-log PATH  where to append pending-perms events (default:
//                           standard `.devcontainer/tmp/logs/claude-code-vscode-ext-pending-perms.jsonl`)
//   --no-inbound            skip inbound events
//   --no-pending-perms      skip pending-perms events
//   --dry-run               print the schedule, write nothing
//
// EXAMPLES
//   node replay-session.js b-balanced                     # 10x speed, capped at 5s waits
//   node replay-session.js a-permission-rich --speed 1    # real-time (long!)
//   node replay-session.js c-long-idle --max-delay-ms 2000  # snappier smoke
//   node replay-session.js b-balanced -i                  # interactive — press n between events
//   node replay-session.js b-balanced --dry-run           # inspect schedule only
// =============================================================================

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'sessions')

// -----------------------------------------------------------------------------
// arg parsing
// -----------------------------------------------------------------------------
const args = process.argv.slice(2)
if (!args[0] || args[0] === '-h' || args[0] === '--help') {
	console.error('Usage: node replay-session.js <slug-or-path> [--speed N] [--max-delay-ms MS]')
	console.error('                                              [--queue-dir PATH] [--inbound-log PATH]')
	console.error('                                              [--pending-perms-log PATH]')
	console.error('                                              [--no-inbound] [--no-pending-perms] [--dry-run]')
	console.error('')
	console.error('Available fixtures :')
	try {
		for (const d of fs.readdirSync(FIXTURES_ROOT)) {
			const metaPath = path.join(FIXTURES_ROOT, d, 'meta.json')
			if (fs.existsSync(metaPath)) {
				const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
				console.error(`  ${d.padEnd(24)} ${m.counts.queue_events} queue · ${m.counts.inbound_events} inbound · ${m.counts.pending_perms_events} pending · ${m.duration_human}`)
			}
		}
	} catch (_) {}
	process.exit(2)
}

const slugOrPath = args[0]
const fixtureDir = slugOrPath.includes('/') || slugOrPath.includes('\\')
	? slugOrPath
	: path.join(FIXTURES_ROOT, slugOrPath)

function argValue(name, fallback) {
	const i = args.indexOf(name)
	if (i < 0) return fallback
	return args[i + 1]
}
function argFlag(name) {
	return args.includes(name)
}

const speed = Number(argValue('--speed', '10')) || 10
const maxDelayMs = Number(argValue('--max-delay-ms', '5000')) || 5000
const minDelayMs = Number(argValue('--min-delay-ms', '0')) || 0
const queueDir = argValue('--queue-dir', path.resolve(__dirname, '..', 'queue'))
const inboundLog = argValue('--inbound-log', path.resolve(__dirname, '..', '..', 'logs', 'claude-code-vscode-ext-inbound.jsonl'))
const pendingPermsLog = argValue('--pending-perms-log', path.resolve(__dirname, '..', '..', 'logs', 'claude-code-vscode-ext-pending-perms.jsonl'))
const skipInbound = argFlag('--no-inbound')
const skipPendingPerms = argFlag('--no-pending-perms')
const dryRun = argFlag('--dry-run')
let interactive = argFlag('--interactive') || argFlag('-i')

// -----------------------------------------------------------------------------
// fixture load + timeline merge
// -----------------------------------------------------------------------------
function loadJsonl(p) {
	if (!fs.existsSync(p)) return []
	return fs.readFileSync(p, 'utf8')
		.split('\n')
		.filter(l => l.trim())
		.map(l => JSON.parse(l))
}

if (!fs.existsSync(fixtureDir)) {
	console.error(`✗ fixture dir not found: ${fixtureDir}`)
	process.exit(1)
}

const meta = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'meta.json'), 'utf8'))
const PLACEHOLDER_SID = '00000000-0000-0000-0000-000000000000'

// Load JSONL preserving both the parsed object (for sorting + inspection) and
// the original raw line (for string-level sid substitution at replay time —
// simpler and safer than deep-walking every nested key looking for `sid` /
// `sessionId` fields that might live under payload.request.sessionId etc).
function loadStream(streamName, filename) {
	const p = path.join(fixtureDir, filename)
	return loadJsonl(p).map((_obj, i) => {
		const raw = fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim())[i]
		return { stream: streamName, obj: _obj, raw }
	})
}

const queueEvents = loadStream('queue', 'queue.jsonl')
const inboundEvents = skipInbound ? [] : loadStream('inbound', 'inbound.jsonl')
const ppEvents = skipPendingPerms ? [] : loadStream('pending-perms', 'pending-perms.jsonl')

const timeline = [...queueEvents, ...inboundEvents, ...ppEvents]
	.filter(e => e.obj.ts)
	.map(e => ({ ...e, absMs: new Date(e.obj.ts).getTime() }))
	.sort((a, b) => a.absMs - b.absMs)

if (timeline.length === 0) {
	console.error('✗ no events found in fixture')
	process.exit(1)
}

const t0Ms = timeline[0].absMs
const totalDurationMs = timeline[timeline.length - 1].absMs - t0Ms
const totalReplayMs = Math.min(totalDurationMs / speed, timeline.reduce((acc, e, i) => {
	if (i === 0) return 0
	const raw = (e.absMs - timeline[i - 1].absMs) / speed
	return acc + Math.max(minDelayMs, Math.min(raw, maxDelayMs))
}, 0))

// -----------------------------------------------------------------------------
// sid rewrite + output paths
// -----------------------------------------------------------------------------
const newSid = crypto.randomUUID()
const queueOutFile = path.join(queueDir, `${newSid}.jsonl`)

if (!dryRun) {
	fs.mkdirSync(queueDir, { recursive: true })
	fs.mkdirSync(path.dirname(inboundLog), { recursive: true })
	fs.mkdirSync(path.dirname(pendingPermsLog), { recursive: true })
}

function rewriteEvent(evt) {
	const nowIso = new Date().toISOString()
	const withSid = evt.raw.replaceAll(PLACEHOLDER_SID, newSid)
	const parsed = JSON.parse(withSid)
	if (parsed.ts) parsed.ts = nowIso
	return JSON.stringify(parsed)
}

function targetFile(stream) {
	if (stream === 'queue') return queueOutFile
	if (stream === 'inbound') return inboundLog
	return pendingPermsLog
}

// -----------------------------------------------------------------------------
// summary banner
// -----------------------------------------------------------------------------
const startWall = Date.now()
console.error('═══════════════════════════════════════════════════════════════')
console.error(`▶ replay ${path.basename(fixtureDir)}  (source sid ${meta.source_sid ? meta.source_sid.slice(0, 8) : '?'})`)
console.error(`  events   : ${timeline.length}  (queue ${queueEvents.length} · inbound ${inboundEvents.length} · pending-perms ${ppEvents.length})`)
console.error(`  captured : ${(totalDurationMs / 60000).toFixed(1)}min real time`)
console.error(`  replay   : ~${(totalReplayMs / 1000).toFixed(1)}s (speed=${speed}× · max-delay=${maxDelayMs}ms)`)
console.error(`  new sid  : ${newSid}`)
console.error(`  queue    : ${queueOutFile}`)
console.error(`  inbound  : ${skipInbound ? 'skipped' : inboundLog}`)
console.error(`  pending  : ${skipPendingPerms ? 'skipped' : pendingPermsLog}`)
if (dryRun) console.error(`  MODE     : dry-run (no writes)`)
if (interactive) console.error(`  MODE     : interactive — [n/Enter/space] fire · [a] auto · [s] skip · [q] quit`)
console.error('═══════════════════════════════════════════════════════════════')

// -----------------------------------------------------------------------------
// countdown ticker (\r-refreshes a single stderr line)
// -----------------------------------------------------------------------------
function fmtEvent(e) {
	if (e.stream === 'queue' && e.obj.event) return `queue.${e.obj.event}`
	if (e.stream === 'inbound' && e.obj.type) return `inbound.${e.obj.type}`
	if (e.stream === 'pending-perms') return 'pending-perms.snapshot'
	return e.stream
}

function tickerLine(idx, total, nextEvent, waitMs) {
	const wait = (waitMs / 1000).toFixed(1)
	const label = fmtEvent(nextEvent).padEnd(30)
	return `[${String(idx + 1).padStart(3)}/${total}] next: ${label}  in ${wait.padStart(5)}s ⏳`
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// -----------------------------------------------------------------------------
// interactive keypress prompt — resolves with 'next' | 'auto' | 'skip'
// -----------------------------------------------------------------------------
function promptKey() {
	return new Promise((resolve) => {
		const stdin = process.stdin
		if (stdin.isTTY) stdin.setRawMode(true)
		stdin.resume()
		const onData = (buf) => {
			const c = buf.toString()
			if (c === 'n' || c === '\r' || c === '\n' || c === ' ') {
				stdin.removeListener('data', onData)
				if (stdin.isTTY) stdin.setRawMode(false)
				stdin.pause()
				resolve('next')
			} else if (c === 'a') {
				stdin.removeListener('data', onData)
				if (stdin.isTTY) stdin.setRawMode(false)
				stdin.pause()
				resolve('auto')
			} else if (c === 's') {
				stdin.removeListener('data', onData)
				if (stdin.isTTY) stdin.setRawMode(false)
				stdin.pause()
				resolve('skip')
			} else if (c === 'q' || c === '') {
				if (stdin.isTTY) stdin.setRawMode(false)
				console.error('\n✗ aborted')
				process.exit(130)
			}
		}
		stdin.on('data', onData)
	})
}

// -----------------------------------------------------------------------------
// main replay loop
// -----------------------------------------------------------------------------
async function main() {
	let firedCount = 0
	let skippedCount = 0
	for (let i = 0; i < timeline.length; i++) {
		const evt = timeline[i]
		const capturedDelayMs = i === 0 ? 0 : (evt.absMs - timeline[i - 1].absMs)
		let waitMs = capturedDelayMs / speed
		waitMs = Math.max(minDelayMs, Math.min(waitMs, maxDelayMs))
		let action = 'next'

		if (interactive) {
			process.stderr.write(`\n[${String(i + 1).padStart(3)}/${timeline.length}] next: ${fmtEvent(evt).padEnd(30)}  (captured Δ ${(capturedDelayMs / 1000).toFixed(1)}s)  press [n/a/s/q] `)
			action = await promptKey()
			process.stderr.write('\n')
			if (action === 'auto') { interactive = false }
			if (action === 'skip') {
				skippedCount++
				process.stderr.write(`[${String(i + 1).padStart(3)}/${timeline.length}]         ${fmtEvent(evt).padEnd(30)}  ⤳ skipped\n`)
				continue
			}
		} else if (waitMs > 0 && !dryRun) {
			const deadline = Date.now() + waitMs
			while (Date.now() < deadline) {
				const remaining = deadline - Date.now()
				process.stderr.write('\r' + tickerLine(i, timeline.length, evt, remaining))
				await sleep(Math.min(250, remaining))
			}
			process.stderr.write('\r' + ' '.repeat(80) + '\r')
		}

		const line = rewriteEvent(evt)
		const dst = targetFile(evt.stream)
		const elapsedSec = ((Date.now() - startWall) / 1000).toFixed(1)
		process.stderr.write(`[${String(i + 1).padStart(3)}/${timeline.length}] +${elapsedSec.padStart(5)}s  ${fmtEvent(evt).padEnd(30)}  → ${path.basename(dst)}\n`)

		if (!dryRun) {
			fs.appendFileSync(dst, line + '\n')
		}
		firedCount++
	}
	console.error('═══════════════════════════════════════════════════════════════')
	console.error(`✓ replay complete — ${firedCount}/${timeline.length} events fired${skippedCount ? ` (${skippedCount} skipped)` : ''} in ${((Date.now() - startWall) / 1000).toFixed(1)}s`)
	if (!dryRun) console.error(`  queue file at ${queueOutFile}`)
}

main().catch(e => {
	console.error('\n✗ replay failed:', e.message)
	process.exit(1)
})
