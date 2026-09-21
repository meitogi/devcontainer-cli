# post-create.d/ — lifecycle fragments for the post-create phase

Drop `NN-name.sh` scripts here to extend what runs during `post-create`.
Empty today — a fresh project needs nothing beyond what the base image
already runs; this directory is where a project adds its own.

## Header

Every fragment starts with a `#!/usr/bin/env bash` shebang and four
`#`-prefixed metadata lines `devc-hook` reads:

```bash
#!/usr/bin/env bash
# @name my-fragment
# @phase post-create
# @required false
# @description One line: what this does and why.
```

`@required true` means the phase aborts if the fragment exits non-zero, and
`../disabled.txt` refuses to disable it without an explicit `!` — see below.

## Order

Lexical `NN-` prefix, e.g. `10-first.sh`, `20-second.sh` — fragments run in
that order.

## Layers

Three `post-create.d/` directories are unioned, sorted together:

    /opt/devcontainer/base/hooks/post-create.d/   the image
    /opt/devcontainer/ext/hooks/post-create.d/    a Dockerfile that FROMs it
    .devcontainer/hooks/post-create.d/            this directory

## Disabling a fragment

List its full key (`post-create.d/<file>.sh`) in `../disabled.txt`. A
fragment marked `@required true` is refused there unless you prefix the key
with `!`:

    !post-create.d/20-something.sh

## Checking what would run

    devc-hook post-create --dry-run
