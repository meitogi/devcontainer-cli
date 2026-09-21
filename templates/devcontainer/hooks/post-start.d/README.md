# post-start.d/ — lifecycle fragments for the post-start phase

Drop `NN-name.sh` scripts here to extend what runs on every `post-start`
(every container start, not just the first). Empty today — a fresh project
needs nothing beyond what the base image already runs (firewall bring-up,
credentials sync); this directory is where a project adds its own.

## Header

Every fragment starts with a `#!/usr/bin/env bash` shebang and four
`#`-prefixed metadata lines `devc-hook` reads:

```bash
#!/usr/bin/env bash
# @name my-fragment
# @phase post-start
# @required false
# @description One line: what this does and why.
```

`@required true` means the phase aborts if the fragment exits non-zero, and
`../disabled.txt` refuses to disable it without an explicit `!` — see below.
The base image's own `@required true` fragments (firewall re-init,
credentials sync) live in the image layer, not here.

## Order

Lexical `NN-` prefix, e.g. `10-first.sh`, `20-second.sh` — fragments run in
that order.

## Layers

Three `post-start.d/` directories are unioned, sorted together:

    /opt/devcontainer/base/hooks/post-start.d/   the image
    /opt/devcontainer/ext/hooks/post-start.d/    a Dockerfile that FROMs it
    .devcontainer/hooks/post-start.d/            this directory

## Disabling a fragment

List its full key (`post-start.d/<file>.sh`) in `../disabled.txt`. A
fragment marked `@required true` is refused there unless you prefix the key
with `!`:

    !post-start.d/20-something.sh

## Checking what would run

    devc-hook post-start --dry-run
