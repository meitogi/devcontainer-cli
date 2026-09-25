// =============================================================================
// notify-app — notif-cli-based desktop notification consumer (macOS, v0.2)
// =============================================================================
//
// Alternative to the "basic-notif" (osascript / WinRT / linux-stub) consumer.
// Dispatches through the standalone `notif` binary (apps/notifier/) so the
// daemon gets :
//   - sender identity control (each banner appears under a chosen `.app`)
//   - per-notif identifier + dismiss API via `notif remove`
//   - callbacks / Tier 3 macOS overrides available on the CLI surface
//
// Mutually exclusive with the basic-notif consumer — activate this one by
// listing `notify` in NOTIFY_CHANNELS (see index.js). If both are listed,
// index.js drops basic-notif with a warning ; they'd otherwise double-fire.
//
// Host support :
//   - Any host with a `notif` binary reachable on PATH (or via the explicit
//     `NOTIF_BIN` env / bundled fallback in getNotifPath). macOS ships a
//     binary today ; Windows and Linux gain one when their apps/notifier
//     backends land — no code change here to onboard them, the consumer
//     just starts resolving a binary and stops reporting `skipped`.
//   - Sender is always `default` (hook.js writes `line.sender = 'default'` on
//     every queue line). Per-event routing (claude vs npm-script vs …) is a
//     v0.3+ extension.
//   - Cancel-remove : subscribes to `cancelled:notification` and calls
//     `notif remove --sender X --id Y` when the banner had already been
//     dispatched. Post-fire state lives in the module-level `dispatched` Map
//     (auto-evicts after 10 min ; NC eventually rolls old banners off anyway).
// =============================================================================

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const log = require('../log')
const { getHostKind } = require('../host')
const focusDebounce = require('../focus-debounce')

// Hardcoded Claude Code sender identity. Every banner dispatched through
// this consumer appears in Notification Center under "Claude Code" with
// the bundled icon, regardless of what hook.js writes on `line.sender`.
// hook.js's `sender` field remains a placeholder for future per-event
// routing consumed by other channels — for the devcontainer daemon
// wiring Claude Code, the identity is always Claude Code.
const CLAUDE_CODE_SENDER = 'claude-code'
const CLAUDE_CODE_NAME   = 'Claude Code'
const CLAUDE_CODE_ICON   = path.join(__dirname, '..', '..', 'vendor', 'senders', 'claude-code.icns')
// LaunchServices display name of VS Code, used as the `<APP>` slug in the
// `focus:open-a://<APP>/<launchUrl>` DSL target we pass as `--on-click`.
// Kept as a module const rather than inlined because this consumer only
// targets VS Code today ; future callers (Slack, Terminal.app, custom
// electron apps) build their own DSL string with their own slug — the DSL
// itself in notif-core stays generic (see `focus:open` in callback.rs).
const VSCODE_APP_SLUG = 'Visual Studio Code'
// First-boot register requires the user to click Allow on the OS permission
// dialog — 90 s window. Anything faster (e.g. the previous 5 s) killed the
// dialog before the user could see it, which macOS then treated as a
// silent denial cached in TCC — subsequent boots surfaced as "Notifications
// are not allowed for this application".
const REGISTER_TIMEOUT_MS = 90_000

// Resolved absolute path to the `notif` binary. Set once at start() ; when
// null (no candidate exists on disk) the consumer reports `skipped` and
// leaves the bus alone so basic-notif can take over via NOTIFY_CHANNELS.
let notifBinPath = null

// Post-fire dispatched-notif tracking. Keyed by sid so `cancelled:notification`
// (which watcher.js emits with `{ id, sid, eventType, reason }`) can look up
// the exact banner without threading extra state through the bus. Value :
// `{ sender, notifId, timeout }` where `timeout` is the auto-evict handle.
const dispatched = new Map()
const DISPATCHED_TTL_MS = 10 * 60 * 1000

// One-shot flag — logs at most one warning when a queue line predates the
// session-8 hook.js (no `notif_id`). Prevents daemon.log flooding when an
// upgrade lands mid-session and older lines are still being replayed.
let notifIdFallbackLogged = false

// One-shot flag — logs at most one warning per boot when a queue line has
// no `launchUrl` (session-1 producer contract : hook.js omits the field when
// history is empty, e.g. fresh container before VS Code writes anything).
// Body-click on such notifs is a no-op, and one line per boot is enough to
// diagnose silent no-ops without flooding daemon.log.
let launchUrlMissingLogged = false

