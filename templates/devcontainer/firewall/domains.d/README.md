# domains.d/ — per-ecosystem project dependencies

Drop `<eco>.txt` files here (e.g. `npm.txt`, `composer.txt`) instead of
growing `../domains.txt` — same 5-format syntax, one ecosystem per file.
Empty today; typically populated by `extract-auto-dependencies` or the
`/scan-deps` skill.

## Format

Same as `../domains.txt`: bare host, `[METHOD] host`, indented paths
(exactly 2 spaces, tab or 1/3+ spaces is a parse error), `METHOD host/path`,
and wildcards. See `../domains.txt`'s own header for the full syntax
reference.

## Merge

`compile-policy.py` walks `domains.d/*.txt` alphabetically and merges
additively with `../domains.txt` and the base image's own `00-base.txt`:
same-host entries across files get their methods unioned and their paths
concatenated.

## Path scopes and mode

A host declared here is reachable in **both** `basic` and `strict` mode. The
path scopes (the indented lines under a host) are **only enforced in
`strict`** — see `../CLAUDE.md`. In `basic`, an allowlisted host accepts
every path regardless of what's declared here.

## Committed vs local

This directory is committed — team-wide, reviewed. For a personal or
temporary addition, use `../domains.local.txt` instead (gitignored).
