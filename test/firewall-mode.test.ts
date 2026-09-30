// `devc firewall-mode` writes two files and nothing else, and the report half
// writes none. The second property is asserted on the bytes rather than on the
// code, with the same whole-fixture snapshot `devc migrate` uses: a command
// whose write is inert until a rebuild is exactly the one where an accidental
// write would go unnoticed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { firewallMode } from '../src/commands/firewall-mode.js'

function scratch(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'devc-fwmode-'))
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function sink(): Writable & { text: () => string } {
	const chunks: string[] = []
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(String(chunk))
			callback()
		},
	}) as Writable & { text: () => string }
	stream.text = () => chunks.join('')
	return stream
}

function run(dir: string, mode?: string, dryRun = false): { code: number; out: string; err: string } {
	const out = sink()
	const err = sink()
	const code = firewallMode({ cwd: dir, mode, dryRun, out, err })
	return { code, out: out.text(), err: err.text() }
}

function snapshot(dir: string, prefix = ''): Record<string, string> {
	const result: Record<string, string> = {}
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name)
		const rel = `${prefix}${entry.name}`
		if (entry.isDirectory()) {
			result[`${rel}/`] = String(statSync(abs).mode)
			Object.assign(result, snapshot(abs, `${rel}/`))
		} else {
			result[rel] = `${statSync(abs).mode}:${readFileSync(abs, 'utf8')}`
		}
	}
	return result
}

/** The smallest tree classifyDevcontainer accepts, plus an optional flag and .env. */
function fixture(dir: string, options: { flag?: string; env?: string } = {}): void {
	const dc = join(dir, '.devcontainer')
	mkdirSync(join(dc, 'firewall'), { recursive: true })
	writeFileSync(join(dc, 'devcontainer.json'), '{}\n', 'utf8')
	if (options.flag !== undefined) writeFileSync(join(dc, 'firewall', 'default-mode'), `${options.flag}\n`, 'utf8')
	if (options.env !== undefined) writeFileSync(join(dc, '.env'), options.env, 'utf8')
}

const flagOf = (dir: string): string => readFileSync(join(dir, '.devcontainer', 'firewall', 'default-mode'), 'utf8')
const envOf = (dir: string): string => readFileSync(join(dir, '.devcontainer', '.env'), 'utf8')
const PROXY = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']

test('no argument reports the mode and writes not one byte', () => {
	const { dir, cleanup } = scratch()
	try {
		fixture(dir, { flag: 'basic', env: 'CLAUDE_CODE_VERSION=2.1.280\n' })
		const before = snapshot(dir)
		const { code, out } = run(dir)
		assert.equal(code, 0)
		assert.match(out, /firewall mode: basic/)
		assert.match(out, /DNS allowlist only/)
		assert.deepEqual(snapshot(dir), before, 'the report wrote something')
	} finally {
		cleanup()
	}
})

test('with no flag file the report says strict and still creates nothing', () => {
	const { dir, cleanup } = scratch()
	try {
		fixture(dir)
		const before = snapshot(dir)
		const { code, out } = run(dir)
		assert.equal(code, 0)
		assert.match(out, /firewall mode: strict/)
		assert.deepEqual(snapshot(dir), before, 'reading defaulted the mode AND wrote the file')
	} finally {
		cleanup()
	}
})

test('strict writes the flag and sets the four proxy variables', () => {
	const { dir, cleanup } = scratch()
	try {
		fixture(dir, { flag: 'basic', env: 'CLAUDE_CODE_VERSION=2.1.280\n' })
		const { code } = run(dir, 'strict')
		assert.equal(code, 0)
		assert.equal(flagOf(dir), 'strict\n')
		for (const key of PROXY) assert.match(envOf(dir), new RegExp(`^${key}=.+$`, 'm'), `${key} not set`)
		assert.match(envOf(dir), /CLAUDE_CODE_VERSION=2\.1\.280/, 'an unrelated key was dropped')
	} finally {
		cleanup()
	}
})

test('basic clears the four proxy variables', () => {
	const { dir, cleanup } = scratch()
	try {
		fixture(dir, { flag: 'strict', env: `CLAUDE_CODE_VERSION=2.1.280\n${PROXY.map(k => `${k}=x`).join('\n')}\n` })
		const { code } = run(dir, 'basic')
		assert.equal(code, 0)
		assert.equal(flagOf(dir), 'basic\n')
		for (const key of PROXY) assert.doesNotMatch(envOf(dir), new RegExp(`^${key}=`, 'm'), `${key} survived`)
		assert.match(envOf(dir), /CLAUDE_CODE_VERSION=2\.1\.280/)
	} finally {
		cleanup()
	}
})