// Path to the JSONL file where the `notif` binary appends action-click
// records (see session 3 — allow-deny-actions). Set in `start()` from the
// projectDir passed by index.js so the file colocates with the existing
// claude-code-vscode-ext-{inbound,outbound}.jsonl channel in
// `.devcontainer/tmp/logs/`.
let actionsInboxPath = null
// Path to the outbound JSONL file the VS Code extension's outbound-action-
// injector polls for tool_permission_response commands. Same
// `.devcontainer/tmp/logs/` dir. Written when we process an Allow click.
let outboundPath = null
// Byte offset into actionsInboxPath — advanced as we drain new lines. At
// start() we seek to the current file size so we skip lines from prior
// daemon incarnations that were already dispatched (or lost — clicks
// during daemon downtime are silently dropped by design).
let inboxOffset = 0
// Map<notifId, { sid, toolUseId, toolInput, timeout }> — populated in
// `send()` for permission_request / permission_prompt events that carry a
// tool_use_id, so the inbox watcher can build the outbound command when the
// user clicks Allow. Same TTL model as `dispatched` above.
const permissionContext = new Map()
const PERMISSION_TTL_MS = 10 * 60 * 1000

// -----------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// -----------------------------------------------------------------------------

/**
 * Wire the notify-app consumer onto the bus. Returns { status, diag } per
 * the index.js consumer contract.
 *
 * `skipped` case :
 *   - no `notif` binary found on any candidate path (the sole gate — the
 *     consumer serves any host once a binary is discoverable).
 *
 * @param {object} opts
 * @param {import('events').EventEmitter} opts.bus   listens for send + cancel events
 * @param {string} [opts.projectDir]                 workspace root — used to resolve
 *                                                    `.devcontainer/tmp/logs/` paths for the
 *                                                    Allow action inbox + outbound.jsonl
 * @returns {{ status: 'ok'|'skipped', diag: object }}
 */
function start({ bus, projectDir, projectName = '' }) {
	const host = getHostKind()
	notifBinPath = getNotifPath()
	if (!notifBinPath) {
		return { status: 'skipped', diag: { host, reason: 'notif-binary-not-found' } }
	}
	log.info(`[notify-app] notif binary resolved at ${notifBinPath}`)

	// TEMPLATES live in notifier.js and read `projectName` from that module's
	// scope via brandTitle(). notifier.start() is skipped when we're active
	// (mutex in index.js), so seed it here — otherwise every --title collapses
	// to bare "Claude Code" and duplicates the bundle header.
	require('./notifier').setProjectName(projectName)

	// Ensure the "Claude Code" sender bundle exists with the bundled icon
	// BEFORE the first send fires. `notif register` is idempotent — no-op
	// when the bundle is already materialized with the same identifier +
	// display name. Failure is non-fatal : we log a warning and continue ;
	// `notif send --sender claude-code` will auto-materialize on first
	// send anyway, just without the bundled icon.
	const registerDiag = registerClaudeCodeSender()

	// Session 3 — resolve the Allow action inbox + outbound.jsonl paths. Both
	// live under the workspace's `.devcontainer/tmp/logs/`, alongside the existing
	// claude-code-vscode-ext-{inbound,outbound}.jsonl channel that ext.js polls.
	// projectDir is passed by index.js (post session 3) ; when it's absent
	// (older index.js callers, standalone tests), Allow simply won't fire —
	// the action arg is skipped and the notif shows Body-click only.
	let inboxDiag = { actions_inbox: 'disabled-no-projectDir' }
	if (projectDir) {
		actionsInboxPath = path.join(projectDir, '.devcontainer', 'tmp', 'logs', 'notif-actions.jsonl')
		outboundPath    = path.join(projectDir, '.devcontainer', 'tmp', 'logs', 'claude-code-vscode-ext-outbound.jsonl')
		inboxDiag       = startActionsInboxWatcher()
	}

	bus.on('send:notification', send)
	bus.on('cancelled:notification', onCancelled)

	const diag = { host, notif: notifBinPath, sender: CLAUDE_CODE_SENDER, ...registerDiag, ...inboxDiag }
	return { status: 'ok', diag }
}

