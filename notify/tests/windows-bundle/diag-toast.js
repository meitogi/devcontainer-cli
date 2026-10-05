#!/usr/bin/env node
// =============================================================================
// diag-toast.js -- isolate why daemon toasts AND flash don't appear on Windows
// =============================================================================
//
// Runs 4 WinRT toast variants + 1 flash-win variant in sequence, isolating
// each layer that could break (XML content, spawn mode, daemon code path).
// Watch the bottom-right for toasts numbered 1..4 and the taskbar for a
// flash in test 5. Report which ones actually appeared.
//
// SAVE AS  : C:\notify-test\diag-toast.js
//            (or already inside the bundle if you re-extracted recently)
// RUN AS   : node diag-toast.js                  (from C:\notify-test\)
//            node .devcontainer\notify\tests\windows-bundle\diag-toast.js
//
// OPTIONAL : pass your VS Code window-title substring as argv[2] :
//            node diag-toast.js "notify-test"
//            (default = "Visual Studio Code")
//
// REPORT BACK :
//   - Which numbered toasts visually appeared (e.g. "1 and 2 appeared, 3 and 4 did not")
//   - The full console output (copy from PowerShell)
// =============================================================================

const { spawn, spawnSync } = require('child_process')
const { EventEmitter } = require('events')
const path = require('path')

const AUMID = 'Microsoft.VisualStudioCode'

function buildPs(xml, sleepMs) {
	const sleepLine = sleepMs > 0 ? `Start-Sleep -Milliseconds ${sleepMs}` : ''
	return `
		[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
		[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]
		$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
		$xml.LoadXml('${xml.replace(/'/g, "''")}')
		$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
		[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show($toast)
		${sleepLine}
		Write-Output 'OK'
	`
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function syncTest(num, label, xml) {
	console.log(`\n=== TEST ${num}: ${label} (spawnSync, blocks until PS exits) ===`)
	const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', buildPs(xml, 0)],
		{ encoding: 'utf8', timeout: 10000 })
	console.log(`exit: ${r.status}`)
	if (r.stdout && r.stdout.trim()) console.log('stdout:', r.stdout.trim())
	if (r.stderr && r.stderr.trim()) console.log('stderr:', r.stderr.trim())
	console.log(`>> Watch for toast "diag ${num}" (4s) ...`)
	await sleep(4000)
}

async function detachedTest(num, label, xml, sleepMs) {
	console.log(`\n=== TEST ${num}: ${label} (spawnDetached, stderr piped) ===`)
	try {
		const c = spawn('powershell.exe', ['-NoProfile', '-Command', buildPs(xml, sleepMs)],
			{ stdio: ['ignore', 'ignore', 'pipe'], detached: true })
		c.unref()
		let stderr = ''
		c.stderr.on('data', (d) => { stderr += d.toString() })
		c.on('exit', (code) => {
			console.log(`(detached PS exited code=${code})`)
			if (stderr.trim()) console.log('stderr:', stderr.trim())
		})
	} catch (e) {
		console.log('SPAWN THREW:', e.message)
	}
	console.log(`>> Watch for toast "diag ${num}" (4s) ...`)
	await sleep(4000)
}

async function productionTest(num) {
	console.log(`\n=== TEST ${num}: Production notifier.sendWindows() via real bus ===`)
	process.env.NOTIFY_NOTIFIER_VERBOSE = '1'
	let notifier
	try {
		// Resolves both from C:\notify-test\ and from windows-bundle/.
		const root = require('fs').existsSync('.devcontainer/notify/lib/consumers/notifier.js')
			? '.'
			: '../../..'
		notifier = require(path.resolve(root, '.devcontainer/notify/lib/consumers/notifier'))
	} catch (e) {
		console.log('REQUIRE FAILED:', e.message)
		return
	}
	const bus = new EventEmitter()
	notifier.start({ bus, projectName: 'diag' })
	await sleep(1500) // Windows AUMID probe / module init grace
	// Daemon shape: bus payload has eventType/sid/ts at top, original JSONL
	// fields wrapped inside .line.  See watcher.js header "BUS PAYLOAD shape".
	bus.emit('send:notification', {
		eventType: 'stop',
		sid: 'diag-test-prod-' + Date.now().toString(36),
		ts: new Date().toISOString(),
		line: {
			ts: new Date().toISOString(),
			sid: 'diag-test-prod',
			event: 'stop',
			session_name: 'diag',
			last_message_excerpt: 'Diag test ' + num + ' - production code path'
		}
	})
	console.log('(emitted on bus -> notifier.send -> sendWindows -> spawnDetached)')
	console.log(`>> Watch for daemon-style toast (4s) ...`)
	await sleep(4000)
}

