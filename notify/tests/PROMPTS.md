# Real-world test prompts

Copy-paste each prompt into a live Claude Code chat (in this devcontainer) to
trigger the corresponding notification event. The daemon must be running on
the host (see [../README.md](../README.md)) and the hooks must be wired
(automatic via `sync-skills.sh` on container open).

Watch the daemon log in another terminal for the full event trace :

```bash
tail -f .devcontainer/tmp/notify/daemon.log
```

Each test below shows the **prompt**, the **expected daemon log lines**, and
the **expected user-visible notification** (macOS / Windows / Discord).

---

## 1. `stop` — turn finishes, user idle

**Prompt** :

```
Print "hello" and stop. Don't ask me anything.
```

**Expected log** (~30 s after Claude finishes) :

```
[watcher] stop           <sid8> — ARMED 30000ms timer
... wait 30 s with no further interaction ...
[watcher] FIRE stop      <sid8> — emitting send:notification
[notifier] DISPATCH darwin stop <sid8> — subtitle="<sessionName> · Stop"
```

**Expected notif** :
- macOS title : `Claude Code · <projectName>` · subtitle : `<sessionName> · Stop` · body : `hello · HH:MM:SS`
- Discord    : `**<projectName> — Session "<sessionName>" — Stop**` then `hello`

---

## 2. `user_replied` cancel — stop is cancelled

Run prompt #1 above, then **within 30 s** type another short prompt :

```
Now print "goodbye".
```

**Expected log** :

```
[watcher] stop           <sid8> — ARMED 30000ms timer
... a few seconds later ...
[watcher] user_replied   <sid8> — CANCELLED pending stop
```

**Expected notif** : **none**. The cancel beat the timer.

If your log shows `no pending timer (already fired or never armed)`, you
waited too long — the stop already fired.

---

## 3. `permission_request` — tool needs Allow/Deny

**Prompt** :

```
Run `traceroute github.com` via Bash and show me the first 3 hops.
```

`traceroute` isn't in the workspace allowlist, so a permission dialog
opens. Don't click Allow / Cancel right away — wait 15 s to see the notif
fire, OR click Allow within 15 s to see the cancel.

**Expected log (Allow within ~15 s)** :

```
[watcher] permission_request <sid8> — ARMED 15000ms timer
... user clicks Allow ...
[watcher] tool_started   <sid8> — CANCELLED pending permission_request
```

**Expected notif (Allow path)** : **none** (cancelled).

**Expected log (no click within 15 s)** :

```
[watcher] permission_request <sid8> — ARMED 15000ms timer
... 15 s pass ...
[watcher] FIRE permission_request <sid8> — emitting send:notification
[notifier] DISPATCH darwin permission_request <sid8> — subtitle="<sessionName> · Permission · Bash"
```

**Expected notif (timer fires)** :
- macOS subtitle : `<sessionName> · Permission · Bash` · body : `{"command":"traceroute..."} · HH:MM:SS`
- Discord       : `**<projectName> — Session "<sessionName>" — Permission \`Bash\`**` with the full `tool_input` in a code fence below

---

## 4. `permission_prompt` — Notification hook variant

Same trigger as #3. Claude Code fires BOTH `PermissionRequest` AND
`Notification(permission_prompt)` for the same dialog. Both events arm
timers (the second replaces the first via "latest wins" — same
behaviour, distinct log signature).

**Look for in the log** :

```
[watcher] permission_request <sid8> — ARMED 15000ms timer
[watcher] permission_prompt  <sid8> — REPLACED previous permission_request timer
[watcher] permission_prompt  <sid8> — ARMED 15000ms timer
```

---

## 5. `elicitation_dialog` — Claude asks a question (AskUserQuestion)

**Prompt** :

```
Ask me which color I prefer between red, green, and blue. Use the
AskUserQuestion tool.
```

Claude opens a single-select dialog with 3 options. **Don't pick** within
15 s to see the notif fire.

**Expected log** :

```
[watcher] elicitation_dialog <sid8> — ARMED 15000ms timer
... 15 s pass ...
[watcher] FIRE elicitation_dialog <sid8> — emitting send:notification
[notifier] DISPATCH darwin elicitation_dialog <sid8> — subtitle="<sessionName> · Question"
```

**Expected notif** :
- macOS subtitle : `<sessionName> · Question` · body : the message Claude posted with the dialog
- Discord       : `**<projectName> — Session "<sessionName>" — Question**` with the prompt in a blockquote

---

## 6. `elicitation_dialog` — multi-choice variant

