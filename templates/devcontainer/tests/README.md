# devcontainer-tools — integration tests

Minimal bash-based assertion suite for devcontainer behavior. Distinct
from `firewall/tests/` (which holds per-host connectivity probes consumed
by `init-firewall.sh` + `test-firewall.sh`).

## Layout

```
tests/
├── lib.sh                              # assertion helpers + run_tests runner
├── run.sh                              # discovers + runs each tier
├── unit/                               # static (anywhere, no rebuild needed)
│   └── test-bake-firewall.sh
├── integration/                        # runtime in-container, runs as `node`
│   ├── test-bake-firewall.sh
│   └── test-firewall-modes.sh
└── host/                               # runs FROM host via docker exec -u root
    └── test-firewall-iptables.sh
```

| Tier | Where it runs | Privilege | What it checks |
|---|---|---|---|
| **unit/** | Host or container, anytime | none | Repo invariants — file presence, syntax, gitignore structure, install.sh migration logic on a tmpdir |
| **integration/** | Inside a rebuilt devcontainer | `node` (no sudo on iptables — sudoers only allows init-firewall.sh / test-firewall.sh) | Runtime behavior observable as node — EROFS on `/etc/` writes, workspace decoupling, vector regression, behavioral firewall probes (curl) |
| **host/** | From the host machine (refuses to run in container) | root via `docker exec -u root` | Privileged checks node can't do — iptables rules, ipset contents, mitmproxy listen socket via `ss` |

## Running

```bash
bash tests/run.sh                       # default = unit + integration
bash tests/run.sh --unit                # only static (no container needed)
bash tests/run.sh --integration         # only runtime (in-container)
bash tests/run.sh --host                # only host-tier (run from HOST)
bash tests/run.sh tests/unit/test-bake-firewall.sh   # one file
bash tests/run.sh --pattern 'test-bake*'             # subset by glob
```

The `host/` tier is opt-in (not part of the default suite) because it
needs a different execution context — your host shell with `docker`
available, not the container. Each host script refuses to run inside a
container with a clear error.

Exit code : 0 = all pass, 1 = at least one failure (per-file pass/fail
breakdown printed at the end).

## Adding a new suite

1. Decide tier :
   - Static (file inspection, no Docker, no rebuild) → `unit/`.
   - Runtime as `node` (no sudo) → `integration/`.
   - Runtime needing root (iptables, ipset, sockets of other users) → `host/` ; the script must `in_container && exit 2` at the top.
2. Create `tests/<tier>/test-<feature>.sh`.
3. `source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"`.
4. Define `test_*` functions ; use the `assert_*` helpers in `lib.sh`.
5. End with `run_tests`.

Available assertions (see [lib.sh](lib.sh)) :

- `assert_true <cmd...> -- "label"` / `assert_false`
- `assert_eq <expected> <actual> "label"` / `assert_ne`
- `assert_file_exists` / `assert_file_missing` / `assert_dir_exists`
- `assert_contains <file> <substring> "label"` / `assert_not_contains`
- `assert_match <file> <ERE> "label"`
- `assert_eq_file_content <file> <expected-content> "label"` (whitespace-trimmed)
- `skip_test "reason"` — record skip, return cleanly.

Environment helpers :

- `in_container` — true inside any devcontainer.
- `repo_root` — walks up to find `.git` / `templates/v2` marker.

## Pre-ship checklist

Before merging a session that touches the devcontainer baseline :

1. `bash tests/run.sh --unit` (passes on host or container, fast).
2. Rebuild Container, then `bash tests/run.sh --integration` (zero skips
   expected for the session under test).
3. If the session touches multiple firewall modes, run the integration
   suite once per mode (off / basic / strict), rebuilding between modes.
4. Document any expected skip in the session log.
