#!/usr/bin/env node
// =============================================================================
// run-tests.js -- cross-platform notify daemon test runner
// =============================================================================
//
// Walks every step in TEST-GUIDE.md, gates visual tests on user input,
// collects PASS/FAIL into a tabular final verdict. Runs identically on :
//
//   - Windows-native :   node .\.devcontainer\notify\tests\windows-bundle\run-tests.js
//                        (or :  .\run-tests.cmd  from the bundle root)
//   - WSL Debian (1/2) : node ./.devcontainer/notify/tests/windows-bundle/run-tests.js
//
// USAGE :
//   node run-tests.js                            # full run
//   node run-tests.js --skip L1,L4               # skip layer(s)
//   NOTIFY_PROJECT_NAME=mywin node run-tests.js  # override flash window-title
// =============================================================================

const { spawn, spawnSync } = require('child_process')
const readline = require('readline')
const path = require('path')
const fs = require('fs')

// -----------------------------------------------------------------------------
// CONFIG / CONTEXT
// -----------------------------------------------------------------------------

const ProjectName = process.env.NOTIFY_PROJECT_NAME || 'Visual Studio Code'

// Resolve paths relative to the bundle root (works from both extract layouts).
// Look upward from the script for the first dir containing .devcontainer/.
function findBundleRoot() {
	let dir = __dirname
	for (let i = 0; i < 6; i++) {
		if (fs.existsSync(path.join(dir, '.devcontainer', 'notify', 'index.js'))) return dir
		dir = path.dirname(dir)
	}
	return process.cwd()
}
const ROOT = findBundleRoot()
const LogFile = path.join(ROOT, '.devcontainer/tmp/notify/daemon.log')
const PidFile = path.join(ROOT, '.devcontainer/tmp/notify/.daemon.pid')
const TestsDir = path.join(ROOT, '.devcontainer/notify/tests')
const DaemonScript = path.join(ROOT, '.devcontainer/notify/index.js')

const SkipLayers = (() => {
	const i = process.argv.indexOf('--skip')
	if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1].split(',')
	return []
})()

const isWSL = process.platform === 'linux' && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)

// -----------------------------------------------------------------------------
// PROMPT + STEP HARNESS
// -----------------------------------------------------------------------------

const Results = []
let DaemonPid = null
let lastExitCode = 0
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const prompt = (q) => new Promise((resolve) => rl.question(q, resolve))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function step(num, layer, title, action, expected, opts = {}) {
	if (SkipLayers.includes(layer)) {
		Results.push({ step: num, layer, title, verdict: 'SKIP', notes: '(layer skipped)' })
		return
	}
	console.log('')
	console.log(`===== Step ${num} [${layer}] -- ${title} =====`)
	console.log(`Expected: ${expected}`)

	let verdict = null
	let notes = ''
	do {
		try { await action() } catch (e) { console.log(`  X Exception: ${e.message}`) }

		if (opts.noPrompt) {
			verdict = opts.exitCodeBased ? (lastExitCode === 0 ? 'PASS' : 'FAIL') : 'PASS'
			break
		}

		const ans = (await prompt('Verdict? [y]es / [r]etrigger / [s]kip / anything else = FAIL (your text -> notes): ')).trim()
		if (/^y(es)?$/i.test(ans))                       verdict = 'PASS'
		else if (/^s(kip)?$/i.test(ans))                 verdict = 'SKIP'
		else if (/^r(etry|etrigger)?$/i.test(ans))     { verdict = null; console.log('  (retriggering...)') }
		else                                           { verdict = 'FAIL'; notes = ans }
	} while (verdict === null)

	Results.push({ step: num, layer, title, verdict, notes })
}

// -----------------------------------------------------------------------------
// DAEMON CONTROL (cross-platform)
// -----------------------------------------------------------------------------

function stopDaemon() {
	// Tracked PID from this runner
	if (DaemonPid) {
		try { process.kill(DaemonPid, 'SIGTERM') } catch (_) {}
		DaemonPid = null
	}
	// Orphan from a previous extract / run — read the pidfile, not pkill all node
	try {
		if (fs.existsSync(PidFile)) {
			const orphanPid = parseInt(fs.readFileSync(PidFile, 'utf8').trim(), 10)
			if (orphanPid && orphanPid !== process.pid) {
				try { process.kill(orphanPid, 'SIGTERM') } catch (_) {}
			}
		}
	} catch (_) {}
	// Linux/WSL fallback : pkill by command line (won't match the runner itself)
	if (process.platform !== 'win32') {
		try { spawnSync('pkill', ['-f', 'notify/index.js']) } catch (_) {}
	}
}

