// =============================================================================
// constants — notify-policy values shared across the daemon
// =============================================================================
//
// Single import surface for the constants that customise notify's behaviour
// (templates, OS defaults, third-party limits, regexes, per-event delays).
// Generic primitives (LF byte, ms/h, log rotation thresholds, SIGTERM grace,
// docker probe timeout, .tmp suffix) deliberately STAY in their respective
// files — extracting them would hurt readability for values that won't change.
//
// Importers :
//   index.js                       → EVENT_DELAYS_MS
//   lib/consumers/notifier.js      → BRAND_NAME, TYPE_LABELS, WINDOWS_AUMID
//   lib/consumers/flash-win.js     → FLASH_EVENT_TYPES
//   lib/consumers/sound.js         → NATIVE_SOUND_DEFAULTS, LINUX_SOUND_CANDIDATES
//   lib/consumers/discord-webhook  → DISCORD_WEBHOOK_URL_RE, DISCORD_TRUNCATION_LIMITS
//   lib/smart-text.js              → TOOL_VERBS, SMART_TEXT_LIMITS, POLICY_PATHS,
//                                    GIT_WRITE_SUBCOMMANDS, KNOWN_PATH_EXT
// =============================================================================

// -----------------------------------------------------------------------------
// TEMPLATES — strings + per-event maps that shape user-facing output.
// -----------------------------------------------------------------------------

/**
 * Brand baked into the OS notification title. Combined with the project name
 * by notifier.brandTitle() : `Claude Code · <project>`. Discord doesn't use
 * this — its bot already shows its display name on each message.
 */
exports.BRAND_NAME = 'Claude Code'

/**
 * Body line 1 = event-type-specific label. Each event has its OWN label,
 * surfacing what KIND of attention is needed. The label is NOT shown for
 * Stop — the recap message in line 2 is already self-explanatory.
 */
exports.TYPE_LABELS = {
	permission_request:  'Permission asked',
	permission_prompt:   'Permission prompt',
	elicitation_dialog:  'Question',
	idle_prompt:         'Idle',
	stop:                null   // sentinel: no label, recap message is the body
}

/**
 * Tool name → the verb opening a permission_request body. Keeps the banner
 * readable without the jargon of the raw tool identifier ("Bash" → "Run").
 * A tool absent from this map falls back to its own name — the tool list is
 * not stable (Monitor, Skill and Artifact all appeared mid-corpus), so the
 * unknown case must degrade cleanly rather than render empty.
 */
exports.TOOL_VERBS = {
	Bash:            'Run',
	Monitor:         'Watch',
	Edit:            'Edit',
	Write:           'Write',
	AskUserQuestion: 'Ask',
	ExitPlanMode:    'Plan',
	Skill:           'Skill',
	Artifact:        'Publish'
}

/**
 * Budget for the composed permission line, ellipsis included. 120 is calibrated
 * on the real corpus : the longest human-written Bash `description` observed is
 * 97 chars, plus the verb and a short effect clause. Anything lower silently
 * truncated descriptions that were already notification-shaped.
 */
exports.SMART_TEXT_LIMITS = {
	line_cap:   120,
	anchor_cap:  30,   // Edit : quoted anchor of the enclosing scope
	question_min: 24   // Ask : floor for the question once the suffix is reserved
}

/**
 * Files whose modification changes a CAPABILITY rather than content. They get a
 * category prefix instead of the generic Edit/Write verb, because the generic
 * one reads as a routine file change : "Edit · settings.local.json" hides that
 * the agent is widening its own permission allowlist.
 *
 * Ordered — first match wins.
 */
