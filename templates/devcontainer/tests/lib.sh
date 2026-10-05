#!/usr/bin/env bash
# tests/lib.sh — minimal bash assertion library for devcontainer-tools tests.
#
# Conventions :
# - Each test file declares functions prefixed `test_` ; lib.sh's `run_tests`
#   helper discovers them and runs each in isolation.
# - Use `assert_*` helpers ; they record pass/fail and emit a one-line marker.
# - Each test should be self-contained (no global state between tests).
# - Tests run inside the devcontainer (post-rebuild) ; some skip on host.
#
# Usage from a test file :
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#   test_foo() { assert_eq "a" "a" "trivial equality" ; }
#   run_tests
#
# Runner usage :
#   bash tests/run.sh                          # all test files
#   bash tests/run.sh tests/test-bake-firewall.sh  # one file

[ -n "${TESTS_LIB_LOADED:-}" ] && return 0
TESTS_LIB_LOADED=1

BOLD=$'\033[1m'
RED=$'\033[1;31m'
GREEN=$'\033[1;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[1;36m'
RST=$'\033[0m'

# Counters (per-file). Reset by run_tests at entry.
_PASS=0
_FAIL=0
_SKIP=0
_FAILURES=()
_CURRENT_TEST=""

# Assert helpers — each records pass/fail and prints a line.
# Convention : `assert_X expected actual "label"` (label always last).

assert_true() {
  # assert_true <cmd...> -- "label"
  # Runs <cmd...> ; passes iff exit 0.
  local label=""
  local cmd=()
  local seen_dashdash=0
  for arg in "$@"; do
    if [ "$arg" = "--" ]; then seen_dashdash=1; continue; fi
    if [ $seen_dashdash -eq 1 ]; then label="$arg"; else cmd+=("$arg"); fi
  done
  if "${cmd[@]}" 2>/dev/null; then
    _ok "$label"
  else
    _nok "$label (cmd failed : ${cmd[*]})"
  fi
}

assert_false() {
  local label=""
  local cmd=()
  local seen_dashdash=0
  for arg in "$@"; do
    if [ "$arg" = "--" ]; then seen_dashdash=1; continue; fi
    if [ $seen_dashdash -eq 1 ]; then label="$arg"; else cmd+=("$arg"); fi
  done
  if "${cmd[@]}" 2>/dev/null; then
    _nok "$label (cmd unexpectedly succeeded : ${cmd[*]})"
  else
    _ok "$label"
  fi
}

assert_eq() {
  local expected="$1" actual="$2" label="${3:-eq}"
  if [ "$expected" = "$actual" ]; then
    _ok "$label"
  else
    _nok "$label : expected '$expected', got '$actual'"
  fi
}

assert_ne() {
  local left="$1" right="$2" label="${3:-ne}"
  if [ "$left" != "$right" ]; then
    _ok "$label"
  else
    _nok "$label : both '$left'"
  fi
}

assert_file_exists() {
  local path="$1" label="${2:-file $1}"
  [ -f "$path" ] && _ok "$label" || _nok "$label : '$path' missing"
}

assert_file_missing() {
  local path="$1" label="${2:-no file $1}"
  [ ! -e "$path" ] && _ok "$label" || _nok "$label : '$path' present"
}

assert_dir_exists() {
  local path="$1" label="${2:-dir $1}"
  [ -d "$path" ] && _ok "$label" || _nok "$label : '$path' missing"
}

assert_contains() {
  # File contains substring (literal).
  local path="$1" needle="$2" label="${3:-contains}"
  [ -f "$path" ] || { _nok "$label : '$path' missing"; return; }
  grep -qF "$needle" "$path" && _ok "$label" || _nok "$label : '$needle' not in $path"
}

assert_not_contains() {
  local path="$1" needle="$2" label="${3:-not contains}"
  if [ -f "$path" ] && grep -qF "$needle" "$path"; then
    _nok "$label : '$needle' found in $path"
  else
    _ok "$label"
  fi
}

assert_match() {
  # File contains line matching ERE.
  local path="$1" re="$2" label="${3:-match}"
  [ -f "$path" ] || { _nok "$label : '$path' missing"; return; }
  grep -qE "$re" "$path" && _ok "$label" || _nok "$label : ERE '$re' no match in $path"
}

assert_eq_file_content() {
  local path="$1" expected="$2" label="${3:-file content}"
  local got
  got=$(cat "$path" 2>/dev/null | tr -d '[:space:]')
  if [ "$got" = "$expected" ]; then
    _ok "$label"
  else
    _nok "$label : '$path' = '$got' (expected '$expected')"
  fi
}

# Skip the current test with a reason. Use for environment-conditional tests.
skip_test() {
  local reason="${1:-no reason}"
  _SKIP=$((_SKIP+1))
  echo "  ${YELLOW}⊘${RST} ${_CURRENT_TEST} — skipped : $reason"
  # Returning non-zero would abort the test function ; we want to exit cleanly.
  return 0
}

# Internal helpers — don't call directly from tests.
_ok()  { _PASS=$((_PASS+1)); echo "  ${GREEN}✓${RST} ${_CURRENT_TEST} :: $1"; }
_nok() { _FAIL=$((_FAIL+1)); _FAILURES+=("${_CURRENT_TEST} :: $1"); echo "  ${RED}✗${RST} ${_CURRENT_TEST} :: $1"; }

# Discover and run all `test_*` functions in the current shell scope.
# Prints a per-file summary. Exits the script with 1 if any test failed.
run_tests() {
  local test_file="${BASH_SOURCE[1]##*/}"
  echo "${BOLD}${CYAN}=== $test_file ===${RST}"
  _PASS=0; _FAIL=0; _SKIP=0; _FAILURES=()

  # Discover test_* functions defined in the caller.
  local fns
  fns=$(declare -F | awk '$3 ~ /^test_/ {print $3}')
  if [ -z "$fns" ]; then
    echo "  ${YELLOW}⊘${RST} no test_* functions found in $test_file"
    return 0
  fi

  # Run tests inline (no subshell) so counters propagate. We trade isolation
  # for accurate reporting ; each test is expected to be self-contained and
  # avoid `set -e` reliance. Subshells dropped the _PASS/_FAIL/_SKIP updates.
  set +e
  local n
  for n in $fns; do
    _CURRENT_TEST="$n"
    "$n"
  done

  echo
  echo "${BOLD}--- $test_file : ${GREEN}$_PASS pass${RST}${BOLD} / ${RED}$_FAIL fail${RST}${BOLD} / ${YELLOW}$_SKIP skip${RST}${BOLD} ---${RST}"
  if [ $_FAIL -gt 0 ]; then
    echo "${RED}Failures :${RST}"
    local f
    for f in "${_FAILURES[@]}"; do echo "  - $f"; done
    return 1
  fi
  return 0
}

# Useful environment helpers.
in_container() {
  [ -f /.dockerenv ] || [ -n "${REMOTE_CONTAINERS:-}" ]
}

repo_root() {
  # Walk up from this lib.sh until we find a marker (e.g., .git or templates/v2).
  local d
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [ "$d" != "/" ]; do
    if [ -d "$d/.git" ] || [ -d "$d/templates/v2" ]; then
      printf '%s' "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
  printf '%s' "$PWD"
}