/**
 * Bootstrap the "Claude Code" sender bundle at daemon boot. Two-step,
 * both idempotent :
 *
 *   1. `notif register --sender claude-code --name "Claude Code" [--icon <path>]`
 *      — materializes the bundle on a fresh install, no-ops when already
 *      materialized (short-circuit on plist + exe presence, keeps the TCC
 *      grant). Fires the OS permission dialog on the very first boot ;
 *      subsequent boots do nothing.
 *   2. `notif set-icon --sender claude-code --icon <path>` — unconditional
 *      icon refresh, byte-compares against the on-disk icon.icns and no-ops
 *      when identical. Handles the "existing bundle, missing / stale icon"
 *      case that `register` short-circuits past (register does NOT refresh
 *      icons on existing bundles).
 *
 * Both steps are non-fatal : on failure we log a warning and continue.
 * The next `notif send --sender claude-code` will auto-materialize the
 * bundle if step 1 didn't ; the icon may end up as the default bell if
 * step 2 didn't run — the daemon still delivers banners, just under a
 * plain sender identity.
 *
 * @returns {object}  diag fields to fold into start()'s return
 */
function registerClaudeCodeSender() {
	const hasIcon = fs.existsSync(CLAUDE_CODE_ICON)
	if (!hasIcon) {
		log.warn(`[notify-app] Claude Code icon missing at ${CLAUDE_CODE_ICON} — sender will use the default bell`)
	}

	// On a FRESH install the bundle doesn't exist and `notif register` fires
	// the OS permission dialog which needs the user to click Allow — that
	// takes much longer than the previous 5 s timeout allowed, so the window
	// is 90 s. On subsequent boots the bundle already exists on disk : we
	// short-circuit to avoid re-running the setup dance (idempotent but
	// wastes daemon boot time + may silently fail if macOS treats a fresh
	// setup call as suspicious).
	//
	// Icon updates from a repo commit do NOT propagate automatically —
	// `notif register` short-circuits on existing bundles and doesn't refresh
	// `Contents/Resources/icon.icns`. To adopt a new icon after this file
	// changed, run `notif set-icon --sender claude-code --icon <path>` on the
	// host manually.
	if (bundleAlreadyMaterialized()) {
		return { register: 'skipped-bundle-exists' }
	}
	const args = ['register', '--sender', CLAUDE_CODE_SENDER, '--name', CLAUDE_CODE_NAME]
	if (hasIcon) args.push('--icon', CLAUDE_CODE_ICON)
	const regStatus = runNotif(args, 'register', REGISTER_TIMEOUT_MS)
	return { register: regStatus }
}

/**
 * Detect whether the Claude Code sender bundle already exists on disk. Used
 * to skip step 1 above on subsequent boots. Checks both the display-named
 * folder (`Claude Code.app` — what `notif register --name "Claude Code"`
 * produces) and the key-fallback folder (`claude-code.app` — what an early
 * hand-crafted register would have left behind).
 *
 * @returns {boolean}
 */
function bundleAlreadyMaterialized() {
	const root = path.join(os.homedir(), '.local', 'share', 'notif', 'senders')
	const candidates = [
		path.join(root, `${CLAUDE_CODE_NAME}.app`, 'Contents', 'MacOS', 'notif'),
		path.join(root, `${CLAUDE_CODE_SENDER}.app`, 'Contents', 'MacOS', 'notif'),
	]
	return candidates.some(p => fs.existsSync(p))
}

/**
 * Small wrapper around spawnSync for the register + set-icon chain. Logs
 * outcome + returns a diag string. Never throws.
 *
 * @param {string[]} args      argv passed to `notif`
 * @param {string} label       log label ("register" / "set-icon")
 * @param {number} timeoutMs   spawnSync timeout
 * @returns {string}           `ok` | `failed-<code>` | `threw`
 */
