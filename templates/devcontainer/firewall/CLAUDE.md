# Firewall — reading & inference rules

**Read this before drawing any conclusion about network access from the
files in this directory.** Nested `CLAUDE.md` — Claude Code auto-loads
it whenever it touches files under `.devcontainer/firewall/`.

## Mode gate — check first

```bash
cat /etc/devcontainer-firewall/default-mode   # the mode actually in force
cat .devcontainer/firewall/default-mode       # what the next rebuild will apply
```

The two disagree when the mode was changed since the last rebuild — the baked
copy wins, because `firewall/` is COPYed into the image at build time. Change it
with `npx devc firewall-mode <off|basic|strict>` (no argument reports it), then
rebuild. `.configured-firewall-mode` is a v2 file : if a tree still carries one,
nothing reads it.

Modes :

| Mode | DNS + ipset | L7 mitmproxy | Path scopes enforced ? |
|---|---|---|---|
| `strict` (default design intent) | ✅ | ✅ | ✅ yes — via `policy.d/*.yaml` |
| `basic` (escape hatch) | ✅ | ❌ **off** | ❌ **no — host granularity only** |
| `off` (kill-switch) | ❌ | ❌ | — |

## `basic` mode : host-level only — DO NOT MIS-READ

**In `basic`, an allowlisted HOST accepts ALL PATHS.** The path scopes
declared in `domains.txt`, `domains.d/*.txt`, and `policy.d/*.yaml`
**only apply in `strict`**.

Reading `[GET] github.com /anthropics/*` in `domains.txt` and concluding
« `github.com/torvalds/…` is blocked » is a **false inference in
`basic`** — the L7 mitmproxy layer is off ; only DNS + ipset apply, and
those match at host granularity.

Common misreads to avoid in `basic` :

- `github.com` scoped to `/anthropics/*` → in basic, every path under
  `github.com` works (torvalds, vitejs, anyone).
- `*.githubusercontent.com` scoped to `/anthropics/*` +
  `/blunt1337/wtfcmd/*` → in basic, ALL raw / avatars / release URLs
  work.
- `api.github.com` scoped to `/repos/anthropics/*` → in basic, any
  `/repos/<owner>/<repo>` works.

**In `basic` :**

- Allowlisted host = every path OK. Just try the call.
- Only DNS / ipset failures indicate a real block (fails loudly).
- New host needed ? → default to a temporary
  `firewall/domains.local.txt` addition (gitignored, revert-friendly).

## `strict` mode : path scopes DO apply

Read `policy.d/<host>.yaml` before proposing an external call. The
`endpoints` + `blocked_paths` + `allowed_header_patterns` are enforced
at L7 by mitmproxy addons. `blocked_path` 403s in `strict` are real.

Adding a new endpoint / host in `strict` :

- Personal / local : `firewall/domains.local.txt` (host) +
  `firewall/policy.local.d/<host>.yaml` (L7 endpoints), both gitignored.
- Team / permanent : `firewall/domains.txt` + `firewall/policy.d/<host>.yaml`,
  both committed. Standard PR + review.

## A new host, in either mode

Two routes, and the cheapest is the default :

- **Personal / temporary** — `firewall/domains.local.txt` (+
  `firewall/policy.local.d/<host>.yaml` in `strict`). Gitignored,
  revert-friendly, and only baked into the image when
  `FIREWALL_ALLOW_LOCAL_AT_REBUILD=1`.
- **Team / permanent** — `firewall/domains.txt` (+
  `firewall/policy.d/<host>.yaml`). Committed, standard PR + review.

A scoped research sibling used to be a third route, through a
`/prepare-research` skill. No image line ships it any more, so there is
nothing to propose — widening the allowlist on one of the two routes above
is the whole decision.

## Editing firewall config — don't fake-verify

Mid-session edits to `domains.txt` / `policy.d/*.yaml` DO NOT refresh
the running dnsmasq / ipset / mitmproxy. The runtime config in
`/var/run/devcontainer-firewall/` is root-owned and emitted only by
`init-firewall.sh` at container boot.

- Running `python3 compile-policy.py` as `node` either fails on
  `/var/run/` writes or recompiles into a file no daemon re-reads —
  it's a false signal.
- The local layer (`domains.local.txt`, `policy.local.d/`) can be
  hot-reloaded in `basic` and `strict` : `reload-firewall --dry-run`
  shows the diff, then the user applies it from the host with
  `wtf firewall reload`. Never apply it yourself — see
  `/opt/devcontainer/base/knowledge/firewall-reload-local.md`.
- Committed sources (`domains.txt`, `domains.d/`, `policy.d/`) are read
  from the baked copy : the only real verification path for those is
  **rebuilding the devcontainer**.
- Never claim « tested by recompile » without a reload or a rebuild.

See `/opt/devcontainer/base/knowledge/firewall.md` for the init flow and
compile-policy modes. A v3 tree carries no `.devcontainer/knowledge/` — the
base image ships those seven sheets.
