// =============================================================================
// discord-webhook — Discord parallel channel
// =============================================================================
//
// Subscribes to 'send:notification' and POSTs to a Discord webhook URL
// (env-var driven). Zero NPM dep — uses native `https`. Fire-and-forget :
// HTTP errors / non-2xx are logged but never thrown back at the bus.
//
// USAGE
//   Add to .devcontainer/.env (gitignored, mode 600 — safe place for secrets) :
//     NOTIFY_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/.../...
//
//   initialize.sh sources .env with `set -a`, so the variable auto-exports
//   into the daemon's process env. No shell-rc editing needed.
//   Unset URL → channel is silently disabled at start().
//
// EXTENSION CONTRACT — TEMPLATES table
//   This module owns Discord's flavour : different from the OS notifier
//   because Discord has its own message metadata (bot display name,
//   timestamp, channel) and richer markdown (code fences, embeds).
//
//   Concretely versus the notifier :
//     - no "Claude Code" prefix → encode in the Discord bot's display name
//     - no time stamp → Discord stamps every message itself
//     - YES project + session in the head → useful when several bots /
//       channels push to the same Discord and you skim the feed
//     - tool_input shown as a code fence (notifier doesn't have the room)
//
//   Head format (bold, line 1) :
//     **<projectName> — Session <sid8> — <event label>**
//   Followed by event-specific body on subsequent lines.
//
//   To customise what shows up for a given event in Discord, edit the
//   TEMPLATES table below — no other file changes needed.
// =============================================================================

const https = require('https')
const { URL } = require('url')
const log = require('../log')
const { DISCORD_WEBHOOK_URL_RE, DISCORD_TRUNCATION_LIMITS } = require('../constants')
const { permissionLine } = require('../smart-text')

let webhookUrl  = ''
let projectName = ''

// -----------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// -----------------------------------------------------------------------------

/**
 * Wire the Discord webhook consumer onto the bus. Resolves the webhook URL
 * (caller override → env var → empty), subscribes to 'send:notification' if
 * a URL is set, and returns a `{ status, diag }` summary for index.js's
 * boot report. Unset URL silently disables this channel — Discord is
 * opt-in and missing it must not fail the daemon boot.
 *
 * Conforms to the consumer contract documented in index.js.
 *
 * @param {object} opts
 * @param {import('events').EventEmitter} opts.bus   listens for 'send:notification'
 * @param {string} [opts.projectName]                project label included in the head template
 * @param {string} [opts.url]                        webhook override ; defaults to NOTIFY_DISCORD_WEBHOOK_URL
 * @returns {{ status: 'ok'|'skipped', diag: object }}
 *          status='skipped' when no URL is configured ; diag.webhook is token-redacted
 */
function start({ bus, projectName: pn = '', url: urlOverride }) {
	const url = urlOverride || process.env.NOTIFY_DISCORD_WEBHOOK_URL || ''
	if (!url) {
		log.info('[discord-webhook] NOTIFY_DISCORD_WEBHOOK_URL not set — Discord channel disabled')
		return { status: 'skipped', diag: { reason: 'no-webhook' } }
	}
	webhookUrl  = url
	projectName = pn
	bus.on('send:notification', send)
	const redacted = redactWebhook(url)
	log.info(`[discord-webhook] Discord channel enabled — webhook=${redacted}`)
	return { status: 'ok', diag: { webhook: redacted } }
}

/**
 * Redact a Discord webhook URL for logging. Keeps the prefix + channel ID
 * (public, safe to surface) and masks the bot token, preserving only the
 * last 4 chars so two log lines from the same webhook can be correlated
 * across daemon restarts.
 *
 * Falls back to a full `****` when the URL doesn't match DISCORD_WEBHOOK_URL_RE
 * so a misshapen URL can't leak the secret into the logs.
 *
 * @param {string} url   webhook URL
 * @returns {string}     `prefix/****abcd` on match, `****` otherwise
 */