function runNotif(args, label, timeoutMs) {
	try {
		const r = spawnSync(notifBinPath, args, {
			stdio:   'pipe',
			timeout: timeoutMs,
			env:     { ...process.env, NOTIF_QUIET: '1' },
		})
		if (r.status === 0) {
			log.info(`[notify-app] notif ${label} ok`)
			return 'ok'
		}
		const stderr = (r.stderr || '').toString().trim()
		if (r.signal) {
			log.warn(`[notify-app] notif ${label} killed by ${r.signal} after ${timeoutMs}ms (probably user did not respond to the OS permission dialog in time) — stderr: ${stderr || '<no stderr>'}`)
			return `timeout-${r.signal}`
		}
		if (stderr.includes('Notifications are not allowed')) {
			log.warn(`[notify-app] notif ${label} exited ${r.status}: TCC has cached a "denied" state for com.notify.${CLAUDE_CODE_SENDER}. Run \`tccutil reset Notifications com.notify.${CLAUDE_CODE_SENDER}\` on the host, then rebuild the devcontainer.`)
			return `failed-tcc-denied`
		}
		log.warn(`[notify-app] notif ${label} exited ${r.status}: ${stderr || '<no stderr>'}`)
		return `failed-${r.status}`
	} catch (e) {
		log.warn(`[notify-app] notif ${label} threw: ${e.message}`)
		return 'threw'
	}
}

// -----------------------------------------------------------------------------
// BINARY RESOLUTION
// -----------------------------------------------------------------------------

/**
 * Resolve the absolute path to the `notif` CLI binary, in priority order :
 *
 *   1. `NOTIF_BIN` env — explicit override.
 *   2. `$XDG_DATA_HOME/notif/notif` — XDG-conformant install location.
 *   3. `~/.local/bin/notif` — common user-local bin dir.
 *   4. `~/bin/notif` — the location suggested by apps/notifier/docs/install-macos.md.
 *   5. `/usr/local/bin/notif` — Homebrew Intel + manual system install.
 *   6. `/opt/homebrew/bin/notif` — Homebrew Apple Silicon.
 *   7. `PATH` scan — any directory on `$PATH` containing `notif` (catches
 *      MacPorts /opt/local/bin, custom shim dirs, etc).
 *   8. `<daemon-root>/vendor/notif` — bundled fallback (daemon ships its own copy).
 *
 * Returns `null` if none exist. Callers report `skipped` and hand the bus
 * back to basic-notif.
 *
 * @returns {string|null} absolute path, or null
 */
function getNotifPath() {
	const explicit = [
		process.env.NOTIF_BIN,
		process.env.XDG_DATA_HOME
			? path.join(process.env.XDG_DATA_HOME, 'notif', 'notif')
			: null,
		path.join(os.homedir(), '.local', 'bin', 'notif'),
		path.join(os.homedir(), 'bin', 'notif'),
		'/usr/local/bin/notif',
		'/opt/homebrew/bin/notif',
	]
	for (const p of explicit) {
		if (p && fs.existsSync(p)) return p
	}
	// PATH scan — no subprocess. `which`-style resolution for whichever
	// bin dir the operator dropped `notif` in and exported on PATH.
	const PATH = process.env.PATH || ''
	for (const dir of PATH.split(path.delimiter)) {
		if (!dir) continue
		const candidate = path.join(dir, 'notif')
		if (fs.existsSync(candidate)) return candidate
	}
	// Bundled fallback — daemon ships its own copy for zero-install cases.
	const vendor = path.join(__dirname, '..', '..', 'vendor', 'notif')
	if (fs.existsSync(vendor)) return vendor
	return null
}

// -----------------------------------------------------------------------------
// DISPATCH
// -----------------------------------------------------------------------------

/**
 * Bus handler for `send:notification`. Extracts sender + notif_id from the
 * queue line (hook.js writes them in session 8+), invokes
 * `notif send --sender X --id Y --title T --body B [...]`, then records the
 * dispatched notif so `onCancelled` can dismiss it later.
 *
 * @param {object} payload   { sid, eventType, ts, line, id }
 * @returns {void}           fire-and-forget
 */