function startDaemon() {
	stopDaemon()
	const env = {
		...process.env,
		NOTIFY_DOCKER_POLL_MS: '0',          // no docker parent in the bundle
		NOTIFY_NOTIFIER_VERBOSE: '1'          // pipe PS stderr into daemon.log
	}
	const child = spawn('node', [DaemonScript], {
		cwd: ROOT,
		env,
		stdio: 'ignore',
		detached: process.platform !== 'win32',  // mirror the production spawn pattern
		windowsHide: true
	})
	child.unref()
	DaemonPid = child.pid
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function runNode(scriptPath, ...args) {
	const r = spawnSync('node', [scriptPath, ...args], { cwd: ROOT, stdio: 'inherit' })
	lastExitCode = r.status == null ? 1 : r.status
	return lastExitCode
}

function tailLog(lines = 5) {
	try {
		const all = fs.readFileSync(LogFile, 'utf8').split('\n').filter((l) => l.trim())
		console.log(all.slice(-lines).join('\n'))
	} catch (e) {
		console.log(`(no log: ${e.message})`)
	}
}

function psBeep() {
	spawnSync('powershell.exe', [
		'-NoProfile', '-Command',
		'[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 800'
	], { stdio: 'inherit', timeout: 5000 })
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

async function main() {
	console.log('=============================================')
	console.log('notify daemon -- test runner (23 steps)')
	console.log(`platform: ${process.platform}${isWSL ? ' (WSL)' : ''} | arch: ${process.arch}`)
	console.log(`project name (flash target): "${ProjectName}"`)
	console.log(`bundle root: ${ROOT}`)
	if (SkipLayers.length) console.log(`skipping layers: ${SkipLayers.join(', ')}`)
	console.log('=============================================')

	// ---------- L1 Detection ----------
	await step(1, 'L1', 'host-detect',
		() => runNode(path.join(TestsDir, 'host-detect.js')),
		'platform/kind detected, powershell.exe reachable',
		{ noPrompt: true, exitCodeBased: true })

	await step(2, 'L1', 'find-aumid VS Code',
		() => runNode(path.join(TestsDir, 'find-aumid.js'), 'Visual Studio Code'),
		'at least one line containing Microsoft.VisualStudioCode (or a GUID)',
		{ noPrompt: true, exitCodeBased: true })

	// ---------- L2 Visual consumers, no daemon ----------
	await step(3, 'L2', 'winrt-standalone (toast)',
		() => runNode(path.join(TestsDir, 'winrt-standalone.js')),
		'toast appears bottom-right with VS Code icon')

	await step(4, 'L2', 'click toast -> VS Code foreground',
		async () => {
			console.log('  (firing a fresh toast -- click it within ~30s to test activation)')
			runNode(path.join(TestsDir, 'winrt-standalone.js'))
		},
		'click the fresh toast -> VS Code becomes foreground within ~1s')

	await step(5, 'L2', 'flash-standalone (taskbar flash)',
		async () => {
			const c = spawn('node', [path.join(TestsDir, 'flash-standalone.js'), 'flash', ProjectName],
				{ cwd: ROOT, stdio: 'inherit', detached: process.platform !== 'win32' })
			c.unref()
			await sleep(2000)
		},
		`VS Code taskbar entry whose title matches "${ProjectName}" flashes orange continuously`)

	await step(6, 'L2', 'click VS Code -> flash stops',
		async () => console.log('  (click the flashing VS Code taskbar button now)'),
		'flash stops within ~50ms once VS Code becomes foreground')

	await step(7, 'L2', 'PowerShell beep',
		() => psBeep(),
		'Windows Asterisk system sound is audible')

	// ---------- L3 Events end-to-end ----------
	await step(8, 'L3', 'launch daemon',
		async () => {
			startDaemon()
			await sleep(2500)
			tailLog(5)
		},
		'daemon.log shows [notifier] start + [watcher] start, no errors')

	const replays = [
		[9,  'stop',               '1', 32, 'replay stop/1 (Tests passing)',                "toast 'Tests passing, PR ready for review' after ~30s"],
		[10, 'stop',               '2', 32, 'replay stop/2 (Build failed)',                 "toast 'Build failed -- see logs ...'"],
		[11, 'permission_request', '1', 32, 'replay permission_request/1 (Bash)',           `toast 'Permission asked - Bash' + flash on ${ProjectName}`],
		[12, 'idle_prompt',        '1',  2, 'replay idle_prompt/1 (instant)',               "IMMEDIATE toast 'Idle' + flash"],
		[13, 'elicitation_dialog', '1', 32, 'replay elicitation_dialog/1 (AskUserQuestion)', "toast 'Question' + flash"],
		[14, 'elicitation_dialog', '2', 32, 'replay elicitation_dialog/2 (ExitPlanMode)',   "toast 'Question' + flash"],
		[15, 'permission_prompt',  '1', 32, 'replay permission_prompt/1',                   "toast 'Permission prompt' + flash"],
		[16, 'notification',       '1',  2, 'replay notification/1 (unmapped)',             "NO toast, log shows 'unmapped eventType notification, skipped'"]
	]
	for (const [num, type, fnum, wait, title, expected] of replays) {
		await step(num, 'L3', title,
			async () => {
				runNode(path.join(TestsDir, 'replay-fixture.js'), type, fnum)
				await sleep(wait * 1000)
				tailLog(4)
			},
			expected)
	}

	await step(17, 'L3', 'simulate stop cancel',
		async () => {
			runNode(path.join(TestsDir, 'notifs.js'), 'stop', 'cancel')
			await sleep(33000)
			tailLog(4)
		},
		'NO toast (user_replied cancels stop timer)')

	await step(18, 'L3', 'simulate perm cancel',
		async () => {
			runNode(path.join(TestsDir, 'notifs.js'), 'perm', 'cancel')
			await sleep(33000)
			tailLog(4)
		},
		'NO toast (tool_started cancels permission_request timer)')

	await step(19, 'L3', 'replay notification/2 (unknown subtype)',
		async () => {
			runNode(path.join(TestsDir, 'replay-fixture.js'), 'notification', '2')
			await sleep(2000)
			tailLog(2)
		},
		'NO toast, log shows "unmapped eventType unknown_subtype, skipped"')

	await step(20, 'L3', 'simulate all (parade)',
		async () => {
			runNode(path.join(TestsDir, 'notifs.js'), 'all')
			await sleep(40000)
		},
		'parade of toasts over ~35s (idle_prompt first, stop last)')

	// ---------- L4 Env vars ----------
	await step(21, 'L4', 'NOTIFY_CHANNELS=notifier (toast only)',
		async () => {
			stopDaemon()
			process.env.NOTIFY_CHANNELS = 'notifier'
			startDaemon()
			await sleep(1500)
			runNode(path.join(TestsDir, 'replay-fixture.js'), 'idle_prompt', '1')
			await sleep(2000)
		},
		'toast ONLY -- NO flash, NO beep')

	await step(22, 'L4', 'NOTIFY_SOUND=off (silent toast + flash)',
		async () => {
			stopDaemon()
			delete process.env.NOTIFY_CHANNELS
			process.env.NOTIFY_SOUND = 'off'
			startDaemon()
			await sleep(1500)
			runNode(path.join(TestsDir, 'replay-fixture.js'), 'permission_request', '1')
			await sleep(32000)
		},
		'toast + flash -- NO beep')

	await step(23, 'L4', 'NOTIFY_CHANNELS=flash-win (flash only)',
		async () => {
			stopDaemon()
			delete process.env.NOTIFY_SOUND
			process.env.NOTIFY_CHANNELS = 'flash-win'
			startDaemon()
			await sleep(1500)
			runNode(path.join(TestsDir, 'replay-fixture.js'), 'permission_request', '1')
			await sleep(32000)
		},
		`flash ONLY on ${ProjectName} -- NO toast, NO beep`)

	// ---------- Cleanup ----------
	console.log('\nCleaning up...')
	stopDaemon()
	delete process.env.NOTIFY_CHANNELS
	delete process.env.NOTIFY_SOUND

	// ---------- Verdict ----------
	console.log('\n=============================================')
	console.log('FINAL VERDICT')
	console.log('=============================================')

	const pad = (s, w) => String(s).padEnd(w)
	console.log(pad('Step', 5) + pad('Layer', 6) + pad('Title', 50) + 'Verdict')
	console.log('-'.repeat(70))
	for (const r of Results) {
		console.log(pad(r.step, 5) + pad(r.layer, 6) + pad(r.title.slice(0, 49), 50) + r.verdict)
	}

	const pass = Results.filter((r) => r.verdict === 'PASS').length
	const fail = Results.filter((r) => r.verdict === 'FAIL').length
	const skip = Results.filter((r) => r.verdict === 'SKIP').length
	console.log('')
	console.log(`PASS: ${pass} / ${Results.length}`)
	console.log(`FAIL: ${fail} / ${Results.length}`)
	console.log(`SKIP: ${skip} / ${Results.length}`)

	const failed = Results.filter((r) => r.verdict === 'FAIL' && r.notes)
	if (failed.length) {
		console.log('\nFAIL details:')
		for (const r of failed) {
			console.log(`  Step ${String(r.step).padStart(2)} [${r.layer}] ${r.title}`)
			console.log(`           -> ${r.notes}`)
		}
	}

	rl.close()
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
