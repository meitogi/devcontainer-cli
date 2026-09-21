// The plan is data; these pin what the data is. A change to the scaffolded
// tree should have to touch the expected list below on purpose.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDevcontainerJson, readStitchuCustomizations } from '../src/lib/devcontainer-json.js'
import { readEnvFile } from '../src/lib/env-file.js'
import {
	appendGitignore,
	applyPlan,
	buildPlan,
	classifyTarget,
	diffPlan,
	OWNERSHIP,
	type ScaffoldAnswers,
} from '../src/lib/scaffold.js'

const ANSWERS: ScaffoldAnswers = {
	projectId: 'demo-app',
	displayName: 'Demo App',
	stack: 'node',
	credsVolume: null,
	claudeCodeVersion: '2.1.272',
}

/** The D15 tree, in full. */
const EXPECTED_FILES = [
	'.claude/settings.local.json',
	'.claude/settings.local.json.example',
	'.devcontainer/.dockerignore',
	'.devcontainer/.env',
	'.devcontainer/.env.example',
	'.devcontainer/.gitignore',
	'.devcontainer/Dockerfile',
	'.devcontainer/LESSONS.md',
	'.devcontainer/claude/CLAUDE-dev.md',
	'.devcontainer/claude/CLAUDE-project.md',
	'.devcontainer/devcontainer.json',
	'.devcontainer/docker-compose.yml',
	'.devcontainer/firewall/CLAUDE.md',
	'.devcontainer/firewall/default-mode',
	'.devcontainer/firewall/domains.d/README.md',
	'.devcontainer/firewall/domains.local.txt.example',
	'.devcontainer/firewall/domains.txt',
	'.devcontainer/firewall/policy.d/README.md',
	'.devcontainer/firewall/ports.txt',
	'.devcontainer/hooks/disabled.txt',
	'.devcontainer/hooks/on-create.d/README.md',
	'.devcontainer/hooks/post-create.d/README.md',
	'.devcontainer/hooks/post-start.d/README.md',
	'.devcontainer/skills/disabled.txt',
	'.devcontainer/vscode-settings.jsonc',
	'.devcontainer/zshrc.local.example',
]

function scratch(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'devc-scaffold-'))
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the plan is exactly the D15 tree', () => {
	const plan = buildPlan(ANSWERS)
	assert.deepEqual(
		plan.files.map((file) => file.path),
		EXPECTED_FILES,
	)
	assert.deepEqual(
		plan.symlinks.map((link) => `${link.path} -> ${link.target}`),
		[
			'LESSONS.md -> .devcontainer/LESSONS.md',
			'.claude/rules/mandatory.md -> ../../.devcontainer/claude/CLAUDE-dev.md',
			'.claude/rules/project.md -> ../../.devcontainer/claude/CLAUDE-project.md',
		],
	)
	assert.equal(plan.imageRef, 'ghcr.io/meitogi/devcontainer-sandbox:1.2.0-cc2.1.272')
})

test('every ownership entry names a file the plan produces', () => {
	const paths = new Set(buildPlan(ANSWERS).files.map((file) => file.path))
	for (const path in OWNERSHIP) assert.ok(paths.has(path), `${path} is in OWNERSHIP but not in the plan`)
})

test('devcontainer.json renders parseable, with the stitchu block and the npx initializeCommand', () => {
	const { dir, cleanup } = scratch()
	try {
		applyPlan({ projectDir: dir, plan: buildPlan(ANSWERS), dryRun: false })
		const file = join(dir, '.devcontainer', 'devcontainer.json')
		const parsed = readDevcontainerJson(file)
		assert.ok(parsed !== null)
		assert.equal(parsed['name'], 'Demo App — Claude Code Sandbox')
		assert.equal(parsed['initializeCommand'], 'npx --yes @meitogi/devcontainer-cli@0.x initialize')
		assert.deepEqual(readStitchuCustomizations(file), { disabledHooks: [] })
	} finally {
		cleanup()
	}
})