function send(payload) {
	const sid  = payload.sid || ''
	const sid8 = sid.slice(0, 8)
	const line = payload.line || {}

	const rawId = line.notif_id
	if (!rawId && !notifIdFallbackLogged) {
		log.warn('[notify-app] queue payload missing notif_id — hook.js pre-dates v0.2 ; using local fallback id (further occurrences squelched)')
		notifIdFallbackLogged = true
	}
	// This consumer is the devcontainer notify path for Claude Code — the
	// sender identity is always "Claude Code", overriding whatever hook.js
	// wrote on line.sender (that field stays a placeholder for other
	// consumers that may implement per-event routing).
	const sender  = CLAUDE_CODE_SENDER
	const notifId = rawId || `fallback-${sid8}-${Date.now()}`
	// Elevate the interruption level on macOS for events that need the
	// user's attention now. Anything else stays at Active (the default).
	const priority = (payload.eventType === 'permission_request' || payload.eventType === 'permission_prompt') ? 'high' : null

	// Reuse the basic-notif TEMPLATES via a lazy require to avoid a load-order
	// cycle at module init. `render()` returns { title, subtitle, body } with
	// the exact same shape basic-notif spawns.
	const { render } = require('./notifier')
	const rendered = render(payload)

	const args = [
		'send',
		'--sender', sender,
		'--id',     notifId,
		'--title',  rendered.title,
		'--body',   rendered.body,
	]
	if (rendered.subtitle) args.push('--subtitle', rendered.subtitle)
	if (priority)          args.push('--priority', priority)

	// Body-click routing : bind `focus:open-a://Visual Studio Code/<launchUrl>`
	// so clicking the notif switches to (and cross-Space focuses) the emitting
	// devcontainer window. See notif-core::callback::CallbackKind::FocusOpen
	// for the DSL. When `launchUrl` is missing (session-1 producer contract),
	// no `--on-click` is passed and click is a silent no-op.
	const focusTarget = buildFocusTarget(line.launchUrl)
	if (focusTarget) {
		args.push('--on-click', focusTarget)
	} else if (!launchUrlMissingLogged) {
		log.warn('[notify-app] event has no valid launchUrl — body-click is a no-op (session-1 producer contract ; further occurrences squelched)')
		launchUrlMissingLogged = true
	}

	// Session 3 — Allow action button for permission_request / permission_prompt
	// events. Emits a `--on-action Allow:file:<inbox>` that lets the `notif`
	// binary append a JSONL record to the inbox when the user taps Allow ; the
	// tail watcher (startActionsInboxWatcher) then writes a
	// tool_permission_response into outbound.jsonl for the ext.js injector.
	// Deliberately no Deny button — body-click focuses VS Code where the user
	// can deny with feedback in the Claude Code UI.
	// AskUserQuestion is excluded : it needs the user to pick a specific
	// answer among N options, not a blanket "allow" — surfacing the button
	// there would trigger an ambiguous ack (which option got allowed ?).
	if (
		actionsInboxPath &&
		(payload.eventType === 'permission_request' || payload.eventType === 'permission_prompt') &&
		line.tool_name !== 'AskUserQuestion' &&
		typeof line.tool_use_id === 'string' && line.tool_use_id
	) {
		args.push('--on-action', `Allow:file:${actionsInboxPath}`)
		rememberPermissionContext(notifId, sid, line.tool_use_id, line.tool_input)
	}

	// Session 4 focus-aware gate. `line.focused` is written by hook.js's
	// readLatestFocus() from the extension patch's `vscode.window.state`
	// snapshot in pending-perms.jsonl. When the host VS Code window is
	// focused at emission time, delay the banner by NOTIFY_FOCUS_DEBOUNCE_MS
	// (default 5 s) — gives the user a grace window to act in-app before the
	// macOS banner interrupts. A `cancelled:notification` on the bus (user
	// replied, tool finished, Allow click via inbound-watch) clears the
	// pending debounce before it fires ; no banner in that case. Missing /
	// false `line.focused` short-circuits to the immediate dispatch path.
	const debounceMs = focusDebounce.getDebounceMs(process.env)
	if (line.focused === true && debounceMs > 0) {
		log.info(`[notify-app] focus-debounce ARM ${sid8} ${payload.eventType} — ${debounceMs}ms (id=${notifId})`)
		focusDebounce.armDebounce(sid, debounceMs, () => {
			log.info(`[notify-app] focus-debounce FIRE ${sid8} ${payload.eventType} — timeout expired (id=${notifId})`)
			dispatchNow(sid, sid8, sender, notifId, args, payload.eventType)
		})
		return
	}
	dispatchNow(sid, sid8, sender, notifId, args, payload.eventType)
}