function redactWebhook(url) {
	const m = url.match(DISCORD_WEBHOOK_URL_RE)
	if (!m) return '****'
	const token = m[2]
	const last4 = token.length >= 4 ? token.slice(-4) : token
	return `${m[1]}****${last4}`
}

// -----------------------------------------------------------------------------
// TEMPLATE HELPERS
// -----------------------------------------------------------------------------

/**
 * First 8 hex chars of the session UUID — the canonical short form used
 * as a fallback whenever a session name is unavailable.
 *
 * @param {string} sid   full session UUID (or any string)
 * @returns {string}     first 8 characters, empty string if sid is falsy
 */
function sid8(sid) {
	return String(sid || '').slice(0, 8)
}

/**
 * Resolve the human-readable session label embedded in the head template.
 * Prefers `session_name` (captured by the hook from the first
 * UserPromptSubmit prompt or aiTitle — wraps in double quotes so the label
 * stays visually intact even when it contains dashes that match our head
 * separator), falls back to sid8 (cryptic but always available).
 *
 * @param {object} payload         notification payload
 * @param {string} payload.sid     session UUID
 * @param {object} payload.line    JSONL event line
 * @param {string} [payload.line.session_name]   pre-resolved label from the hook
 * @returns {string}               `"<session_name>"` if present, else sid8(sid)
 */
function sessionLabel({ sid, line }) {
	const name = line && line.session_name
	if (name) return `"${name}"`
	return sid8(sid)
}

/**
 * Build the bold first-line context header `**<project> — Session <label> — <event>**`.
 * Drops the project segment cleanly when projectName is empty so manual
 * `node index.js` runs from arbitrary cwds still produce a readable message.
 *
 * @param {object} payload      notification payload (passed to sessionLabel)
 * @param {string} eventLabel   short event label (e.g. 'Stop', 'Idle', 'Permission \\`Bash\\`')
 * @returns {string}            markdown-bold header line
 */
function head(payload, eventLabel) {
	const parts = []
	if (projectName) parts.push(projectName)
	parts.push(`Session ${sessionLabel(payload)}`)
	parts.push(eventLabel)
	return `**${parts.join(' — ')}**`
}

// -----------------------------------------------------------------------------
// PER-TOOL INPUT RENDERING (used by permission_request)
// -----------------------------------------------------------------------------
//
// Discord doesn't tolerate the same payload shapes the host notif gets away
// with. Two pitfalls fixed here :
//
//   1. JSON.stringify of an object whose VALUES are multi-line strings
//      (e.g. ExitPlanMode.plan, a whole markdown document) produces a
//      string where the inner `\n` are escape sequences — two characters,
//      backslash + n. Discord renders them literally. Solution : for tools
//      where we know a field is markdown, surface that field directly.
//
//   2. Tool inputs frequently contain triple-backtick fences (markdown
//      plans, code blocks in prompts). Wrapping them in our OWN ``` fence
//      lets the inner ``` close the outer fence early — markdown leaks
//      out. `safeFence()` breaks any ``` triple with a zero-width space.

/**
 * Neutralise inner ``` triples in content destined for a code fence by
 * inserting U+200B (zero-width space) between the first and second
 * backtick. Discord's markdown renderer ignores the ZWSP visually but
 * the byte-level fence-close pattern no longer matches, so an inner
 * triple cannot close the outer fence early.
 *
 * @param {*} content   value to scrub — coerced via String(content)
 * @returns {string}    scrubbed content with all ``` triples broken
 */
