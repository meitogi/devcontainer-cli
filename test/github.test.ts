import assert from 'node:assert/strict'
import test from 'node:test'
import { listTokenRepos, pickDefaultRepo } from '../src/lib/github.js'

type Init = { headers?: Record<string, string>; signal?: AbortSignal }

function answering(status: number, body: unknown) {
	const calls: { url: string; init: Init | undefined }[] = []
	const fetchImpl = async (url: string, init?: Init) => {
		calls.push({ url, init })
		return { ok: status >= 200 && status < 300, status, json: async () => body }
	}
	return { fetchImpl, calls }
}

test('listTokenRepos: /user/repos with the token as Bearer, owner/name of each', async () => {
	const { fetchImpl, calls } = answering(200, [{ full_name: 'acme/claude-ext-patchs' }, { full_name: 'acme/app' }, { name: 'no-full-name' }])
	assert.deepEqual(await listTokenRepos('github_pat_x', { fetchImpl }), { repos: ['acme/claude-ext-patchs', 'acme/app'] })
	assert.equal(calls.length, 1)
	const call = calls[0] as { url: string; init: Init | undefined }
	assert.equal(call.url, 'https://api.github.com/user/repos?per_page=100&sort=full_name')
	assert.equal(call.init?.headers?.['Authorization'], 'Bearer github_pat_x')
})

test('listTokenRepos never throws: refused, other status, bad body, no network, timeout all come back as the reason', async () => {
	assert.deepEqual(await listTokenRepos('t', answering(401, {})), { error: 'GitHub refused this token (401)' })
	assert.deepEqual(await listTokenRepos('t', answering(403, {})), { error: 'api.github.com answered 403' })
	assert.deepEqual(await listTokenRepos('t', answering(200, { message: 'nope' })), { error: 'api.github.com answered without a repo list' })
	const offline = async () => {
		throw new Error('getaddrinfo ENOTFOUND api.github.com')
	}
	assert.deepEqual(await listTokenRepos('t', { fetchImpl: offline }), { error: 'getaddrinfo ENOTFOUND api.github.com' })
	const hanging = (_url: string, init?: Init) =>
		new Promise<never>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
		})
	assert.deepEqual(await listTokenRepos('t', { fetchImpl: hanging, timeoutMs: 10 }), { error: 'api.github.com did not answer in time' })
})

test('pickDefaultRepo: the first name saying ext-patch, else the first', () => {
	assert.equal(pickDefaultRepo(['acme/app', 'acme/Claude-Ext-Patchs', 'acme/vscode-ext-patches']), 1)
	assert.equal(pickDefaultRepo(['acme/app', 'acme/web']), 0)
})
