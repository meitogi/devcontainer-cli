// =============================================================================
// flash-win — Windows taskbar flash on attention-requiring events
// =============================================================================
//
// Subscribes to 'send:notification' for events where the user is being
// asked for input (permission_request, permission_prompt, idle_prompt,
// elicitation_dialog) and flashes VS Code's taskbar entry via Win32's
// FlashWindowEx (User32.dll) through PowerShell P/Invoke.
//
// HWND discovery happens fresh per flash (~500–800 ms PS cold start) so
// we always target a live window even after VS Code restarts. The
// enumerator filters by :
//   1. process == Code.exe
//   2. window title CONTAINS the project name (matches the specific
//      VS Code window where this repo is open ; ignores other VS Code
//      instances the user might have running)
//   Fallback : first visible VS Code window if no title match.
//
// Flash STOPS via SetWinEventHook(EVENT_SYSTEM_FOREGROUND) — the
// PowerShell process stays alive after FlashWindowEx, waits on the
// foreground event for the target HWND, then calls FLASHW_STOP. This
// replaces FLASHW_TIMERNOFG's OS-managed auto-stop, which didn't fire
// reliably on every Windows configuration. The wait loop also breaks
// on IsWindow($hwnd) == false, so closing VS Code mid-flash doesn't
// leak the PS process.
//
// No-op on non-Windows hosts — module loads but start() exits early. The
// "host" check here is getHostKind() === 'windows', which also covers WSL
// (the Linux Node binary calls `powershell.exe` through interop ; the PS
// script then talks to User32 on the Windows side as if it were native).
// Doesn't flash for `stop` events (low urgency — user can come back when
// they want).
// =============================================================================

const { spawn } = require('child_process')
const log = require('../log')
const { FLASH_EVENT_TYPES } = require('../constants')
const { getHostKind } = require('../host')

let projectName = ''
let enabled     = false

// -----------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// -----------------------------------------------------------------------------

/**
 * Wire the Windows taskbar-flash consumer onto the bus. No-op on every
 * non-Windows host (returns `skipped` so index.js's status report shows
 * the channel as cleanly disabled, not failed). On Windows — native or
 * WSL via interop — captures the project name for HWND discovery and
 * subscribes to 'send:notification'.
 *
 * @param {object} opts
 * @param {import('events').EventEmitter} opts.bus   listens for 'send:notification'
 * @param {string} [opts.projectName]                substring to match in VS Code's window title
 * @returns {{ status: 'ok'|'skipped', diag: object }}
 *          status='skipped' with `reason: 'non-windows'` outside the windows host kind
 */
function start({ bus, projectName: pn = '' }) {
	if (getHostKind() !== 'windows') {
		log.info('[flash-win] not Windows — disabled')
		return { status: 'skipped', diag: { reason: 'non-windows' } }
	}
	projectName = pn
	enabled     = true
	bus.on('send:notification', flash)
	const wsl = process.platform === 'linux' ? ' (wsl)' : ''
	log.info(`[flash-win] enabled${wsl}, project="${projectName}"`)
	return { status: 'ok', diag: process.platform === 'linux' ? { wsl: true } : {} }
}

// -----------------------------------------------------------------------------
// FLASH
// -----------------------------------------------------------------------------

/**
 * Per-event dispatch attached to 'send:notification'. Filters on
 * FLASH_EVENT_TYPES (only attention-requiring events flash — `stop` is
 * intentionally excluded so a finished task doesn't yank the user back),
 * builds the discovery + flash PowerShell, and spawns it detached. Errors
 * are logged but never thrown — the daemon must never crash on a flash
 * miss.
 *
 * @param {object} payload          notification payload from the bus
 * @param {string} payload.eventType   event class — checked against FLASH_EVENT_TYPES
 * @returns {void}                  fire-and-forget detached PowerShell spawn
 */
function flash(payload) {
	if (!enabled) return
	if (!FLASH_EVENT_TYPES.has(payload.eventType)) return

	const ps = buildPowerShell(projectName)
	try {
		// Windows : windowsHide + NO detached. Detaching puts the child in a
		// new process group that loses the interactive user-session
		// association — FlashWindowEx then silently does nothing. Same fix
		// as notifier.spawnDetached / sound.play(), proven via diag-toast.js.
		const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], {
			stdio: 'ignore',
			windowsHide: true
		})
		child.unref()
		child.on('error', (err) => log.warn(`[flash-win] spawn failed: ${err.message}`))
	} catch (e) {
		log.warn(`[flash-win] threw: ${e.message}`)
	}
}

// -----------------------------------------------------------------------------
// PowerShell P/Invoke — EnumWindows + FlashWindowEx
// -----------------------------------------------------------------------------

/**
 * Build the PowerShell script that discovers VS Code's HWND, flashes the
 * taskbar entry, and stops the flash on foreground via SetWinEventHook.
 * Discovery + flash + wait run in one PS cold start (~500–800 ms), and
 * discovery is FRESH per flash to survive VS Code restarts.
 *
 * Discovery order :
 *   1. Enumerate visible windows owned by a Code.exe process
 *   2. Prefer titles containing `projName` (case-insensitive substring)
 *   3. Fall back to the first visible VS Code window otherwise
 *
 * Flash flags are `FLASHW_ALL | FLASHW_TIMER = 7` — caption + taskbar
 * flash CONTINUOUSLY, no shell auto-stop. The script then arms a
 * SetWinEventHook(EVENT_SYSTEM_FOREGROUND) hook and pumps messages via
 * Application.DoEvents() + 50 ms sleep until the target HWND becomes
 * foreground (idle CPU ~0 %). On match, FLASHW_STOP is issued. The
 * loop also breaks if IsWindow($hwnd) goes false, so the PS process
 * doesn't leak when VS Code closes mid-flash. FLASHW_TIMERNOFG (the
 * OS-managed auto-stop variant, flags=15) was tried first ; it didn't
 * fire reliably on every Windows configuration, hence the explicit hook.
 *
 * Single quotes inside `projName` are doubled to escape them in the PS
 * string literal that holds it ; no other escaping is needed because the
 * value is only passed once into a single-quoted argument.
 *
 * @param {string} projName   substring to match in VS Code's window title
 * @returns {string}          PowerShell script source ready to feed `powershell.exe -Command`
 */
