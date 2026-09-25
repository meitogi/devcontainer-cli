// =============================================================================
// notifier — OS-native desktop notification dispatch
// =============================================================================
//
// Subscribes to 'send:notification' on the bus and spawns the right
// platform-native command per notif. Zero NPM dependency.
//
// EXTENSION CONTRACT — TEMPLATES table
//   This module owns the look of OS desktop notifications. Each event
//   type has its own entry in TEMPLATES, returning { title, subtitle,
//   body } — the three fields that map cleanly onto macOS osascript
//   (title / subtitle / body) and Windows WinRT toast (line 1 / line 2).
//
//   Layout convention :
//     title    = "Claude Code · <project>"     ← daemon-wide brand
//     subtitle = "<session name>"              ← customTitle / aiTitle (may be long)
//     body     = "<action hint>\n<message> · HH:MM:SS"
//                  ^── line 1 (skipped for Stop / Idle — message is self-describing)
//                                  ^── line 2 (terse)
//
//   Subtitle carries the session identifier — useful when several Claude
//   tabs are open and the user needs to know WHICH session pinged. macOS
//   may truncate long subtitles in some surfaces ; that's acceptable —
//   the verbose body lines below have plenty of room for the actual info.
//
//   Body line 1 surfaces a SHORT action hint for events that need the
//   user to do something ("Permission asked", "Question"). For events
//   that are informational ("Stop" = "I'm done", "Idle" = "I'm waiting"),
//   the line 1 hint is dropped — the recap / message in line 2 already
//   conveys what happened.
//
//   Time stamp is local 24-hour HH:MM:SS, derived from the event's ts so
//   it reflects the creation moment, not "now".
//
//   To customise what shows up for a given event, edit the TEMPLATES
//   table below — no other file changes needed.
//
// PLATFORM SUPPORT
//   macos          → osascript `display notification` (built-in)
//   windows        → PowerShell WinRT toast + VS Code AUMID. Covers both
//                    native win32 Node AND Linux-on-WSL (powershell.exe
//                    reached via interop). Boot-time spawnSync probe
//                    decides whether to enable.
//   linux native   → TODO stub (notify-send -a "Claude Code" sub body)
// =============================================================================

const { spawn, spawnSync } = require('child_process')
const log = require('../log')
const { BRAND_NAME, TYPE_LABELS, WINDOWS_AUMID, WINDOWS_DETACHED_GRACE_MS } = require('../constants')
const { getHostKind } = require('../host')
const { permissionLine } = require('../smart-text')

let projectName = ''

// -----------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// -----------------------------------------------------------------------------

/**
 * Wire the OS-native notifier consumer onto the bus. Subscribes to
 * 'send:notification' and dispatches via sendMac / sendWindows / sendLinux.
 * Linux returns `skipped` because sendLinux is a logging stub today (kept
 * for future libnotify wiring — see file footer).
 *
 * Conforms to the consumer contract documented in index.js : returns a
 * `{ status, diag }` diagnostics object that index.js relays in its boot
 * report.
 *
 * @param {object} opts
 * @param {import('events').EventEmitter} opts.bus   listens for 'send:notification'
 * @param {string} [opts.projectName]                optional project label baked into the title
 * @returns {{ status: 'ok'|'skipped', diag: object }}
 *          status='skipped' on linux-native (no implementation yet) or on WSL
 *          when powershell.exe isn't reachable ; diag.host set on all paths,
 *          diag.aumid added on windows, diag.reason on skip
 */
function start({ bus, projectName: pn = '' }) {
	projectName = pn
	const host = getHostKind()
	if (host === 'linux') {
		return { status: 'skipped', diag: { host, reason: 'linux-not-implemented' } }
	}
	if (host === 'unknown') {
		return { status: 'skipped', diag: { host, reason: 'unsupported-platform' } }
	}
	if (host === 'windows' && process.platform === 'linux' && !probePowerShell()) {
		// WSL but powershell.exe not reachable — degrade cleanly instead of
		// failing at every notif spawn. WSL1 without interop gets us here.
		return { status: 'skipped', diag: { host, reason: 'wsl-no-powershell' } }
	}
	bus.on('send:notification', send)
	const diag = { host }
	if (host === 'windows') diag.aumid = WINDOWS_AUMID
	if (process.platform === 'linux') diag.wsl = true
	return { status: 'ok', diag }
}

