// The compat shim — templates/v3/project/initialize.sh in the monorepo — is
// what lets a devcontainer.json that says `bash .devcontainer/initialize.sh`
// end up in this CLI's `initialize`. It ships there, not here (a scaffolded
// project calls npx from devcontainer.json directly), so this suite runs only
// beside the monorepo, like template-drift.test.ts.
//
// Three properties: its exec line is the scaffold's initializeCommand — the
// string npx-resolution.test.ts proves resolves locally against a dead
// registry; it runs from the project root whatever the caller's cwd; and
// without npx it fails with a message rather than a bash error.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDevcontainerJson } from '../src/lib/devcontainer-json.js'
import { applyPlan, buildPlan } from '../src/lib/scaffold.js'
import { PACKAGE_ROOT } from '../src/lib/version.js'

const SHIM = join(PACKAGE_ROOT, '..', '..', 'templates', 'v3', 'project', 'initialize.sh')
const skip = !existsSync(SHIM) && 'monorepo template not present'

function scratch(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'devc-shim-'))
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** The scaffold's own initializeCommand, rendered by the real plan. */
function scaffoldedInitializeCommand(dir: string): string {
	applyPlan({
		projectDir: dir,
		plan: buildPlan({ projectId: 'demo-app', displayName: 'Demo App', stack: 'node', credsVolume: null, claudeCodeVersion: '2.1.272' }),
		dryRun: false,
	})
	const value = readDevcontainerJson(join(dir, '.devcontainer', 'devcontainer.json'))?.['initializeCommand']
	assert.equal(typeof value, 'string')
	return value as string
}

/** A PATH holding only what the shim needs besides npx: dirname (and bash is invoked by absolute path). */
function pathWith(dir: string, fakeNpx: string | null, withNode = false): string {
	const bin = join(dir, 'bin')
	mkdirSync(bin, { recursive: true })
	const dirname = spawnSync('/bin/sh', ['-c', 'command -v dirname'], { encoding: 'utf8' }).stdout.trim()
	symlinkSync(dirname, join(bin, 'dirname'))
	// The shim also uses date/mkdir/uname for its host report. A real host has
	// them; symlink them rather than pretend a PATH that thin is realistic.
	for (const tool of ['date', 'mkdir', 'uname', 'cat', 'tr']) {
		const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
		if (found !== '') symlinkSync(found, join(bin, tool))
	}
	if (fakeNpx !== null) {
		writeFileSync(join(bin, 'npx'), fakeNpx, 'utf8')
		chmodSync(join(bin, 'npx'), 0o755)
	}
	// A Node the shim will accept, for the tests that exercise the happy path.
	// Faked rather than inherited so the result does not depend on the machine
	// running the suite.
	if (withNode) {
		writeFileSync(join(bin, 'node'), '#!/bin/sh\n[ "$1" = "--version" ] && { echo v24.0.0; exit 0; }\nexit 0\n', 'utf8')
		writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho 11.0.0\n', 'utf8')
		chmodSync(join(bin, 'node'), 0o755)
		chmodSync(join(bin, 'npm'), 0o755)
	}
	return bin
}

test('the shim execs exactly the scaffold\'s initializeCommand, plus the caller\'s arguments', { skip }, () => {
	const { dir, cleanup } = scratch()
	try {
		const shim = readFileSync(SHIM, 'utf8')
		const expected = scaffoldedInitializeCommand(join(dir, 'ref'))
		assert.match(shim, new RegExp(`^exec ${expected.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} "\\$@"$`, 'm'))
		assert.match(shim, /^set -eu$/m)
		assert.match(shim, /^cd "\$\(dirname "\$0"\)\/\.\."$/m)
	} finally {
		cleanup()
	}
})

test('run from anywhere, the shim hands npx the argv from the project root', { skip }, () => {
	const { dir, cleanup } = scratch()
	try {
		const project = join(dir, 'proj')
		mkdirSync(join(project, '.devcontainer'), { recursive: true })
		copyFileSync(SHIM, join(project, '.devcontainer', 'initialize.sh'))
		const log = join(dir, 'npx.log')
		const bin = pathWith(dir, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > "${log}"\n`, true)
		const run = spawnSync('/bin/bash', [join(project, '.devcontainer', 'initialize.sh'), '--dry-run'], {
			cwd: dir,
			encoding: 'utf8',
			env: { PATH: bin, DEVC_NODE_SEARCH: join(dir, 'no-node') },
		})
		assert.equal(run.status, 0, run.stderr)
		const expected = scaffoldedInitializeCommand(join(dir, 'ref'))
		assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [project, ...expected.split(' ').slice(1), '--dry-run'])
	} finally {
		cleanup()
	}
})

// The shim now searches for a Node >= 18 (nvm/fnm/asdf/volta/homebrew layouts)
// because initializeCommand runs under `/bin/sh -c` with no profile sourced, so a
// version manager is invisible here. With none found it must stop, not guess.
test('without a usable Node on the host, the shim exits 1 and says why', { skip }, () => {
	const { dir, cleanup } = scratch()
	try {
		const project = join(dir, 'proj')
		mkdirSync(join(project, '.devcontainer'), { recursive: true })
		copyFileSync(SHIM, join(project, '.devcontainer', 'initialize.sh'))
		const bin = pathWith(dir, null)
		const run = spawnSync('/bin/bash', ['.devcontainer/initialize.sh'], { cwd: project, encoding: 'utf8', env: { PATH: bin, DEVC_NODE_SEARCH: join(dir, 'no-node') } })
		assert.equal(run.status, 1)
		assert.match(run.stdout + run.stderr, /no Node >= 18 anywhere this step can see/)
		// It must not have asked a question it cannot receive an answer to.
		assert.match(run.stdout + run.stderr, /No terminal is attached/)
	} finally {
		cleanup()
	}
})
