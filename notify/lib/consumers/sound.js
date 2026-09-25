// =============================================================================
// sound — cross-platform notification sound
// =============================================================================
//
// Subscribes to 'send:notification' and plays a short sound on the host
// audio device. Modes via NOTIFY_SOUND :
//
//   unset / NOTIFY_SOUND=default → OS-native notification bell (default)
//                                  macOS  : afplay /System/Library/Sounds/Glass.aiff
//                                  Linux  : paplay/aplay/ffplay on a freedesktop/alsa sound
//                                  Windows: PowerShell SystemSounds::Asterisk
//   NOTIFY_SOUND=<abs path>      → custom file (WAV recommended for cross-OS,
//                                  AIFF/MP3/M4A also fine on macOS, OGG on Linux)
//   NOTIFY_SOUND=off             → sound channel explicitly disabled
//
// The master kill-switch is now NOTIFY_CHANNELS (drop `sound` from the CSV to
// disable without setting `=off`). Sound is on by default when NOTIFY_CHANNELS
// is unset or `all`.
//
// No NPM dep, no asset bundled : the default uses each OS's built-in sound.
// Spawn is detached + unref'd, errors are logged but never thrown — the
// daemon never blocks on audio playback.
// =============================================================================

const fs = require('fs')
const { spawn, spawnSync } = require('child_process')
const log = require('../log')
const { NATIVE_SOUND_DEFAULTS, LINUX_SOUND_CANDIDATES } = require('../constants')
const { getHostKind } = require('../host')

let playSpec = null  // { cmd, args } resolved once at start()

// -----------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// -----------------------------------------------------------------------------

/**
 * Wire the sound consumer onto the bus. Resolves the play spec ONCE at
 * boot (caller override → NOTIFY_SOUND env → 'default') so the per-event
 * dispatch is a pure `spawn` with no extra resolution overhead.
 *
 * Three terminal states, each producing a distinct `{ status, diag }` :
 *   - `=off`                       → skipped (user-disabled)
 *   - resolveSpec returns reason   → fail (reason carries the kebab-case tag)
 *   - resolveSpec returns spec     → ok, dispatch subscribed
 *
 * @param {object} opts
 * @param {import('events').EventEmitter} opts.bus   listens for 'send:notification'
 * @param {string} [opts.sound]                      override ; defaults to NOTIFY_SOUND env, then 'default'
 * @returns {{ status: 'ok'|'skipped'|'fail', diag: object }}
 *          diag.mode is 'default' or 'custom' ; diag.resolved set on ok ; diag.reason set on skipped/fail
 */
function start({ bus, sound: soundOverride }) {
	const sound = soundOverride || process.env.NOTIFY_SOUND || 'default'
	if (sound === 'off') {
		log.info('[sound] NOTIFY_SOUND=off — sound channel disabled')
		return { status: 'skipped', diag: { reason: 'user-disabled' } }
	}
	const mode = sound === 'default' ? 'default' : 'custom'
	const res = resolveSpec(sound)
	if (res.reason) {
		log.warn(`[sound] cannot enable — reason=${res.reason}`)
		return { status: 'fail', diag: { reason: res.reason } }
	}
	playSpec = res.spec
	bus.on('send:notification', play)
	const label = mode === 'default' ? 'native default' : `custom (${sound})`
	log.info(`[sound] enabled — ${label} via ${playSpec.cmd}`)
	return { status: 'ok', diag: { mode, resolved: playSpec.resolved } }
}

// -----------------------------------------------------------------------------
// SPEC RESOLUTION
// -----------------------------------------------------------------------------

// All resolver helpers return one of :
//   { spec: { cmd, args, resolved } }  — playable
//   { reason: '<kebab-case-tag>' }     — failure with a specific, readable tag
// The tag lands in the status file's `reason=` so the user sees WHY the sound
// channel failed (file-not-found / no-linux-sound-found / no-linux-player /
// unsupported-platform), not a generic "resolve-failed".

/**
 * Top-level spec resolver. Dispatches to resolveDefault or resolveCustom
 * based on the literal string `'default'` (the sentinel for the OS-native
 * bell) vs anything else (treated as an absolute file path).
 *
 * @param {string} sound   'default' or absolute path to a sound file
 * @returns {{ spec?: object, reason?: string }}   see file header for the shape
 */
function resolveSpec(sound) {
	if (sound === 'default') return resolveDefault()
	return resolveCustom(sound)
}

/**
 * Resolve the default OS-native bell. Linux-native is special-cased because
 * there is no single bundled asset path that works everywhere — falls
 * through to resolveLinuxDefault which probes a list of standard
 * freedesktop / alsa candidates. macOS and Windows (including WSL via
 * powershell.exe interop) pull their spec from NATIVE_SOUND_DEFAULTS.
 *
 * @returns {{ spec?: object, reason?: string }}   `unsupported-platform` outside macos/windows/linux
 */