**Prompt** :

```
Use AskUserQuestion with multiSelect: true to ask me which features I
want: dark mode, auto-save, and word wrap.
```

Same event type (`elicitation_dialog`) — multi-select is just a UI
variant, not a separate hook signal. Same notif rendering as #5.

---

## 7. `idle_prompt` — 60 s of inactivity after Claude finishes

**Prompt** :

```
Just say "done" and stop.
```

Then **don't interact for 60+ seconds**. After ~60 s of inactivity,
Claude Code emits `Notification(idle_prompt)` itself (binary internal
heuristic). The daemon fires immediately (0 s delay).

**Expected log** :

```
[watcher] stop           <sid8> — ARMED 30000ms timer
[watcher] FIRE stop      <sid8> — emitting send:notification
... still idle ...
[watcher] idle_prompt    <sid8> — ARMED 0ms timer
[watcher] FIRE idle_prompt <sid8> — emitting send:notification
```

So you'll get TWO notifs : Stop at +30 s, Idle at +~60 s (60 s after Stop
was emitted, plus the 30 s Stop delay = ~90 s total walked-away time).

To test idle alone without the Stop, just walk away even longer after
the Stop notif fires.

---

## 8. Discord webhook (optional, parallel channel)

Set the webhook URL in `.devcontainer/.env` :

```
NOTIFY_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/.../...
```

Then rebuild container (so `initialize.sh` re-spawns the daemon with the
env var) and rerun any test above. Discord receives a message in parallel
with the OS notif.

You should see in the daemon log :

```
[webhook] Discord channel enabled
```

If you see `Discord channel disabled — NOTIFY_DISCORD_WEBHOOK_URL not set`,
the env var didn't reach the daemon. Check `.devcontainer/.env` for typos
and that the daemon was re-spawned after the edit (kill its pid and
re-run `initialize.sh`, or Rebuild Container).

---

## 9. Direct module tests (host-side, no Claude needed)

If you want to validate a specific channel in isolation without going
through Claude :

```bash
# Fire one OS desktop notif using the REAL daemon transform
node .devcontainer/notify/tests/modules.js notifier

# POST a test message to Discord (reads NOTIFY_DISCORD_WEBHOOK_URL)
node .devcontainer/notify/tests/modules.js webhook

# Probe the devcontainer with docker ps
node .devcontainer/notify/tests/modules.js docker-watch

# Run the watcher for ~10 s with short delays + auto-fire one event
node .devcontainer/notify/tests/modules.js watcher

# Run all 4 sequentially
node .devcontainer/notify/tests/modules.js all
```

## 10. Synthetic JSONL events (container-side, bypass Claude)

If you want to drive specific events without waiting for Claude to do
them naturally, use the JSONL synth :

```bash
# Each fires through the real hook → JSONL → daemon → channels pipeline
node .devcontainer/notify/tests/notifs.js stop          # 30 s delay
node .devcontainer/notify/tests/notifs.js perm          # 15 s delay
node .devcontainer/notify/tests/notifs.js idle          # immediate
node .devcontainer/notify/tests/notifs.js perm-prompt   # 15 s delay
node .devcontainer/notify/tests/notifs.js elicit        # 15 s delay
node .devcontainer/notify/tests/notifs.js v2            # 30 s delay, body = "Recap line wins"
node .devcontainer/notify/tests/notifs.js all           # all of the above

# Cancel debounce test : fire event + user_replied 2 s later
node .devcontainer/notify/tests/notifs.js stop cancel   # expect NO notif
node .devcontainer/notify/tests/notifs.js perm cancel
```

## 11. Windows-only standalone tests

These don't touch the daemon — pure PowerShell smoke for the WinRT toast
and FlashWindowEx paths :

```powershell
# Fire one WinRT toast with hardcoded AUMID + project name
node .devcontainer/notify/tests/winrt-standalone.js

# Find a VS Code window by title substring + flash its taskbar entry
node .devcontainer/notify/tests/flash-standalone.js          # default "Devcontainer Tools"
node .devcontainer/notify/tests/flash-standalone.js Portal42 # any substring
node .devcontainer/notify/tests/flash-standalone.js ""       # first VS Code window

# List Start Menu apps + their AUMIDs (useful when the hardcoded VS Code
# AUMID doesn't match your install variant)
node .devcontainer/notify/tests/find-aumid.js                # default filter "Visual Studio Code"
node .devcontainer/notify/tests/find-aumid.js Slack          # any filter
node .devcontainer/notify/tests/find-aumid.js ""             # dump everything
```