exports.POLICY_PATHS = [
	[/(^|\/)\.claude\/settings[^/]*\.json$/, 'Permissions'],
	[/(^|\/)firewall\//,                     'Firewall'],
	[/(^|\/)\.gitignore$/,                   'Gitignore'],
	[/(^|\/)hooks\.json$/,                   'Hook'],
	[/(^|\/)pending\/[^/]+\.sh$/,            'Host-script']
]

/**
 * git subcommands that mutate the repository, index or refs. Membership is
 * tested with `in`, so the values are irrelevant — only the keys matter.
 * `stash`, `tag` and `worktree` are included : they were missing from the first
 * iteration and hid 7 real worktree/ref mutations.
 */
exports.GIT_WRITE_SUBCOMMANDS = {
	commit: 1, push: 1, checkout: 1, switch: 1, add: 1, reset: 1, revert: 1,
	rebase: 1, merge: 1, apply: 1, am: 1, 'cherry-pick': 1, clean: 1, rm: 1,
	mv: 1, restore: 1, init: 1, clone: 1, fetch: 1, pull: 1, stash: 1, tag: 1,
	worktree: 1, 'update-ref': 1, 'update-index': 1
}

/**
 * Extensions that make a bare basename credible as a filesystem path. Used by
 * smart-text's validity gate to reject JS fragments scraped out of inline
 * scripts. `log` and `bak` are deliberately ABSENT : `console.log` would
 * otherwise pass the gate and be rendered as a written file.
 */
exports.KNOWN_PATH_EXT = /\.(js|mjs|cjs|ts|tsx|vue|json|jsonl|md|sh|py|rb|pl|txt|svg|png|jpe?g|gif|webp|css|html?|ya?ml|toml|ini|conf|lock|zip|tar|gz|ttf|otf|woff2?|wasm|asm|tsv|csv|sql|excalidraw|imf|act|gr2|grf|lub|mkv|mp4|bmp|patch|diff)$/i

/**
 * Per-event-type delay (ms) applied by the watcher before firing the
 * notification. Tuned to absorb the "user cancels seconds later" path :
 * permission events wait 30 s so a follow-up Stop can "latest-wins"-replace
 * the timer (PostToolUse does NOT fire on user-Cancel). Idle is 0 — the
 * hook binary already waited 60 s before emitting the line.
 */
exports.EVENT_DELAYS_MS = {
	stop:                30_000, // 30 s — turn finished, wait for follow-up
	permission_request:  30_000, // 30 s — Cancel path emits Stop ~3-5 s later but PostToolUse
	                             //        does NOT fire on user-Cancel ; the Stop must arrive in
	                             //        time to "latest-wins"-replace this timer. 30 s gives
	                             //        plenty of headroom for slow tools + slow Stops.
	idle_prompt:              0, //   0 s — binary already waited 60 s before firing the hook
	permission_prompt:   30_000, // 30 s — Notification variant of permission_request, same logic
	elicitation_dialog:  30_000  // 30 s — Claude asked a question (dialog with options)
}

// -----------------------------------------------------------------------------
// DEFAULTS — platform-specific defaults + third-party limits.
// -----------------------------------------------------------------------------

/**
 * AUMID used as the toast's source identity on Windows. Hardcoded to
 * the standard VS Code installer's AUMID — gives the toast VS Code's
 * icon + activation. If you run VS Code Insiders or a non-standard
 * install, override this constant (Squirrel installs use a GUID,
 * Insiders is "Microsoft.VisualStudioCodeInsiders", etc.).
 */
exports.WINDOWS_AUMID = 'Microsoft.VisualStudioCode'

/**
 * Detached PowerShell processes that hand a fire-and-forget request to a
 * Windows broker (WinRT toast via ToastNotifier.Show(), system sound via
 * SystemSounds.Asterisk.Play()) must stay alive briefly after the call.
 * Without a trailing Start-Sleep, the detached PS exits in ~50 ms and the
 * OS broker drops the registration before it can render. 600 ms is the
 * empirical value used by both consumers :
 *   - notifier.sendWindows() interpolates this constant into the PS script
 *   - sound.js bakes it into NATIVE_SOUND_DEFAULTS.windows.args (literal,
 *     since the args array is declarative — keep the two values in sync if
 *     this constant ever changes).
 */
exports.WINDOWS_DETACHED_GRACE_MS = 600

/**
 * Event types that warrant a taskbar flash. Stop / tool_started /
 * tool_finished are deliberately excluded.
 */
exports.FLASH_EVENT_TYPES = new Set([
	'permission_request',
	'permission_prompt',
	'idle_prompt',
	'elicitation_dialog'
])

/**
 * Native defaults per host kind (see lib/host.getHostKind() — 'windows'
 * covers both native win32 Node and WSL Linux Node with interop). Built-in
 * OS notification sounds — nothing bundled in the repo. Linux is resolved
 * dynamically (distros ship different sound packages) ; see
 * sound.resolveLinuxDefault().
 * `resolved` is the human-readable descriptor surfaced to the status file —
 * a path on macOS, a system-sound name on Windows (no file is played).
 */
exports.NATIVE_SOUND_DEFAULTS = {
	macos: {
		cmd:      'afplay',
		args:     ['/System/Library/Sounds/Glass.aiff'],
		resolved: '/System/Library/Sounds/Glass.aiff'
	},
	windows: {
		cmd:      'powershell.exe',
		args:     ['-NoProfile', '-Command',
			'[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600'],
		resolved: 'SystemSounds::Asterisk'
	}
}

/**
 * Discord enforces a 2000-char hard limit per message ; render() caps at 1900
 * to leave margin for any template-side prefix growth, and truncates to 1893
 * to reserve 7 chars for a closing "\n```" fence if truncation lands inside
 * a code block. `hard_limit` is informational — the actual cap is body_cap.
 */
exports.DISCORD_TRUNCATION_LIMITS = {
	body_cap:          1900,
	body_truncate_to:  1893,
	hard_limit:        2000
}

// -----------------------------------------------------------------------------
// PATHS — filesystem locations probed at runtime.
// -----------------------------------------------------------------------------

/**
 * Probe these in order on Linux ; first existing file wins. freedesktop
 * sounds ship with most GNOME/KDE installs ; ALSA sample is the universal
 * fallback.
 */
exports.LINUX_SOUND_CANDIDATES = [
	'/usr/share/sounds/freedesktop/stereo/message-new-instant.oga',
	'/usr/share/sounds/freedesktop/stereo/bell.oga',
	'/usr/share/sounds/alsa/Front_Center.wav'
]

// -----------------------------------------------------------------------------
// REGEXES — parsing patterns kept here for centralised review.
// -----------------------------------------------------------------------------

/**
 * Discord webhook URL shape : https://discord.com/api/webhooks/<channel_id>/<token>
 * Capture group 1 = prefix incl. trailing slash (channel ID is public),
 * capture group 2 = bot token (the actual secret). Used by redactWebhook()
 * to mask only the token portion in logs.
 */
exports.DISCORD_WEBHOOK_URL_RE = /^(https:\/\/discord\.com\/api\/webhooks\/\d+\/)(.+)$/
