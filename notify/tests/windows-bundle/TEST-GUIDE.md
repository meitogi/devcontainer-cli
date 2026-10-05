# TEST-GUIDE — Windows 11 ARM, notify daemon

23-step manual walkthrough validating the notify daemon end-to-end on a
Windows 11 ARM VM under Parallels (M1 / M2 / M3 / M4 / Intel Macs).

**Before you start :**

- Daemon prerequisites confirmed (Node ARM64 + VS Code installed — see
  `README.md` in this folder).
- This bundle is extracted at `C:\notify-test\` (or wherever — every
  command below uses *relative* paths from the extract dir).
- Open PowerShell at the bundle root :
  ```powershell
  cd C:\notify-test
  ```
- **VS Code window title substring** : pick a unique substring from
  YOUR window title (e.g. `notify-test`, your project folder name, or
  the universal `Visual Studio Code`). Steps that need it say
  `<YOUR-PROJECT>` — substitute everywhere.

**Verdict legend :** `[ ]` PASS / `[ ]` FAIL — tick the right box per
step. Final tabular result is auto-collected by `run-tests.ps1` ; if
you use this manual flow, transcribe the results yourself.

---

## Layer 1 — Detection (steps 1-2)

### Step 1 — host-detect

Confirms host kind = `windows` and `powershell.exe` is reachable.

```powershell
node .devcontainer\notify\tests\host-detect.js
```

**Expected :** prints `platform: win32`, `kind: windows`, `powershell:
OK`. Exit code 0.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 2 — find-aumid (VS Code)

Confirms the AUMID used for the toast is resolvable.

```powershell
node .devcontainer\notify\tests\find-aumid.js "Visual Studio Code"
```

**Expected :** at least one line ending in `Microsoft.VisualStudioCode`
(or a GUID for Squirrel installs — note the GUID if so).

**Verdict :** [ ] PASS  [ ] FAIL — AUMID found : ______________________

---

## Layer 2 — Visual consumers, no daemon (steps 3-7)

### Step 3 — winrt-standalone (toast)

Fires a hardcoded WinRT toast bypassing the daemon. Validates the
WinRT path independently.

```powershell
node .devcontainer\notify\tests\winrt-standalone.js
```

**Expected :** within 2 seconds, a toast appears in the bottom-right
corner of the screen with VS Code's icon and title `Claude Code · …`.
Toast stays in the Action Center.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 4 — click toast → VS Code foreground

Click the toast from step 3 (or fire another via step 3 if it has
already dismissed). VS Code should come to the foreground.

**Expected :** VS Code window becomes foreground within ~1 second.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 5 — flash-standalone (taskbar flash)

Triggers a continuous orange flash on the VS Code taskbar entry whose
title matches `<YOUR-PROJECT>`.

```powershell
node .devcontainer\notify\tests\flash-standalone.js flash "<YOUR-PROJECT>"
```

**Expected :** the VS Code taskbar button starts flashing orange and
keeps flashing until step 6.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 6 — click VS Code → flash stops

Click the flashing VS Code taskbar button (or Alt+Tab to it). The
flash should stop immediately.

**Expected :** flash stops within ~50 ms of VS Code becoming
foreground. The Node process from step 5 exits.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 7 — PowerShell beep

Validates the sound channel independently of the daemon.

```powershell
powershell.exe -NoProfile -Command "[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 800"
```

**Expected :** the Windows Asterisk system sound is audible.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

## Layer 3 — Events end-to-end (steps 8-20)

### Step 8 — launch daemon

Starts the notify daemon. Leave it running for the remainder of L3.

```powershell
$env:NOTIFY_DOCKER_POLL_MS="0"; Start-Process node -ArgumentList ".devcontainer\notify\index.js" -WindowStyle Minimized
Start-Sleep -Seconds 2
Get-Content .devcontainer\notify\queue\daemon.log -Tail 5
```

**Expected :** log tail shows `[notifier] start` and
`[watcher] start watching <queue-dir>`. No error lines.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 9 — replay stop/1 (recap "Tests passing")

```powershell
.\replay stop 1
Start-Sleep -Seconds 32
Get-Content .devcontainer\notify\queue\daemon.log -Tail 4
```

**Expected :** after ~30 s, a toast with body `Tests passing, PR ready
for review`. Log shows `ARMED 30000ms timer` then `FIRE stop`.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 10 — replay stop/2 (variant "Build failed")

```powershell
.\replay stop 2
Start-Sleep -Seconds 32
Get-Content .devcontainer\notify\queue\daemon.log -Tail 4
```

**Expected :** after ~30 s, a toast with body `Build failed — see
logs, 2 type errors in checkout.vue.js`. Confirms recap variance per
fixture is preserved through the daemon.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 11 — replay permission_request/1 (Bash + flash)

```powershell
.\replay permission_request 1
Start-Sleep -Seconds 32
Get-Content .devcontainer\notify\queue\daemon.log -Tail 4
```

**Expected :** after ~30 s, a toast `Permission asked · Bash` AND a
taskbar flash on `<YOUR-PROJECT>` window.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 12 — replay idle_prompt/1 (instant)

```powershell
.\replay idle_prompt 1
Start-Sleep -Seconds 2
Get-Content .devcontainer\notify\queue\daemon.log -Tail 4
```

**Expected :** **immediate** toast `Idle` (0 ms delay) + taskbar flash.
Log shows `ARMED 0ms timer` then `FIRE idle_prompt` on the same line
pair, ~1 ms apart.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 13 — replay elicitation_dialog/1 (AskUserQuestion)

```powershell
.\replay elicitation_dialog 1
Start-Sleep -Seconds 32
Get-Content .devcontainer\notify\queue\daemon.log -Tail 4
```

**Expected :** after ~30 s, a toast `Question` + flash. Body contains
`Which library should we use for date formatting?`.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 14 — replay elicitation_dialog/2 (ExitPlanMode variant)

```powershell
.\replay elicitation_dialog 2
Start-Sleep -Seconds 32
Get-Content .devcontainer\notify\queue\daemon.log -Tail 4
```

**Expected :** after ~30 s, a toast `Question` + flash. Body contains
`Ready to exit plan mode?`. Confirms message variance.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 15 — replay permission_prompt/1 (notification variant)

```powershell
.\replay permission_prompt 1
Start-Sleep -Seconds 32
Get-Content .devcontainer\notify\queue\daemon.log -Tail 4
```

**Expected :** after ~30 s, a toast `Permission prompt` + flash.
Confirms the wrapped-notification path for permission events.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 16 — replay notification/1 (unmapped path)

```powershell
.\replay notification 1
Start-Sleep -Seconds 2
Get-Content .devcontainer\notify\queue\daemon.log -Tail 2
```

**Expected :** **NO toast.** Log shows `notification <sid8> — unmapped
eventType "notification", skipped`. Confirms the fall-through branch
for envelopes without a known `notification_type`.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 17 — simulate stop cancel

Fires `stop` then `user_replied` 2 s later. The user_replied must
cancel the 30 s timer ; NO toast should appear.

```powershell
.\simulate stop cancel
Start-Sleep -Seconds 33
Get-Content .devcontainer\notify\queue\daemon.log -Tail 4
```

**Expected :** **NO toast.** Log shows `stop ARMED` then `user_replied
… CANCELLED pending stop`.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 18 — simulate perm cancel

Fires `permission_request` then `tool_started` 2 s later. tool_started
cancels the pending permission timer ; NO toast.

```powershell
.\simulate perm cancel
Start-Sleep -Seconds 33
Get-Content .devcontainer\notify\queue\daemon.log -Tail 4
```

**Expected :** **NO toast.** Log shows `permission_request ARMED` then
`tool_started … CANCELLED pending permission_request`.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 19 — replay notification/2 (unknown subtype)

Confirms the unmapped log line ALSO fires for an envelope with a
notification_type the watcher doesn't recognise.

```powershell
.\replay notification 2
Start-Sleep -Seconds 2
Get-Content .devcontainer\notify\queue\daemon.log -Tail 2
```

**Expected :** **NO toast.** Log shows `unknown_subtype <sid8> —
unmapped eventType "unknown_subtype", skipped`.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 20 — simulate all (sequential parade)

Fires every scenario back-to-back. Watch your desktop for the parade
of toasts over the next ~35 s.

```powershell
.\simulate all
Start-Sleep -Seconds 40
```

**Expected :** an idle_prompt toast first (0 s), then a perm /
perm-prompt / elicit toast cluster (~5 s if delays were tweaked, else
~30 s), then a stop toast last (~30 s). Latest-wins applies — if two
events share an sid (they shouldn't here, sids are unique per
scenario), only the last timer fires.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

## Layer 4 — Env vars (steps 21-23)

For these, stop the daemon (close the minimised Node window), set the
env var, relaunch, and rerun a sample replay (idle_prompt is fastest).

### Step 21 — NOTIFY_CHANNELS=notifier (toast only)

```powershell
# Stop any running daemon first
Stop-Process -Name node -Force -ErrorAction SilentlyContinue
$env:NOTIFY_CHANNELS = "notifier"
$env:NOTIFY_DOCKER_POLL_MS="0"; Start-Process node -ArgumentList ".devcontainer\notify\index.js" -WindowStyle Minimized
Start-Sleep -Seconds 2
.\replay idle_prompt 1
Start-Sleep -Seconds 2
```

**Expected :** toast ONLY. NO taskbar flash. NO beep.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 22 — NOTIFY_SOUND=off (silent toast + flash)

```powershell
Stop-Process -Name node -Force -ErrorAction SilentlyContinue
Remove-Item Env:NOTIFY_CHANNELS -ErrorAction SilentlyContinue
$env:NOTIFY_SOUND = "off"
$env:NOTIFY_DOCKER_POLL_MS="0"; Start-Process node -ArgumentList ".devcontainer\notify\index.js" -WindowStyle Minimized
Start-Sleep -Seconds 2
.\replay permission_request 1
Start-Sleep -Seconds 32
```

**Expected :** toast + taskbar flash. **NO beep.**

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

### Step 23 — NOTIFY_CHANNELS=flash-win (flash only)

```powershell
Stop-Process -Name node -Force -ErrorAction SilentlyContinue
Remove-Item Env:NOTIFY_SOUND -ErrorAction SilentlyContinue
$env:NOTIFY_CHANNELS = "flash-win"
$env:NOTIFY_DOCKER_POLL_MS="0"; Start-Process node -ArgumentList ".devcontainer\notify\index.js" -WindowStyle Minimized
Start-Sleep -Seconds 2
.\replay permission_request 1
Start-Sleep -Seconds 32
```

**Expected :** taskbar flash ONLY on `<YOUR-PROJECT>`. NO toast. NO
beep.

**Verdict :** [ ] PASS  [ ] FAIL — notes : ____________________

---

## Cleanup

```powershell
Stop-Process -Name node -Force -ErrorAction SilentlyContinue
Remove-Item Env:NOTIFY_CHANNELS -ErrorAction SilentlyContinue
Remove-Item Env:NOTIFY_SOUND -ErrorAction SilentlyContinue
```

## Final verdict

23 steps total. Tally and report :

```
L1 Detection         : __ / 2 PASS
L2 Visual consumers  : __ / 5 PASS
L3 Events end-to-end : __ / 13 PASS
L4 Env vars          : __ / 3 PASS
------------------------------
TOTAL                : __ / 23 PASS
```