/**
 * Boot-time probe — `powershell.exe -NoProfile -Command exit 0`. WSL exposes
 * Windows binaries via interop ; if the spawn fails or the exit code is
 * non-zero we conclude PowerShell is unreachable (WSL1 without interop, or
 * a fundamentally broken interop setup). 3 s timeout — cold-start through
 * interop is normally well under 1 s.
 *
 * @returns {boolean}   true when powershell.exe responded with exit 0
 */
function probePowerShell() {
	try {
		const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], {
			stdio:   'ignore',
			timeout: 3000
		})
		return r.status === 0
	} catch (_) {
		return false
	}
}

// -----------------------------------------------------------------------------
// SHARED TEMPLATE HELPERS
// -----------------------------------------------------------------------------

/**
 * Format a timestamp as `HH:MM:SS` in 24-hour local time, locale-independent.
 * Built from the supplied ISO string (the event's creation moment) so the
 * notif body reflects when the user-relevant thing actually happened, not
 * "now" when the debounced notif finally fires.
 *
 * @param {string} ts   ISO 8601 timestamp ; falsy → uses current time
 * @returns {string}    `HH:MM:SS`
 */
function hhmmss(ts) {
	const d = ts ? new Date(ts) : new Date()
	const pad = (n) => String(n).padStart(2, '0')
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

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
 * Build the brand title displayed on line 1 of every notification. Reads
 * the module-level `projectName` captured at start() time and appends it
 * to the BRAND_NAME constant with a centered-dot separator. Falls back to
 * the bare brand when no project name was supplied.
 *
 * @returns {string}   `Claude Code · <project>` or `Claude Code`
 */
function brandTitle() {
	return projectName ? `${BRAND_NAME} · ${projectName}` : BRAND_NAME
}

/**
 * Resolve the human-readable session label displayed on line 2 (subtitle).
 * Prefers the user-set customTitle / Claude aiTitle captured by the hook
 * (e.g. `DOING - Build macOS host…`), falls back to sid8(sid) when no
 * session_name was carried on the line.
 *
 * @param {object} payload          notification payload
 * @param {string} payload.sid      session UUID
 * @param {object} payload.line     JSONL event line
 * @param {string} [payload.line.session_name]   pre-resolved label from the hook
 * @returns {string}                session_name when present, else sid8(sid)
 */
function sessionLabel({ sid, line }) {
	return (line && line.session_name) || sid8(sid)
}

/**
 * Body line 1 helper — currently delegates to sessionLabel. Kept as a
 * separate function so templates can swap it out independently of the
 * subtitle resolution if needed later.
 *
 * @param {object} payload   notification payload (see sessionLabel)
 * @returns {string}         session label to render on body line 1
 */
function sessionLine(payload) {
	return sessionLabel(payload)
}

/**
 * Build the trailing time footer appended to body line 2 — ` · HH:MM:SS`
 * derived from the event timestamp. Centralised so every template renders
 * the same separator and time format.
 *
 * @param {object} payload      notification payload
 * @param {string} payload.ts   event creation timestamp (ISO 8601)
 * @returns {string}            ` · HH:MM:SS` ready to concatenate to a body
 */
function footer(payload) {
	return ` · ${hhmmss(payload.ts)}`
}

// -----------------------------------------------------------------------------
// TEMPLATES — one per eventType. Each returns { title, subtitle, body }.
// Common shape :
//   title    = "Claude Code · <project>"
//   subtitle = "<session name>"          ← long customTitle / aiTitle
//   body     = "<action hint>\n<message> · HH:MM:SS"
//            OR  "<message> · HH:MM:SS"    (no hint for self-describing events)
// -----------------------------------------------------------------------------

const TEMPLATES = {
	stop: (p) => ({
		title:    brandTitle(),
		subtitle: sessionLabel(p),
		body:     `${p.line.last_message_excerpt || '(empty)'}${footer(p)}`
	}),

	// No footer here, unlike every other template : the OS already timestamps
	// the banner, and those 11 characters are worth more spent on naming what
	// is about to happen — the Allow button is right there in the notification.
	permission_request: (p) => ({
		title:    brandTitle(),
		subtitle: sessionLabel(p),
		body:     permissionLine(p.line)
	}),

	permission_prompt: (p) => ({
		title:    brandTitle(),
		subtitle: sessionLabel(p),
		body:     `${TYPE_LABELS.permission_prompt}\n${p.line.message || '(prompt)'}${footer(p)}`
	}),

	elicitation_dialog: (p) => ({
		title:    brandTitle(),
		subtitle: sessionLabel(p),
		body:     `${TYPE_LABELS.elicitation_dialog}\n${p.line.message || '(question)'}${footer(p)}`
	}),

	idle_prompt: (p) => ({
		title:    brandTitle(),
		subtitle: sessionLabel(p),
		body:     `${TYPE_LABELS.idle_prompt}\n${p.line.message || 'Claude is waiting for input'}${footer(p)}`
	}),

	// Fired by index.js right before process.exit() on container:gone /
	// uncaughtException. Carries the shutdown reason in `last_message_excerpt`
	// so the user knows whether Docker quit, the container went away, or the
	// daemon crashed — without having to grep daemon.log.
	daemon_stopped: (p) => ({
		title:    brandTitle(),
		subtitle: 'Notify daemon stopped',
		body:     `${p.line.last_message_excerpt || '(unknown reason)'}${footer(p)}`
	})
}

/**
 * Render a payload to its `{ title, subtitle, body }` triple via the
 * TEMPLATES table keyed by `payload.eventType`. Falls back to a generic
 * `(no template)` shape when an event type has no entry yet — the channel
 * still fires so the user knows something happened, just with no styling.
 *
 * Exported so tests can preview the final output without spawning the OS
 * notifier process.
 *
 * @param {object} payload              event payload from the bus
 * @param {string} payload.eventType    template key
 * @returns {{ title: string, subtitle: string, body: string }}
 *          rendered notification triple ready for the platform-specific send
 */
function render(payload) {
	const fn = TEMPLATES[payload.eventType]
	if (fn) return fn(payload)
	return {
		title:    brandTitle(),
		subtitle: payload.eventType,
		body:     `(no template)${footer(payload)}`
	}
}

// -----------------------------------------------------------------------------
// DISPATCH
// -----------------------------------------------------------------------------

/**
 * Single-entry dispatcher attached to the 'send:notification' bus event.
 * Renders the payload through TEMPLATES then routes to the platform-
 * specific spawn helper. Unknown platforms log a warning and bail — the
 * Discord webhook channel still fires regardless from index.js' parallel
 * registration.
 *
 * @param {object} payload   notification payload (sid, eventType, ts, line, …)
 * @returns {void}           fire-and-forget — spawns a detached child process
 */
function send(payload) {
	const rendered = render(payload)
	const sid8 = String(payload.sid || '').slice(0, 8)
	const host = getHostKind()
	log.info(`[notifier] DISPATCH ${host} ${payload.eventType} ${sid8} — subtitle="${rendered.subtitle}"`)
	switch (host) {
		case 'macos':   return sendMac(rendered)
		case 'windows': return sendWindows(rendered)
		case 'linux':   return sendLinux(rendered)
		default:        return log.warn(`[notifier] unsupported host: ${host}`)
	}
}

// -----------------------------------------------------------------------------
// macOS render
// -----------------------------------------------------------------------------

/**
 * macOS dispatch — `osascript -e display notification`. `osascript -e`
 * expects a single AppleScript source string ; backslashes, double-quotes,
 * and newlines in the input are neutralised to spaces so they cannot
 * break out of the string literal and inject AppleScript.
 *
 * @param {object} triple
 * @param {string} triple.title      notification title (line 1)
 * @param {string} triple.subtitle   notification subtitle (line 2)
 * @param {string} triple.body       notification body
 * @returns {void}                   fire-and-forget detached osascript spawn
 */
function sendMac({ title, subtitle, body }) {
	const safe = (s) => String(s).replace(/[\\"]/g, ' ').replace(/[\r\n]+/g, ' ')
	// Intentionally silent : we omit the optional `sound name "..."` parameter.
	// Since macOS Big Sur, `display notification` is silent by default when no
	// sound is specified — audio is left to the parallel `sound` consumer
	// (lib/consumers/sound.js) to avoid a double-chime per event.
	//
	// To re-enable a built-in macOS sound here, append ` sound name "Submarine"`
	// (or any other) to the AppleScript string :
	//   const script = `display notification "${safe(body)}" with title "${safe(title)}" subtitle "${safe(subtitle)}" sound name "Submarine"`
	// Valid names (no extension) match files under /System/Library/Sounds/ :
	// Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr,
	// Sosumi, Submarine, Tink.
	const script = `display notification "${safe(body)}" with title "${safe(title)}" subtitle "${safe(subtitle)}"`
	spawnDetached('osascript', ['-e', script])
}

// -----------------------------------------------------------------------------
// Windows render
// -----------------------------------------------------------------------------

// --- AUMID discovery (kept as reference, not called) ---
// If WINDOWS_AUMID needs to be auto-detected (Insiders / Squirrel install
// / Microsoft Store variant), uncomment the helper below and call it from
// start() to populate a let-binding before sendWindows uses it. Costs one
// PowerShell cold start (~500-800 ms) per daemon boot.
//
// function discoverVscodeAumid() {
// 	const ps = `
// 		$a = (Get-StartApps | Where-Object { $_.Name -match '^Visual Studio Code$' } | Select-Object -First 1).AppID
// 		if (-not $a) { $a = (Get-StartApps | Where-Object { $_.Name -match 'Visual Studio Code' } | Select-Object -First 1).AppID }
// 		if (-not $a) { $a = 'Microsoft.Windows.Explorer' }
// 		Write-Output $a
// 	`
// 	try {
// 		const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 5000 })
// 		return (r.stdout || '').trim() || 'Microsoft.Windows.Explorer'
// 	} catch (_) { return 'Microsoft.Windows.Explorer' }
// }

/**
 * Windows dispatch — WinRT toast via inline PowerShell. The toast XML packs
 * the brand title as line 1 and the body as line 2, both XML-escaped. The
 * subtitle is folded into line 1 with an em-dash separator because WinRT
 * toasts only render two `<text>` lines reliably. Inside the PS-quoted
 * LoadXml literal, single quotes are doubled to escape them.
 *
 * Borrows VS Code's identity via the WINDOWS_AUMID constant — the notif
 * appears as if VS Code emitted it, which clicks through to the right app.
 *
 * @param {object} triple
 * @param {string} triple.title      notification title (folded into line 1)
 * @param {string} triple.subtitle   subtitle (folded into line 1 after the title)
 * @param {string} triple.body       notification body (line 2)
 * @returns {void}                   fire-and-forget detached PowerShell spawn
 */
function sendWindows({ title, subtitle, body }) {
	const xmlEscape = (s) => String(s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&apos;')
	const line1 = xmlEscape(`${title} — ${subtitle}`)
	const line2 = xmlEscape(body)
	// `<audio silent="true"/>` mutes the toast itself — without it, Windows
	// plays its `Notification.Default` chime, which would double up with the
	// parallel `sound` consumer (lib/consumers/sound.js). The <audio> element
	// MUST come after <visual> per the WinRT toast schema.
	//
	// To re-enable a sound here, swap the <audio/> element with one of :
	//   <audio src="ms-winsoundevent:Notification.IM"/>
	//     valid suffixes : Default, IM, Mail, Reminder, SMS
	//   <audio src="file:///C:/path/to/bell.wav"/>
	//     custom WAV, <10 s, on a path the OS toast platform can reach
	//   <audio src="ms-winsoundevent:Notification.Looping.Alarm2" loop="true"/>
	//     looping sound — also requires `<toast duration="long">` on the root
	const xml = `<toast><visual><binding template="ToastGeneric"><text>${line1}</text><text>${line2}</text></binding></visual><audio silent="true"/></toast>`
	const ps = `
		[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
		[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]
		$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
		$xml.LoadXml('${xml.replace(/'/g, "''")}')
		$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
		[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_AUMID}').Show($toast)
		Start-Sleep -Milliseconds ${WINDOWS_DETACHED_GRACE_MS}
	`
	spawnDetached('powershell.exe', ['-NoProfile', '-Command', ps])
}

// -----------------------------------------------------------------------------
// Linux — TODO
// -----------------------------------------------------------------------------

/**
 * Linux dispatch — stub. Today this just logs a warning ; the Discord
 * webhook consumer remains the user-facing channel on Linux. Drop-in
 * replacement when a Linux user shows up :
 *   `spawnDetached('notify-send', ['-a', title, subtitle, body])`
 * libnotify-bin is pre-installed on GNOME / KDE / XFCE.
 *
 * @param {object} triple
 * @param {string} triple.title      notification title
 * @param {string} triple.subtitle   subtitle
 * @param {string} triple.body       notification body
 * @returns {void}                   logs a warning, does not spawn
 */
function sendLinux({ title, subtitle, body }) {
	log.warn(`[notifier] linux not implemented yet (title="${title}", subtitle="${subtitle}"). Discord webhook still active if configured.`)
}

// -----------------------------------------------------------------------------
// SPAWN HELPER
// -----------------------------------------------------------------------------

/**
 * Spawn a child process fully detached from the daemon : stdio ignored,
 * unref'd so it doesn't keep the event loop alive, and any spawn error
 * surfaces as a warn-level log instead of crashing the daemon. Used by
 * all three platform-specific dispatchers ; centralised so a single tweak
 * (e.g. capturing stderr for debugging) propagates everywhere.
 *
 * @param {string} cmd     executable to spawn
 * @param {string[]} args  argv passed to the executable
 * @returns {void}         fire-and-forget — errors are logged, never thrown
 */
function spawnDetached(cmd, args) {
	try {
		// NOTIFY_NOTIFIER_VERBOSE=1 → pipe stderr into daemon.log instead of
		// dropping it. Off by default ; toggles on when diagnosing silent
		// dispatch failures (DISPATCH log line appears, no toast visible).
		const verbose = process.env.NOTIFY_NOTIFIER_VERBOSE === '1'
		const stdio = verbose ? ['ignore', 'ignore', 'pipe'] : 'ignore'
		// Platform-branched detach mode :
		//   - Windows (incl. WSL→Windows interop) : windowsHide (no console
		//     flash) + NO detached. Detaching puts the child in a new process
		//     group that loses the interactive user-session association —
		//     WinRT toasts then silently fail (proven via diag-toast.js,
		//     tests 3-6 vs 1-2). Mirrors the proven pattern in sound.js.
		//     windowsHide is silently ignored on Linux/WSL but harmless there ;
		//     what matters is the absence of detached:true.
		//   - macOS / native Linux : detached + unref so the daemon can exit
		//     cleanly while the osascript / notify-send child keeps running.
		const opts = getHostKind() === 'windows'
			? { stdio, windowsHide: true }
			: { stdio, detached: true }
		const child = spawn(cmd, args, opts)
		child.unref()
		child.on('error', (err) => log.warn(`[notifier] ${cmd} failed: ${err.message}`))
		if (verbose && child.stderr) {
			child.stderr.on('data', (chunk) => {
				log.warn(`[notifier] ${cmd} stderr: ${chunk.toString().trim()}`)
			})
		}
	} catch (e) {
		log.warn(`[notifier] spawn ${cmd} threw: ${e.message}`)
	}
}

/**
 * Inject the project label used by brandTitle() without going through start().
 * Needed by sibling consumers (notify-app) that reuse this file's TEMPLATES /
 * render() but are mutually exclusive with start() on the channel mux — so
 * without this hook, projectName stays '' and brandTitle() collapses to the
 * bare BRAND_NAME, losing the ` · <project>` suffix.
 *
 * @param {string} pn   project name, falsy → cleared
 */
function setProjectName(pn) {
	projectName = pn || ''
}

// TEMPLATES + render are exposed so tests can preview the final output
// without spawning the OS notifier process.
module.exports = { start, TEMPLATES, render, setProjectName }
