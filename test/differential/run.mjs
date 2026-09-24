// Differential harness: bash initialize.sh vs devc initialize.
//
// The port claims zero behavioural regression on the observable artefacts —
// flag files, .env keys and values, logs/host-os. This proves it by running
// both implementations against two identical scratch copies of a
// .devcontainer tree and diffing the results.
//
// NO LONGER COVERED, deliberately: the base-image `docker build` argv and the
// BUILD_BASE_NO_CACHE consumption. The CLI dropped the local base build (the
// published GHCR image replaces it); bash keeps it until session 7 retires the
// script. The traces are compared minus those bash-only calls — see the
// scoping note at the comparison site.
//
// Two obstacles, both handled rather than waved away:
//
//   1. docker is unreachable from inside this devcontainer, and the bash script
//      cannot complete without it (`set -e` kills it when `docker build`
//      fails). So a stub `docker` goes first on PATH; it records every argv it
//      receives, which turns "did both call docker the same way" into an
//      assertion rather than a hope.
//   2. Both runs need stdin to not be a TTY. That is also the interesting path:
//      it is what CI and a VS Code rebuild actually hit.
//
// Usage: node test/differential/run.mjs [--keep]

import { spawnSync } from 'node:child_process'
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '../..')
const REPO_ROOT = resolve(PKG_ROOT, '../..')
const SOURCE_DEVCONTAINER = join(REPO_ROOT, '.devcontainer')
const DEVC = join(PKG_ROOT, 'bin', 'devc.mjs')

const keep = process.argv.includes('--keep')

// Runtime artefacts and heavy trees with no bearing on what initialize does.
// Copying the live .devcontainer whole would move hundreds of MB and drag in
// another session's queue state.
const SKIP_TOP = new Set([
	'logs',
	'node_modules',
	'research-bundles',
	'pending',
	'cache',
	'firewall-blocks',
	'.zsh-custom',
	'vscode-macos',
])

function seedScratch(root, name) {
	const dest = join(root, name, '.devcontainer')
	mkdirSync(dest, { recursive: true })
	cpSync(SOURCE_DEVCONTAINER, dest, {
		recursive: true,
		filter: (src) => {
			const rel = relative(SOURCE_DEVCONTAINER, src)
			if (rel === '') return true
			if (SKIP_TOP.has(rel.split('/')[0])) return false
			return !rel.startsWith('tmp/') && !rel.startsWith('notify/queue')
		},
	})
	// Remove the flag files so both implementations take the first-run path and
	// have to write them, and blank default-mode so the seeding branch runs too.
	// Both spellings: the bash original writes them at the root, the node port
	// under tmp/configured/.
	for (const flag of [
		'.configured-auth',
		'.configured-claude-mode',
		'.configured-firewall-mode',
		'tmp/configured/auth',
		'tmp/configured/claude-mode',
	]) {
		rmSync(join(dest, flag), { force: true })
	}
	writeFileSync(join(dest, 'firewall', 'default-mode'), '', 'utf8')
	return dest
}

/**
 * A fake `docker` that records its argv.
 *
 * `image inspect` succeeds so both implementations take the "image present"
 * branch; `ps` returns nothing so both conclude "no matching container", which
 * is the branch that then reaches `docker build`.
 *
 * mode 0o755 is passed to writeFileSync directly — chmod is blocklisted here.
 */
function writeDockerStub(binDir, tracePath) {
	mkdirSync(binDir, { recursive: true })
	const stub = `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(tracePath)}
if [ "$1" = "--version" ]; then echo "Docker version 00.0.0-stub, build stub"; fi
exit 0
`
	writeFileSync(join(binDir, 'docker'), stub, { encoding: 'utf8', mode: 0o755 })
}

/** Every file under `root`, minus the per-run log directory. */
function fileList(root) {
	const out = []
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const full = join(dir, entry.name)
			const rel = relative(root, full)
			if (rel === '.devcontainer/logs' || rel === '.devcontainer/tmp') continue
			if (entry.isDirectory()) walk(full)
			else out.push(rel)
		}
	}
	walk(root)
	return out.sort()
}

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

// --- run -------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'devc-diff-'))
const bashDir = seedScratch(root, 'bash-run')
const nodeDir = seedScratch(root, 'node-run')
const binDir = join(root, 'stub-bin')
const bashTrace = join(root, 'docker-argv-bash.txt')
const nodeTrace = join(root, 'docker-argv-node.txt')

const baseEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, DEBUG: '0' }
delete baseEnv.DEBUG_REBUILD_CONTEXT

writeDockerStub(binDir, bashTrace)
const bashResult = spawnSync('bash', [join(bashDir, 'initialize.sh')], {
	cwd: dirname(bashDir),
	env: baseEnv,
	encoding: 'utf8',
	stdio: ['pipe', 'pipe', 'pipe'],
})

