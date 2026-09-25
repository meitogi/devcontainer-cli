// The substituter is twenty lines; what matters is the contract around it —
// strictness, and that every shipped template renders clean with the value
// set the wizard actually produces.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative as relativePath } from 'node:path'
import { placeholders, render, TemplateError } from '../src/lib/template.js'
import { TEMPLATES_DIR, templateValues } from '../src/lib/scaffold.js'
import { PACKAGE_ROOT } from '../src/lib/version.js'
import { VENDORED_NOTIFY_DIR } from '../src/lib/notify-daemon.js'

test('substitutes every occurrence of a key', () => {
	assert.equal(render('a {{X}} b {{X}} {{Y}}', { X: '1', Y: '2' }), 'a 1 b 1 2')
})

test('throws on a placeholder with no value, naming the template', () => {
	assert.throws(() => render('{{MISSING}}', {}, 'devcontainer.json'), (error: unknown) => {
		assert.ok(error instanceof TemplateError)
		assert.match(error.message, /devcontainer\.json: no value for \{\{MISSING\}\}/)
		return true
	})
})

test('leaves lowercase or Go-template braces alone', () => {
	// docker --format '{{.Name}}' and compose interpolation must survive.
	assert.equal(render("--format '{{.Name}}' ${DC_PROJECT:-x}", {}), "--format '{{.Name}}' ${DC_PROJECT:-x}")
})

test('placeholders() lists distinct keys in order', () => {
	assert.deepEqual(placeholders('{{B}} {{A}} {{B}}'), ['B', 'A'])
})

test('every shipped template renders with the wizard value set and leaves no placeholder', () => {
	const values = templateValues({
		projectId: 'demo',
		displayName: 'Demo',
		stack: 'php',
		credsVolume: null,
		claudeCodeVersion: '2.1.272',
	})
	const files = walk(TEMPLATES_DIR)
	assert.ok(files.length > 20, `expected the template tree, got ${files.length} files`)
	for (const file of files) {
		const rendered = render(readFileSync(file, 'utf8'), values, file)
		assert.doesNotMatch(rendered, /\{\{[A-Z_]+\}\}/, `${file} still carries a placeholder`)
	}
})

test('the templates use exactly the keys the wizard provides', () => {
	const provided = Object.keys(templateValues({ projectId: 'x', displayName: 'x', stack: 'node', credsVolume: null, claudeCodeVersion: '2.1.272' }))
	const used = new Set<string>()
	for (const file of walk(TEMPLATES_DIR)) for (const key of placeholders(readFileSync(file, 'utf8'))) used.add(key)
	assert.deepEqual([...used].sort(), ['DEVC_PACKAGE', 'DEVC_RANGE', 'PROJECT_DISPLAY_NAME', 'PROJECT_ID', 'PROJECT_STACK'])
	for (const key of used) assert.ok(provided.includes(key), `${key} is used but never provided`)
})

test('every template and vendored-daemon file is in the npm pack listing', () => {
	// npm drops files named .gitignore from tarballs without a word; this is
	// the guard that keeps the shipped tree equal to the checked-out one.
	//
	// notify/ rides the same guard for two entries npm can swallow just as
	// quietly: the nested package.json — 23 bytes that make `require()` work at
	// all, the package itself being "type": "module" — and vendor/senders/
	// claude-code.icns, the one binary in the tree.
	const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--silent'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
	assert.equal(packed.status, 0, packed.stderr)
	const listing = JSON.parse(packed.stdout) as { files: { path: string }[] }[]
	const shipped = new Set((listing[0]?.files ?? []).map((file) => file.path))
	for (const file of [...walk(TEMPLATES_DIR), ...walk(VENDORED_NOTIFY_DIR)]) {
		const relative = relativePath(PACKAGE_ROOT, file)
		assert.ok(shipped.has(relative), `${relative} is on disk but not in the tarball`)
	}
})

function walk(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		// npm strips .DS_Store from the tarball without a word, and the host is a
		// Mac: one Finder visit would redden a test that has nothing to do with it.
		if (name === '.DS_Store') continue
		const path = join(dir, name)
		if (statSync(path).isDirectory()) out.push(...walk(path))
		else out.push(path)
	}
	return out
}
