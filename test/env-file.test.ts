// The .env editor is the module most likely to cause silent damage: the file
// it edits is 90% comments, is read by docker-compose, and used to be `source`d
// by bash. Every test here is a property the bash line editor had.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySet, applyUncomment, applyUnset, hasKey, readEnvFile } from '../src/lib/env-file.js'

test('appends a new key with a trailing newline', () => {
	assert.equal(applySet('FOO=1\n', 'BAR', '2'), 'FOO=1\nBAR=2\n')
})

test('appends into an empty file without a leading blank line', () => {
	assert.equal(applySet('', 'FOO', '1'), 'FOO=1\n')
})

test('repairs a missing trailing newline before appending', () => {
	// Without the repair, bash would have produced "FOO=1BAR=2".
	assert.equal(applySet('FOO=1', 'BAR', '2'), 'FOO=1\nBAR=2\n')
})

test('repairs a missing trailing newline when rewriting in place', () => {
	assert.equal(applySet('FOO=1', 'FOO', '2'), 'FOO=2\n')
})

test('rewrites in place without moving the line', () => {
	const before = 'A=1\nFOO=old\nB=2\n'
	assert.equal(applySet(before, 'FOO', 'new'), 'A=1\nFOO=new\nB=2\n')
})

test('rewrites every duplicate of a key, matching the awk semantics', () => {
	assert.equal(applySet('FOO=1\nBAR=x\nFOO=2\n', 'FOO', '9'), 'FOO=9\nBAR=x\nFOO=9\n')
})

test('preserves comments, blank lines and ordering byte for byte', () => {
	const before = [
		'# =========================================',
		'# Devcontainer environment configuration',
		'# =========================================',
		'',
		'# === Project & volumes ===================',
		'',
		'# Unique per workspace folder.',
		'# Default : dc-project',
		'DC_PROJECT=symptems',
		'',
		'#CLAUDE_CREDS_VOLUME=claude-creds-shared',
		'',
		'# === System ==============================',
		'#TZ=Europe/Paris',
		'',
	].join('\n')

	const after = applySet(before, 'DC_PROJECT', 'other')
	assert.equal(after, before.replace('DC_PROJECT=symptems', 'DC_PROJECT=other'))

	// A commented-out key is not a key: appending must not resurrect it in place.
	const appended = applySet(before, 'TZ', 'UTC')
	assert.ok(appended.startsWith(before))
	assert.equal(appended.slice(before.length), 'TZ=UTC\n')
	assert.ok(appended.includes('#TZ=Europe/Paris'), 'the documented default survives')
})

test('unset drops every matching line and keeps the rest', () => {
	assert.equal(applyUnset('A=1\nFOO=x\nB=2\nFOO=y\n', 'FOO'), 'A=1\nB=2\n')
})

test('unset keeps comments and blank lines', () => {
	const before = '# head\n\nHTTPS_PROXY=http://127.0.0.1:8080\n# tail\n'
	assert.equal(applyUnset(before, 'HTTPS_PROXY'), '# head\n\n# tail\n')
})

test('unset of an absent key is a no-op', () => {
	assert.equal(applyUnset('A=1\n', 'ZZZ'), 'A=1\n')
})

test('unset newline-terminates a file that lacked one, like grep', () => {
	assert.equal(applyUnset('A=1\nFOO=x', 'FOO'), 'A=1\n')
})

test('unset of the only line yields an empty file, not a bare newline', () => {
	assert.equal(applyUnset('FOO=x\n', 'FOO'), '')
})

test('hasKey ignores commented and prefixed lookalikes', () => {
	const content = '#FOO=1\nFOOBAR=2\nexport FOO=3\n'
	assert.equal(hasKey(content, 'FOO'), false)
	assert.equal(hasKey(content, 'FOOBAR'), true)
})

test('readEnvFile returns {} for a missing file', () => {
	assert.deepEqual(readEnvFile('/nonexistent/.env'), {})
})

// --- applyUncomment (devc init's .env generation) -----------------------------

test('applyUncomment turns the first documented default into a live line', () => {
	const before = '# docs\n#DC_PROJECT=old\n\n#ANTHROPIC_BASE_URL=a\n#ANTHROPIC_BASE_URL=b\n'
	assert.equal(applyUncomment(before, 'DC_PROJECT', 'new'), '# docs\nDC_PROJECT=new\n\n#ANTHROPIC_BASE_URL=a\n#ANTHROPIC_BASE_URL=b\n')
	assert.equal(applyUncomment(before, 'ANTHROPIC_BASE_URL', 'c'), '# docs\n#DC_PROJECT=old\n\nANTHROPIC_BASE_URL=c\n#ANTHROPIC_BASE_URL=b\n')
})

test('applyUncomment defers to applySet for a live key, and appends when nothing documents the key', () => {
	assert.equal(applyUncomment('#K=1\nK=2\n', 'K', '3'), '#K=1\nK=3\n')
	assert.equal(applyUncomment('A=1\n', 'K', '3'), 'A=1\nK=3\n')
})
