#!/usr/bin/env bash
# fake-hook.sh — simulate what hook.js would write to the queue when
# Claude Code fires a real event, so the notify daemon runs its full
# pipeline (watcher → notify-app → notif send / remove) without needing
# an actual Claude Code session in the loop.
#
# Runs on the Mac host (or in the container — both see the same queue
# via bind-mount). Requires jq for the JSON build ; every mac has it.
#
# Subcommands are named around the user-facing Claude Code lifecycle
# (send / question / perm-request) rather than the raw watcher event
# names. This mirrors how an operator running smokes thinks : "a perm
# request that got approved" reads better than the underlying
# permission_request → tool_finished pair.
#
# Usage :
#   ./fake-hook.sh send                       # plain user-facing message
#   ./fake-hook.sh question                   # Claude idle, waiting for input
#   ./fake-hook.sh reply [SID]                # user typed a reply — closes any
#                                             # pending event (question, perm,
#                                             # stop). Universal cancel signal.
#   ./fake-hook.sh perm-request               # tool asks permission (30s delay)
#   ./fake-hook.sh perm-request-approved      # user clicked Allow, tool ran
#   ./fake-hook.sh perm-request-denied        # user clicked Deny
#   ./fake-hook.sh stop                       # end of Claude message turn
#   ./fake-hook.sh invariant                  # full-flow combo test
#
# The queue dir defaults to `.devcontainer/tmp/notify/` relative to
# the current working directory. Override with $QUEUE_DIR if the daemon
# writes elsewhere on your host.

set -euo pipefail

QUEUE_DIR="${QUEUE_DIR:-.devcontainer/tmp/notify}"
mkdir -p "$QUEUE_DIR"

now_iso() { date -u +"%Y-%m-%dT%H:%M:%S.000Z" ; }
now_ms()  { date +%s%3N 2>/dev/null || date +%s000 ; }

# Deterministic per-run SID so cancel-remove can target it. Overridable
# via `SID=xxx ./fake-hook.sh …` for repeated runs against the same
# fake session.
: "${SID:=$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo deadbeef-1111-2222-3333-444444444444)}"
SID8="${SID:0:8}"

# Append one JSONL line to the queue for the given SID.
queue_line() {
    local target_sid="$1"
    local line="$2"
    echo "$line" >> "${QUEUE_DIR}/${target_sid}.jsonl"
}

fake_send() {
    local NOTIF_ID="notification-${SID8}-$(now_ms)"
    queue_line "$SID" "{\"ts\":\"$(now_iso)\",\"sid\":\"${SID}\",\"event\":\"notification\",\"sender\":\"default\",\"notif_id\":\"${NOTIF_ID}\",\"message\":\"fake-hook send test\"}"
    echo "queued notification (plain) for sid=${SID} — fires instantly"
    echo "  → banner subject to your NOTIFY_CHANNELS ; daemon.log will show DISPATCH within 500 ms"
}

fake_question() {
    local NOTIF_ID="notification-${SID8}-$(now_ms)"
    queue_line "$SID" "{\"ts\":\"$(now_iso)\",\"sid\":\"${SID}\",\"event\":\"notification\",\"sender\":\"default\",\"notif_id\":\"${NOTIF_ID}\",\"notification_type\":\"idle_prompt\",\"message\":\"fake-hook question — Claude waiting for input\"}"
    echo "queued notification (idle_prompt) for sid=${SID} — fires instantly"
    echo "  → close it with : $0 reply ${SID}"
}

fake_reply() {
    local target_sid="${1:-${SID}}"
    local target_sid8="${target_sid:0:8}"
    local NOTIF_ID="user_replied-${target_sid8}-$(now_ms)"
    queue_line "$target_sid" "{\"ts\":\"$(now_iso)\",\"sid\":\"${target_sid}\",\"event\":\"user_replied\",\"sender\":\"default\",\"notif_id\":\"${NOTIF_ID}\"}"
    echo "queued user_replied for sid=${target_sid}"
    echo "  → universal cancel signal — closes ANY pending notification (question, perm-request, stop)"
    echo "  → pre-fire pending timer cleared ; post-fire banner dismissed via notif remove"
}

