#!/usr/bin/env node
// =============================================================================
// test-flash-standalone — flash VS Code's taskbar entry on Windows
// =============================================================================
//
// Run on WINDOWS only. Enumerates all visible VS Code windows, filters by
// project name in the window title, and applies one of two modes.
//
// Modes :
//   flash  (default) orange blinking continuous + SetWinEventHook foreground
//          stop → the flash starts and stops the moment the target window
//          becomes foreground (Alt+Tab, click on the taskbar button, etc.).
//   clear  stops any flash on the target window
//          (FLASHW_STOP via FlashWindowEx with dwFlags = 0).
//
//   node test-flash-standalone.js                        # flash, default DEFAULT_PROJECT_NAME
//   node test-flash-standalone.js flash "Portal42"       # flash, any title substring
//   node test-flash-standalone.js clear                  # stop any stuck flash
//
// VS Code window title format :
//   <file> - <folder> - Visual Studio Code
//   <folder> - Visual Studio Code
//
// SetWinEventHook(EVENT_SYSTEM_FOREGROUND) is the canonical Win32 event-
// driven way to react to foreground changes. The OS posts a message to our
// queue the instant the foreground window changes; we react in the callback.
// Application.DoEvents() + 50 ms Sleep is just a message pump that yields
// CPU between drains, so effective stop latency is up to ~50 ms.
// =============================================================================

const { spawn } = require('child_process')

// =============================================================================
// CONFIG — VS Code window title substring used to find the target window.
// Override via CLI arg #2 :  node flash-standalone.js flash "Portal42"
// Edit this default for a permanent project-specific match.
// Matching is case-sensitive substring on the full window title, e.g.
//   "myfile.ts - notify-daemon - Visual Studio Code"
// Common values : "Visual Studio Code" (universal trailer), the folder name,
// or a unique file currently open in the project.
// =============================================================================
const DEFAULT_PROJECT_NAME = 'Visual Studio Code'

const RAW_MODE     = process.argv[2] !== undefined ? process.argv[2] : 'flash'
const VALID_MODES  = ['flash', 'clear']
if (!VALID_MODES.includes(RAW_MODE)) {
	console.error(`Invalid MODE "${RAW_MODE}" — must be "flash" or "clear"`)
	console.error(`Usage: node test-flash-standalone.js [flash|clear] [PROJECT_NAME]`)
	process.exit(1)
}
const PROJECT_NAME = process.argv[3] !== undefined ? process.argv[3] : DEFAULT_PROJECT_NAME

console.log(`Mode ${RAW_MODE} — looking for a VS Code window with title containing "${PROJECT_NAME}"...\n`)

