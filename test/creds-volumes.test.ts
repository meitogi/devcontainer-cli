// Discovery of the Claude credentials volumes: the pure ranking, and the docker
// argv sequence against a stub `docker` first on PATH — the technique from the
// session-3 differential harness.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverCredsVolumes, rankCredsVolumes } from '../src/lib/docker.js'

test('ranks by distinct projects, strips the compose suffix, ties by name', () => {
	const ranked = rankCredsVolumes([
		{ name: 'claude-creds-zeta', projects: ['zeta-claude-code', '', 'zeta-claude-code'] },
		{ name: 'claude-creds-shared', projects: ['beta-claude-code', 'alpha-claude-code', 'gamma-claude-code'] },
		{ name: 'claude-credentials-shared', projects: ['old-claude-code', 'older-claude-code'] },
		{ name: 'claude-creds-unused', projects: [''] },
		{ name: 'claude-creds-alpha', projects: ['alpha-claude-code'] },
	])
	assert.deepEqual(ranked, [
		{ name: 'claude-creds-shared', projects: ['alpha', 'beta', 'gamma'] },
		{ name: 'claude-credentials-shared', projects: ['old', 'older'] },
		{ name: 'claude-creds-alpha', projects: ['alpha'] },
		{ name: 'claude-creds-zeta', projects: ['zeta'] },
		{ name: 'claude-creds-unused', projects: [] },
	])
})

test('discoverCredsVolumes lists, filters, then asks docker ps once per volume', () => {
	const binDir = mkdtempSync(join(tmpdir(), 'devc-bin-'))
	const trace = join(binDir, 'trace')
	const stub = `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(trace)}
if [ "$1" = "volume" ]; then
  printf 'claude-creds-shared\\nmitmproxy-x\\nclaude-creds-solo\\nclaude-credentials-legacy\\nother\\n'
elif [ "$1" = "ps" ]; then
  case "$*" in
    *claude-creds-shared*) printf 'a-claude-code\\nb-claude-code\\n' ;;
    *claude-creds-solo*) printf 'solo-claude-code\\n' ;;
    *) printf '' ;;
  esac
fi
exit 0
`
	writeFileSync(join(binDir, 'docker'), stub, { encoding: 'utf8', mode: 0o755 })
	const saved = process.env['PATH']
	process.env['PATH'] = `${binDir}:${saved ?? ''}`
	try {
		const found = discoverCredsVolumes()
		assert.deepEqual(found, [
			{ name: 'claude-creds-shared', projects: ['a', 'b'] },
			{ name: 'claude-creds-solo', projects: ['solo'] },
			{ name: 'claude-credentials-legacy', projects: [] },
		])
		const calls = readFileSync(trace, 'utf8').trim().split('\n')
		assert.equal(calls[0], 'volume ls --format {{.Name}}')
		assert.equal(calls.length, 4, 'one ps per matching volume, none for the others')
		assert.ok(calls.slice(1).every((call) => call.startsWith('ps -a --filter volume=claude-cred')))
		assert.match(calls[1] as string, /--format \{\{\.Label "com\.docker\.compose\.project"\}\}$/)
	} finally {
		process.env['PATH'] = saved
		rmSync(binDir, { recursive: true, force: true })
	}
})

test('discoverCredsVolumes returns null when docker does not answer', () => {
	const binDir = mkdtempSync(join(tmpdir(), 'devc-bin-'))
	writeFileSync(join(binDir, 'docker'), '#!/bin/bash\nexit 1\n', { encoding: 'utf8', mode: 0o755 })
	const saved = process.env['PATH']
	process.env['PATH'] = `${binDir}:${saved ?? ''}`
	try {
		assert.equal(discoverCredsVolumes(), null)
	} finally {
		process.env['PATH'] = saved
		rmSync(binDir, { recursive: true, force: true })
	}
})
