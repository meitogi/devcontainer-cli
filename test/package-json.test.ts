// The manifest edit is textual on purpose; every case below is a shape that a
// parse/stringify round-trip would have silently reformatted — or that the
// text edit must refuse rather than guess.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPackageJson } from '../src/lib/package-json.js'

const NAME = '@meitogi/devcontainer-cli'
const RANGE = '^0.1.0'

function inserted(existing: string): string {
	const plan = planPackageJson(existing, NAME, RANGE)
	assert.equal(plan.kind, 'insert', JSON.stringify(plan))
	const content = plan.kind === 'insert' ? plan.content : ''
	// Whatever the shape, the result must parse and carry the entry.
	const parsed = JSON.parse(content) as { devDependencies: Record<string, string> }
	assert.equal(parsed.devDependencies[NAME], RANGE)
	return content
}

test('creates a minimal private manifest when none exists', () => {
	const plan = planPackageJson(null, NAME, RANGE)
	assert.equal(plan.kind, 'create')
	const parsed = JSON.parse(plan.kind === 'create' ? plan.content : '') as Record<string, unknown>
	assert.deepEqual(parsed, { private: true, devDependencies: { [NAME]: RANGE } })
})

test('inserts into a non-empty block, keeping indentation and the rest byte for byte', () => {
	const existing = '{\n  "name": "x",\n  "devDependencies": {\n    "typescript": "^5"\n  }\n}\n'
	assert.equal(inserted(existing), `{\n  "name": "x",\n  "devDependencies": {\n    "${NAME}": "${RANGE}",\n    "typescript": "^5"\n  }\n}\n`)
})

test('opens an empty block', () => {
	assert.equal(inserted('{\n\t"devDependencies": {}\n}\n'), `{\n\t"devDependencies": {\n\t\t"${NAME}": "${RANGE}"\n\t}\n}\n`)
})

test('adds the block before the final brace, with the comma the previous property needs', () => {
	assert.equal(inserted('{\n  "name": "x"\n}\n'), `{\n  "name": "x",\n  "devDependencies": {\n    "${NAME}": "${RANGE}"\n  }\n}\n`)
	assert.equal(inserted('{\n  "name": "x"\n}'), `{\n  "name": "x",\n  "devDependencies": {\n    "${NAME}": "${RANGE}"\n  }\n}`, 'no final newline stays that way')
})

test('keeps CRLF line endings', () => {
	const content = inserted('{\r\n  "name": "x",\r\n  "devDependencies": {\r\n    "a": "1"\r\n  }\r\n}\r\n')
	assert.ok(!content.includes('\n'.repeat(1) + '    "' + NAME) || content.includes(`\r\n    "${NAME}"`))
	assert.ok(!/[^\r]\n/.test(content), 'no bare LF introduced')
})

test('reports an entry that is already there', () => {
	assert.deepEqual(planPackageJson(`{"devDependencies":{"${NAME}":"^0.0.1"}}`, NAME, RANGE), { kind: 'present' })
})

test('refuses what it cannot edit safely, with a reason', () => {
	const reasons = [
		planPackageJson('{ nope', NAME, RANGE),
		planPackageJson('[]', NAME, RANGE),
		planPackageJson('﻿{\n  "name": "x"\n}\n', NAME, RANGE),
		planPackageJson('{\n  "overrides": {\n    "devDependencies": {\n    }\n  }\n}\n', NAME, RANGE),
		planPackageJson('{"name":"x"}', NAME, RANGE),
	].map((plan) => (plan.kind === 'manual' ? plan.reason : plan.kind))
	assert.deepEqual(reasons, [
		'the file is not valid JSON',
		'the file is not a JSON object',
		'the file starts with a byte-order mark',
		'"devDependencies" is not a top-level key',
		'could not tell the indentation',
	])
})