const projEsc = String(PROJECT_NAME).replace(/'/g, "''")

const ps = `
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType,
	IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

public class W {
	[StructLayout(LayoutKind.Sequential)]
	public struct FI { public uint cbSize; public IntPtr h; public uint f; public uint c; public uint t; }
	[DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FI p);
	[DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder s, int n);
	[DllImport("user32.dll")] public static extern int  GetWindowTextLength(IntPtr h);
	[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	public delegate bool EnumCB(IntPtr h, IntPtr lp);
	[DllImport("user32.dll")] public static extern bool EnumWindows(EnumCB cb, IntPtr lp);

	// EVENT_SYSTEM_FOREGROUND = 0x3, WINEVENT_OUTOFCONTEXT = 0x0.
	[DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(
		uint eventMin, uint eventMax, IntPtr hmodWinEventProc,
		WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);
	[DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

	public static List<KeyValuePair<IntPtr, string>> Find(string proj, HashSet<uint> codePids) {
		var prefer = new List<KeyValuePair<IntPtr, string>>();
		var others = new List<KeyValuePair<IntPtr, string>>();
		EnumWindows((h, lp) => {
			if (!IsWindowVisible(h)) return true;
			uint pid; GetWindowThreadProcessId(h, out pid);
			if (!codePids.Contains(pid)) return true;
			int len = GetWindowTextLength(h);
			if (len == 0) return true;
			var sb = new StringBuilder(len + 1);
			GetWindowText(h, sb, sb.Capacity);
			var title = sb.ToString();
			var entry = new KeyValuePair<IntPtr, string>(h, title);
			if (!string.IsNullOrEmpty(proj) && title.IndexOf(proj, StringComparison.OrdinalIgnoreCase) >= 0)
				prefer.Add(entry);
			else
				others.Add(entry);
			return true;
		}, IntPtr.Zero);
		prefer.AddRange(others);
		return prefer;
	}
}
"@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

# Block until the target HWND becomes foreground via SetWinEventHook.
# Comparing HWNDs as Int64 because raw IntPtr -eq/-ne in PS is unreliable.
# Delegate held in script scope so the GC doesn't collect it mid-callback.
function Wait-ForegroundEvent($targetHwnd) {
	$targetLong = $targetHwnd.ToInt64()
	$script:fgDone = $false

	$script:fgCb = [WinEventDelegate] {
		param($hHook, $evt, $hwnd, $oid, $cid, $th, $ts)
		$fgLong = $hwnd.ToInt64()
		Write-Host ("  [event] foreground HWND={0} (target={1})" -f $fgLong, $targetLong)
		if ($fgLong -eq $targetLong) { $script:fgDone = $true }
	}

	$hook = [W]::SetWinEventHook(0x3, 0x3, [IntPtr]::Zero, $script:fgCb, 0, 0, 0)
	if ($hook -eq [IntPtr]::Zero) {
		Write-Error "SetWinEventHook returned NULL — hook registration failed"
		return
	}

	try {
		while (-not $script:fgDone) {
			[System.Windows.Forms.Application]::DoEvents()
			Start-Sleep -Milliseconds 50
		}
	} finally {
		[W]::UnhookWinEvent($hook) | Out-Null
	}
}

$codeProcs = Get-Process Code -ErrorAction SilentlyContinue
if (-not $codeProcs) { Write-Error "no VS Code process found — is VS Code running?"; exit 1 }
$pidSet = New-Object System.Collections.Generic.HashSet[uint32]
foreach ($p in $codeProcs) { [void]$pidSet.Add([uint32]$p.Id) }

$hits = [W]::Find('${projEsc}', $pidSet)
if ($hits.Count -eq 0) { Write-Error "no VS Code window with a visible title found"; exit 1 }

Write-Host ("Candidates found: " + $hits.Count)
foreach ($kv in $hits) {
	$marker = if ($kv.Key -eq $hits[0].Key) { "→" } else { " " }
	Write-Host ("  {0} HWND {1,-12} {2}" -f $marker, $kv.Key, $kv.Value)
}

$hwnd = $hits[0].Key
Write-Host ""
Write-Host ("Target HWND " + $hwnd + " — mode ${RAW_MODE}")

$fi = New-Object W+FI
$fi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($fi)
$fi.h      = $hwnd
$fi.c      = 0
$fi.t      = 0

switch ('${RAW_MODE}') {
	'flash' {
		# 7 = FLASHW_ALL (3) | FLASHW_TIMER (4) — continuous flash, no shell
		# auto-stop. We stop it ourselves on the foreground event.
		$fi.f = 7
		[W]::FlashWindowEx([ref]$fi) | Out-Null
		Write-Host "Orange blinking. Waiting for SetWinEventHook foreground event..."
		Wait-ForegroundEvent $hwnd
		$fiStop = New-Object W+FI
		$fiStop.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($fiStop)
		$fiStop.h      = $hwnd
		$fiStop.f      = 0  # FLASHW_STOP
		[W]::FlashWindowEx([ref]$fiStop) | Out-Null
		Write-Host "Stopped."
	}
	'clear' {
		$fiStop = New-Object W+FI
		$fiStop.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($fiStop)
		$fiStop.h      = $hwnd
		$fiStop.f      = 0  # FLASHW_STOP
		[W]::FlashWindowEx([ref]$fiStop) | Out-Null
		Write-Host "Stopped any flash on the target window."
	}
}
`

const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })

child.on('error', (err) => {
	console.error('✗ PowerShell spawn failed:', err.message)
	process.exit(1)
})
child.on('exit', (code) => process.exit(code || 0))