test('off writes off and clears the proxy variables', () => {
	const { dir, cleanup } = scratch()
	try {
		fixture(dir, { flag: 'strict', env: `${PROXY.map(k => `${k}=x`).join('\n')}\n` })
		assert.equal(run(dir, 'off').code, 0)
		assert.equal(flagOf(dir), 'off\n')
		for (const key of PROXY) assert.doesNotMatch(envOf(dir), new RegExp(`^${key}=`, 'm'))
	} finally {
		cleanup()
	}
})

test('the v2 aliases are accepted, warned about, and never written back', () => {
	for (const [alias, canonical] of [
		['okeish', 'basic'],
		['paranoid', 'strict'],
	] as const) {
		const { dir, cleanup } = scratch()
		try {
			fixture(dir, { flag: 'off', env: '' })
			const { code, err } = run(dir, alias)
			assert.equal(code, 0)
			assert.equal(flagOf(dir), `${canonical}\n`, `${alias} was written verbatim`)
			assert.match(err, /v2 name/, 'the deprecation went unmentioned')
		} finally {
			cleanup()
		}
	}
})

test('an invalid mode is usage, and nothing is written', () => {
	const { dir, cleanup } = scratch()
	try {
		fixture(dir, { flag: 'basic', env: '' })
		const before = snapshot(dir)
		const { code, err } = run(dir, 'nope')
		assert.equal(code, 2)
		assert.match(err, /invalid mode "nope"/)
		assert.deepEqual(snapshot(dir), before)
	} finally {
		cleanup()
	}
})

test('--dry-run writes nothing and says so', () => {
	const { dir, cleanup } = scratch()
	try {
		fixture(dir, { flag: 'basic', env: '' })
		const before = snapshot(dir)
		const { code, out } = run(dir, 'strict', true)
		assert.equal(code, 0)
		assert.match(out, /dry-run/)
		assert.deepEqual(snapshot(dir), before)
	} finally {
		cleanup()
	}
})

test('re-setting the current mode repairs a drifted .env', () => {
	const { dir, cleanup } = scratch()
	try {
		// The flag says basic, .env still carries strict's variables — what a bare
		// `echo basic > default-mode` leaves behind.
		fixture(dir, { flag: 'basic', env: `${PROXY.map(k => `${k}=x`).join('\n')}\n` })
		const { code, out } = run(dir, 'basic')
		assert.equal(code, 0)
		assert.match(out, /unchanged/)
		for (const key of PROXY) assert.doesNotMatch(envOf(dir), new RegExp(`^${key}=`, 'm'), `${key} not repaired`)
	} finally {
		cleanup()
	}
})

test('the report names the drift rather than hiding it', () => {
	const { dir, cleanup } = scratch()
	try {
		fixture(dir, { flag: 'basic', env: `${PROXY.map(k => `${k}=x`).join('\n')}\n` })
		const { code, out } = run(dir)
		assert.equal(code, 0, 'finding drift is a successful report, not a failure')
		assert.match(out, /stale/)
	} finally {
		cleanup()
	}
})

test('a directory with no devcontainer.json is refused, and nothing is written', () => {
	const { dir, cleanup } = scratch()
	try {
		mkdirSync(join(dir, '.devcontainer'), { recursive: true })
		const before = snapshot(dir)
		const { code, err } = run(dir, 'strict')
		assert.equal(code, 1)
		assert.match(err, /devcontainer\.json/)
		assert.deepEqual(snapshot(dir), before)
	} finally {
		cleanup()
	}
})

test('a leftover .configured-firewall-mode is named but never read or touched', () => {
	const { dir, cleanup } = scratch()
	try {
		fixture(dir, { flag: 'basic', env: '' })
		const legacy = join(dir, '.devcontainer', '.configured-firewall-mode')
		writeFileSync(legacy, 'off\n', 'utf8')
		const { code, out } = run(dir, 'strict')
		assert.equal(code, 0)
		assert.equal(flagOf(dir), 'strict\n', 'the legacy file was read instead of the argument')
		assert.equal(readFileSync(legacy, 'utf8'), 'off\n', 'the legacy file was modified')
		assert.match(out, /v2 file/)
	} finally {
		cleanup()
	}
})

test('the rebuild instruction is last, and the screen carries no banned glyph', () => {
	const { dir, cleanup } = scratch()
	try {
		fixture(dir, { flag: 'basic', env: '' })
		const { out } = run(dir, 'strict')
		const lines = out.trimEnd().split('\n')
		assert.match(lines.at(-1) as string, /Rebuild Container/, 'the call to action is not last')
		assert.doesNotMatch(out, /[✓→⚠✗📖·—]/, 'no emoji-presentation or decorative glyph on screen')
		assert.doesNotMatch(out, /firewall-mode\.sh/, 'the retired script is named again')
	} finally {
		cleanup()
	}
})
