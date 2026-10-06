import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_BASE_VERSION } from '../src/lib/docker.js'
import { latestPublishedBase, newestBase } from '../src/lib/registry.js'

const TAGS = ['1.7.2-cc2.1.272', '1.9.0-cc2.1.280', '1.10.0-cc2.1.280', '1.9.1-cc2.1.280', 'latest', '2.0.0-rc1-cc2.1.280', '1.9.5-cc2.1.220']

test('newestBase keeps the line and compares numerically, not lexically', () => {
	assert.equal(newestBase(TAGS, '2.1.280'), '1.10.0')
	assert.equal(newestBase(TAGS, '2.1.220'), '1.9.5')
	assert.equal(newestBase(TAGS, '2.1.999'), null)
	assert.equal(newestBase([], '2.1.280'), null)
})

function fakeFetch(answers: Record<string, { ok: boolean; status: number; body: unknown }>) {
	const calls: string[] = []
	const fetchImpl = async (url: string) => {
		calls.push(url)
		const key = Object.keys(answers).find((k) => url.includes(k))
		if (key === undefined) throw new Error(`unexpected url ${url}`)
		const a = answers[key] as { ok: boolean; status: number; body: unknown }
		return { ok: a.ok, status: a.status, json: async () => a.body }
	}
	return { fetchImpl, calls }
}

test('latestPublishedBase: token then tags/list, newest on the line', async () => {
	const { fetchImpl, calls } = fakeFetch({
		'/token?scope=repository:meitogi/devcontainer-sandbox:pull': { ok: true, status: 200, body: { token: 't' } },
		'/v2/meitogi/devcontainer-sandbox/tags/list': { ok: true, status: 200, body: { tags: TAGS } },
	})
	assert.deepEqual(await latestPublishedBase('2.1.280', { fetchImpl }), { version: '1.10.0', source: 'ghcr' })
	assert.equal(calls.length, 2)
})

test('latestPublishedBase never throws: a refused token, a bad body, or no network fall back to the default with the reason', async () => {
	const refused = fakeFetch({ '/token': { ok: false, status: 403, body: {} } })
	assert.deepEqual(await latestPublishedBase('2.1.280', { fetchImpl: refused.fetchImpl }), {
		version: DEFAULT_BASE_VERSION, source: 'default', reason: 'ghcr.io/token answered 403',
	})
	const malformed = fakeFetch({ '/token': { ok: true, status: 200, body: { token: 't' } }, '/tags/list': { ok: true, status: 200, body: {} } })
	assert.equal((await latestPublishedBase('2.1.280', { fetchImpl: malformed.fetchImpl })).reason, 'tags/list answered without tags')
	const offline = async () => { throw new Error('getaddrinfo ENOTFOUND ghcr.io') }
	assert.equal((await latestPublishedBase('2.1.280', { fetchImpl: offline })).reason, 'getaddrinfo ENOTFOUND ghcr.io')
	const empty = fakeFetch({ '/token': { ok: true, status: 200, body: { token: 't' } }, '/tags/list': { ok: true, status: 200, body: { tags: ['latest'] } } })
	assert.equal((await latestPublishedBase('2.1.280', { fetchImpl: empty.fetchImpl })).reason, 'no published image on the cc2.1.280 line')
})
