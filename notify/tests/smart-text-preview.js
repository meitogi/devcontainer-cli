#!/usr/bin/env node
// =============================================================================
// smart-text-preview — replay real permission requests through the renderer
// =============================================================================
//
// Prints the BEFORE / AFTER of every permission request captured by the VS Code
// extension patch, so the banner can be judged on the real distribution rather
// than on a hand-picked sample. This is the tool that drove the three
// iterations of lib/smart-text.js ; keep it working so the next one is cheap.
//
// The question to ask while reading the output is not "is it short" but :
//
//     Seeing only this line, with an Allow button next to it, would I know
//     what I am authorising ?
//
// STREAM SHAPE — the two sides use different casings
//
//   The extension log is camelCase (`toolName`, `inputs`) while the queue the
//   daemon consumes is snake_case (`tool_name`, `tool_input`, see
//   tests/fixtures/permission_request/1.jsonl). This script maps the former to
//   the latter ; do not "fix" one of them to match the other.
//
// USAGE
//   node .devcontainer/notify/tests/smart-text-preview.js [options]
//
// OPTIONS
//   --risky        only requests whose banner raises ⚠
//   --nodesc       only requests with no human-written description (hardest)
//   --tool NAME    filter on a tool (Bash, Edit, Write, AskUserQuestion…)
//   --after-only   drop the BEFORE lines, print the new banner alone
//   --limit N      stop after N requests (default: all)
//   --log PATH     read this JSONL instead of the default pair (repeatable)
//
// EXIT CODE
//   0  every invariant held (length, single line, non-empty, no lone surrogate)
//   1  at least one invariant broke — the offending lines are printed to stderr
// =============================================================================

const fs = require('fs')
const path = require('path')

const { permissionLine } = require('../lib/smart-text')
const { SMART_TEXT_LIMITS } = require('../lib/constants')

const CAP = SMART_TEXT_LIMITS.line_cap
const LOG_DIR = path.join(__dirname, '..', '..', 'logs')
const DEFAULT_LOGS = [
	path.join(LOG_DIR, 'claude-code-vscode-ext-pending-perms.jsonl'),
	path.join(LOG_DIR, 'claude-code-vscode-ext-pending-perms-2.jsonl')
]

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const argv = process.argv.slice(2)
const opts = { risky: false, nodesc: false, tool: '', afterOnly: false, limit: Infinity, logs: [] }
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]
	if (a === '--risky') opts.risky = true
	else if (a === '--nodesc') opts.nodesc = true
	else if (a === '--after-only') opts.afterOnly = true
	else if (a === '--tool') opts.tool = argv[++i] || ''
	else if (a === '--limit') { const n = Number(argv[++i]); opts.limit = Number.isFinite(n) ? n : Infinity }
	else if (a === '--log') opts.logs.push(argv[++i])
	else if (a === '-h' || a === '--help') { printUsage(); process.exit(0) }
	else { process.stderr.write(`unknown option: ${a}\n`); printUsage(); process.exit(2) }
}
if (!opts.logs.length) opts.logs = DEFAULT_LOGS

/** Print the option list. @returns {void} */
function printUsage() {
	process.stdout.write(`Usage: node ${path.basename(__filename)} [--risky] [--nodesc] [--tool NAME]
                       [--after-only] [--limit N] [--log PATH]\n`)
}

// -----------------------------------------------------------------------------
// LEGACY RENDERER — kept here, and only here, for the BEFORE column
// -----------------------------------------------------------------------------

/**
 * Reproduce the pre-smartText body : `<tool> — <tool_input verbatim, 150> · HH:MM:SS`.
 * It no longer exists in notifier.js ; this copy exists so the comparison
 * stays honest and reviewable.
 *
 * @param {string} tool                 tool_name
 * @param {string|object} input         tool_input
 * @returns {string}                    the banner as it used to render
 */
