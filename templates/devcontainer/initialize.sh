#!/usr/bin/env bash
# Advanced node auto-detection, then hand over to `devc initialize`.
#
# devcontainer.json runs this under `/bin/sh -c` with no profile sourced. VS Code
# does resolve the login shell environment on macOS and Linux, so nvm is usually
# already visible there — but not under WSL, never on Windows, and not when that
# resolution times out. So we look for the newest node >= $MIN ourselves, in the
# directories version managers install into.
#
# Builtins only until a node is found: on a broken PATH an external `dirname` or
# `cut` would exit 127 with no message, which is the failure this file exists to
# prevent.
#
# DEVC_NODE=/path/to/node forces one interpreter and skips detection.
set -eu
case "$0" in */*) cd "${0%/*}/.." ;; *) cd .. ;; esac

MIN=18
: "${HOME:=/nonexistent}"   # set -u, and the boot environment does not always carry HOME

# Named once so the registry probe below and the exec agree, and so the copy
# this CLI ships differs from the monorepo one by these two lines alone.
PKG={{DEVC_PACKAGE}}
RANGE={{DEVC_RANGE}}

# "v20.11.1" -> 20011001, to compare without `sort -V` (absent from BSD sort).
vkey() { IFS=. read -r a b c <<EOF
${1#v}
EOF
  a="${a%%[!0-9]*}"; b="${b%%[!0-9]*}"; c="${c%%[!0-9]*}"
  echo $(( ${a:-0} * 1000000 + ${b:-0} * 1000 + ${c:-0} )); }

BEST=''; BEST_KEY=0; BEST_VER=''
consider() {
  [ -x "${1:-}" ] || return 0
  v="$("$1" --version 2>/dev/null)" || return 0
  case "$v" in v[0-9]*) ;; *) return 0 ;; esac
  k="$(vkey "$v")"
  [ "$k" -ge $(( MIN * 1000000 )) ] || return 0
  [ "$k" -gt "$BEST_KEY" ] || return 0
  BEST="$1"; BEST_KEY="$k"; BEST_VER="$v"
}

if [ -n "${DEVC_NODE:-}" ]; then
  consider "$DEVC_NODE"
else
  consider "$(command -v node 2>/dev/null || true)"
  PATH_OK="$BEST"   # non-empty when the boot PATH already carried a usable node
  for d in \
    "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin \
    "$HOME"/.fnm/node-versions/*/installation/bin \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin \
    "$HOME/Library/Application Support/fnm"/node-versions/*/installation/bin \
    "${ASDF_DATA_DIR:-$HOME/.asdf}"/installs/nodejs/*/bin \
    "${VOLTA_HOME:-$HOME/.volta}"/tools/image/node/*/bin \
    "$HOME"/.nodenv/versions/*/bin \
    "${N_PREFIX:-/usr/local}"/n/versions/node/*/bin \
    /opt/homebrew/bin /opt/homebrew/opt/node@*/bin \
    /usr/local/bin /usr/local/opt/node@*/bin \
    /opt/local/bin /snap/bin /usr/bin /bin
  do consider "$d/node"; done
fi

if [ -z "$BEST" ]; then
  echo "initialize.sh: no node >= $MIN found on this host." >&2
  echo "  Launch VS Code from a terminal (code .), install Node $MIN+ system-wide," >&2
  echo "  or set DEVC_NODE=/path/to/node." >&2
  exit 1
fi

case "$BEST" in */*) NODE_DIR="${BEST%/*}" ;; *) NODE_DIR=. ;; esac
case ":$PATH:" in *":$NODE_DIR:"*) ;; *) PATH="$NODE_DIR:$PATH"; export PATH ;; esac

# npm 6's npx cannot run a scoped package with a subcommand: it would take
# `initialize` for a package name and execute a stranger's code instead.
NPM_VER="$(npm --version 2>/dev/null || echo 0)"; NPM_MAJOR="${NPM_VER%%.*}"
case "$NPM_MAJOR" in ''|*[!0-9]*) NPM_MAJOR=0 ;; esac
if [ "$NPM_MAJOR" -lt 7 ]; then
  echo "initialize.sh: npm $NPM_VER is too old to launch the CLI (needs 7+)." >&2
  exit 1
fi

echo "initialize.sh: node $BEST_VER ($BEST)"
# When this line shows up, the boot PATH carried no usable node and detection is
# what saved the day — the only way to know it happened.
[ -n "${PATH_OK:-}" ] || echo "initialize.sh: boot PATH had no node — found by detection"

# npx prints nothing while it resolves, so say which path it is about to take.
# With the CLI as a root devDependency it runs that copy offline and returns at
# once; without one it downloads from the registry on EVERY window open, which
# is a silent multi-second gap right here with no progress of its own.
if [ -d "node_modules/$PKG" ]; then
  echo "initialize.sh: starting devc initialize (local copy, no download)"
else
  echo "initialize.sh: downloading $PKG@$RANGE from the npm registry — no progress is"
  echo "               shown, this is not a hang. It repeats every window open until the"
  echo "               CLI is a root devDependency:  npm i -D $PKG"
fi
exec npx --yes --package="$PKG@$RANGE" devc initialize "$@"
