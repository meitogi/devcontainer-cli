import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	projectCustomizations,
	readStitchuCustomizations,
	stripJsonComments,
} from '../src/lib/devcontainer-json.js'

test('strips // comments but keeps line count', () => {
	const source = '{\n  // a comment\n  "a": 1\n}\n'
	assert.equal(stripJsonComments(source).split('\n').length, source.split('\n').length)
	assert.deepEqual(JSON.parse(stripJsonComments(source)), { a: 1 })
})

test('a // inside a string survives — the sed the dispatcher uses does not', () => {
	const source = '{ "url": "https://example.com/x", "path": "C:\\\\a" }'
	assert.deepEqual(JSON.parse(stripJsonComments(source)), {
		url: 'https://example.com/x',
		path: 'C:\\a',
	})
})

test('an escaped quote does not end the string early', () => {
	const source = '{ "q": "say \\"hi\\" // not a comment" }'
	assert.deepEqual(JSON.parse(stripJsonComments(source)), { q: 'say "hi" // not a comment' })
})

function writeConfig(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'devc-json-'))
	const file = join(dir, 'devcontainer.json')
	writeFileSync(file, body, 'utf8')
	return file
}

test('reads customizations.stitchu-devc from a commented, trailing-comma file', () => {
	const file = writeConfig(`{
  // Project configuration reuses the native customizations slot.
  "customizations": {
    "stitchu-devc": {
      "disabledHooks": [],
      "allowLocalAtRebuild": true,
    },
  },
}
`)
	assert.deepEqual(readStitchuCustomizations(file), { disabledHooks: [], allowLocalAtRebuild: true })
})

test('a file with no customizations yields {} rather than throwing', () => {
	assert.deepEqual(readStitchuCustomizations(writeConfig('{ "name": "x" }')), {})
	assert.deepEqual(readStitchuCustomizations('/nonexistent/devcontainer.json'), {})
})

test('malformed JSON is tolerated — initialize must not die on a bad config', () => {
	assert.deepEqual(readStitchuCustomizations(writeConfig('{ not json')), {})
})

test('projects allowLocalAtRebuild as 1/0', () => {
	assert.deepEqual(projectCustomizations({ allowLocalAtRebuild: true }, {}), [
		{ key: 'FIREWALL_ALLOW_LOCAL_AT_REBUILD', value: '1' },
	])
	assert.deepEqual(projectCustomizations({ allowLocalAtRebuild: false }, {}), [
		{ key: 'FIREWALL_ALLOW_LOCAL_AT_REBUILD', value: '0' },
	])
})

test('a user override in .env wins over the team default', () => {
	assert.deepEqual(
		projectCustomizations({ allowLocalAtRebuild: true }, { FIREWALL_ALLOW_LOCAL_AT_REBUILD: '0' }),
		[],
	)
})

test('an absent customization projects nothing', () => {
	assert.deepEqual(projectCustomizations({}, {}), [])
	assert.deepEqual(projectCustomizations({ disabledHooks: [] }, {}), [])
})