/**
 * Spawn `notif send` with the pre-built argv and record the dispatched banner
 * so cancel signals can later dismiss it. Extracted from `send()` so the
 * focus-aware gate can either invoke it directly (not focused) or defer it
 * behind a debounce timer (focused).
 *
 * @param {string}   sid
 * @param {string}   sid8       first 8 chars for log lines
 * @param {string}   sender     'claude-code' in v0.2
 * @param {string}   notifId
 * @param {string[]} args       fully-built `notif send` argv
 * @param {string}   eventType  logged for diagnostics
 * @returns {void}              fire-and-forget
 */
function dispatchNow(sid, sid8, sender, notifId, args, eventType) {
	log.info(`[notify-app] DISPATCH ${eventType} ${sid8} — id=${notifId} sender=${sender}`)
	// Enforce the "1 delivered banner per sid" invariant : dismiss any prior
	// banner for this sid BEFORE dispatching the new one, so Notification
	// Center never accumulates duplicates when a session emits multiple
	// events (e.g. permission_request then stop).
	dismissPrevious(sid, 'replaced-by-new-notif')
	spawnFireAndForget(notifBinPath, args)
	rememberDispatched(sid, sender, notifId)
}

/**
 * Dismiss the currently-tracked banner for a sid via `notif remove`, and drop
 * the `dispatched` entry. Silent no-op when nothing is tracked (pre-fire
 * cancels never had a banner to remove ; a fresh dispatch on an empty slot
 * has nothing to replace).
 *
 * @param {string} sid
 * @param {string} reason  logged for diagnostics
 * @returns {void}         fire-and-forget
 */
function dismissPrevious(sid, reason) {
	const entry = dispatched.get(sid)
	if (!entry) return
	dispatched.delete(sid)
	if (entry.timeout) clearTimeout(entry.timeout)
	const sid8 = sid.slice(0, 8)
	log.info(`[notify-app] dismiss ${sid8} — removing notif id=${entry.notifId} (${reason})`)
	spawnFireAndForget(notifBinPath, [
		'remove',
		'--sender', entry.sender,
		'--id',     entry.notifId,
	])
}

/**
 * Bus handler for `cancelled:notification`. Delegates to `dismissPrevious`
 * so the "1 banner per sid" invariant is enforced through a single code
 * path for both cancel-triggered and dispatch-triggered dismissals.
 *
 * @param {object} evt
 * @param {string} [evt.sid]        session id — provided by watcher.js since session-8
 * @param {string} [evt.eventType]  logged for diagnostics
 * @param {string} [evt.reason]     logged for diagnostics
 * @returns {void}                  fire-and-forget
 */
function onCancelled({ sid, eventType, reason } = {}) {
	if (!sid) return
	// Session 4 — if a focus-debounce timer is pending for this sid, cancel
	// it BEFORE the dismiss path : a debounced-and-cancelled event never
	// dispatched, so `dismissPrevious` will short-circuit at its empty-map
	// check (no banner to remove). Doing cancel-debounce first keeps the
	// happy-path (dispatched banner + cancel) unchanged.
	if (focusDebounce.cancelDebounce(sid)) {
		log.info(`[notify-app] focus-debounce CANCEL ${sid.slice(0, 8)} — ${eventType || 'unknown'}/${reason}`)
	}
	dismissPrevious(sid, `${eventType || 'unknown'}/${reason}`)
}

/**
 * Store the (sender, notif_id) pair for a dispatched banner so onCancelled
 * can dismiss it. Auto-evicts after DISPATCHED_TTL_MS ; the previous entry
 * (if any) is cleared so its timer never leaks.
 *
 * @param {string} sid
 * @param {string} sender
 * @param {string} notifId
 * @returns {void}
 */
function rememberDispatched(sid, sender, notifId) {
	if (!sid || !notifId) return
	const prev = dispatched.get(sid)
	if (prev?.timeout) clearTimeout(prev.timeout)
	const timeout = setTimeout(() => dispatched.delete(sid), DISPATCHED_TTL_MS)
	timeout.unref?.()
	dispatched.set(sid, { sender, notifId, timeout })
}

// -----------------------------------------------------------------------------
// SPAWN HELPER
// -----------------------------------------------------------------------------

/**
 * Fire-and-forget spawn : stdio ignored, detached + unref'd so the child
 * outlives the daemon on shutdown ; NOTIF_QUIET=1 silences the CLI's
 * progress log (daemon isn't interactive). Errors are logged and swallowed
 * — a failed notif dispatch must never crash the daemon.
 *
 * @param {string} cmd     absolute path to the `notif` binary
 * @param {string[]} args  argv
 * @returns {void}
 */
