#!/usr/bin/env bash
#
# .devcontainer/host-helpers/docker-audit.sh — audit the project's
# devcontainer images for size, layer sharing, and disk waste.
#
# Run on the HOST (not in the container — needs the local docker daemon).
# Auto-detects which images to inspect by parsing .devcontainer/Dockerfile*
# and .devcontainer/docker-compose.yml. Missing tags are reported and skipped.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/layers"

rev_lines() { awk '{a[NR]=$0} END{for(i=NR;i>=1;i--) print a[i]}'; }

human() {
	awk -v b="${1:-0}" 'BEGIN{
		split("B KB MB GB TB", u, " "); i=1
		while (b >= 1024 && i < 5) { b /= 1024; i++ }
		if (i == 1) printf "%d %s", b, u[i]
		else if (b < 10) printf "%.2f %s", b, u[i]
		else printf "%.1f %s", b, u[i]
	}'
}

if ! docker info >/dev/null 2>&1; then
	echo "Docker daemon unreachable. Check that Docker is running on the host." >&2
	exit 1
fi

# --- 1. Auto-detect expected tags ---

DC_PROJECT="$(grep -E '^DC_PROJECT=' "$REPO_ROOT/.devcontainer/.env" 2>/dev/null \
	| head -1 | sed 's/^DC_PROJECT=//' | tr -d '"' || true)"
# The scaffolded default; .env above wins whenever it carries the key.
DEFAULT_PROJECT="{{PROJECT_ID}}"
DC_PROJECT="${DC_PROJECT:-$DEFAULT_PROJECT}"
COMPOSE_NAME="${DC_PROJECT}-claude-code"

# v3 pulls a PUBLISHED base image instead of building Dockerfile.base, so the
# parent is the pinned ARG, not the FROM of a local base Dockerfile.
BASE_PARENT="$(grep -E '^ARG BASE_IMAGE=' "$REPO_ROOT/.devcontainer/Dockerfile" 2>/dev/null \
	| head -1 | sed 's/^ARG BASE_IMAGE=//' || true)"

# ⚠ v3 PULLS a published base image and builds no local one, so the two
# expectations this array used to carry — a locally built base and the
# `uniclaudeproxy:local` bridge — can never resolve. Dropped.
#
# The cross-project section that used to follow this file (≈150 lines, "==
# Cross-project audit: claude-devcontainer-base ==") was dead for the same
# reason and has been removed rather than carried into every project: it
# compared layer prefixes of locally built base images, and under a published
# base there is no local base to compare against. Rewriting it for the
# published-image model is a separate piece of work nobody has asked for.
EXPECTED=(
	"$BASE_PARENT"
	"${COMPOSE_NAME}-app"
)

LOCAL_TAGS=()
MISSING=()
for tag in "${EXPECTED[@]}"; do
	[ -z "$tag" ] && continue
	if docker image inspect "$tag" >/dev/null 2>&1; then
		LOCAL_TAGS+=("$tag")
	else
		MISSING+=("$tag")
	fi
done

if [ "${#MISSING[@]}" -gt 0 ]; then
	echo "Tags missing locally (skipped):"
	printf '  - %s\n' "${MISSING[@]}"
	echo
fi

if [ "${#LOCAL_TAGS[@]}" -eq 0 ]; then
	echo "No devcontainer image found locally." >&2
	exit 1
fi

# --- 2. Per-image data: total size + DIFF_IDs + per-layer sizes ---

: >"$WORK/sizes.tsv"
: >"$WORK/layersize.tsv"

i=0
for tag in "${LOCAL_TAGS[@]}"; do
	total="$(docker image inspect --format '{{.Size}}' "$tag")"
	docker image inspect --format '{{range .RootFS.Layers}}{{.}}{{"\n"}}{{end}}' "$tag" \
		| grep -v '^$' >"$WORK/layers/$i.txt"
	count="$(wc -l <"$WORK/layers/$i.txt" | tr -d ' ')"
	printf '%s\t%s\t%s\n' "$tag" "$total" "$count" >>"$WORK/sizes.tsv"

	# Align history (top-down, Size>0) reversed with RootFS.Layers (bottom-up).
	docker history --no-trunc --human=false --format '{{.Size}}' "$tag" \
		| awk '$1+0 > 0' \
		| rev_lines >"$WORK/sizes_only.txt"
	paste "$WORK/layers/$i.txt" "$WORK/sizes_only.txt" >>"$WORK/layersize.tsv"

	i=$((i+1))
done

# Dedup DIFF_ID -> bytes (a given DIFF_ID has a stable size).
sort -u -k1,1 -t$'\t' "$WORK/layersize.tsv" >"$WORK/layersize_uniq.tsv"

# --- 3. Section: Sizes ---

echo "== Sizes =="
printf '%-50s  %10s  %7s\n' "TAG" "SIZE" "LAYERS"
sort -k2,2 -nr -t$'\t' "$WORK/sizes.tsv" | while IFS=$'\t' read -r tag bytes layers; do
	printf '%-50s  %10s  %7s\n' "$tag" "$(human "$bytes")" "$layers"
done
total_naive="$(awk -F'\t' '{s+=$2} END{print s+0}' "$WORK/sizes.tsv")"
printf '%-50s  %10s\n' "TOTAL (naive — sum of images)" "$(human "$total_naive")"
echo

# --- 4. Section: Layer-sharing matrix ---

echo "== Layer sharing =="
echo "(common prefix / total in the smaller — a full prefix means"
echo " the FROM chain still shares perfectly.)"
echo

n="${#LOCAL_TAGS[@]}"
printf '%-50s' ""
for ((j=0; j<n; j++)); do printf '%8s' "[$j]"; done
echo

for ((i=0; i<n; i++)); do
	label="${LOCAL_TAGS[$i]}"
	[ "${#label}" -gt 46 ] && label="${label:0:46}"
	printf '[%d] %-46s' "$i" "$label"
	for ((j=0; j<n; j++)); do
		if [ "$i" -eq "$j" ]; then
			# ASCII '-' (1 byte = 1 display column). The em-dash '—'
			# (3 bytes, 1 col) breaks printf '%Ns' alignment because
			# the spec pads by bytes, not by display width.
			printf '%8s' "-"
			continue
		fi
		prefix=0
		while IFS= read -r line_i && IFS= read -r line_j <&3; do
			[ "$line_i" = "$line_j" ] || break
			prefix=$((prefix+1))
		done <"$WORK/layers/$i.txt" 3<"$WORK/layers/$j.txt"
		ci="$(wc -l <"$WORK/layers/$i.txt" | tr -d ' ')"
		cj="$(wc -l <"$WORK/layers/$j.txt" | tr -d ' ')"
		smaller="$ci"
		[ "$cj" -lt "$smaller" ] && smaller="$cj"
		printf '%8s' "$prefix/$smaller"
	done
	echo
done
echo

# --- 5. Section: Waste ---

echo "== Waste =="
subset_disk="$(awk -F'\t' '{s+=$2} END{print s+0}' "$WORK/layersize_uniq.tsv")"
saved=$((total_naive - subset_disk))
[ "$saved" -lt 0 ] && saved=0
if [ "$total_naive" -gt 0 ]; then
	pct="$(awk -v s="$saved" -v t="$total_naive" 'BEGIN{printf "%.1f", (s/t)*100}')"
else
	pct="0.0"
fi
printf '  Sum of images              : %s\n' "$(human "$total_naive")"
printf '  Real disk (subset)         : %s\n' "$(human "$subset_disk")"
printf '  Saved via sharing          : %s (%s %%)\n' "$(human "$saved")" "$pct"

