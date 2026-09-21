# Firewall — reading & inference rules

**Read this before drawing any conclusion about network access from the
files in this directory.** Nested `CLAUDE.md` — Claude Code auto-loads
it whenever it touches files under `.devcontainer/firewall/`.

## Mode gate — check first

```bash
cat .devcontainer/.configured-firewall-mode
# empty ⇒ read .devcontainer/firewall/default-mode
```

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
- **Never propose `/prepare-research`** — it's `strict`-only ; in
  `basic` it brings no added value.

## `strict` mode : path scopes DO apply

Read `policy.d/<host>.yaml` before proposing an external call. The
`endpoints` + `blocked_paths` + `allowed_header_patterns` are enforced
at L7 by mitmproxy addons. `blocked_path` 403s in `strict` are real.

Adding a new endpoint / host in `strict` :

- Personal / local : `firewall/domains.local.txt` (host) +
  `firewall/policy.local.d/<host>.yaml` (L7 endpoints), both gitignored.
- Team / permanent : `firewall/domains.txt` + `firewall/policy.d/<host>.yaml`,
  both committed. Standard PR + review.

## `/prepare-research` decision tree

The `/prepare-research` skill spawns a scoped research devcontainer.
Use it ONLY when :

1. Mode = `strict` AND
2. Genuine deep-scope work : third-party POST/DELETE integration,
   multi-host package evaluation, or clean isolated workspace to
   experiment without touching main state.

In `basic`, or for lighter needs in `strict`, prefer :

- **Route 2** — temp `firewall/domains.local.txt` addition (default when
  unsure, cheapest, revert-friendly).
- **Route 3** — permanent : `domains.local.txt` (personal) or
  `domains.txt` (team, committed).

See the skill file for the full 3-route matrix.

## Editing firewall config — don't fake-verify

Mid-session edits to `domains.txt` / `policy.d/*.yaml` DO NOT refresh
the running dnsmasq / ipset / mitmproxy. The runtime config in
`/var/run/devcontainer-firewall/` is root-owned and emitted only by
`init-firewall.sh` at container boot.

- Running `python3 compile-policy.py` as `node` either fails on
  `/var/run/` writes or recompiles into a file no daemon re-reads —
  it's a false signal.
- The only real verification path is **rebuilding the devcontainer**.
- Never claim « tested by recompile » without a rebuild.

See `knowledge/firewall.md` for the init flow and compile-policy modes.