function spawnFireAndForget(cmd, args) {
	try {
		const child = spawn(cmd, args, {
			detached: true,
			stdio:    'ignore',
			env:      { ...process.env, NOTIF_QUIET: '1' },
		})
		child.unref()
		child.on('error', (err) => log.warn(`[notify-app] ${cmd} failed: ${err.message}`))
	} catch (e) {
		log.warn(`[notify-app] spawn ${cmd} threw: ${e.message}`)
	}
}

// -----------------------------------------------------------------------------
// FOCUS DSL HELPER
// -----------------------------------------------------------------------------

/**
 * Build the `focus:open-a://<APP>/<URL>` DSL target for a given launchUrl,
 * or null when the URL is missing / malformed. Shared between the body-click
 * `--on-click` (session 2) and any future action target that wants to focus
 * VS Code — extracted so both paths stay in sync on the sanitisation.
 *
 * Rejection cases : non-string, empty, or containing whitespace / NUL. All
 * three would fail the inner `parse_target` boundary in `notif`, aborting
 * the whole `notif send` — worse UX than a silent no-op click.
 *
 * @param {string|undefined} url    launchUrl candidate from the queue line
 * @returns {string|null}           DSL target, or null when the URL is unusable
 */
function buildFocusTarget(url) {
	if (typeof url !== 'string' || !url || /[\s\0]/.test(url)) return null
	return `focus:open-a://${VSCODE_APP_SLUG}/${url}`
}

// -----------------------------------------------------------------------------
// PERMISSION CONTEXT + ACTIONS INBOX (session 3)
// -----------------------------------------------------------------------------

/**
 * Store the send-time (sid, tool_use_id, tool_input) triple for a
 * permission notification so the inbox watcher can build the outbound
 * command when the user later clicks Allow. Auto-evicts after
 * PERMISSION_TTL_MS ; a duplicate insert clears the previous timer so it
 * never leaks.
 *
 * @param {string} notifId
 * @param {string} sid
 * @param {string} toolUseId
 * @param {*}      toolInput   pass-through from the queue line ; may be
 *                              undefined / any JSON shape
 * @returns {void}
 */
function rememberPermissionContext(notifId, sid, toolUseId, toolInput) {
	if (!notifId || !sid || !toolUseId) return
	const prev = permissionContext.get(notifId)
	if (prev?.timeout) clearTimeout(prev.timeout)
	const timeout = setTimeout(() => permissionContext.delete(notifId), PERMISSION_TTL_MS)
	timeout.unref?.()
	permissionContext.set(notifId, { sid, toolUseId, toolInput, timeout })
}

/**
 * Wire the actions inbox tail watcher. Ensures the logs dir + inbox file
 * exist, seeks to the current file end (so we skip records from prior
 * daemon incarnations — Allow clicks during daemon downtime are silently
 * lost by design), and installs a polling watcher that drains new lines
 * as they land.
 *
 * Returns a small diag object folded into the consumer's start() report.
 *
 * @returns {object}
 */
function startActionsInboxWatcher() {
	try {
		fs.mkdirSync(path.dirname(actionsInboxPath), { recursive: true })
		if (!fs.existsSync(actionsInboxPath)) {
			fs.writeFileSync(actionsInboxPath, '')
		}
		inboxOffset = fs.statSync(actionsInboxPath).size
	} catch (e) {
		log.warn(`[notify-app] cannot prepare actions inbox at ${actionsInboxPath}: ${e.message}`)
		return { actions_inbox: `failed-${e.code || 'io'}` }
	}
	try {
		// 500 ms poll — matches the ext.js outbound poll cadence (200 ms) plus
		// some slack. `fs.watchFile` uses stat polling, which is bullet-proof
		// against the inode-swap gotchas of `fs.watch` on network / bind mounts.
		// `persistent: false` so the watcher doesn't ref the event loop — the
		// bus subscription is what keeps the daemon alive, and tests can exit
		// cleanly without an explicit unwatch call.
		fs.watchFile(actionsInboxPath, { interval: 500, persistent: false }, drainActionsInbox)
	} catch (e) {
		log.warn(`[notify-app] cannot watch ${actionsInboxPath}: ${e.message}`)
		return { actions_inbox: `watch-failed-${e.code || 'io'}` }
	}
	log.info(`[notify-app] actions inbox attached to ${actionsInboxPath} (offset=${inboxOffset})`)
	return { actions_inbox: actionsInboxPath }
}

