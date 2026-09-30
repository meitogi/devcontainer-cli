// `initialize.sh` — the launcher `initializeCommand` names. It ships in THIS
// package (templates/devcontainer/initialize.sh) and lands in every scaffold, so
// these tests run against the real rendered artefact rather than the monorepo
// copy, and need no monorepo guard.
//
// Why a script at all, rather than the npx call inline in devcontainer.json:
// the hook runs under `/bin/sh -c` on Unix but `cmd.exe /c` on Windows
// (devcontainers/cli src/spec-node/utils.ts:560, hardcoded on process.platform),
// and `gitbash` is a supported host kind that stays win32. Only a bare command
// NAME resolves in both shells. Going straight to npx would also leave MSYSTEM
// unset, making detectHostKind() return `unknown` and refuse the host.
//
// Three properties: it execs the npx call npx-resolution.test.ts proves resolves
// locally against a dead registry; it runs from the project root whatever the
// caller's cwd; and with no usable Node it fails with a message, not a bash
// error — using only builtins to get there, because an external `dirname` on a
// broken PATH would exit 127 silently, the very failure this file prevents.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDevcontainerJson } from '../src/lib/devcontainer-json.js'
import { applyPlan, buildPlan } from '../src/lib/scaffold.js'
import { CLI_NAME, majorRange } from '../src/lib/version.js'

/** The npx call the shim must exec, built from the same source templateValues uses. */
const NPX_ARGV = ['--yes', `--package=${CLI_NAME}@${majorRange()}`, 'devc', 'initialize']

function scratch(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'devc-shim-'))
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Scaffold a real project and hand back its root — the shim is at .devcontainer/initialize.sh. */
function scaffold(projectDir: string): string {
	applyPlan({
		projectDir,
		plan: buildPlan({ projectId: 'demo-app', displayName: 'Demo App', stack: 'node', credsVolume: null, claudeCodeVersion: '2.1.272' }),
		dryRun: false,
	})
	return projectDir
}

/**
 * A PATH holding only npx and, optionally, a Node the shim accepts.
 *
 * Deliberately thin: the shim uses nothing but shell builtins until it has
 * resolved a Node, so there is no dirname/cat/tr to provide. A test that needed
 * them would be testing a regression.
 */
function pathWith(dir: string, fakeNpx: string | null, withNode = false): string {
	const bin = join(dir, 'bin')
	mkdirSync(bin, { recursive: true })
	if (fakeNpx !== null) {
		writeFileSync(join(bin, 'npx'), fakeNpx, 'utf8')
		chmodSync(join(bin, 'npx'), 0o755)
	}
	// Faked rather than inherited so the result does not depend on the machine
	// running the suite — and v99 so it beats whatever real Node the search list
	// finds under /usr/bin or /usr/local/bin. The shim picks the NEWEST it sees
	// and prefixes PATH with that one's directory; a lower fake would hand the
	// real npx the argv and the assertions would measure the wrong process.
	if (withNode) {
		writeFileSync(join(bin, 'node'), '#!/bin/sh\n[ "$1" = "--version" ] && { echo v99.0.0; exit 0; }\nexit 0\n', 'utf8')
		writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho 11.0.0\n', 'utf8')
		chmodSync(join(bin, 'node'), 0o755)
		chmodSync(join(bin, 'npm'), 0o755)
	}
	return bin
}

test('devcontainer.json names the shim, and the shim execs the npx call', () => {
	const { dir, cleanup } = scratch()
	try {
		const project = scaffold(join(dir, 'proj'))
		const value = readDevcontainerJson(join(project, '.devcontainer', 'devcontainer.json'))?.['initializeCommand']
		assert.equal(value, 'bash .devcontainer/initialize.sh')

		const shim = readFileSync(join(project, '.devcontainer', 'initialize.sh'), 'utf8')
		// The package is named once, at the top; the exec indirects through it.
		assert.match(shim, new RegExp(`^PKG=${CLI_NAME.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'))
		assert.match(shim, new RegExp(`^RANGE=${majorRange().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'))
		assert.match(shim, /^exec npx --yes --package="\$PKG@\$RANGE" devc initialize "\$@"$/m)
		assert.match(shim, /^set -eu$/m)
		// Builtin parameter expansion, not `$(dirname "$0")`: an external binary
		// here exits 127 with no message when the boot PATH is broken.
		assert.match(shim, /^case "\$0" in \*\/\*\) cd "\$\{0%\/\*\}\/\.\." ;; \*\) cd \.\. ;; esac$/m)
		// No external binary anywhere in the code — comments may name them.
		const code = shim.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
		for (const tool of ['dirname', 'basename', 'cut', 'sed', 'awk', 'grep', 'sort']) {
			assert.doesNotMatch(code, new RegExp(`\\b${tool}\\b`), `${tool} would exit 127 on a broken PATH`)
		}
	} finally {
		cleanup()
	}
})

test('run from anywhere, the shim hands npx the argv from the project root', () => {
	const { dir, cleanup } = scratch()
	try {
		const project = scaffold(join(dir, 'proj'))
		const log = join(dir, 'npx.log')
		const bin = pathWith(dir, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > "${log}"\n`, true)
		const run = spawnSync('/bin/bash', [join(project, '.devcontainer', 'initialize.sh'), '--dry-run'], {
			cwd: dir,
			encoding: 'utf8',
			env: { PATH: bin },
		})
		assert.equal(run.status, 0, run.stderr)
		assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [project, ...NPX_ARGV, '--dry-run'])
	} finally {
		cleanup()
	}
})

// The shim searches for a Node >= 18 (nvm/fnm/asdf/volta/homebrew layouts)
// because VS Code resolves the login shell environment only on macOS and Linux —
// never on Windows, and not for the WSL server. With none found it must stop,
// not guess.
//
// DEVC_NODE drives this deterministically. A PATH-only sandbox cannot: the
// search list carries absolute fallbacks (/usr/bin, /usr/local/bin, …) that any
// real machine satisfies, so the test would find a Node and die at `exec npx`
// with 127 instead of exercising the branch.
test('without a usable Node on the host, the shim exits 1 and says why', () => {
	const { dir, cleanup } = scratch()
	try {
		const project = scaffold(join(dir, 'proj'))
		const bin = pathWith(dir, null)
		const run = spawnSync('/bin/bash', ['.devcontainer/initialize.sh'], {
			cwd: project,
			encoding: 'utf8',
			env: { PATH: bin, DEVC_NODE: join(dir, 'no-such-node') },
		})
		assert.equal(run.status, 1)
		assert.match(run.stdout + run.stderr, /no node >= 18 found on this host/)
		// It names the three ways out rather than just refusing.
		assert.match(run.stdout + run.stderr, /code \./)
		assert.match(run.stdout + run.stderr, /DEVC_NODE=/)
	} finally {
		cleanup()
	}
})

// HOME is not guaranteed in the boot environment, and the shim runs under
// `set -u`. Regression: an unguarded $HOME in the search list aborted the whole
// step with `HOME: unbound variable` before any detection ran.
test('the shim survives an environment with no HOME', () => {
	const { dir, cleanup } = scratch()
	try {
		const project = scaffold(join(dir, 'proj'))
		const log = join(dir, 'npx.log')
		const bin = pathWith(dir, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > "${log}"\n`, true)
		const run = spawnSync('/bin/bash', ['.devcontainer/initialize.sh'], {
			cwd: project,
			encoding: 'utf8',
			env: { PATH: bin },
		})
		assert.equal(run.status, 0, run.stderr)
		assert.doesNotMatch(run.stderr, /unbound variable/)
	} finally {
		cleanup()
	}
})
