# policy.d/ — L7 enforcement policy (strict mode only)

Drop `<host>.yaml` files here to declare the `endpoints` / `blocked_paths` /
`allowed_header_patterns` mitmproxy enforces at L7 for a host already
allowlisted in `../domains.txt` or `../domains.d/*.txt`. Empty today.

## When this applies

Only in `strict` mode. In `basic`, mitmproxy is off entirely and these files
are inert — see `../CLAUDE.md`'s mode table before assuming a policy here
does anything.

## Format

One YAML file per host, named `<host>.yaml`, declaring `endpoints`,
`blocked_paths` and `allowed_header_patterns` for that host.

## Committed vs local

This directory is committed — team-wide, reviewed. For a personal or
temporary policy, use `../policy.local.d/<host>.yaml` instead (gitignored) —
see `../CLAUDE.md` for the full strict-mode host addition flow.