fake_perm_request() {
    local NOTIF_ID="permission_request-${SID8}-$(now_ms)"
    queue_line "$SID" "{\"ts\":\"$(now_iso)\",\"sid\":\"${SID}\",\"event\":\"permission_request\",\"sender\":\"default\",\"notif_id\":\"${NOTIF_ID}\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"fake test\"}}"
    echo "queued permission_request for sid=${SID} — fires in ~30 s (EVENT_DELAYS_MS)"
    echo "  → approve with : SID=${SID} $0 perm-request-approved"
    echo "  → deny with    : SID=${SID} $0 perm-request-denied"
}

fake_perm_request_approved() {
    local NOTIF_ID="tool_finished-${SID8}-$(now_ms)"
    queue_line "$SID" "{\"ts\":\"$(now_iso)\",\"sid\":\"${SID}\",\"event\":\"tool_finished\",\"sender\":\"default\",\"notif_id\":\"${NOTIF_ID}\",\"tool_name\":\"Bash\"}"
    echo "queued tool_finished for sid=${SID} — post-fire banner dismissed via notif remove"
    echo "  → v0.2.8 invariant : the earlier perm-request banner must disappear from NC within 500 ms"
}

fake_perm_request_denied() {
    local NOTIF_ID="tool_cancelled-${SID8}-$(now_ms)"
    queue_line "$SID" "{\"ts\":\"$(now_iso)\",\"sid\":\"${SID}\",\"event\":\"tool_cancelled\",\"sender\":\"default\",\"notif_id\":\"${NOTIF_ID}\",\"tool_name\":\"Bash\"}"
    echo "queued tool_cancelled for sid=${SID} — post-fire banner dismissed via notif remove"
}

fake_stop() {
    local NOTIF_ID="stop-${SID8}-$(now_ms)"
    queue_line "$SID" "{\"ts\":\"$(now_iso)\",\"sid\":\"${SID}\",\"event\":\"stop\",\"sender\":\"default\",\"notif_id\":\"${NOTIF_ID}\",\"last_message_excerpt\":\"fake-hook stop test — recap goes here\"}"
    echo "queued stop for sid=${SID} — fires in ~30 s"
}

# Full-flow combo scenario. Validates the "1 banner per sid" invariant
# end-to-end : after step 3, Notification Center must show exactly ONE
# banner (the `send` one), not two (perm + send).
fake_invariant() {
    echo "=== invariant test — sid=${SID} ==="
    echo "step 1/3 : queue perm-request (fires in ~30 s)"
    fake_perm_request
    echo
    echo "step 2/3 : sleep 32 s so the perm banner delivers …"
    sleep 32
    echo
    echo "step 3/3 : queue a plain send on the same sid"
    fake_send
    echo
    sleep 3
    echo "=== done ==="
    echo "→ inspect Notification Center : should see exactly ONE banner (the send)"
    echo "→ if the perm-request banner is still visible, the v0.2.8 invariant is broken"
}

case "${1:-help}" in
    send)                    fake_send                                    ;;
    question)                fake_question                                ;;
    reply)                   shift ; fake_reply "${1:-}"                  ;;
    perm-request)            fake_perm_request                            ;;
    perm-request-approved)   fake_perm_request_approved                   ;;
    perm-request-denied)     fake_perm_request_denied                     ;;
    stop)                    fake_stop                                    ;;
    invariant)               fake_invariant                               ;;
    *)
        cat <<EOF
usage: $0 <subcommand> [SID]

Subcommands (user-facing lifecycle) :
  send                       plain message notification (fires instantly)
  question                   Claude idle, waiting for input (idle_prompt)
  reply [SID]                user typed a reply — user_replied event.
                             Universal cancel signal : closes ANY pending
                             notification (question / perm-request / stop).
                             This is what fires when the user types a new
                             prompt instead of clicking Allow/Deny on a
                             pending perm-request.
  perm-request               tool asks permission (30 s delay)
  perm-request-approved      user clicked Allow → tool_finished
  perm-request-denied        user clicked Deny  → tool_cancelled
  stop                       end of Claude message turn (30 s delay)
  invariant                  combo scenario : perm → wait 32 s → send

Environment overrides :
  QUEUE_DIR   default: .devcontainer/tmp/notify
  SID         default: fresh UUID per invocation

Examples :
  $0 send                                        # instant fire
  $0 perm-request                                # 30 s delay
  SID=my-test-sid $0 perm-request                # fixed SID …
  SID=my-test-sid $0 perm-request-approved       # … then approve
  $0 invariant                                   # full-flow smoke
EOF
        exit 1
        ;;
esac
