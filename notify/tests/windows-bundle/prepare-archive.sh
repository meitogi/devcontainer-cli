#!/usr/bin/env bash
# =============================================================================
# prepare-archive.sh — bundle notify daemon for standalone Windows test
# =============================================================================
#
# Run from the repo root (the dir containing .devcontainer/). Stages
# .devcontainer/notify/ (daemon source + tests/ + tests/fixtures/) into
# /tmp/notify-test/, copies the user-facing files (README, TEST-GUIDE,
# run-tests.js + run-tests.cmd, replay.cmd, simulate.cmd) to the bundle root for one-
# line discoverability in the VM, then zips to ~/Desktop/notify-test.zip.
#
# Convenience copies at bundle root are populated from the same source
# (this directory) on every run — single source of truth, no drift.
#
# Output : ~/Desktop/notify-test.zip (~110 KB, no npm deps)
# Override via NOTIFY_BUNDLE_OUT for headless / CI runs.
# =============================================================================

set -euo pipefail

# --- Sanity check --------------------------------------------------------------
if [[ ! -d ".devcontainer/notify" ]]; then
	echo "✗ Run from the project root (must contain .devcontainer/)." >&2
	echo "  cwd = $(pwd)" >&2
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Stage ---------------------------------------------------------------------
STAGE_PARENT="$(mktemp -d)"
STAGE="$STAGE_PARENT/notify-test"
mkdir -p "$STAGE/.devcontainer/tmp/notify"

echo "→ Stage : $STAGE"

# Copy notify/ minus runtime state. tests/ + tests/fixtures/ are included.
rsync -a \
	--exclude='queue/**' \
	--exclude='*.log' \
	--exclude='.daemon.pid' \
	--exclude='notify-architecture.excalidraw' \
	--exclude='.DS_Store' \
	.devcontainer/notify/ "$STAGE/.devcontainer/notify/"

# Minimal devcontainer.json — locate.js reads only the `name` field.
cat > "$STAGE/.devcontainer/devcontainer.json" <<'JSON'
{ "name": "notify-test" }
JSON

# Empty .devcontainer/tmp/logs/ — inbound-watch warns ENOENT otherwise. The
# bundle has no VS Code extension feeding it, so the watcher sits idle
# but at least starts cleanly.
mkdir -p "$STAGE/.devcontainer/tmp/logs"
# Keep the dir in the zip (some zippers skip empty dirs)
touch "$STAGE/.devcontainer/tmp/logs/.gitkeep"

# Convenience copies at bundle root. SCRIPT_DIR is
# .devcontainer/notify/tests/windows-bundle/, so the canonical files
# are right next to this script.
cp "$SCRIPT_DIR/README.md"       "$STAGE/README.md"
cp "$SCRIPT_DIR/TEST-GUIDE.md"   "$STAGE/TEST-GUIDE.md"
cp "$SCRIPT_DIR/run-tests.js"    "$STAGE/run-tests.js"
cp "$SCRIPT_DIR/run-tests.cmd"   "$STAGE/run-tests.cmd"
cp "$SCRIPT_DIR/replay.cmd"      "$STAGE/replay.cmd"
cp "$SCRIPT_DIR/simulate.cmd"    "$STAGE/simulate.cmd"

# --- Zip -----------------------------------------------------------------------
# Override via NOTIFY_BUNDLE_OUT for headless / CI runs (e.g. inside a
# devcontainer that has no ~/Desktop). Defaults to the Mac host's Desktop.
ARCHIVE="${NOTIFY_BUNDLE_OUT:-$HOME/Desktop/notify-test.zip}"
mkdir -p "$(dirname "$ARCHIVE")"
rm -f "$ARCHIVE"
if command -v zip >/dev/null 2>&1; then
	( cd "$STAGE_PARENT" && zip -rq "$ARCHIVE" "notify-test" -x '*.DS_Store' )
else
	# Fallback: python3 zipfile (Mac + most Linux ship Python by default).
	# Doesn't support exclusion ; .DS_Store entries are filtered by rsync.
	( cd "$STAGE_PARENT" && python3 -m zipfile -c "$ARCHIVE" "notify-test" )
fi

# --- Recap ---------------------------------------------------------------------
echo
echo "✓ Archive : $ARCHIVE"
echo "  Size    : $(du -h "$ARCHIVE" | cut -f1)"
echo "  Files (first 40) :"
unzip -l "$ARCHIVE" 2>/dev/null | awk 'NR>3 && $NF != "" {print "    " $NF}' | head -40 \
	|| python3 -m zipfile -l "$ARCHIVE" | head -40

FIX_COUNT="$(unzip -l "$ARCHIVE" 2>/dev/null | grep -c 'tests/fixtures/.*\.jsonl$' || true)"
echo "  Fixtures bundled : $FIX_COUNT"

# --- Cleanup -------------------------------------------------------------------
rm -rf "$STAGE_PARENT"
echo
echo "Next step: transfer $ARCHIVE to the Windows VM."
echo "  - Parallels Volumes : cp \"$ARCHIVE\" \"/Volumes/[Your Mac]/Desktop/\""
echo "  - Drag & drop       : directly into the Parallels window"
echo "  - SCP               : scp \"$ARCHIVE\" user@win-vm-ip:~/"
