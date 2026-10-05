#!/usr/bin/env bash
# validate-claude-switch.sh — multi-rebuild orchestrator for claude-switch
# validation. Same pattern as validate-session-1.sh.
#
# Each invocation :
#   1. Detects the active claude mode from .env (cloud / local / local-proxy).
#   2. Runs the claude-switch integration suite (filtered to that mode).
#   3. Appends result to .devcontainer/tmp/logs/claude-switch-validation.log.
#   4. Tells you what to do next : claude-switch <next-mode> + rebuild.
#
# Usage : bash .devcontainer/tests/validate-claude-switch.sh
#
# Reset progress : rm .devcontainer/tmp/logs/claude-switch-validation.log

set +e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR=/workspace/.devcontainer/tmp/logs
STATE="$STATE_DIR/claude-switch-validation.log"
mkdir -p "$STATE_DIR"

BOLD=$'\033[1m'; RED=$'\033[1;31m'; GREEN=$'\033[1;32m'
YELLOW=$'\033[1;33m'; CYAN=$'\033[1;36m'; RST=$'\033[0m'

if [ ! -f /.dockerenv ] && [ -z "${REMOTE_CONTAINERS:-}" ]; then
  echo "${RED}This script must run inside the rebuilt devcontainer, not on the host.${RST}" >&2
  exit 2
fi

if [ ! -d /etc/devcontainer-firewall ]; then
  echo "${RED}/etc/devcontainer-firewall missing — wrong image?${RST}" >&2
  exit 2
fi

# Detect bake state.
post_bake=1
if command -v findmnt >/dev/null 2>&1; then
  findmnt -n /etc/devcontainer-firewall >/dev/null 2>&1 && post_bake=0
else
  awk '$5 == "/etc/devcontainer-firewall" {found=1} END {exit !found}' /proc/self/mountinfo 2>/dev/null && post_bake=0
fi
if [ $post_bake -eq 0 ]; then
  echo "${RED}Container is pre-bake (bind mount still active). Rebuild first.${RST}" >&2
  echo "  Cmd+Shift+P → Dev Containers: Rebuild Container" >&2
  exit 2
fi

# Detect active mode from .env (same logic as the integration test).
ENV_FILE=/workspace/.devcontainer/.env
mode="cloud"
if   grep -qE '^ANTHROPIC_BASE_URL=http://ollama\.internal:11434' "$ENV_FILE" 2>/dev/null; then mode="local"
fi

echo "${BOLD}${CYAN}== claude-switch validation — active mode: $mode ==${RST}"
echo

# Run just the claude-switch integration test.
out=$(bash "$HERE/integration/test-claude-switch.sh" 2>&1)
echo "$out"
echo

# Parse aggregate (same approach as run.sh).
strip_ansi() { sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'; }
line=$(echo "$out" | strip_ansi | grep -E -- '--- .* : .* pass / .* fail / .* skip ---' | tail -1)
p=$(echo "$line"  | sed -nE 's/.*[^0-9]([0-9]+) pass.*/\1/p')
f=$(echo "$line" | sed -nE 's/.*[^0-9]([0-9]+) fail.*/\1/p')
s=$(echo "$line" | sed -nE 's/.*[^0-9]([0-9]+) skip.*/\1/p')
p=${p:-0}; f=${f:-0}; s=${s:-0}

status="pass"
[ "$f" -gt 0 ] && status="fail"

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "$ts $mode $status $p/$f/$s" >> "$STATE"

echo "${BOLD}── State so far ──${RST}"
cat "$STATE"
echo

have_cloud=0; have_local=0; have_local_proxy=0
while read -r _ts m st _counts; do
  [ "$st" != "pass" ] && continue
  case "$m" in
    cloud)        have_cloud=1 ;;
    local)        have_local=1 ;;
    local-proxy)  have_local_proxy=1 ;;
  esac
done < "$STATE"

remaining=()
[ $have_cloud       -eq 0 ] && remaining+=("cloud")
[ $have_local       -eq 0 ] && remaining+=("local")
[ $have_local_proxy -eq 0 ] && remaining+=("local-proxy")

if [ "$f" -gt 0 ]; then
  echo "${RED}✗ Current run FAILED ($f assertion(s)). Investigate before flipping mode.${RST}"
  exit 1
fi

if [ ${#remaining[@]} -eq 0 ]; then
  echo "${GREEN}${BOLD}✅ All 3 claude-switch modes validated (cloud, local, local-proxy).${RST}"
  echo
  echo "claude-switch end-to-end coverage complete. Safe to return to your"
  echo "preferred mode :"
  echo "  bash .devcontainer/host-helpers/claude-switch cloud   # default"
  echo
  echo "(or local / local-proxy if you were dogfooding a local backend)."
  exit 0
fi

next="${remaining[0]}"
echo "${YELLOW}${BOLD}Next step :${RST} switch to '$next' and rebuild."
echo
printf '\033[1;33m  # From your HOST shell :\033[0m\n'
echo "  bash .devcontainer/host-helpers/claude-switch $next"
echo "  → Cmd+Shift+P → Dev Containers: Rebuild Container"
echo "  → Once back inside : bash .devcontainer/tests/validate-claude-switch.sh"
echo
echo "Remaining modes to validate : ${remaining[*]}"
exit 0
