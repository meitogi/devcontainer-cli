#!/usr/bin/env node
// =============================================================================
// test-winrt-standalone — WinRT toast test with fixed AUMID + sample project
// =============================================================================
//
// Run on WINDOWS only. No daemon involved, no AUMID discovery — uses
// hardcoded values so you can validate the toast look-and-feel without
// any environment dependency.
//
//   node test-winrt-standalone.js
//
// Hardcoded sample values (edit at the top of the file to change) :
//   - AUMID    = "Microsoft.VisualStudioCode"  (standard VS Code install)
//   - project  = "Devcontainer Tools"                    (front part of devcontainer.json
//                                               `name` field, before the dash)
//
// If your VS Code install uses a different AUMID (Insiders / Squirrel /
// MS Store), run `node find-aumid.js` (sibling file) once to discover
// yours, then paste it into the AUMID constant below.
//
// Expected result : a Windows toast appears in Action Center under the
// "Visual Studio Code" icon. Clicking does nothing — classic Win32
// installs of VS Code have no COM activator registered for the AUMID, so
// a bare toast with no `launch` attribute is intentionally inert on click.
// See lib/consumers/notifier.md for the click-back analysis.
// =============================================================================

const { spawnSync } = require('child_process')

// -----------------------------------------------------------------------------
// EDIT-HERE constants
// -----------------------------------------------------------------------------
const AUMID        = 'Microsoft.VisualStudioCode'
const PROJECT_NAME = 'Devcontainer Tools'

// -----------------------------------------------------------------------------
// Sample payload mimicking what the daemon would render for a Stop event
// -----------------------------------------------------------------------------
const title    = `Claude Code · ${PROJECT_NAME}`
const subtitle = `DOING - Build something cool · Stop`
const body     = `synthetic recap line · ${new Date().toTimeString().slice(0, 8)}`

// -----------------------------------------------------------------------------
// XML build + PowerShell push
// -----------------------------------------------------------------------------
const xmlEscape = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const line1 = xmlEscape(`${title} — ${subtitle}`)
const line2 = xmlEscape(body)
const xml = `<toast><visual><binding template="ToastGeneric">` +
            `<text>${line1}</text>` +
            `<text>${line2}</text>` +
            `</binding></visual></toast>`

const ps = `
	[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
	[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]
	$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
	$xml.LoadXml('${xml.replace(/'/g, "''")}')
	$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
	[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show($toast)
	Write-Output 'OK'
`

console.log(`AUMID:    ${AUMID}`)
console.log(`project:  ${PROJECT_NAME}`)
console.log(`title:    ${title}`)
console.log(`subtitle: ${subtitle}`)
console.log(`body:     ${body}`)
console.log()
console.log('→ Firing toast...')

const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 10000 })

if (r.error)        { console.error('✗ spawn:', r.error.message); process.exit(1) }
if (r.status !== 0) { console.error('✗ exit', r.status, '\nstderr:', r.stderr); process.exit(1) }

console.log('✓ Toast fired. Look at Action Center / bottom-right.')
console.log('  Click is a no-op by design (no `launch` attribute on this toast).')
