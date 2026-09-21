// The initializeCommand the scaffold writes is `npx --yes <pkg>@<major>.x
// initialize`. This proves the property it relies on: with the package
// installed locally, npx runs that copy without touching the registry. The
// registry is pointed at a closed port, so any resolution attempt fails loudly.
//
// Slow (a pack and an install from a tarball, ~5-10 s); skipped when npm is
// not on PATH.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLI_NAME, CLI_VERSION, majorRange, PACKAGE_ROOT } from '../src/lib/version.js'

const npm = spawnSync('npm', ['--version'], { encoding: 'utf8' })
const hasNpm = npm.status === 0

const DEAD_REGISTRY = 'http://127.0.0.1:9/'

// `npm publish --dry-run` runs this suite through prepublishOnly with
// npm_config_dry_run=true exported, and children inherit it: `npm pack` then
// exits 0 having written no tarball, and `npm install` installs nothing. Every
// npm the test spawns gets it scrubbed.
const ENV = { ...process.env }
delete ENV.npm_config_dry_run

test('npx resolves the locally installed copy with no registry access', { skip: !hasNpm && 'npm not on PATH' }, () => {
	const work = mkdtempSync(join(tmpdir(), 'devc-npx-'))
	try {
		const packed = spawnSync('npm', ['pack', '--pack-destination', work, '--silent'], { cwd: PACKAGE_ROOT, encoding: 'utf8', env: ENV })
		assert.equal(packed.status, 0, packed.stderr)
		const tarball = readdirSync(work).find((name) => name.endsWith('.tgz'))
		assert.ok(tarball !== undefined)

		const project = join(work, 'project')
		writeFileSync(join(work, 'package.json'), '{ "private": true }\n', 'utf8')
		const install = spawnSync(
			'npm',
			['install', '--save-dev', '--no-audit', '--no-fund', '--ignore-scripts', `--registry=${DEAD_REGISTRY}`, join(work, tarball)],
			{ cwd: work, encoding: 'utf8', env: ENV },
		)
		assert.equal(install.status, 0, install.stderr)
		void project

		const run = spawnSync('npx', ['--yes', `--registry=${DEAD_REGISTRY}`, `${CLI_NAME}@${majorRange()}`, '--version'], {
			cwd: work,
			encoding: 'utf8',
			env: { ...ENV, npm_config_registry: DEAD_REGISTRY },
		})
		assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
		assert.equal(run.stdout.trim(), CLI_VERSION)
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
})