function buildPowerShell(projName) {
	// Escape single quotes for the PS string literal that holds projName.
	const projEsc = String(projName).replace(/'/g, "''")
	return `
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

// Top-level delegate so PowerShell can reference it as [WinEventDelegate].
public delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType,
	IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

public class W {
	[StructLayout(LayoutKind.Sequential)]
	public struct FI { public uint cbSize; public IntPtr h; public uint f; public uint c; public uint t; }
	[DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FI p);
	[DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder s, int n);
	[DllImport("user32.dll")] public static extern int  GetWindowTextLength(IntPtr h);
	[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
	[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	public delegate bool EnumCB(IntPtr h, IntPtr lp);
	[DllImport("user32.dll")] public static extern bool EnumWindows(EnumCB cb, IntPtr lp);

	// SetWinEventHook — event-driven foreground change detection.
	// EVENT_SYSTEM_FOREGROUND = 0x3, WINEVENT_OUTOFCONTEXT = 0x0
	// (callback runs in our process, no DLL injection needed).
	[DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(
		uint eventMin, uint eventMax, IntPtr hmodWinEventProc,
		WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);
	[DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

	public static List<IntPtr> Find(string proj, HashSet<uint> codePids) {
		var prefer = new List<IntPtr>();
		var others = new List<IntPtr>();
		EnumWindows((h, lp) => {
			if (!IsWindowVisible(h)) return true;
			uint pid; GetWindowThreadProcessId(h, out pid);
			if (!codePids.Contains(pid)) return true;
			int len = GetWindowTextLength(h);
			if (len == 0) return true;
			var sb = new StringBuilder(len + 1);
			GetWindowText(h, sb, sb.Capacity);
			var title = sb.ToString();
			if (!string.IsNullOrEmpty(proj) && title.IndexOf(proj, StringComparison.OrdinalIgnoreCase) >= 0)
				prefer.Add(h);
			else
				others.Add(h);
			return true;
		}, IntPtr.Zero);
		prefer.AddRange(others);
		return prefer;
	}
}
"@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue

# WinForms loaded for Application.DoEvents() — drains the message queue so
# WinEvent callbacks (WINEVENT_OUTOFCONTEXT) actually fire on our thread.
# Without a pump the hook silently never invokes the delegate.
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

# Block until the target HWND becomes foreground (SetWinEventHook) or the
# window is destroyed (IsWindow tick — avoids leaking PS when VS Code
# closes before the user clicks it). HWNDs compared as Int64 because raw
# IntPtr equality in PS boxes to Object and uses reference identity. The
# delegate is held in a script-scoped var so the GC doesn't collect it
# before native calls.
function Wait-ForegroundEvent($targetHwnd) {
	$targetLong = $targetHwnd.ToInt64()
	$script:fgDone = $false

	$script:fgCb = [WinEventDelegate] {
		param($hHook, $evt, $hwnd, $oid, $cid, $th, $ts)
		if ($hwnd.ToInt64() -eq $targetLong) { $script:fgDone = $true }
	}

	# EVENT_SYSTEM_FOREGROUND = 0x3, WINEVENT_OUTOFCONTEXT = 0x0
	$hook = [W]::SetWinEventHook(0x3, 0x3, [IntPtr]::Zero, $script:fgCb, 0, 0, 0)
	if ($hook -eq [IntPtr]::Zero) { return }

	try {
		while (-not $script:fgDone) {
			if (-not [W]::IsWindow($targetHwnd)) { break }
			[System.Windows.Forms.Application]::DoEvents()
			Start-Sleep -Milliseconds 50
		}
	} finally {
		[W]::UnhookWinEvent($hook) | Out-Null
	}
}

# Collect PIDs of running Code.exe processes
$codeProcs = Get-Process Code -ErrorAction SilentlyContinue
if (-not $codeProcs) { exit 1 }
$pidSet = New-Object System.Collections.Generic.HashSet[uint32]
foreach ($p in $codeProcs) { [void]$pidSet.Add([uint32]$p.Id) }

$hwnds = [W]::Find('${projEsc}', $pidSet)
if ($hwnds.Count -eq 0) { exit 1 }

$hwnd = $hwnds[0]

# 7 = FLASHW_ALL (3) | FLASHW_TIMER (4) — continuous flash, no shell
# auto-stop. Wait-ForegroundEvent below stops it explicitly on the
# foreground event for $hwnd (or on window destruction).
$fi = New-Object W+FI
$fi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($fi)
$fi.h      = $hwnd
$fi.f      = 7
$fi.c      = 0
$fi.t      = 0
[W]::FlashWindowEx([ref]$fi) | Out-Null

Wait-ForegroundEvent $hwnd

$fiStop = New-Object W+FI
$fiStop.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($fiStop)
$fiStop.h      = $hwnd
$fiStop.f      = 0  # FLASHW_STOP
[W]::FlashWindowEx([ref]$fiStop) | Out-Null
	`
}

module.exports = { start }
