#!/usr/bin/env node
// Map a Claude Code session UUID → most recent tab title.
//
// Reads .devcontainer/logs/claude-code-vscode-ext-inbound.jsonl (written by
// user-action-observer.py) and indexes every `update_session_state` and
// `rename_tab` event by sessionId, keeping the newest title per UUID.
//
// Usage:
//   session-title.js <uuid-or-prefix>   print title for one UUID (prefix ≥ 4 chars OK)
//   session-title.js                    tab-separated list: uuid<TAB>ts<TAB>title (newest first)
//   session-title.js --json             JSON object { uuid: title }
//
// Exit codes: 0 ok, 1 UUID not found, 2 log file missing.

const fs   = require('node:fs')
const path = require('node:path')

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e })

const LOG_FILE = path.resolve(
	__dirname, '..', '..', 'logs', 'claude-code-vscode-ext-inbound.jsonl'
)

function buildIndex() {
	if (!fs.existsSync(LOG_FILE)) {
		process.stderr.write(`session-title: log file not found: ${LOG_FILE}\n`)
		process.exit(2)
	}
	const index = new Map()
	const raw = fs.readFileSync(LOG_FILE, 'utf8')
	for (const line of raw.split('\n')) {
		if (!line) continue
		let evt
		try { evt = JSON.parse(line) } catch { continue }
		const req = evt && evt.payload && evt.payload.request
		if (!req) continue
		if (req.type !== 'update_session_state' && req.type !== 'rename_tab') continue
		const sid   = evt.sessionId
		const title = req.title
		const ts    = evt.ts || ''
		if (!sid || typeof title !== 'string' || !title) continue
		const prev = index.get(sid)
		if (!prev || ts > prev.ts) index.set(sid, { title, ts })
	}
	return index
}

const argv     = process.argv.slice(2)
const jsonMode = argv.includes('--json')
const query    = argv.find(a => !a.startsWith('--'))
const index    = buildIndex()

if (query) {
	const q = query.toLowerCase()
	const matches = [...index.entries()].filter(([uuid]) => uuid.toLowerCase().startsWith(q))
	if (matches.length === 0) {
		process.stderr.write(`session-title: no session matches "${query}"\n`)
		process.exit(1)
	}
	if (matches.length === 1) {
		process.stdout.write(matches[0][1].title + '\n')
	} else {
		for (const [uuid, { title }] of matches) {
			process.stdout.write(`${uuid}\t${title}\n`)
		}
	}
} else if (jsonMode) {
	const out = {}
	for (const [uuid, { title }] of index) out[uuid] = title
	process.stdout.write(JSON.stringify(out, null, 2) + '\n')
} else {
	const rows = [...index.entries()].sort((a, b) => b[1].ts.localeCompare(a[1].ts))
	for (const [uuid, { title, ts }] of rows) {
		process.stdout.write(`${uuid}\t${ts}\t${title}\n`)
	}
}
