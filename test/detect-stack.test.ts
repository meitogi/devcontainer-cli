import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyStack, detectStack, inspectProject, isStackId, STACKS, stackInfo } from '../src/lib/detect-stack.js'

test('manifests win over the histogram, most specific first', () => {
	assert.equal(classifyStack(['package.json', 'capacitor.config.ts'], []).stack, 'android-capacitor')
	assert.equal(classifyStack(['package.json', 'composer.json'], [{ ext: 'js', count: 100 }]).stack, 'php')
	assert.equal(classifyStack(['build.gradle.kts'], []).stack, 'android')
	assert.deepEqual(classifyStack(['Cargo.toml'], [{ ext: 'rs', count: 38 }]), { stack: 'rust', evidence: ['Cargo.toml', '38 .rs files'] })
	assert.equal(classifyStack(['package.json'], []).stack, 'node')
})

test('the histogram decides when no manifest does', () => {
	assert.deepEqual(classifyStack(['README.md'], [{ ext: 'md', count: 3 }, { ext: 'py', count: 2 }]), {
		stack: 'python',
		evidence: ['2 .py files'],
	})
	assert.deepEqual(classifyStack([], []), { stack: 'other', evidence: [] })
	assert.equal(classifyStack([], [{ ext: 'kt', count: 1 }]).evidence[0], '1 .kt file')
})

test('inspectProject reads root manifests and a pruned, depth-bounded histogram', () => {
	const dir = mkdtempSync(join(tmpdir(), 'devc-detect-'))
	try {
		writeFileSync(join(dir, 'Cargo.toml'), '', 'utf8')
		mkdirSync(join(dir, 'src', 'a', 'b', 'c'), { recursive: true })
		writeFileSync(join(dir, 'src', 'main.rs'), '', 'utf8')
		writeFileSync(join(dir, 'src', 'a', 'x.rs'), '', 'utf8')
		// Root, src/, src/a/ are the three levels; src/a/b/ is beyond the bound.
		writeFileSync(join(dir, 'src', 'a', 'b', 'too-deep.rs'), '', 'utf8')
		mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
		writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '', 'utf8')
		writeFileSync(join(dir, 'Makefile'), '', 'utf8')
		const { manifests, histogram } = inspectProject(dir)
		assert.deepEqual(manifests.sort(), ['Cargo.toml', 'Makefile'])
		assert.deepEqual(histogram, [
			{ ext: 'rs', count: 2 },
			{ ext: 'toml', count: 1 },
		])
		assert.equal(detectStack(dir).stack, 'rust')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('stack ids and docs', () => {
	assert.ok(isStackId('android-capacitor'))
	assert.ok(!isStackId('cobol'))
	assert.equal(stackInfo('php').doc, 'stacks/php.md')
	assert.equal(stackInfo('node').doc, null)
	assert.equal(STACKS[0]?.id, 'node')
	assert.equal(STACKS[STACKS.length - 1]?.id, 'other')
})
