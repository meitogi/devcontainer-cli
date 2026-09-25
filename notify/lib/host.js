// =============================================================================
// host — high-level OS kind, collapsing WSL into Windows
// =============================================================================
//
// `process.platform` answers "what kind of Node binary am I" — `linux` from
// inside WSL, even when the host is Windows. The consumers care about a
// different question : "which notification stack should I drive" — and for
// WSL2 (and WSL1 with interop), the right answer is the Windows stack
// (`powershell.exe` is reachable on PATH thanks to the Windows-side interop
// shim).
//
// getHostKind() returns one of :
//   'macos'   → darwin
//   'windows' → win32 OR linux-on-WSL (with powershell.exe reachable in PATH)
//   'linux'   → linux native (no WSL interop)
//   'unknown' → anything else (freebsd, openbsd, sunos, aix, …)
//
// Detection of WSL is layered (cheapest signal first) :
//   1. WSL_INTEROP env var — set on WSL2 only, very reliable
//   2. WSL_DISTRO_NAME env var — set on both WSL1 and WSL2 by /init
//   3. /proc/version contains 'microsoft' or 'wsl' — kernel-level fallback
//
// The result is memoised because none of the underlying signals change
// during the daemon's lifetime (we never re-enter WSL mid-process).
//
// What this module does NOT do :
//   - probe whether powershell.exe actually works — that's a consumer's job
//     at start() time (notifier does a spawnSync probe).
//   - translate WSL Linux paths to Windows paths (wslpath) — out of scope ;
//     consumers that need it should call `wslpath -w <path>` themselves.
//   - distinguish WSL1 from WSL2 — both expose interop the same way, the
//     consumers don't care.
// =============================================================================

const fs = require('fs')

let cached = null

/**
 * Resolve the host's notification stack kind. Memoised on first call.
 *
 * @returns {'macos'|'windows'|'linux'|'unknown'}
 *          'windows' is returned for both native win32 Node AND for Linux
 *          Node running under WSL (where powershell.exe is reachable via
 *          interop). Caller decides whether to probe powershell.exe.
 */
function getHostKind() {
	if (cached) return cached
	cached = detect()
	return cached
}

function detect() {
	const platform = process.platform
	if (platform === 'darwin') return 'macos'
	if (platform === 'win32')  return 'windows'
	if (platform !== 'linux')  return 'unknown'

	if (process.env.WSL_INTEROP)     return 'windows'
	if (process.env.WSL_DISTRO_NAME) return 'windows'
	try {
		const ver = fs.readFileSync('/proc/version', 'utf8').toLowerCase()
		if (ver.includes('microsoft') || ver.includes('wsl')) return 'windows'
	} catch (_) {}
	return 'linux'
}

/**
 * Diagnostic helper — returns the raw signals used by detect(). Used by the
 * boot log line and by tests/host-detect.js so we can see WHY a host got
 * classified the way it did.
 *
 * @returns {{ platform: string, kind: string, wslInterop: boolean,
 *             wslDistro: string|null, procVersion: string|null }}
 */
function getHostSignals() {
	let procVersion = null
	try {
		procVersion = fs.readFileSync('/proc/version', 'utf8').trim()
	} catch (_) {}
	return {
		platform:    process.platform,
		kind:        getHostKind(),
		wslInterop:  Boolean(process.env.WSL_INTEROP),
		wslDistro:   process.env.WSL_DISTRO_NAME || null,
		procVersion
	}
}

module.exports = { getHostKind, getHostSignals }
