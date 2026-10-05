#!/usr/bin/env bash
# integration/test-claude-switch.sh — verify claude-switch mode application.
#
# claude-switch (host-side) toggles 2 files :
#   - .devcontainer/.env (ANTHROPIC_BASE_URL line comment/decomment)
#   - .devcontainer/firewall/ports.txt (active host:port entry)
#
# After a rebuild, the baked /etc/devcontainer-firewall/ports.txt
# should match the workspace copy (which was just updated by claude-switch).
# This suite cross-checks workspace ↔ baked alignment for whichever mode
# is currently active, detected from .env.
#
# Each `test_mode_*` skips unless the detected mode matches.

source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

ENV_FILE=/workspace/.devcontainer/.env
WORKSPACE_TCP=/workspace/.devcontainer/firewall/ports.txt
BAKED_TCP=/etc/devcontainer-firewall/ports.txt

_post_bake() {
  in_container || return 1
  [ -d /etc/devcontainer-firewall ] || return 1
  if command -v findmnt >/dev/null 2>&1; then
    findmnt -n /etc/devcontainer-firewall >/dev/null 2>&1 && return 1
  else
    awk '$5 == "/etc/devcontainer-firewall" {found=1} END {exit !found}' /proc/self/mountinfo 2>/dev/null && return 1
  fi
  return 0
}

# Detect the active claude mode from .env (uncommented ANTHROPIC_BASE_URL).
_claude_mode() {
  [ -f "$ENV_FILE" ] || { echo "unknown"; return; }
  if   grep -qE '^ANTHROPIC_BASE_URL=http://ollama\.internal:11434'  "$ENV_FILE"; then echo "local"
  elif grep -qE '^#?\s*ANTHROPIC_BASE_URL='                          "$ENV_FILE"; then echo "cloud"
  else                                                                                echo "cloud"
  fi
}

# Count active (non-comment, non-blank) entries in a file.
_active_lines() {
  grep -vE '^\s*(#|$)' "$1" 2>/dev/null | tr -d '[:space:]' | grep -c .
}

test_workspace_baked_alignment() {
  _post_bake || { skip_test "not in post-bake container"; return; }
  [ -f "$WORKSPACE_TCP" ] && [ -f "$BAKED_TCP" ] || {
    skip_test "ports.txt missing in workspace or /etc"; return; }
  # The active entries must match exactly (comments may differ in spacing
  # but actual entries are what init-firewall.sh applies as iptables ACCEPT).
  local ws_active baked_active
  ws_active=$(grep -vE '^\s*(#|$)' "$WORKSPACE_TCP" | tr -d '[:space:]' | sort)
  baked_active=$(grep -vE '^\s*(#|$)' "$BAKED_TCP"   | tr -d '[:space:]' | sort)
  if [ "$ws_active" = "$baked_active" ]; then
    _ok "workspace ↔ baked ports active entries match"
  else
    _nok "workspace ↔ baked diverge — last rebuild didn't pick up claude-switch ?"
    echo "      workspace : $(echo "$ws_active" | tr '\n' ' ')"
    echo "      baked     : $(echo "$baked_active" | tr '\n' ' ')"
  fi
}

test_mode_cloud() {
  _post_bake || { skip_test "not in post-bake container"; return; }
  local m; m=$(_claude_mode)
  [ "$m" = "cloud" ] || { skip_test "active mode = $m, not cloud"; return; }
  # Expected : no active entry (only commented examples) in both copies.
  if [ "$(_active_lines "$BAKED_TCP")" -eq 0 ]; then
    _ok "cloud : baked ports has zero active entries"
  else
    _nok "cloud : baked ports has unexpected entries"
    grep -vE '^\s*(#|$)' "$BAKED_TCP" | sed 's/^/      /'
  fi
}

test_mode_local() {
  _post_bake || { skip_test "not in post-bake container"; return; }
  local m; m=$(_claude_mode)
  [ "$m" = "local" ] || { skip_test "active mode = $m, not local"; return; }
  # Expected : host:11434 active in baked (Ollama on host gateway).
  if grep -qE '^[[:space:]]*host:11434[[:space:]]*$' "$BAKED_TCP"; then
    _ok "local : baked has host:11434 active"
  else
    _nok "local : baked missing host:11434"
  fi
  local extras
  extras=$(grep -vE '^[[:space:]]*(#|$|host:11434[[:space:]]*$)' "$BAKED_TCP" | tr -d '[:space:]' | grep -c .)
  [ "$extras" -eq 0 ] && _ok "local : no extra active entries" \
                      || _nok "local : $extras extra entries in baked"
}

run_tests
