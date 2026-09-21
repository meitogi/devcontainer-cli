# Releasing

Maintainer documentation. If you only consume the package, you want
[README.md](README.md) instead — nothing here is needed to run `devc`.

## Steps

1. Bump `version` in `package.json` (every change to what ships in the tarball
   = a bump; a commit that changes only CI or maintainer docs does not).
   Use `npm version <v> --no-git-tag-version` rather than editing by hand — it
   updates `package-lock.json` too, and the lockfile carries the version in
   **two** places.
2. Commit the bump and push it to `main`.
3. Rehearse from CI: run the
   [publish workflow](.github/workflows/publish.yml) with
   `workflow_dispatch` and `dry_run=true`. Read the file listing in the log.
4. Tag `v<version>` and push the tag. That is the release.

```sh
npm version 0.1.2 --no-git-tag-version
git commit -am "release: @meitogi/devcontainer-cli 0.1.2"
git push origin main
gh workflow run publish.yml -f dry_run=true && gh run watch
git tag -a v0.1.2 -m "@meitogi/devcontainer-cli 0.1.2" && git push origin v0.1.2
```

The workflow's `guard` job **fails on purpose** if the pushed tag is not
`v<package.json version>`. Bumping the manifest and tagging are one gesture,
not two.

`workflow_dispatch` skips the tag check (`if: github.ref_type == 'tag'` is
false). Useful for rehearsing and for replaying a failed run; not a way to cut
a release.

## Verifying a release

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
- *Allowed actions* must have **`npm publish`** ticked. Configurations created
  after 2026-09-03 default to `npm stage publish` only, and the workflow's
  plain `npm publish` is then refused.

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