/**
 * `fs.watchFile` callback — reads the new bytes since `inboxOffset`, splits
 * on newlines, and dispatches each parsed JSONL record via
 * `processInboxLine`. Truncation (size < offset) resets the offset to 0.
 *
 * @param {fs.Stats} curr
 * @returns {void}
 */
function drainActionsInbox(curr) {
	if (curr.size < inboxOffset) {
		// File was truncated / rotated externally — reset and drain from the top.
		log.info('[notify-app] actions inbox truncated — offset reset')
		inboxOffset = 0
	}
	if (curr.size === inboxOffset) return
	let buf
	try {
		const fd = fs.openSync(actionsInboxPath, 'r')
		buf = Buffer.alloc(curr.size - inboxOffset)
		fs.readSync(fd, buf, 0, buf.length, inboxOffset)
		fs.closeSync(fd)
	} catch (e) {
		log.warn(`[notify-app] read ${actionsInboxPath} failed: ${e.message}`)
		return
	}
	inboxOffset = curr.size
	const text = buf.toString('utf8')
	for (const raw of text.split('\n')) {
		if (!raw) continue
		let record
		try { record = JSON.parse(raw) }
		catch (e) {
			log.warn(`[notify-app] bad JSONL in actions inbox: ${e.message}`)
			continue
		}
		processInboxLine(record)
	}
}

/**
 * Dispatch one parsed actions-inbox record. Only records with
 * `event === "action:Allow"` produce an outbound line ; anything else is
 * logged and ignored (future action labels can extend the switch).
 *
 * @param {object} record   CallbackPayload written by `notif`'s file: DSL
 * @param {string} [record.notif_id]
 * @param {string} [record.event]     e.g. "action:Allow"
 * @returns {void}
 */
function processInboxLine(record) {
	const notifId = record?.notif_id
	const event   = record?.event
	if (!notifId || event !== 'action:Allow') return
	const ctx = permissionContext.get(notifId)
	if (!ctx) {
		log.warn(`[notify-app] action:Allow received for unknown notif_id=${notifId} — dropped`)
		return
	}
	permissionContext.delete(notifId)
	if (ctx.timeout) clearTimeout(ctx.timeout)
	writeAllowOutbound(ctx.sid, ctx.toolUseId, ctx.toolInput)
}

/**
 * Append a `tool_permission_response` allow command to the outbound.jsonl
 * file the VS Code extension's outbound-action-injector polls. Schema
 * mirrors outbound-tester.js exactly so the ext.js watcher parses both
 * sources identically.
 *
 * Naming note — the parameter is called `toolUseId` for historical continuity
 * with the queue-line field `line.tool_use_id`, but its actual value is the
 * ext-side channel `requestId` (hex 32 chars) sourced from pending-perms.jsonl
 * by hook.js. NOT the model-side `toolu_XXX` from Claude — those are a
 * disjoint ID namespace and would fail the injector's pending-request match.
 *
 * @param {string} sid
 * @param {string} toolUseId   ext channel requestId — see naming note above
 * @param {*}      toolInput   passthrough of the original tool_input ;
 *                              becomes `updatedInput` on the wire
 * @returns {void}
 */
function writeAllowOutbound(sid, toolUseId, toolInput) {
	if (!outboundPath) return
	const cmd = {
		cmd:                'tool_permission_response',
		sessionId:          sid,
		requestId:          toolUseId,
		behavior:           'allow',
		updatedInput:       toolInput ?? {},
		updatedPermissions: [],
	}
	try {
		fs.mkdirSync(path.dirname(outboundPath), { recursive: true })
		fs.appendFileSync(outboundPath, JSON.stringify(cmd) + '\n')
		log.info(`[notify-app] allow ack written for sid=${sid.slice(0, 8)} rid=${toolUseId.slice(0, 8)}`)
	} catch (e) {
		log.warn(`[notify-app] outbound append failed at ${outboundPath}: ${e.message}`)
	}
}

module.exports = {
	start,
	getNotifPath,
	// Exposed for tests only ; do not consume from production code.
	_test: { buildFocusTarget, processInboxLine, rememberPermissionContext, permissionContext },
}