writeDockerStub(binDir, nodeTrace)
const nodeResult = spawnSync(process.execPath, [DEVC, 'initialize', '--devcontainer-dir', nodeDir], {
	cwd: dirname(nodeDir),
	env: baseEnv,
	encoding: 'utf8',
	stdio: ['pipe', 'pipe', 'pipe'],
})

// --- compare ---------------------------------------------------------------

let failures = 0
const report = []

function check(name, expected, actual) {
	const ok = expected === actual
	if (!ok) failures++
	report.push(`${ok ? '  PASS' : '  FAIL'}  ${name}`)
	if (!ok) {
		report.push(`        bash: ${JSON.stringify(expected)}`)
		report.push(`        node: ${JSON.stringify(actual)}`)
	}
}

report.push('=== devc initialize — differential vs initialize.sh ===', '')

check('exit code', bashResult.status, nodeResult.status)
// The node port relocates machine state under tmp/ ; the bash original writes
// it at the .devcontainer root. Same value, two spellings — so each side is
// read where its own implementation puts it.
const RELOCATED = [
	['auth flag', '.configured-auth', 'tmp/configured/auth'],
	['claude-mode flag', '.configured-claude-mode', 'tmp/configured/claude-mode'],
	['firewall mode', 'firewall/default-mode', 'firewall/default-mode'],
	['logs/host-os', 'logs/host-os', 'tmp/logs/host-os'],
]
for (const [label, bashRel, nodeRel] of RELOCATED) {
	check(label, read(join(bashDir, bashRel)), read(join(nodeDir, nodeRel)))
}
check('.env byte for byte', read(join(bashDir, '.env')), read(join(nodeDir, '.env')))

// The docker-argv comparison is SCOPED since the CLI dropped the local base
// build: bash still runs `docker --version` / `image inspect` / `build`, the
// CLI never does — compose pulls the published base tag instead. Those calls
// are filtered from the bash side before comparing, so the check still proves
// the shared surface (the `ps -a` reopen probe, `volume create`) is identical,
// and the two explicit checks below keep the intentional divergence loud
// instead of silently shrinking coverage.
const BUILD_ONLY = /^(--version$|image inspect |build )/
const normaliseTrace = (path, { dropBuild = false } = {}) =>
	(read(path) ?? '')
		.split('\n')
		.filter(Boolean)
		.filter((line) => !(dropBuild && BUILD_ONLY.test(line)))
		.map((line) => line.split(root).join('<ROOT>').replace(/bash-run|node-run/g, '<RUN>'))
		.join('\n')
check('docker argv sequence (minus the bash-only base build)', normaliseTrace(bashTrace, { dropBuild: true }), normaliseTrace(nodeTrace))
check('bash still builds the base locally', true, /^build /m.test(read(bashTrace) ?? ''))
check('the CLI never invokes docker build', false, /^build /m.test(read(nodeTrace) ?? ''))

// The .vscode stub is created by the node run only, deliberately: it exists in
// the shipped template copies of initialize.sh but not in the dogfood one, and
// this command supersedes both.
const EXPECTED_NODE_ONLY = ['.vscode/settings.json']
// fileList skips .devcontainer/tmp, so the markers the node port relocated
// there stay visible only on the bash side. Their *content* is compared above.
const EXPECTED_BASH_ONLY = ['.devcontainer/.configured-auth', '.devcontainer/.configured-claude-mode']
const bashFiles = fileList(dirname(bashDir))
const nodeFiles = fileList(dirname(nodeDir))
check(
	'files only in the bash run',
	EXPECTED_BASH_ONLY.join(','),
	bashFiles.filter((f) => !nodeFiles.includes(f)).join(','),
)
check(
	'files only in the node run',
	EXPECTED_NODE_ONLY.join(','),
	nodeFiles.filter((f) => !bashFiles.includes(f)).join(','),
)

report.push('', `bash exit ${bashResult.status} · node exit ${nodeResult.status}`)
if (bashResult.status !== 0) {
	report.push('--- bash stderr (last 15) ---', bashResult.stderr.split('\n').slice(-15).join('\n'))
}
if (nodeResult.status !== 0) {
	report.push('--- node stderr (last 15) ---', nodeResult.stderr.split('\n').slice(-15).join('\n'))
}
report.push(`scratch: ${root}${keep ? ' (kept)' : ' (removed)'}`)

process.stdout.write(`${report.join('\n')}\n`)
process.stdout.write(failures === 0 ? '\nALL CHECKS PASS\n' : `\n${failures} CHECK(S) FAILED\n`)

if (!keep) rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
