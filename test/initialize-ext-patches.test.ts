// `devc initialize` fills EXT_PATCHES_REPO/REF/TOKEN from the machine store
// only where the project's .env leaves them empty. The template now ships
// EXT_PATCHES_TOKEN=<change-me> live, so "empty" has to include the
// placeholder — otherwise the one line put there to be filled is the one line
// that blocks the fill. And a machine ref left empty (auto) must not be
// written as a live empty pin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Logger } from '../src/lib/logger.js'
import { readEnvFile } from '../src/lib/env-file.js'
import { applyExtPatchesConfig } from '../src/commands/initialize.js'

function scratchEnv(content: string): { envFile: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'devc-extp-'))
	mkdirSync(join(dir, '.devcontainer'))
	const envFile = join(dir, '.devcontainer', '.env')
	writeFileSync(envFile, content)
	return { envFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const quiet = () => Logger.create({ logFile: '/dev/null', silentSink: true, out: new PassThrough(), err: new PassThrough(), isTTY: false })

test('the <change-me> placeholder counts as empty and is filled from the machine store', () => {
	const { envFile, cleanup } = scratchEnv('EXT_PATCHES_REPO=meitogi/claude-ext-patchs\nEXT_PATCHES_TOKEN=<change-me>\n#EXT_PATCHES_REF=cc2.1.272-r1\n')
	try {
		applyExtPatchesConfig({ envFile, logger: quiet(), dryRun: false, machine: { repo: 'meitogi/claude-ext-patchs', ref: '', token: 'github_pat_real' } })
		const env = readEnvFile(envFile)
		assert.equal(env['EXT_PATCHES_TOKEN'], 'github_pat_real')
		assert.equal(env['EXT_PATCHES_REPO'], 'meitogi/claude-ext-patchs')
		assert.equal(env['EXT_PATCHES_REF'], undefined, 'an auto ref in the store writes no pin')
		assert.match(readFileSync(envFile, 'utf8'), /^#EXT_PATCHES_REF=cc2\.1\.272-r1$/m, 'the documented line is left as it was')
	} finally {
		cleanup()
	}
})

test('a real token already in .env is never overwritten by the store', () => {
	const { envFile, cleanup } = scratchEnv('EXT_PATCHES_REPO=meitogi/claude-ext-patchs\nEXT_PATCHES_TOKEN=github_pat_mine\n')
	try {
		applyExtPatchesConfig({ envFile, logger: quiet(), dryRun: false, machine: { repo: 'meitogi/claude-ext-patchs', ref: 'cc2.1.272-r1', token: 'github_pat_other' } })
		const env = readEnvFile(envFile)
		assert.equal(env['EXT_PATCHES_TOKEN'], 'github_pat_mine')
		assert.equal(env['EXT_PATCHES_REF'], 'cc2.1.272-r1', 'a pinned ref in the store fills an unset one')
	} finally {
		cleanup()
	}
})
