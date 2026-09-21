// Chunk reassembly. Bash got this from `read -r` on a pipe; here every failure
// mode has to be handled explicitly, so every failure mode is tested.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LineSplitter, stripAnsi, truncate } from '../src/lib/lines.js'
import { ESC } from '../src/lib/logger.js'

function collect(chunks: (Buffer | string)[], flush = true): string[] {
	const lines: string[] = []
	const splitter = new LineSplitter((line) => lines.push(line))
	for (const chunk of chunks) splitter.push(chunk)
	if (flush) splitter.flush()
	return lines
}

test('joins a line split across two chunks', () => {
	assert.deepEqual(collect(['a\nb', 'c\n']), ['a', 'bc'])
})

test('holds back an unterminated line until flush', () => {
	assert.deepEqual(collect(['partial'], false), [])
	assert.deepEqual(collect(['partial']), ['partial'])
})

test('emits nothing extra when the chunk ends exactly on a newline', () => {
	assert.deepEqual(collect(['a\n']), ['a'])
})

test('keeps interior blank lines', () => {
	assert.deepEqual(collect(['a\n\nb\n']), ['a', '', 'b'])
})

test('strips CR so a CRLF producer does not corrupt the window', () => {
	assert.deepEqual(collect(['a\r\nb\r\n']), ['a', 'b'])
})

test('reassembles a UTF-8 sequence split across chunks', () => {
	const buffer = Buffer.from('héllo\n', 'utf8')
	// 'h' is 1 byte, 'é' is 2 — cut between them.
	const lines = collect([buffer.subarray(0, 2), buffer.subarray(2)])
	assert.deepEqual(lines, ['héllo'])
	assert.ok(!lines[0]?.includes('�'), 'no replacement character')
})

test('stripAnsi removes SGR and cursor escapes', () => {
	assert.equal(stripAnsi(`${ESC}[1;36mbuilding${ESC}[0m`), 'building')
	assert.equal(stripAnsi(`${ESC}[2Kerased`), 'erased')
	assert.equal(stripAnsi('plain'), 'plain')
})

test('truncate cuts on code points, never mid-sequence', () => {
	assert.equal(truncate('abcdef', 3), 'abc')
	assert.equal(truncate('abc', 10), 'abc')
	assert.equal(truncate('', 5), '')
	assert.equal(truncate('abc', 0), '')
	// Two code points that occupy 4 UTF-8 bytes each — a byte cut would split them.
	assert.equal(truncate('éàü', 2), 'éà')
})