function safeFence(content) {
	return String(content).replace(/```/g, '`​``')
}

/**
 * Wrap content in a Discord code fence after neutralising inner ``` triples.
 * Returns a string that starts with a newline so the fence renders on its
 * own line when concatenated to a preceding head.
 *
 * @param {*} content   value to wrap — passed through safeFence
 * @param {string} [lang]   optional language hint for the opening fence (e.g. 'json')
 * @returns {string}    `\\n\\`\\`\\`<lang>\\n<content>\\n\\`\\`\\`` ready to concatenate
 */
function fenceWrap(content, lang = '') {
	return '\n```' + lang + '\n' + safeFence(content) + '\n```'
}

/**
 * Format an AskUserQuestion tool_input as a markdown bullet list. Mirrors
 * the intent of notifier.summarizeAskUserQuestion but uses Discord's room
 * to show EVERY question (not just the first), each with its options
 * rendered inline as `_[opt1 / opt2]_` italics. Returns '' on any
 * malformed shape so the caller can fall back to the generic JSON path.
 *
 * @param {object} input    AskUserQuestion tool_input object
 * @param {Array<{question:string, options?:Array<{label:string}>}>} [input.questions]
 *                          list of questions with optional choice arrays
 * @returns {string}        bullet list, or '' on malformed input
 */
function formatAskUserQuestion(input) {
	if (!input || typeof input !== 'object') return ''
	const qs = input.questions
	if (!Array.isArray(qs) || qs.length === 0) return ''
	const lines = []
	for (const q of qs) {
		if (!q || typeof q.question !== 'string') continue
		const question = q.question.trim()
		if (!question) continue
		const opts = Array.isArray(q.options)
			? q.options.map(o => o && typeof o.label === 'string' ? o.label : null).filter(Boolean)
			: []
		const optsStr = opts.length ? ` _[${opts.join(' / ')}]_` : ''
		lines.push(`- ${question}${optsStr}`)
	}
	return lines.join('\n')
}

/**
 * Render a permission_request line's tool_input for Discord display.
 * Dispatched by tool_name : ExitPlanMode surfaces its `plan` markdown
 * verbatim (no fence so Discord renders the formatting), AskUserQuestion
 * goes through the bullet-list formatter, every other tool falls back to
 * `JSON.stringify(input, null, 2)` inside a safe fence (`safeFence` breaks
 * any inner ``` triples).
 *
 * Returns '' when there's nothing meaningful to show, so the caller can
 * concatenate the result without trailing whitespace.
 *
 * @param {object} line                 JSONL event line
 * @param {string} [line.tool_name]     tool identifier used for dispatch
 * @param {string|object} line.tool_input   raw or structured tool input
 * @returns {string}                    rendered body chunk ready to append after head()
 */
function renderToolInput(line) {
	const toolName = line.tool_name || ''
	const input = line.tool_input

	// ExitPlanMode : the `plan` field is already markdown — let Discord
	// render it instead of stuffing it into a code fence.
	if (toolName === 'ExitPlanMode' && input && typeof input.plan === 'string') {
		return '\n\n' + input.plan
	}

	// AskUserQuestion : bullet list, far more readable than the raw JSON.
	if (toolName === 'AskUserQuestion') {
		const formatted = formatAskUserQuestion(input)
		if (formatted) return '\n\n' + formatted
	}

	// Fallback : keep the old JSON-in-a-fence shape, now safe against
	// inner ``` triples.
	if (input === undefined || input === null) return ''
	if (typeof input === 'string') return input ? fenceWrap(input) : ''
	let inputStr = ''
	try { inputStr = JSON.stringify(input, null, 2) }
	catch { inputStr = String(input) }
	return inputStr ? fenceWrap(inputStr) : ''
}

// -----------------------------------------------------------------------------
// TEMPLATES — one per eventType. Each returns the Discord content string.
//
// Discord enforces a hard char limit per message (see DISCORD_TRUNCATION_LIMITS
// in lib/constants.js) ; `render()` caps below that to leave margin for any
// template-side prefix growth.
// -----------------------------------------------------------------------------
const TEMPLATES = {
	stop: (p) =>
		`${head(p, 'Stop')}\n${p.line.last_message_excerpt || '_(no recap)_'}`,

	// The smartText line rides as a TITLE above the code fence — Discord has the
	// room to keep the full tool_input below, so this summarises rather than
	// replaces. It is what makes a skimmed channel readable.
	permission_request: (p) => {
		const label = `Permission \`${p.line.tool_name || 'unknown'}\` — ${permissionLine(p.line)}`
		return head(p, label) + renderToolInput(p.line)
	},

	idle_prompt: (p) =>
		`${head(p, 'Idle')}\n${p.line.message || '_(Claude is waiting)_'}`,

	permission_prompt: (p) =>
		`${head(p, 'Permission prompt')}\n${p.line.message || '_(no message)_'}`,

	elicitation_dialog: (p) =>
		`${head(p, 'Question')}\n${p.line.message || '_(no message)_'}`
}

/**
 * Render a payload to the final Discord message string. Routes through the
 * TEMPLATES table keyed by `payload.eventType`, falling back to a generic
 * `**<eventType>** — (no template)` shape so an unknown event still posts
 * something useful.
 *
 * Two safety nets after the template :
 *   1. Cap the body at DISCORD_TRUNCATION_LIMITS.body_truncate_to (well
 *      below Discord's hard 2000-char limit — see lib/constants.js).
 *   2. If truncation or template authoring left an odd number of ```
 *      fences, append a closing fence so Discord doesn't render the rest
 *      of the channel feed as code.
 *
 * Exported so tests can preview the final content without making a real
 * POST request.
 *
 * @param {object} payload              event payload from the bus
 * @param {string} payload.eventType    template key
 * @returns {string}                    Discord-ready message string (≤ body_cap chars)
 */
function render(payload) {
	const fn = TEMPLATES[payload.eventType]
	const out = fn ? fn(payload) : `**${payload.eventType}** — (no template)`
	let s = String(out)
	if (s.length > DISCORD_TRUNCATION_LIMITS.body_cap) {
		s = s.slice(0, DISCORD_TRUNCATION_LIMITS.body_truncate_to)  // reserve 7 chars for "\n```"
	}
	// If we truncated mid-fence (or a template emitted an unbalanced one),
	// close it so Discord doesn't render everything that follows as code.
	const fences = s.match(/```/g)
	if (fences && fences.length % 2 === 1) s += '\n```'
	return s
}

// -----------------------------------------------------------------------------
// SEND
// -----------------------------------------------------------------------------

/**
 * POST the rendered payload to the Discord webhook. Fire-and-forget : the
 * response is drained (to free the socket) and non-2xx responses are logged
 * at warn level, but no error is propagated back to the bus. The 'send'
 * handler must never throw — that would crash the daemon.
 *
 * Uses native `https` to keep zero NPM dependencies. Discord returns 204
 * No Content on success ; the warn-on-≥400 catches rate limiting (429),
 * invalid webhooks (404), and payload format errors (400).
 *
 * @param {object} payload   notification payload from the bus
 * @returns {void}           fire-and-forget HTTPS POST
 */
function send(payload) {
	let target
	try { target = new URL(webhookUrl) } catch (e) {
		log.warn(`[discord-webhook] invalid URL: ${e.message}`)
		return
	}

	const data = JSON.stringify({ content: render(payload) })

	const req = https.request({
		method: 'POST',
		hostname: target.hostname,
		port: target.port || 443,
		path: target.pathname + target.search,
		headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
	}, (res) => {
		// Drain the response — required to free the socket. Discord returns
		// 204 No Content on success ; 4xx-5xx get logged.
		res.resume()
		if (res.statusCode >= 400) log.warn(`[discord-webhook] Discord ${res.statusCode}`)
	})
	req.on('error', (err) => log.warn(`[discord-webhook] request failed: ${err.message}`))
	req.write(data)
	req.end()
}

// TEMPLATES + render are exposed so tests can preview the final Discord
// content without making a real POST. redactWebhook is exposed so the
// redaction shape can be asserted from tests / smoke checks.
module.exports = { start, TEMPLATES, render, redactWebhook }
