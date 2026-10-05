# notify/tests — daemon test surface (live + Windows bundle)

Everything for testing the notify daemon lives here. Two modes :

- **In-container, live** — `notifs.js`, `modules.js`, individual
  `*-standalone.js` scripts exercised directly with the daemon
  running on the macOS / Linux host.
- **Bundled, Windows VM** — `prepare-archive.sh` packs this folder
  + the daemon source into `~/Desktop/notify-test.zip`. The Windows
  user extracts, runs `run-tests.js`, **visually approves or rejects
  each toast / flash / sound**, follows `TEST-GUIDE.md`.

**Goal of the Windows bundle :** visually validate every notification
type and every consumer (WinRT toast, taskbar flash, system sound,
click-activation) on a real Windows 11 ARM environment. The bundle
simulates the events synthetically (no real Claude session in the VM —
that's impossible on M1/M2 since WSL2 + Docker + the devcontainer
toolchain can't run there), so you can confirm each surface produces
the right visible artefact without dragging the full dev workflow into
the VM. `run-tests.cmd` (entry point) triggers each scenario and asks
you `[y]es / [n]o / [r]etrigger / [s]kip` between visual checks --
`r` re-runs the same step so you can re-verify without having to
restart the whole runner.

Source-of-truth = this directory. Fixtures, scripts, .cmd wrappers,
docs all live here. The bundle is built from here every time. No
duplicated source tree.

## Folder layout

```
.devcontainer/notify/tests/
├── PROMPTS.md                       # real-world prompts for live macOS testing
├── notifs.js                        # synthetic event driver (cross-platform)
├── replay-fixture.js                # fixture replayer (cross-platform)
├── modules.js                       # per-module exerciser
├── host-detect.js                   # platform + powershell.exe probe
├── find-aumid.js                    # Windows AUMID resolver
├── winrt-standalone.js              # standalone WinRT toast test
├── flash-standalone.js              # standalone taskbar flash test (DEFAULT_PROJECT_NAME at top)
│
├── fixtures/                        # 22 synthetic-faithful JSONL fixtures
│   ├── stop/{1,2,3}.jsonl
│   ├── permission_request/{1,2,3}.jsonl
│   ├── idle_prompt/{1,2,3}.jsonl
│   ├── elicitation_dialog/{1,2,3}.jsonl
│   ├── permission_prompt/{1,2,3}.jsonl
│   ├── notification/{1,2,3}.jsonl
│   ├── tool_started/1.jsonl
│   ├── tool_finished/1.jsonl
│   ├── tool_cancelled/1.jsonl
│   └── user_replied/1.jsonl
│
└── windows-bundle/                  # all Windows-bundle scaffolding (this folder)
    ├── README.md                    # this file
    ├── TEST-GUIDE.md                # 23-step manual walkthrough
    ├── run-tests.js                # PowerShell auto runner
    ├── replay.cmd                   # Windows wrapper → ../replay-fixture.js
    ├── simulate.cmd                 # Windows wrapper → ../notifs.js
    └── prepare-archive.sh           # bundles parent tests/ + daemon → notify-test.zip
```

---

## A. Live testing (Mac / Linux, in the devcontainer)

The daemon runs on the host (started by `.devcontainer/initialize.sh`).
Replay a fixture or fire a synthetic event from the devcontainer ; the
host daemon picks it up and shows a desktop notification.

```bash
# From the project root :
node .devcontainer/notify/tests/replay-fixture.js stop 1
node .devcontainer/notify/tests/replay-fixture.js idle_prompt
node .devcontainer/notify/tests/notifs.js perm
node .devcontainer/notify/tests/notifs.js all cancel
```

Tail the log on the host (or in the devcontainer — the queue dir is
bind-mounted) :

```bash
tail -f .devcontainer/tmp/notify/daemon.log
```

For real-world scenarios that exercise the hook end-to-end (not just
the watcher), see [PROMPTS.md](../PROMPTS.md).

---

## B. Windows bundle — Mac → Parallels VM workflow

### Mac-chip matrix — what your silicon supports

| Mac chip | Parallels + Windows 11 ARM | WSL2 inside Windows 11 ARM | Bundle path used |
|---|---|---|---|
| M1, M2 (Pro / Max / Ultra) | yes | no — silicon-mur, no nested virtualization at the SoC level | **Windows-native** (this bundle) |
| M3, M4 (any variant) | yes | yes — unlocked since macOS Sonoma + Parallels 20 | Windows-native — WSL2 path untested + out of scope |
| Intel | yes (x64 Windows 11) | yes — legacy nested virt | Windows-native — same flow |

The bundle exercises the **Windows-native Node + PowerShell + WinRT**
path. The WSL2 interop path stays untested — about 5 lines in
[../../lib/host.js](../../lib/host.js) gated by `WSLENV`, only affects binary
lookup, not toast generation.

### B.1 — What to install (one time)

**On the Mac (host) :**

```bash
brew install --cask parallels
# OR https://www.parallels.com/products/desktop/download/
```

**In Parallels — VM creation :**

- New VM → **Get Windows from Microsoft** (Parallels handles ISO + license)
  OR import a Windows 11 ARM VHDX manually.
- VM spec : ≥ 4 GB RAM, ≥ 64 GB disk, 2 vCPU.
- Configure → Options → Sharing → enable **Share Mac folders with
  Windows** + **Share Mac home**. The bundle zip then appears under
  `Z:\<your-mac-user>\Desktop\` inside the VM.

**Inside the Windows 11 ARM VM — PowerShell as admin :**

```powershell
# 1. Node.js LTS ARM64 — winget auto-selects the arm64 build on Win11 ARM
winget install OpenJS.NodeJS.LTS
# If winget unavailable, manual MSI :
#   https://nodejs.org/en/download/  →  "Windows Installer (.msi) — ARM64"
# Critical: pick ARM64, NOT x64. x64 runs under xtajit64.dll emulation
# and tanks WinRT toast latency.

# 2. Verify arch (CRITICAL)
node --version           # → v20.x or v22.x
node -p "process.arch"   # → arm64  (NOT x64)

# 3. VS Code ARM64
winget install Microsoft.VisualStudioCode
# OR https://code.visualstudio.com/download → "ARM 64 (User installer)"

# 4. PowerShell — built-in powershell.exe 5.1 is enough.
# The bundle calls `powershell.exe` explicitly, not pwsh.
```

### B.2 — Build the bundle

On the Mac, from the project root :

```bash
bash .devcontainer/notify/tests/windows-bundle/prepare-archive.sh
# → ~/Desktop/notify-test.zip  (~110 KB, zero npm deps, 22 fixtures inside)
```

Override the destination for CI / sandbox runs :

```bash
NOTIFY_BUNDLE_OUT=/tmp/notify-test.zip \
  bash .devcontainer/notify/tests/windows-bundle/prepare-archive.sh
```

### B.3 — Deploy in the VM

```powershell
# In the Windows VM, via the Mac shared home (Parallels mounts ~/Desktop/
# as a network share, typically Z:\<your-mac-user>\Desktop\) :
Copy-Item "Z:\<mac-user>\Desktop\notify-test.zip" "C:\notify-test.zip"
Expand-Archive "C:\notify-test.zip" "C:\notify-test"
cd C:\notify-test

# AUMID sanity check
node .devcontainer\notify\tests\find-aumid.js "Visual Studio Code"
# Expect : Microsoft.VisualStudioCode (Squirrel installs use a GUID — note it)

# Either auto runner — .cmd entry bypasses PowerShell execution policy
.\run-tests.cmd

# … or manual walkthrough
notepad TEST-GUIDE.md
```

### B.4 — Use the bundle

Three modes :

- **A. Auto** -- `.\run-tests.cmd` walks every step. After each
  visual scenario fires, you answer
  `[y]es / [r]etrigger / [s]kip / anything else = FAIL`.
  - `y` / `yes` -> PASS
  - `s` / `skip` -> SKIP
  - `r` / `retry` / `retrigger` -> re-fire the same action and re-ask
  - **anything else** (e.g. `the click does not focus VS Code`) -> FAIL,
    and the text you typed is captured as the failure note.

  Final block prints a `Step Layer Title Verdict` table plus a
  red-highlighted `FAIL details` section listing each failed step's
  note verbatim.
- **B. Manual** — open `TEST-GUIDE.md`, follow the 23 steps, tick the
  PASS / FAIL checkboxes yourself.
- **C. À la carte** — see the cheat-sheet below.

```powershell
# Optional : tell run-tests.js your VS Code window-title substring up-front
$env:NOTIFY_PROJECT_NAME = "notify-test"
.\run-tests.cmd

# Skip layers
.\run-tests.cmd -SkipLayers L1,L4
```

### B.5 — Cheat-sheet (à la carte)

| Need | Command |
|---|---|
| Detect host | `node .devcontainer\notify\tests\host-detect.js` |
| Find VS Code AUMID | `node .devcontainer\notify\tests\find-aumid.js "Visual Studio Code"` |
| Fire one toast | `node .devcontainer\notify\tests\winrt-standalone.js` |
| Flash taskbar | `node .devcontainer\notify\tests\flash-standalone.js flash "<YOUR-PROJECT>"` |
| Stop flash | `node .devcontainer\notify\tests\flash-standalone.js clear "<YOUR-PROJECT>"` |
| Launch daemon | `$env:NOTIFY_DOCKER_POLL_MS="0"; Start-Process node -ArgumentList ".devcontainer\notify\index.js" -WindowStyle Minimized` |
| Stop daemon | `Stop-Process -Name node -Force` |
| Daemon log | `Get-Content .devcontainer\notify\queue\daemon.log -Tail 20 -Wait` |
| Replay a fixture | `.\replay <type> [num]` (e.g. `.\replay stop 1`) |
| Synthetic event | `.\simulate <type> [cancel]` (e.g. `.\simulate idle`, `.\simulate stop cancel`) |
| List fixture types | `dir .devcontainer\notify\tests\fixtures` |

---

## Bundle layout (what's inside `notify-test.zip`)

```
C:\notify-test\
├── README.md                          # copy of this file (Windows-friendly path hints)
├── TEST-GUIDE.md                      # copy of TEST-GUIDE.md
├── run-tests.js                      # copy of run-tests.js
├── replay.cmd                         # copy of replay.cmd
├── simulate.cmd                       # copy of simulate.cmd
└── .devcontainer\
    ├── devcontainer.json              # minimal { "name": "notify-test" }
    └── notify\
        ├── index.js                   # daemon entry
        ├── lib\                       # consumers, watchers, etc.
        ├── queue\                     # daemon.log + state\ + .daemon.pid
        └── tests\                     # canonical scripts + fixtures (same source)
```

Root-level files are convenience copies the prepare-archive.sh script
adds for one-line discoverability in the VM. The canonical location
stays `.devcontainer\notify\tests\` ; both copies are populated from
the same source on every bundle build. Edit once here, re-run
prepare-archive.sh.

---

## Troubleshooting

- **Toast doesn't appear (Windows)** — check `Get-Content
  .devcontainer\notify\queue\daemon.log -Tail 20` for a `FIRE` line
  followed by `DISPATCH windows`. If FIRE is missing, the watcher
  didn't process the event ; if DISPATCH is missing, the notifier
  failed (look for a `[notifier] error` line right after).
- **`process.arch` reports `x64`** — Node x64 build under emulation.
  Uninstall, install the **ARM64** MSI.
- **AUMID not `Microsoft.VisualStudioCode`** — Squirrel installs use a
  GUID. Override `WINDOWS_AUMID` in
  [../../lib/constants.js](../../lib/constants.js) to the GUID printed
  by step 2.
- **Flash matches wrong window** — narrow the title substring. CLI arg
  #2 to `flash-standalone.js`, or `$ProjectName` in `run-tests.js`,
  or `DEFAULT_PROJECT_NAME` at the top of
  [../flash-standalone.js](../flash-standalone.js).
- **Daemon won't start (Windows)** — check for an existing Node
  process (`Get-Process node`). The daemon's lockfile prevents two
  instances.
- **Daemon shuts itself down after ~60 s** — `docker-watch` polls for
  a devcontainer-labelled parent container and treats "no match" as
  `container:gone -> exit daemon`. The bundle has no parent docker.
  Launch with `$env:NOTIFY_DOCKER_POLL_MS="0"` to disable the poll
  (already baked into `run-tests.cmd` and the cheat-sheet launch
  command).

## What this bundle does NOT exercise

The bundle covers everything the daemon produces visually (toast,
flash, sound, click-activation, env-var combos) for synthetic events.
The following surfaces are deliberately left out because they can't
be reproduced on an M1/M2 Mac without WSL2 / Docker / Claude actually
running inside Windows 11 (silicon-mur on Apple Silicon < M3 makes
that workflow impossible) :

- **WSL2 interop path** in [../../lib/host.js](../../lib/host.js) —
  only matters if Claude runs in a WSL2 distro emitting events to
  Windows-side notifications. We test the Windows-native Node path
  instead.
- **`docker-watch`** — needs the Portal42 docker container running
  inside the VM. Not feasible.
- **`inbound-watch`** — needs the Claude Code VS Code extension
  running inside the VM with its inbound IPC pipe. Not feasible.
- **`launcher-watch`** — needs a Claude parent process to monitor for
  liveness. The bundle has no Claude, so nothing to watch.
- **`sleep-watch`** — needs the host to actually sleep / wake mid-run
  to assert the daemon recovers. Coverable manually if you suspend
  the VM ; not automated in the runner.
- **Discord webhook channel** — separately tested via
  `node modules.js discord-webhook` on the macOS host.
- **macOS / Linux notification paths** — exercised every day in the
  devcontainer ; bundling them in the Windows VM would add no
  signal.
- **Real-capture fixtures** — current fixtures are synthetic-faithful
  (every field shaped per the hook schema). Real-payload capture is
  a future session, gated on a `hook.js` audit-log edit.
