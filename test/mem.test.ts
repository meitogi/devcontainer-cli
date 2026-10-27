import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { mem } from '../src/commands/mem.js'
import { classify, collect, type MemSnapshot } from '../src/lib/mem-collect.js'
import { render } from '../src/lib/mem-render.js'
import { PACKAGE_ROOT } from '../src/lib/version.js'

const VSCODE = '/vscode/vscode-server/bin/linux-arm64/4fe60c8b/node'
const BOOT = '/vscode/vscode-server/bin/linux-arm64/4fe60c8b/out/bootstrap-fork'

test('classify names the processes ps shows as MainThread', () => {
	const cases: [string[], string][] = [
		[[VSCODE, '--dns-result-order=ipv4first', BOOT, '--type=extensionHost', '--transformURIs'], 'VS Code — extension host'],
		[[VSCODE, BOOT, '--type=fileWatcher'], 'VS Code — file watcher'],
		[[VSCODE, BOOT, '--type=ptyHost', '--logsPath'], 'VS Code — terminals (ptyHost)'],
		[[VSCODE, '/vscode/vscode-server/bin/linux-arm64/4fe60c8b/out/server-main.js', '--log', 'debug'], 'VS Code — server'],
		[
			[VSCODE, '/home/node/.vscode-server/extensions/dbaeumer.vscode-eslint-3.0.34/server/out/eslintServer.js', '--node-ipc'],
			'Extension dbaeumer.vscode-eslint',
		],
		[[VSCODE, '/vscode/vscode-server/bin/linux-arm64/4fe60c8b/extensions/json-language-features/server/dist/node/main.js'], 'Extension json-language-features'],
		[
			['/home/node/.vscode-server/extensions/anthropic.claude-code-2.1.310-linux-arm64/resources/native-binary/claude', '--output-format', 'stream-json'],
			'Claude Code',
		],
		[[VSCODE, '-e', "const net = require('net'); net.createConnection({ port: 39529 })"], 'VS Code — port relay'],
		[[VSCODE, '/tmp/vscode-remote-containers-server-6a78fe87.js'], 'VS Code — Dev Containers helper'],
		[['/bin/bash', '/usr/local/bin/creds-watch'], 'bash creds-watch'],
		[['/bin/zsh', '-c', '-l', 'source /tmp/snapshot.sh && ls'], 'zsh -c'],
		[['/usr/bin/inotifywait', '-m', '/workspace'], 'inotifywait'],
	]
	for (const [argv, label] of cases) assert.equal(classify(argv), label, argv.join(' '))
})

function fakeRoots(): { proc: string; cgroup: string } {
	const root = mkdtempSync(join(tmpdir(), 'devc-mem-'))
	const proc = join(root, 'proc')
	const cgroup = join(root, 'cgroup')
	mkdirSync(cgroup, { recursive: true })
	const addProc = (pid: number, argv: string[], pssKb: number, rssKb: number): void => {
		mkdirSync(join(proc, String(pid)), { recursive: true })
		writeFileSync(join(proc, String(pid), 'cmdline'), `${argv.join('\0')}\0`)
		writeFileSync(join(proc, String(pid), 'smaps_rollup'), `Rss:  ${rssKb} kB\nPss:  ${pssKb} kB\nSwap:  4 kB\n`)
	}
	addProc(10, [VSCODE, BOOT, '--type=extensionHost'], 500_000, 600_000)
	addProc(11, ['/bin/bash', '/usr/local/bin/creds-watch'], 100, 300)
	addProc(12, ['/bin/bash', '/usr/local/bin/creds-watch'], 200, 300)
	// A kernel thread: directory present, empty cmdline.
	addProc(2, [], 0, 0)
	writeFileSync(join(proc, '2', 'cmdline'), '')
	mkdirSync(join(proc, 'self'), { recursive: true })
	writeFileSync(join(proc, 'meminfo'), 'MemTotal: 16000000 kB\nMemAvailable: 9000000 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\n')
	mkdirSync(join(proc, 'pressure'))
	writeFileSync(join(proc, 'pressure', 'memory'), 'some avg10=1.25 avg60=0.61 avg300=1.03 total=1\n')
	writeFileSync(join(cgroup, 'memory.current'), '2000\n')
	writeFileSync(join(cgroup, 'memory.max'), 'max\n')
	writeFileSync(join(cgroup, 'memory.stat'), 'anon 1100\nfile 800\nkernel 100\nshmem 0\nactive_file 300\ninactive_file 500\n')
	return { proc, cgroup }
}