function resolveDefault() {
	const host = getHostKind()
	if (host === 'linux') return resolveLinuxDefault()
	const spec = NATIVE_SOUND_DEFAULTS[host]
	if (!spec) {
		log.warn(`[sound] no native default for host ${host} — disabled`)
		return { reason: 'unsupported-platform' }
	}
	return { spec }
}

/**
 * Linux default-bell resolver. Picks the first existing path from
 * LINUX_SOUND_CANDIDATES (PulseAudio bell, ALSA fallback, freedesktop dings)
 * then hands it to linuxPlayerFor to find a working playback command.
 *
 * @returns {{ spec?: object, reason?: string }}   `no-linux-sound-found` if none of the candidates exist
 */
function resolveLinuxDefault() {
	const file = LINUX_SOUND_CANDIDATES.find((p) => fs.existsSync(p))
	if (!file) {
		log.warn('[sound] no freedesktop/alsa sound asset found on linux — disabled')
		return { reason: 'no-linux-sound-found' }
	}
	return linuxPlayerFor(file)
}

/**
 * Resolve a user-provided custom file path into a playable spec. macOS uses
 * `afplay`, Windows uses an inline PowerShell `Media.SoundPlayer.PlaySync()`,
 * Linux defers to linuxPlayerFor() for the player probe. Missing files and
 * unsupported platforms surface as a tagged `reason`.
 *
 * WSL caveat : when on WSL routed to the windows branch, `absPath` is a
 * Linux path (e.g. `/mnt/c/Users/.../bell.wav` or `/home/me/bell.wav`).
 * Media.SoundPlayer needs a Windows path. The /mnt/<drive>/ form is
 * resolved by Windows transparently, but a path under the WSL VHDX won't
 * play. Translate with `wslpath -w <path>` upstream if you need WAVs from
 * the WSL filesystem.
 *
 * @param {string} absPath   absolute path to the user's sound file
 * @returns {{ spec?: object, reason?: string }}
 *          `file-not-found` if the path doesn't exist, `unsupported-platform` on other OSes
 */
function resolveCustom(absPath) {
	if (!fs.existsSync(absPath)) {
		log.warn(`[sound] file not found: ${absPath} — disabled`)
		return { reason: 'file-not-found' }
	}
	switch (getHostKind()) {
		case 'macos':
			return { spec: { cmd: 'afplay', args: [absPath], resolved: absPath } }
		case 'windows':
			return { spec: {
				cmd:      'powershell.exe',
				args:     ['-NoProfile', '-Command',
					`(New-Object Media.SoundPlayer "${absPath}").PlaySync()`],
				resolved: absPath
			} }
		case 'linux':
			return linuxPlayerFor(absPath)
		default:
			log.warn(`[sound] unsupported host: ${getHostKind()}`)
			return { reason: 'unsupported-platform' }
	}
}

/**
 * Pick the first available Linux player binary and return a spec ready to
 * spawn. Probe order : paplay (PulseAudio — GNOME / KDE default) → aplay
 * (ALSA fallback) → ffplay (universal). `which` runs at start() time only,
 * never per event, so the per-notif cost stays at a single spawn.
 *
 * @param {string} file   absolute path to the sound file to play
 * @returns {{ spec?: object, reason?: string }}   `no-linux-player` when none of the three are on PATH
 */
function linuxPlayerFor(file) {
	const which = (cmd) => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0
	if (which('paplay')) return { spec: { cmd: 'paplay', args: [file], resolved: file } }
	if (which('aplay'))  return { spec: { cmd: 'aplay',  args: ['-q', file], resolved: file } }
	if (which('ffplay')) return { spec: { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', file], resolved: file } }
	log.warn('[sound] no linux player found (paplay/aplay/ffplay) — disabled')
	return { reason: 'no-linux-player' }
}

// -----------------------------------------------------------------------------
// DISPATCH
// -----------------------------------------------------------------------------

/**
 * Per-event dispatch attached to 'send:notification'. Spawns the pre-resolved
 * `playSpec` so audio playback never blocks the daemon event loop, and any
 * spawn error surfaces as a warn-level log instead of crashing the process.
 * Ignores the event payload — sound is contextless.
 *
 * Windows uses `windowsHide` instead of `detached` : `detached: true` launches
 * powershell.exe with DETACHED_PROCESS, severing it from the user session AND
 * its audio mixer — the child runs but the sound is never heard. `unref()`
 * alone keeps the event loop free. Unix keeps `detached: true` so the player
 * survives a daemon crash (afplay / paplay orphan-safe).
 *
 * @returns {void}   fire-and-forget spawn
 */
function play() {
	try {
		const opts = getHostKind() === 'windows'
			? { stdio: 'ignore', windowsHide: true }
			: { stdio: 'ignore', detached: true }
		const child = spawn(playSpec.cmd, playSpec.args, opts)
		child.unref()
		child.on('error', (err) => log.warn(`[sound] ${playSpec.cmd} failed: ${err.message}`))
	} catch (e) {
		log.warn(`[sound] spawn threw: ${e.message}`)
	}
}

module.exports = { start }
