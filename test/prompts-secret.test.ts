// readlineAsk's masked prompt shares stdin with the wizard's own readline
// interface. Driven through a fake TTY so the masked (raw-mode) branch runs:
// the question after a secret must still be answered, and the secret must
// never be echoed in clear.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { readlineAsk } from '../src/lib/prompts.js'

function fakeTty(): PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void } {
	return Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
}

function sink(): Writable & { text: () => string } {
	const chunks: string[] = []
	const stream = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			chunks.push(chunk.toString())
			callback()
		},
	})
	return Object.assign(stream, { text: () => chunks.join('') })
}

/** Rejects instead of hanging when the stream is left paused. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms))])
}

test('a question after a masked secret is still answered, and the secret never reaches the output in clear', async () => {
	const input = fakeTty()
	const out = sink()
	const prompts = readlineAsk(input, out)
	try {
		const first = prompts.ask('Stack: ')
		input.write('node\r')
		assert.equal(await within(first, 1000), 'node')

		const token = prompts.askSecret('Token: ')
		input.write('github_pat_secret\r')
		assert.equal(await within(token, 1000), 'github_pat_secret')

		const after = prompts.ask('Repo: ')
		input.write('acme/patches\r')
		assert.equal(await within(after, 1000), 'acme/patches')

		assert.ok(!out.text().includes('github_pat_secret'))
		assert.ok(!/\*s|\*e|\*c/.test(out.text()), 'no clear character drawn after the stars')
	} finally {
		prompts.close()
	}
})
