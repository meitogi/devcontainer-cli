# `policy.local.d/` — local advanced rules per host

This `.example/` directory is committed; the real `policy.local.d/` is **gitignored**.

## When to use

For per-host fine-grained rules that override `policy.d/` (committed) **without**
wiping the host's path list from `domains.txt`.

Use this when:
- A baseline body limit is too tight for your project (e.g. you POST 100 MB to
  `api.anthropic.com/v1/files`).
- You need a custom `endpoints:` schema for a new path.
- You want to opt out of a detection (`detect_internal_path_leak: false`) for
  one host without disabling it globally.

For **just adding hosts** (no advanced rules) or **disabling** existing ones,
use `domains.local.txt` (simpler, cf. `domains.local.txt.example`).

## How

1. `cp -r policy.local.d.example/ policy.local.d/`  (or just create the dir + files).
2. Drop `<host>.yaml` files matching hostnames present in `domains.txt` /
   `domains.local.txt`. The hostname is the bare form (no `*.`, no trailing slash).
3. Rebuild the devcontainer or re-run `init-firewall.sh`.

At boot, `compile-policy.py` deep-merges these files on top of `policy.d/` and
logs each override in `policy.compiled.yaml` under `runtime._overrides_applied`.

## Examples

See [api.anthropic.com.yaml](api.anthropic.com.yaml) for an endpoint body-limit
relax + extra detection opt-out.
