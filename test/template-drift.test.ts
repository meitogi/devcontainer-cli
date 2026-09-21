// The CLI ships its own copy of the v3 project template, because a published
// package cannot reach into the monorepo. Two copies drift (session 4 saw it
// twice); this pins the byte-identical subset while both trees exist side by
// side. Skipped once the package lives in its own repository.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEMPLATES_DIR } from '../src/lib/scaffold.js'
import { PACKAGE_ROOT } from '../src/lib/version.js'

const MONOREPO_TEMPLATE = join(PACKAGE_ROOT, '..', '..', 'templates', 'v3', 'project')

/** Files that must stay byte-identical to templates/v3/project/. */
const SHARED = [
	'.dockerignore',
	'.env.example',
	'.gitignore',
	'Dockerfile',
	'docker-compose.yml',
	'vscode-settings.jsonc',
	'zshrc.local.example',
	'firewall/CLAUDE.md',
	'firewall/default-mode',
	'firewall/domains.local.txt.example',
	'firewall/domains.txt',
	'firewall/ports.txt',
	'hooks/disabled.txt',
	'skills/disabled.txt',
]

test('the shipped templates match templates/v3/project byte for byte', { skip: !existsSync(MONOREPO_TEMPLATE) && 'monorepo template not present' }, () => {
	for (const relative of SHARED) {
		// The template stores `.gitignore` as `_gitignore` so npm ships it.
		const ours = readFileSync(join(TEMPLATES_DIR, 'devcontainer', relative === '.gitignore' ? '_gitignore' : relative), 'utf8')
		const theirs = readFileSync(join(MONOREPO_TEMPLATE, relative), 'utf8')
		assert.equal(ours, theirs, `${relative} drifted from templates/v3/project`)
	}
})

test('devcontainer.json differs from the monorepo copy only by the initializeCommand block', { skip: !existsSync(MONOREPO_TEMPLATE) && 'monorepo template not present' }, () => {
	const ours = readFileSync(join(TEMPLATES_DIR, 'devcontainer', 'devcontainer.json'), 'utf8')
	const theirs = readFileSync(join(MONOREPO_TEMPLATE, 'devcontainer.json'), 'utf8')
	const strip = (text: string): string =>
		text
			.split('\n')
			.filter((line) => !line.includes('initializeCommand') && !/^\s*\/\/ /.test(line))
			.join('\n')
	assert.equal(strip(ours), strip(theirs))
})
