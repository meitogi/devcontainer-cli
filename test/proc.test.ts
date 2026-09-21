import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CommandFailed } from '../src/lib/logger.js'
import { PROXY_VARS, run, scrubEnv, tailFile } from '../src/lib/proc.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('scrubEnv removes every proxy variable in both cases', () => {
	const base = {
		HTTPS_PROXY: 'a',
		HTTP_PROXY: 'b',
		NO_PROXY: 'c',
		https_proxy: 'd',
		http_proxy: 'e',
		no_proxy: 'f',
		PATH: '/usr/bin',
	}
	const scrubbed = scrubEnv(base, PROXY_VARS)
	for (const key of PROXY_VARS) assert.equal(scrubbed[key], undefined, `${key} survived`)
	assert.equal(scrubbed['PATH'], '/usr/bin', 'unrelated variables kept')
})

test('scrubEnv does not mutate its input', () => {
	const base = { HTTPS_PROXY: 'a' }
	scrubEnv(base, PROXY_VARS)
	assert.equal(base.HTTPS_PROXY, 'a')
})

test('run merges stdout and stderr into one line stream', async () => {
	const lines: string[] = []
	const result = await run({
		argv: [
			process.execPath,
			'-e',
			"process.stdout.write('out\\n'); process.stderr.write('err\\n')",
		],
		onLine: (line) => lines.push(line),
	})
	assert.equal(result.code, 0)
	assert.deepEqual([...lines].sort(), ['err', 'out'])
})

test('run emits an unterminated final line', async () => {
	const lines: string[] = []
	await run({
		argv: [process.execPath, '-e', "process.stdout.write('no newline')"],
		onLine: (line) => lines.push(line),
	})
	assert.deepEqual(lines, ['no newline'])
})

test('run throws CommandFailed carrying the argv, reproducing set -e', async () => {
	const argv = [process.execPath, '-e', 'process.exit(7)']
	await assert.rejects(
		() => run({ argv }),
		(error: unknown) => {
			assert.ok(error instanceof CommandFailed)
			assert.equal(error.code, 7)
			assert.deepEqual(error.argv, argv)
			return true
		},
	)
})

test('run with check:false reports the code instead of throwing', async () => {
	const result = await run({ argv: [process.execPath, '-e', 'process.exit(4)'], check: false })
	assert.equal(result.code, 4)
})

test('run applies unsetEnv to the child environment', async () => {
	const lines: string[] = []
	await run({
		argv: [process.execPath, '-e', "process.stdout.write(String(process.env.HTTPS_PROXY))"],
		env: { ...process.env, HTTPS_PROXY: 'http://should-be-gone' },
		unsetEnv: PROXY_VARS,
		onLine: (line) => lines.push(line),
	})
	assert.deepEqual(lines, ['undefined'])
})

test('tailFile returns the last N lines and tolerates a missing file', () => {
	const dir = mkdtempSync(join(tmpdir(), 'devc-tail-'))
	const file = join(dir, 'build.log')
	writeFileSync(file, 'a\nb\nc\nd\n', 'utf8')
	assert.deepEqual(tailFile(file, 2), ['c', 'd'])
	assert.deepEqual(tailFile(file, 99), ['a', 'b', 'c', 'd'])
	assert.deepEqual(tailFile(join(dir, 'absent.log'), 5), [])
})
