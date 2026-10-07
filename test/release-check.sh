#!/usr/bin/env bash
# release-check.sh — step 0 of RELEASING.md. Replays the publish.yml `guard`
# job locally, prunes dist/ before the suite (tsc does not prune it itself —
# D169, 7.4), and runs the notify/ tests and the templates/ jargon grep that
# RELEASING.md step 0 already asks for by hand.
#
# No registry, no tiers, no transcription: a release is still cut from
# RELEASING.md by hand. This only buys back a tag before the guard job would
# refuse it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO"

PUBLISH_YML=".github/workflows/publish.yml"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

ok() { printf '\xe2\x9c\x94 %s\n' "$1"; }
fail() { printf '\xe2\x9c\x98 %s\n' "$1" >&2; exit 1; }

# 1. tools
for t in node jq git; do
  command -v "$t" >/dev/null 2>&1 || fail "tool check: $t not found"
done
NPM_HAVE="$(npm --version)"
NPM_NEED="$(grep -o 'need="[0-9.]*"' "$PUBLISH_YML" | head -1 | cut -d'"' -f2)"
[ -n "$NPM_NEED" ] || fail "tool check: could not read the npm floor from $PUBLISH_YML"
if [ "$(printf '%s\n%s\n' "$NPM_NEED" "$NPM_HAVE" | sort -V | head -n1)" != "$NPM_NEED" ]; then
  fail "tool check: npm $NPM_HAVE < $NPM_NEED required by $PUBLISH_YML"
fi
ok "tools: node $(node --version), jq, git, npm $NPM_HAVE >= $NPM_NEED"

# 2. tree
[ -z "$(git status --porcelain)" ] || fail "tree: working tree is not clean"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || fail "tree: on branch '$BRANCH', expected main"
ok "tree: clean, on main"

# 3. guard rejoued
REPO_URL="$(jq -r '.repository.url' package.json)"
WANT_URL="git+https://github.com/meitogi/devcontainer-cli.git"
[ "$REPO_URL" = "$WANT_URL" ] || fail "guard: repository.url is '$REPO_URL', expected '$WANT_URL'"
REPO_DIR="$(jq -r '.repository.directory // "none"' package.json)"
[ "$REPO_DIR" = "none" ] || fail "guard: repository.directory is a monorepo leftover ('$REPO_DIR')"
VERSION="$(jq -r '.version' package.json)"
LOCK_VERSIONS="$(jq -r '.version, .packages[""].version' package-lock.json)"
for v in $LOCK_VERSIONS; do
  [ "$v" = "$VERSION" ] || fail "guard: package-lock.json version '$v' != package.json version '$VERSION'"
done
ok "guard: repository field and version ($VERSION) agree with package-lock.json"

# 4. tag libre
git tag -l "v$VERSION" | grep -q . && fail "tag: v$VERSION already exists locally"
if REMOTE_TAG="$(git ls-remote --tags origin "v$VERSION" 2>/dev/null)"; then
  [ -z "$REMOTE_TAG" ] || fail "tag: v$VERSION already exists on origin"
  ok "tag: v$VERSION is free (checked locally and on origin)"
else
  ok "tag: v$VERSION is free locally (OMIT: could not reach origin)"
fi

# 5. etape 0 de RELEASING
NOTIFY_FAILS=0
NOTIFY_COUNT=0
for t in notify/tests/*.test.js; do
  NOTIFY_COUNT=$((NOTIFY_COUNT + 1))
  node "$t" >/dev/null 2>&1 || NOTIFY_FAILS=$((NOTIFY_FAILS + 1))
done
[ "$NOTIFY_FAILS" -eq 0 ] || fail "releasing step 0: $NOTIFY_FAILS/$NOTIFY_COUNT notify/ test(s) failed"
JARGON="$(grep -rniE "phase [0-9]|session [0-9]|\bD[0-9]{1,2}\b" templates/ || true)"
[ -z "$JARGON" ] || fail "releasing step 0: rollout jargon leaked into templates/"
ok "releasing step 0: $NOTIFY_COUNT/$NOTIFY_COUNT notify/ tests pass, no jargon in templates/"

# 6. suite
# tsc does not prune dist/: a deleted test keeps running from its .js (D169)
rm -rf dist
npm test >"$LOG" 2>&1 || { cat "$LOG" >&2; fail "suite: npm test failed — see above"; }
PASS="$(grep -m1 '^# \?pass ' "$LOG" | grep -o '[0-9]*' || grep -m1 '^ℹ pass ' "$LOG" | grep -o '[0-9]*')"
FAIL="$(grep -m1 '^# \?fail ' "$LOG" | grep -o '[0-9]*' || grep -m1 '^ℹ fail ' "$LOG" | grep -o '[0-9]*')"
SKIPPED="$(grep -m1 '^# \?skipped ' "$LOG" | grep -o '[0-9]*' || grep -m1 '^ℹ skipped ' "$LOG" | grep -o '[0-9]*')"
[ "$FAIL" = "0" ] || fail "suite: $FAIL failing test(s)"
[ "$SKIPPED" = "0" ] || fail "suite: $SKIPPED skipped test(s)"
ok "suite: $PASS pass, 0 fail, 0 skipped"

# 7. projet vierge
SANDBOX_SCRIPT="$REPO/../devcontainer-sandbox/test/bare-project.sh"
if [ -e "$SANDBOX_SCRIPT" ]; then
  bash "$SANDBOX_SCRIPT" --simulate
  BARE="$REPO/../../.tmp/bare"
  TGZ_NAME="meitogi-devcontainer-cli-$VERSION.tgz"
  # npm install's own log never echoes the tarball name back (just "added N
  # package(s)"); the packed tarball sitting next to it is the real signal
  # that initializeCommand would run this checkout.
  [ -e "$BARE/$TGZ_NAME" ] || fail "bare project: $BARE does not contain $TGZ_NAME"
  [ -s "$BARE/.cli-install.log" ] || fail "bare project: $BARE/.cli-install.log is missing or empty"
  ok "bare project: scaffold + pack ($TGZ_NAME) + offline install simulated clean"
else
  ok "bare project: – skipped (no sandbox checkout)"
fi

printf '\xe2\x9c\x94 release-check: %s is ready to tag — see RELEASING.md step 1\n' "$VERSION"