function legacyLine(tool, input) {
	const cut = (s, n) => (!s ? '' : String(s).length <= n ? String(s) : `${String(s).slice(0, n - 1)}…`)
	let rendered
	if (input === undefined || input === null) rendered = '(no input)'
	else if (typeof input === 'string') rendered = cut(input, 150) || '(no input)'
	else if (tool === 'AskUserQuestion' && Array.isArray(input.questions) && input.questions[0]) {
		rendered = cut(String(input.questions[0].question || '').trim(), 150)
	} else if (tool === 'ExitPlanMode' && typeof input.plan === 'string') {
		const h1 = input.plan.match(/^#\s+(.+)$/m)
		rendered = cut(h1 ? h1[1].trim() : input.plan.split('\n', 1)[0].trim(), 150)
	} else if (tool === 'Bash' && typeof input.command === 'string') {
		rendered = cut(input.command, 150) || '(no input)'
	} else if (tool === 'Edit' && typeof input.file_path === 'string') {
		const head = typeof input.old_string === 'string' ? input.old_string.split('\n', 1)[0] : ''
		rendered = cut(head ? `${input.file_path}: ${head}` : input.file_path, 150)
	} else if (tool === 'Write' && typeof input.file_path === 'string') {
		rendered = cut(input.file_path, 150)
	} else {
		let json = ''
		try { json = JSON.stringify(input) } catch { json = String(input) }
		rendered = cut(json, 150) || '(no input)'
	}
	return `${tool || 'Permission asked'} — ${rendered} · 14:32:07`
}

// -----------------------------------------------------------------------------
// LOAD
// -----------------------------------------------------------------------------

/**
 * Read the extension's pending-perms logs and map each `pending` record onto a
 * queue-shaped line.
 *
 * @param {string[]} files   absolute JSONL paths
 * @returns {Array<{tool_name:string, tool_input:object}>}
 */
function loadRequests(files) {
	const rows = []
	for (const file of files) {
		let raw
		try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
			process.stderr.write(`[preview] skipping ${file}: ${e.code || e.message}\n`)
			continue
		}
		for (const l of raw.split('\n')) {
			if (!l.trim()) continue
			let rec
			try { rec = JSON.parse(l) } catch { continue }
			if (!rec || !rec.toolName) continue          // settle / boot records carry no input
			rows.push({ tool_name: rec.toolName, tool_input: rec.inputs })
		}
	}
	return rows
}

const requests = loadRequests(opts.logs)
if (!requests.length) {
	process.stderr.write('[preview] no permission requests found — is the extension patch active ?\n')
	process.exit(1)
}

// -----------------------------------------------------------------------------
// RENDER
// -----------------------------------------------------------------------------

const byTool = {}
const seen = {}
const violations = []
let shown = 0
let warned = 0
let longest = 0

for (const line of requests) {
	const tool = line.tool_name
	const input = line.tool_input
	const after = permissionLine(line)
	const hasDesc = !!(input && typeof input === 'object' && input.description)

	byTool[tool] = (byTool[tool] || 0) + 1
	if (after.includes('⚠')) warned++
	const len = Array.from(after).length
	if (len > longest) longest = len

	if (!after.trim()) violations.push(`empty banner — ${tool}`)
	else if (/[\n\r\t]/.test(after)) violations.push(`control char — ${after}`)
	else if (len > CAP) violations.push(`${len} > ${CAP} — ${after}`)
	else if (/[\uD800-\uDFFF]/.test(after.slice(-1))) violations.push(`lone surrogate — ${after}`)

	if (opts.tool && tool !== opts.tool) continue
	if (opts.risky && !after.includes('⚠')) continue
	if (opts.nodesc && hasDesc) continue
	if (shown >= opts.limit) continue

	const raw = (input && (input.command || input.file_path || input.plan || input.skill)) || ''
	const key = `${tool}|${after}|${String(raw).slice(0, 200)}`
	if (seen[key]) { seen[key]++; continue }
	seen[key] = 1
	shown++

	if (opts.afterOnly) {
		process.stdout.write(`${after}\n`)
	} else {
		process.stdout.write(`\nAVANT  ${legacyLine(tool, input).replace(/\n/g, ' ⏎ ').slice(0, 150)}\n`)
		process.stdout.write(`APRÈS  ${after}   [${len}]\n`)
	}
}

// -----------------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------------

const toolLine = Object.keys(byTool)
	.sort((a, b) => byTool[b] - byTool[a])
	.map(t => `${t}=${byTool[t]}`)
	.join('  ')

process.stdout.write(`\n${'='.repeat(78)}\n`)
process.stdout.write(`requests   : ${requests.length}   (${toolLine})\n`)
process.stdout.write(`rendered   : ${shown} unique lines shown\n`)
process.stdout.write(`warnings   : ${warned} (${Math.round((warned / requests.length) * 100)} %) raise ⚠\n`)
process.stdout.write(`longest    : ${longest} / ${CAP}\n`)
process.stdout.write(`invariants : ${violations.length ? `${violations.length} BROKEN` : 'all held'}\n`)

if (violations.length) {
	for (const v of violations.slice(0, 20)) process.stderr.write(`  ✗ ${v}\n`)
	if (violations.length > 20) process.stderr.write(`  … and ${violations.length - 20} more\n`)
	process.exit(1)
}