test('collect reads the cgroup totals and sums processes by group', () => {
	const snapshot = collect(fakeRoots())
	const { totals } = snapshot
	assert.equal(totals.current, 2000)
	assert.equal(totals.docker, 1500, 'current − inactive_file')
	assert.equal(totals.limited, false)
	assert.equal(totals.limit, 16_000_000 * 1024, 'unlimited cgroup falls back to MemTotal')
	assert.equal(totals.anon, 1100)
	assert.equal(totals.fileInactive, 500)
	assert.equal(totals.vmSwapUsed, 1500 * 1024)
	assert.equal(totals.pressure, 1.25)

	assert.deepEqual(
		snapshot.groups.map((group) => [group.label, group.pss, group.rss, group.swap]),
		[
			['VS Code — extension host', 500_000 * 1024, 600_000 * 1024, 4096],
			['bash creds-watch', 300 * 1024, 600 * 1024, 8192],
		],
	)
	assert.deepEqual(
		snapshot.groups[1]?.procs.map((proc) => [proc.pid, proc.cmd]),
		[
			[12, '/bin/bash /usr/local/bin/creds-watch'],
			[11, '/bin/bash /usr/local/bin/creds-watch'],
		],
		'processes sorted by PSS, cmdline kept',
	)
})

test('the compiled collector has no relative import, so it can be piped into a container', () => {
	const source = readFileSync(join(PACKAGE_ROOT, 'dist', 'src', 'lib', 'mem-collect.js'), 'utf8')
	assert.doesNotMatch(source, /from\s+['"]\./)
	assert.doesNotMatch(source, /import\(\s*['"]\./)
})

test('render shows each group with its size and the change since the baseline', () => {
	const now = collect(fakeRoots())
	const before: MemSnapshot = structuredClone(now)
	before.t = now.t - 30_000
	;(before.groups[0] as { pss: number }).pss -= 12 * 1024 * 1024
	before.groups.pop()
	const text = render(now, before, { width: 120, procs: true, source: 'test' })
	assert.match(text, /488 MiB +586 MiB +\+12 +1 +VS Code — extension host/)
	assert.match(text, /0 MiB +1 MiB +new +2 +bash creds-watch/)
	assert.match(text, /Δ30s/)
	assert.match(text, /^ +0 MiB +0 MiB +12 \/bin\/bash \/usr\/local\/bin\/creds-watch/m, '--procs lists the pids')
	assert.match(text, /Container +0 MiB +\(what Docker shows\)/)
})

test('host path: the collector runs through docker exec and streams its snapshots back', async () => {
	// A stand-in docker that drops `exec -i <id>` and runs the rest locally.
	const bin = mkdtempSync(join(tmpdir(), 'devc-mem-bin-'))
	const argsFile = join(bin, 'args')
	writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$@" > ${argsFile}\nshift 3\nexec "$@"\n`)
	chmodSync(join(bin, 'docker'), 0o755)
	const path = process.env['PATH']
	process.env['PATH'] = `${bin}:${path}`
	const out = new PassThrough()
	let text = ''
	out.on('data', (chunk) => (text += String(chunk)))
	try {
		const code = await mem({ cwd: process.cwd(), container: 'abc123', host: true, once: true, json: true, out })
		assert.equal(code, 0)
	} finally {
		process.env['PATH'] = path
	}
	assert.equal(readFileSync(argsFile, 'utf8').trim(), 'exec -i abc123 node --input-type=module -')
	const lines = text.trim().split('\n')
	assert.equal(lines.length, 1, '--once emits a single snapshot')
	const snapshot = JSON.parse(lines[0] as string) as MemSnapshot
	assert.ok(snapshot.totals.current > 0)
	assert.ok(snapshot.groups.some((group) => group.procs.length > 0))
})
