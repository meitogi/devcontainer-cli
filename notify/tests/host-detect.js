#!/usr/bin/env node
// =============================================================================
// host-detect — sanity-check lib/host.js's WSL detection
// =============================================================================
//
// Standalone : `node tests/host-detect.js` from the notify/ dir on any host.
// Prints the raw signals lib/host.js looks at + the resolved kind, plus a
// live powershell.exe probe so you can confirm WSL interop actually works
// on this machine.
//
// Expected outputs :
//   - macOS native        → kind=macos
//   - Windows native      → kind=windows, platform=win32
//   - Linux native        → kind=linux
//   - WSL2                → kind=windows, platform=linux, wslInterop=true,
//                           wslDistro=<your distro>, powershell=ok
//   - WSL1 with interop   → kind=windows, platform=linux, wslDistro set
//                           (no WSL_INTEROP), powershell=ok
//   - WSL1 no interop     → kind=windows (procVersion-based),
//                           powershell=unreachable → notifier would
//                           `skipped reason=wsl-no-powershell`
// =============================================================================

const { spawnSync } = require('child_process')
const { getHostKind, getHostSignals } = require('../lib/host')

const sig = getHostSignals()
console.log('host signals :')
console.log(`  platform     = ${sig.platform}`)
console.log(`  kind         = ${sig.kind}`)
console.log(`  wslInterop   = ${sig.wslInterop}`)
console.log(`  wslDistro    = ${sig.wslDistro || '(unset)'}`)
console.log(`  procVersion  = ${sig.procVersion ? sig.procVersion.slice(0, 100) : '(unreadable)'}`)
console.log('')

if (getHostKind() === 'windows') {
	process.stdout.write('powershell.exe probe ... ')
	const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '"OK"'], {
		encoding: 'utf8',
		timeout:  5000
	})
	if (r.error) {
		console.log(`unreachable (${r.error.code || r.error.message})`)
		process.exit(1)
	}
	if (r.status !== 0) {
		console.log(`exit ${r.status} stderr="${(r.stderr || '').trim()}"`)
		process.exit(1)
	}
	console.log(`ok (stdout="${(r.stdout || '').trim()}")`)
} else {
	console.log('powershell.exe probe skipped — host is not windows-kind')
}
