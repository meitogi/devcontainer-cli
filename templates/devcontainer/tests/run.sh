#!/usr/bin/env bash
# tests/run.sh — discover + run all `test-*.sh` files in this directory.
#
# Usage :
#   bash tests/run.sh                          # run everything
#   bash tests/run.sh tests/test-bake-firewall.sh   # run a single file
#   bash tests/run.sh --pattern '*-firewall*'       # glob on filename
#
# Exits 0 if all files pass, 1 if any failed.

set +e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PATTERN="test-*.sh"
SCOPE=""        # "", "unit", "integration", or "host"
FILES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pattern)      PATTERN="$2"; shift 2 ;;
    --unit)         SCOPE="unit"; shift ;;
    --integration)  SCOPE="integration"; shift ;;
    --host)         SCOPE="host"; shift ;;
    *)              FILES+=("$1"); shift ;;
  esac
done

# Default discovery : unit + integration (in-container tiers). host/ tier is
# opt-in via --host because it needs to run from the host machine via
# docker exec — distinct execution context.
if [ ${#FILES[@]} -eq 0 ]; then
  if [ -n "$SCOPE" ]; then
    search_dirs=("$HERE/$SCOPE")
  else
    search_dirs=("$HERE/unit" "$HERE/integration")
  fi
  for d in "${search_dirs[@]}"; do
    [ -d "$d" ] || continue
    while IFS= read -r f; do FILES+=("$f"); done < <(find "$d" -maxdepth 1 -name "$PATTERN" -type f | sort)
  done
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "✗ No test files matched (pattern: $PATTERN)" >&2
  exit 1
fi

total_pass=0
total_fail=0
total_skip=0
failed_files=()

strip_ansi() { sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'; }

for f in "${FILES[@]}"; do
  out=$(bash "$f" 2>&1)
  rc=$?
  echo "$out"
  echo
  # Parse the "--- file : N pass / N fail / N skip ---" line after stripping
  # ANSI colors (otherwise the ESC bytes break the awk word boundaries).
  line=$(echo "$out" | strip_ansi | grep -E -- '--- .* : .* pass / .* fail / .* skip ---' | tail -1)
  p=$(echo "$line"  | sed -nE 's/.*[^0-9]([0-9]+) pass.*/\1/p')
  fl=$(echo "$line" | sed -nE 's/.*[^0-9]([0-9]+) fail.*/\1/p')
  sk=$(echo "$line" | sed -nE 's/.*[^0-9]([0-9]+) skip.*/\1/p')
  total_pass=$((total_pass + ${p:-0}))
  total_fail=$((total_fail + ${fl:-0}))
  total_skip=$((total_skip + ${sk:-0}))
  [ "$rc" -ne 0 ] && failed_files+=("${f##*/}")
done

echo "═══════════════════════════════════════"
echo "  Aggregate : $total_pass pass / $total_fail fail / $total_skip skip"
echo "═══════════════════════════════════════"
if [ ${#failed_files[@]} -eq 0 ]; then
  echo "✅ All test files pass"
  exit 0
else
  echo "❌ Failed files :"
  for f in "${failed_files[@]}"; do echo "  - $f"; done
  exit 1
fi
