# Releasing

Maintainer documentation. If you only consume the package, you want
[README.md](README.md) instead — nothing here is needed to run `devc`.

## Steps

0. Two checks on what is about to ship.

   - **Re-copy `notify/` from the development tree.** The tarball's copy is the
     one every project runs, and this repo is not where the daemon is edited —
     the dogfood's `.devcontainer/notify/` is, which is why its `.env` pins
     `NOTIFY_DAEMON_DIR=notify`. Skipping this ships yesterday's daemon to
     everyone, which is the exact failure the vendoring removed: before it, a
     project ran a copy 20 days stale and nothing could say so.
     ```sh
     rm -rf notify
     rsync -a --exclude='.DS_Store' \
       ../../.devcontainer/notify/{index.js,package.json,lib,vendor} notify/
     git status --short notify/
     ```
     The `rm -rf` is the point, not carelessness: `rsync --delete` prunes inside
     the directories it recurses into but leaves anything stranded at the
     destination root, so a file the daemon dropped would ship forever. Nothing
     here is authored — the four entries above rebuild it whole.

     No output from `git status` is a valid answer: it means the daemon did not
     change since the last release. Four entries and nothing else — `tools/`
     resolves `__dirname/../../logs/` and would break from inside the npx cache,
     and `queue*/` is ~15 MB of runtime state.
   - **Check `templates/` for rollout jargon.** Internal phase/session labels
     ("Phase 3 A3", "Session 4") leak in from time to time and read as nonsense
     to a project that never saw the rollout:
     ```sh
     grep -rniE "phase [0-9]|session [0-9]|\bD[0-9]{1,2}\b" templates/
     ```
1. Bump `version` in `package.json` (every change to what ships in the tarball
   = a bump; a commit that changes only CI or maintainer docs does not).
   Use `npm version <v> --no-git-tag-version` rather than editing by hand — it
   updates `package-lock.json` too, and the lockfile carries the version in
   **two** places.
2. Commit the bump and push it to `main`.
3. Rehearse from CI: run the
   [publish workflow](.github/workflows/publish.yml) with
   `workflow_dispatch` and `dry_run=true`. Read the file listing in the log.
4. Tag `v<version>` and push the tag. CI then **stages** the version.
5. Review the staged tarball and approve it with 2FA. That is the release.

```sh
npm version 0.1.2 --no-git-tag-version
git commit -am "release: @meitogi/devcontainer-cli 0.1.2"
git push origin main
gh workflow run publish.yml -f dry_run=true && gh run watch
git tag -a v0.1.2 -m "@meitogi/devcontainer-cli 0.1.2" && git push origin v0.1.2
```

## Staging, and why the tag is not the point of no return

This workflow runs `npm stage publish`, never `npm publish`. A staged version
sits in npm's staging area and is **not installable** — `npm view` keeps
reporting the previous version until someone approves it.

```sh
npm stage list @meitogi/devcontainer-cli
npm stage view <stage-id>
npm stage download <stage-id>
npm stage approve <stage-id>
npm stage reject <stage-id>
```

`approve` prompts for 2FA, whether you run it in the CLI or click Approve in
the **Staged Packages** tab on npmjs.com. `reject` throws the staged version
away, and you can stage the same version again afterwards.

That asymmetry is the whole point. A published version is permanent: `npm
unpublish` works for 72 hours, and after that the number is burned and the next
fix has to take a new one. A staged version costs nothing to discard. So the
irreversible gesture is the approval, made by a human looking at the tarball —
not a `git push` of a tag.

`npm stage download` is worth actually using before approving. It hands you the
exact bytes CI built, which is the only way to check the tarball rather than
the repository.

The workflow's `guard` job **fails on purpose** if the pushed tag is not
`v<package.json version>`. Bumping the manifest and tagging are one gesture,
not two.

`workflow_dispatch` skips the tag check (`if: github.ref_type == 'tag'` is
false). Useful for rehearsing and for replaying a failed run; not a way to cut
a release.

## Verifying a release

After approval:

```sh
npm view @meitogi/devcontainer-cli version dist.fileCount dist.shasum \
  repository.url dist.attestations.provenance.predicateType
```

`dist.attestations.provenance.predicateType` must print
`https://slsa.dev/provenance/v1`. If it comes back undefined, provenance did
not attach — check that the repository is still public and that
`repository.url` matches it exactly.