test('.env carries the answers live on their documented lines', () => {
	const plain = buildPlan(ANSWERS).files.find((file) => file.path === '.devcontainer/.env')?.content ?? ''
	assert.match(plain, /^DC_PROJECT=demo-app$/m)
	assert.match(plain, /^#CLAUDE_CREDS_VOLUME=claude-creds-shared$/m, 'private volume keeps the key commented')
	assert.match(plain, /^#BASE_IMAGE=/m, 'default line keeps BASE_IMAGE commented')
	assert.deepEqual(readEnvFile(join('/dev/null')), {})

	const shared = buildPlan({ ...ANSWERS, credsVolume: 'claude-creds-team', claudeCodeVersion: '2.1.220' })
	const env = shared.files.find((file) => file.path === '.devcontainer/.env')?.content ?? ''
	assert.match(env, /^CLAUDE_CREDS_VOLUME=claude-creds-team$/m)
	assert.match(env, /^BASE_IMAGE=ghcr\.io\/meitogi\/devcontainer-sandbox:1\.2\.0-cc2\.1\.220$/m)
	// The example itself stays a template of commented defaults.
	const example = shared.files.find((file) => file.path === '.devcontainer/.env.example')?.content ?? ''
	assert.match(example, /^#DC_PROJECT=demo-app$/m)
})

test('CLAUDE-project.md carries the stack, compose carries the project id', () => {
	const plan = buildPlan({ ...ANSWERS, stack: 'php' })
	const claude = plan.files.find((file) => file.path === '.devcontainer/claude/CLAUDE-project.md')?.content ?? ''
	assert.match(claude, /^\*\*Default stack\*\* : PHP\.$/m)
	const compose = plan.files.find((file) => file.path === '.devcontainer/docker-compose.yml')?.content ?? ''
	assert.match(compose, /^name: \$\{DC_PROJECT:-demo-app\}-claude-code$/m)
	const other = buildPlan({ ...ANSWERS, stack: 'other' }).files.find((file) => file.path === '.devcontainer/claude/CLAUDE-project.md')?.content ?? ''
	assert.match(other, /^\*\*Default stack\*\* : to be filled in\.$/m)
})

test('applyPlan writes the tree, and a second pass writes nothing', () => {
	const { dir, cleanup } = scratch()
	try {
		const plan = buildPlan(ANSWERS)
		const first = applyPlan({ projectDir: dir, plan, dryRun: false })
		assert.equal(first.written.length, EXPECTED_FILES.length + 3)
		assert.equal(first.gitignore, 'appended')
		assert.deepEqual(first.symlinkProblems, [])
		assert.equal(readlinkSync(join(dir, 'LESSONS.md')), '.devcontainer/LESSONS.md')
		assert.equal(readlinkSync(join(dir, '.claude', 'rules', 'project.md')), '../../.devcontainer/claude/CLAUDE-project.md')
		assert.equal(readFileSync(join(dir, '.devcontainer', 'firewall', 'default-mode'), 'utf8').trim(), 'strict')

		const before = snapshot(dir, plan.files.map((file) => file.path))
		const second = applyPlan({ projectDir: dir, plan, dryRun: false })
		assert.deepEqual(second.written, [])
		assert.equal(second.gitignore, 'unchanged')
		assert.deepEqual(snapshot(dir, plan.files.map((file) => file.path)), before)
		const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8')
		assert.equal(gitignore.split('\n').filter((line) => line === '# DevContainer (v3) — root-scope').length, 1)
	} finally {
		cleanup()
	}
})

test('applyPlan never overwrites, and dry-run writes nothing', () => {
	const { dir, cleanup } = scratch()
	try {
		const plan = buildPlan(ANSWERS)
		const dry = applyPlan({ projectDir: dir, plan, dryRun: true })
		assert.equal(dry.written.length, EXPECTED_FILES.length + 3)
		assert.ok(!existsSync(join(dir, '.devcontainer')))
		assert.ok(!existsSync(join(dir, '.gitignore')))

		mkdirSync(join(dir, '.devcontainer'), { recursive: true })
		writeFileSync(join(dir, '.devcontainer', '.env'), 'DC_PROJECT=mine\n', 'utf8')
		writeFileSync(join(dir, 'LESSONS.md'), 'a regular file\n', 'utf8')
		const result = applyPlan({ projectDir: dir, plan, dryRun: false })
		assert.equal(readFileSync(join(dir, '.devcontainer', '.env'), 'utf8'), 'DC_PROJECT=mine\n')
		assert.ok(result.kept.includes('.devcontainer/.env'))
		assert.ok(!lstatSync(join(dir, 'LESSONS.md')).isSymbolicLink())
		assert.equal(result.symlinkProblems.length, 1)
		assert.match(result.symlinkProblems[0] as string, /LESSONS\.md exists and is not a symlink/)
	} finally {
		cleanup()
	}
})

test('appendGitignore separates from existing content and repairs a missing newline', () => {
	const { dir, cleanup } = scratch()
	try {
		const file = join(dir, '.gitignore')
		writeFileSync(file, 'node_modules', 'utf8')
		assert.equal(appendGitignore(file, '# sentinel\nx\n', false), 'appended')
		assert.equal(readFileSync(file, 'utf8'), 'node_modules\n\n# sentinel\nx\n')
		assert.equal(appendGitignore(file, '# sentinel\nx\n', false), 'unchanged')
		// A v2 block from install.sh does not count as the v3 sentinel.
		writeFileSync(file, '# DevContainer (v2) — root-scope\n.claude/*\n', 'utf8')
		assert.equal(appendGitignore(file, '# DevContainer (v3) — root-scope\n.claude/*\n', false), 'appended')
	} finally {
		cleanup()
	}
})

test('diffPlan reports identical / differs / yours / missing', () => {
	const { dir, cleanup } = scratch()
	try {
		const plan = buildPlan(ANSWERS)
		applyPlan({ projectDir: dir, plan, dryRun: false })
		writeFileSync(join(dir, '.devcontainer', '.dockerignore'), 'edited\n', 'utf8')
		rmSync(join(dir, '.devcontainer', 'skills', 'disabled.txt'))
		const report = Object.fromEntries(diffPlan(dir, plan).map((file) => [file.path, file.status]))
		assert.equal(report['.devcontainer/docker-compose.yml'], 'identical')
		assert.equal(report['.devcontainer/.dockerignore'], 'differs')
		assert.equal(report['.devcontainer/Dockerfile'], 'yours')
		assert.equal(report['.devcontainer/.env'], 'yours')
		assert.equal(report['.devcontainer/skills/disabled.txt'], 'missing')
	} finally {
		cleanup()
	}
})

// === classifyTarget ==========================================================

test('classifyTarget: absent, empty, and freshly scaffolded', () => {
	const { dir, cleanup } = scratch()
	try {
		assert.deepEqual(classifyTarget(dir), { kind: 'absent' })
		mkdirSync(join(dir, '.devcontainer'))
		writeFileSync(join(dir, '.devcontainer', '.gitkeep'), '', 'utf8')
		assert.deepEqual(classifyTarget(dir), { kind: 'absent' })
		applyPlan({ projectDir: dir, plan: buildPlan(ANSWERS), dryRun: false })
		assert.deepEqual(classifyTarget(dir), { kind: 'same' })
		// Hand edits do not change the verdict.
		writeFileSync(join(dir, '.devcontainer', 'hooks', 'post-start.d', '50-mine.sh'), '#!/bin/sh\n', 'utf8')
		writeFileSync(join(dir, '.devcontainer', 'Dockerfile'), `${readFileSync(join(dir, '.devcontainer', 'Dockerfile'), 'utf8')}RUN apt-get install -y php\n`, 'utf8')
		assert.deepEqual(classifyTarget(dir), { kind: 'same' })
	} finally {
		cleanup()
	}
})

test('classifyTarget: install.sh trees are refused by their fingerprints, before anything else', () => {
	const { dir, cleanup } = scratch()
	try {
		const dc = join(dir, '.devcontainer')
		applyPlan({ projectDir: dir, plan: buildPlan(ANSWERS), dryRun: false })
		// A v3-looking tree with a v2 marker is still v2 to us.
		writeFileSync(join(dc, '.configured-setup'), '# Auto-generated by install.sh v2.1.0\nVERSION="2.1.0"\n', 'utf8')
		const v2 = classifyTarget(dir)
		assert.equal(v2.kind, 'different')
		assert.match(v2.kind === 'different' ? v2.found : '', /v2 layout made by install\.sh/)
		rmSync(join(dc, '.configured-setup'))
		writeFileSync(join(dc, 'Dockerfile.base'), 'FROM node\n', 'utf8')
		const base = classifyTarget(dir)
		assert.match(base.kind === 'different' ? base.found : '', /Dockerfile\.base/)
		rmSync(join(dc, 'Dockerfile.base'))
		writeFileSync(join(dc, '.configured-setup'), 'VERSION="1.3.0"\n', 'utf8')
		assert.match((classifyTarget(dir) as { found: string }).found, /v1 layout/)
	} finally {
		cleanup()
	}
})

test('classifyTarget: foreign, unparseable, nested and root-level configurations', () => {
	const { dir, cleanup } = scratch()
	try {
		const dc = join(dir, '.devcontainer')
		mkdirSync(dc)
		writeFileSync(join(dc, 'README'), 'x', 'utf8')
		assert.match((classifyTarget(dir) as { found: string }).found, /no devcontainer\.json/)
		writeFileSync(join(dc, 'devcontainer.json'), '{ "image": "mcr.microsoft.com/devcontainers/base" }\n', 'utf8')
		assert.match((classifyTarget(dir) as { found: string }).found, /without a customizations\.stitchu-devc block/)
		writeFileSync(join(dc, 'devcontainer.json'), '{ /* block */ "name": "x" }\n', 'utf8')
		assert.match((classifyTarget(dir) as { found: string }).found, /cannot parse/)
		writeFileSync(join(dc, 'devcontainer.json'), '{ "customizations": { "stitchu-devc": {} } }\n', 'utf8')
		assert.match((classifyTarget(dir) as { found: string }).found, /does not build on ghcr\.io\/meitogi\/devcontainer-sandbox/)
		mkdirSync(join(dc, 'alt'))
		writeFileSync(join(dc, 'alt', 'devcontainer.json'), '{}', 'utf8')
		assert.match((classifyTarget(dir) as { found: string }).found, /nested configurations/)
		rmSync(dc, { recursive: true })
		writeFileSync(join(dir, '.devcontainer.json'), '{}', 'utf8')
		assert.match((classifyTarget(dir) as { found: string }).found, /\.devcontainer\.json at the project root/)
	} finally {
		cleanup()
	}
})

function snapshot(dir: string, paths: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {}
	for (const path of paths) out[path] = readFileSync(join(dir, ...path.split('/')), 'utf8')
	return out
}
