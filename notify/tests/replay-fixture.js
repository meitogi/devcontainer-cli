#!/usr/bin/env node
// =============================================================================
// replay-fixture — write a fixture JSONL into the daemon's queue
// =============================================================================
//
// Reads a fixture file (one or more JSONL lines), regenerates `sid` and `ts`
// per replay, and writes the result to <queueDir>/<new-sid>.jsonl. The
// running daemon picks it up via fs.watch and processes it like any real
// hook-emitted line.
//
// USAGE
//   node replay-fixture.js <type>           # → fixtures/<type>/1.jsonl
//   node replay-fixture.js <type> <num>     # → fixtures/<type>/<num>.jsonl
//   node replay-fixture.js <full-path>      # any absolute / relative path
//
//   Types : stop, permission_request, idle_prompt, elicitation_dialog,
//           permission_prompt, notification, user_replied, tool_started,
//           tool_finished, tool_cancelled
//
// Fixtures hold placeholder values for sid + ts (typically the zero-UUID
// and 1970-01-01) so the substitution is obvious in any log inspection.
// =============================================================================

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { locateQueueDir } = require('../lib/locate')

const FIXTURES_DIR = path.join(__dirname, 'fixtures')

const arg1 = process.argv[2]
const arg2 = process.argv[3]

if (!arg1) {
	console.error('Usage: node replay-fixture.js <type> [num]    or    <fixture-path.jsonl>')
	process.exit(2)
}

// Resolve either a shorthand "<type> [num]" against the fixtures dir, or
// a literal path passed through.
let fixturePath
if (arg1.endsWith('.jsonl') || arg1.includes('/') || arg1.includes('\\')) {
	fixturePath = arg1
} else {
	const num = arg2 || '1'
	fixturePath = path.join(FIXTURES_DIR, arg1, `${num}.jsonl`)
}

if (!fs.existsSync(fixturePath)) {
	console.error(`✗ fixture not found: ${fixturePath}`)
	process.exit(1)
}

const newSid = crypto.randomUUID()
const queueDir = locateQueueDir()
const outFile = path.join(queueDir, `${newSid}.jsonl`)
const now = new Date().toISOString()

const lines = fs.readFileSync(fixturePath, 'utf8')
	.split('\n')
	.filter(l => l.trim())
	.map(l => {
		const obj = JSON.parse(l)
		obj.sid = newSid
		obj.ts = now
		return JSON.stringify(obj)
	})

fs.writeFileSync(outFile, lines.join('\n') + '\n')
console.log(`✓ Replayed ${path.relative(process.cwd(), fixturePath)} as sid=${newSid.slice(0, 8)}`)
console.log(`  → ${outFile}`)