Then the cold consumer path, which is what the scaffolded `initializeCommand`
actually does:

```sh
cd "$(mktemp -d)" && git init -q
npx --yes @meitogi/devcontainer-cli@<version> --version
npm i --no-save @meitogi/devcontainer-cli@<version> && npm audit signatures
```

## The npm credential

There is none, and that is the design. Publishing uses **npm Trusted
Publishing**: the workflow mints a short-lived OIDC token, npm exchanges it for
a publish credential, and nothing long-lived is stored in this repository.
Provenance attestations are generated automatically as a consequence — no
`--provenance` flag needed.

**The workflow's filename is load-bearing.** The trust relationship is
configured on npmjs.com (package → Settings → Trusted publishing) against the
owner, the repository name, *and the literal string `publish.yml`*. npm does
not validate that configuration when you save it, so a rename — or a typo in
the form — surfaces only at publish time, as an `E404` that looks like a
missing package rather than a refused credential. **If you rename this file,
change the npm side first.**

Two more traps in that form, both of which cost a red run to discover:

- the *Organization or user* field takes `meitogi`, **not** `@meitogi`;
- *Allowed actions* deliberately leaves **`npm publish` unticked**. `npm stage
  publish` is always allowed, so the workflow needs nothing here — and leaving
  it unticked is what guarantees CI cannot put a version live on its own. npm's
  own UI recommends this, and it is the reason the release gesture ends in a
  2FA approval rather than in a tag push.

Requirements, for when the pinned versions are bumped: trusted publishing needs
**npm ≥ 11.5.1 and Node ≥ 22.14.0**. The workflow pins `node-version: '24'`
precisely because Node 24 bundles npm 11.19.0. Never replace that with
`node-version-file: package.json`: `setup-node` would read `engines.node`
(`>=18`), install a Node whose bundled npm predates OIDC entirely, and the
publish would fail in a way that points nowhere near the cause.

### Publishing by hand, if CI is unavailable

From a clean checkout of the tag, as a maintainer with 2FA:

```sh
npm ci && npm publish --otp=<6-digit code>
```

Note what this skips: it publishes directly, with no staging and no second
look, and the tarball is built on your machine rather than on a clean runner —
so it carries no provenance attestation. It is the break-glass route, not a
shortcut. Prefer re-running the workflow.

`npm publish` alone will answer `403 … Two-factor authentication or granular
access token with bypass 2fa enabled is required` — that is a refusal *before*
any write, not a broken account. The OTP expires in about 30 seconds: type the
command first, read the code, then press Enter. This route stays open unless
someone ticks "Require two-factor authentication and disallow tokens" in the
package's publishing-access settings.

## Why the tests run twice

`npm test` is an explicit workflow step **and** the body of `prepublishOnly`.
That is not an oversight.

The explicit step gives a named, readable failure before npm has touched the
registry at all. `prepublishOnly` is the invariant that survives someone
editing the workflow, or publishing by hand from a laptop — and it is the only
reason it is safe for `dist/` to be gitignored, since a fresh clone has no
build output and the tarball ships `dist/src/`.

Do not "optimise" either one away. The obvious saving —
`npm publish --ignore-scripts` after the explicit test — trades a structural
guarantee for about a minute.

## Things not to tidy

- **`scripts.test` leaves `dist/test/*.test.js` unquoted on purpose.** The glob
  is expanded by the shell npm runs the script body in. Quoting it hands
  expansion to Node's own glob support, which only exists from Node 22 — so the
  suite would silently stop running for anyone on the Node 18 that
  `engines.node` advertises.
- **`test/template-drift.test.ts` skips here, and should.** It compares the
  shipped template against the copy in the monorepo this package was extracted
  from; outside that tree the path does not resolve and both tests report
  `skip`. Keep the `existsSync` guard rather than deleting the file — it wakes
  up on its own if the two trees are ever side by side again, which is exactly
  when drift happens.
- **`templates/devcontainer/_gitignore` and `templates/root/gitignore-root` are
  misspelled deliberately.** npm unconditionally drops files named
  `.gitignore` from a tarball. `test/template.test.ts` asserts every template
  file appears in the `npm pack` listing, which is what keeps that true.
