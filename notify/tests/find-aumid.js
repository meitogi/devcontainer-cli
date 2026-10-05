#!/usr/bin/env node
// =============================================================================
// find-aumid — AUMID discovery for any Start Menu app on Windows
// =============================================================================
//
// Run on WINDOWS only. Lists Start Menu entries whose name matches the
// given filter and prints their AUMIDs.
//
//   node find-aumid.js                 # defaults to "Visual Studio Code"
//   node find-aumid.js "Slack"         # any app
//   node find-aumid.js "Code Insiders"
//   node find-aumid.js ""              # empty = list everything (long output)
//
// Use this when the hardcoded WINDOWS_AUMID in lib/consumers/notifier.js
// doesn't match your install variant :
//   - VS Code Insiders                 → typically `…Insiders`
//   - User installer (Squirrel)        → typically a {GUID} AUMID
//   - Microsoft Store version          → PackageFamilyName!App
// =============================================================================

const { spawnSync } = require('child_process')

const filter = process.argv[2] !== undefined ? process.argv[2] : 'Visual Studio Code'
// PowerShell single-quote escape : '' for literal '
const filterEsc = String(filter).replace(/'/g, "''")

const ps = filter
	? `Get-StartApps | Where-Object { $_.Name -match '${filterEsc}' } | Format-Table Name, AppID -AutoSize`
	: `Get-StartApps | Format-Table Name, AppID -AutoSize`

console.log(`Searching Start Menu for ${filter ? `"${filter}"` : '(all entries)'}...\n`)

const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], {
	encoding: 'utf8',
	timeout:  5000
})

if (r.error) { console.error('✗ PowerShell spawn failed:', r.error.message); process.exit(1) }
if (r.status !== 0) { console.error('✗ exit', r.status, '\nstderr:', r.stderr); process.exit(1) }

const out = (r.stdout || '').trim()
if (!out) {
	console.warn(`⚠ No entry matching "${filter}" found in the Start Menu.`)
	console.warn('  Possible reasons :')
	console.warn('    - The app is installed as a portable / standalone (no Start Menu entry)')
	console.warn('    - Filter is too strict — try a shorter substring')
	console.warn('    - Try `node find-aumid.js ""` to dump every entry')
	process.exit(2)
}

console.log(out)
console.log('Copy the relevant AppID into WINDOWS_AUMID (lib/consumers/notifier.js)')
console.log('or AUMID (test-winrt-standalone.js).')