async function tripleEmitTest(num, projectName) {
	console.log(`\n=== TEST ${num}: ALL 3 consumers on ONE bus.emit (mirrors daemon) ===`)
	console.log('    This is the exact concurrency pattern the daemon uses :')
	console.log('    bus.emit(send:notification) -> notifier + sound + flash-win fire in parallel.')
	process.env.NOTIFY_NOTIFIER_VERBOSE = '1'
	const root = require('fs').existsSync('.devcontainer/notify/lib/consumers/notifier.js')
		? '.'
		: '../../..'
	let notifier, sound, flashWin
	try {
		notifier  = require(path.resolve(root, '.devcontainer/notify/lib/consumers/notifier'))
		sound     = require(path.resolve(root, '.devcontainer/notify/lib/consumers/sound'))
		flashWin  = require(path.resolve(root, '.devcontainer/notify/lib/consumers/flash-win'))
	} catch (e) {
		console.log('REQUIRE FAILED:', e.message)
		return
	}
	const bus = new EventEmitter()
	notifier.start({ bus, projectName: 'diag' })
	sound.start({ bus, sound: 'default' })
	flashWin.start({ bus, projectName })
	await sleep(1500)

	// permission_request fires ALL THREE channels (notifier+sound+flash-win)
	const payload = {
		eventType: 'permission_request',
		sid: 'diag-triple-' + Date.now().toString(36),
		ts: new Date().toISOString(),
		line: {
			ts: new Date().toISOString(),
			sid: 'diag-triple',
			event: 'permission_request',
			session_name: 'diag',
			tool_name: 'DiagTriple',
			tool_input: { command: 'diag concurrent emit test' }
		}
	}
	console.log('(emitting send:notification for permission_request -- 3 PS spawn concurrently)')
	bus.emit('send:notification', payload)

	console.log('>> Watch for : toast + flash + sound, ALL at once (7s) ...')
	await sleep(7000)
}

async function flashTest(num, projectName) {
	console.log(`\n=== TEST ${num}: Production flash-win via real bus (project="${projectName}") ===`)
	process.env.NOTIFY_NOTIFIER_VERBOSE = '1'
	let flashWin
	try {
		const root = require('fs').existsSync('.devcontainer/notify/lib/consumers/flash-win.js')
			? '.'
			: '../../..'
		flashWin = require(path.resolve(root, '.devcontainer/notify/lib/consumers/flash-win'))
	} catch (e) {
		console.log('REQUIRE FAILED:', e.message)
		return
	}
	const bus = new EventEmitter()
	flashWin.start({ bus, projectName })
	await sleep(500)
	// permission_request is in FLASH_EVENT_TYPES, so flash should fire
	bus.emit('send:notification', {
		eventType: 'permission_request',
		sid: 'diag-flash-' + Date.now().toString(36),
		ts: new Date().toISOString(),
		line: {
			ts: new Date().toISOString(),
			sid: 'diag-flash',
			event: 'permission_request',
			session_name: 'diag',
			tool_name: 'DiagTest'
		}
	})
	console.log('(emitted permission_request on bus -> flash-win)')
	console.log(`>> Watch the taskbar entry whose title contains "${projectName}" -- it should flash orange (6s) ...`)
	console.log('   (Alt+Tab to that window to stop it once you see it)')
	await sleep(6000)
}

async function main() {
	const projectName = process.argv[2] || 'Visual Studio Code'

	console.log('=============================================')
	console.log('diag-toast: 4 toast variants + 1 flash-win')
	console.log('=============================================')
	console.log(`Project name (flash target) : "${projectName}"`)
	console.log('Watch bottom-right for toasts numbered 1 to 4,')
	console.log('and the taskbar for a flash in test 5.\n')

	// T1: simplest possible toast, sync -- confirms WinRT works at all
	await syncTest(1, 'ASCII-only XML',
		'<toast><visual><binding template="ToastGeneric"><text>diag 1</text><text>ASCII via spawnSync</text></binding></visual></toast>')

	// T2: em-dash + middle-dot, sync -- does Unicode in XML break things?
	await syncTest(2, 'em-dash + middle-dot in XML',
		'<toast><visual><binding template="ToastGeneric"><text>diag 2 — em-dash</text><text>middle-dot · in body</text></binding></visual></toast>')

	// T3: ASCII XML, detached + sleep -- does the daemon's detached mode work?
	await detachedTest(3, 'ASCII XML, detached + Start-Sleep 600',
		'<toast><visual><binding template="ToastGeneric"><text>diag 3</text><text>spawnDetached + 600ms grace</text></binding></visual></toast>',
		600)

	// T4: production code path -- the real daemon notifier
	await productionTest(4)

	// T5: production flash-win
	await flashTest(5, projectName)

	// T6: ALL 3 consumers at once (mirrors daemon's bus.emit pattern)
	await tripleEmitTest(6, projectName)

	console.log('\n=============================================')
	console.log('DONE')
	console.log('=============================================')
	console.log('Report :')
	console.log('  1. Which numbered toasts appeared (1 / 2 / 3 / 4 / 6 ?)')
	console.log('  2. Did test 5 flash your taskbar ? Did test 6 ?')
	console.log('  3. Paste the full console output above')
	process.exit(0)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
