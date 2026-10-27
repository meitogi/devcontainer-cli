// Memory snapshot of the container this code runs in: cgroup totals plus every
// process, grouped by what it is rather than by binary name.
//
// Self-contained on purpose — `node:*` imports only, never `./…`. On the host,
// `devc mem` cannot read the container's /proc, so it pipes this file's
// compiled source to `node --input-type=module -` through `docker exec` and
// reads back one JSON snapshot per line. A relative import would not resolve
// there; test/mem.test.ts guards that.
//
// The snapshot is also the contract a web dashboard is meant to consume later,
// so it carries raw bytes and no presentation.

import { readdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'

export interface MemTotals {
	/** cgroup memory.current: everything charged to the container. */
	current: number
	/** current − inactive_file, the figure `docker stats` / Docker Desktop shows. */
	docker: number
	/** memory.max, or the VM's MemTotal when the cgroup is unlimited. */
	limit: number
	limited: boolean
	anon: number
	fileActive: number
	fileInactive: number
	kernel: number
	shmem: number
	swap: number
	vmTotal: number
	vmAvailable: number
	vmSwapTotal: number
	vmSwapUsed: number
	/** /proc/pressure/memory `some avg10`, percent of time stalled on memory. */
	pressure: number
}

export interface MemProcess {
	pid: number
	cmd: string
	/** Proportional set size: shared pages split between their users. */
	pss: number
	rss: number
	swap: number
}

export interface MemGroup {
	label: string
	pss: number
	rss: number
	swap: number
	/** Sorted by PSS, largest first. */
	procs: MemProcess[]
}

export interface MemSnapshot {
	t: number
	host: string
	totals: MemTotals
	/** Sorted by PSS, largest first. */
	groups: MemGroup[]
}

export interface MemRoots {
	proc: string
	cgroup: string
}

const DEFAULT_ROOTS: MemRoots = { proc: '/proc', cgroup: '/sys/fs/cgroup' }

function read(path: string): string {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return ''
	}
}

/** `key<sep>value` lines to numbers; units (`kB`) are dropped by parseInt. */
function parseTable(text: string, sep: string): Record<string, number> {
	const out: Record<string, number> = {}
	for (const line of text.split('\n')) {
		const i = line.indexOf(sep)
		if (i > 0) out[line.slice(0, i).trim()] = parseInt(line.slice(i + 1), 10)
	}
	return out
}

const INTERPRETERS: Record<string, true> = { node: true, python: true, python3: true, bash: true, sh: true, zsh: true, deno: true, bun: true }

function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1)
}

/** Trailing argv of the collector the host runs here, so it names itself in its own table. */
export const COLLECTOR_TAG = 'devc-mem'

/** What a process is, from its argv — every node process is `MainThread` to `ps`. */
export function classify(argv: readonly string[]): string {
	const exe = argv[0] ?? ''
	const cmd = argv.join(' ')
	if (exe.endsWith('/claude') || exe === 'claude') return 'Claude Code'
	if (argv[argv.length - 1] === COLLECTOR_TAG) return 'devc mem (host collector)'
	if (cmd.includes('tsserver')) return 'TypeScript server'
	const type = /--type=(\w+)/.exec(cmd)?.[1]
	if (type === 'extensionHost') return 'VS Code — extension host'
	else if (type === 'fileWatcher') return 'VS Code — file watcher'
	else if (type === 'ptyHost') return 'VS Code — terminals (ptyHost)'
	else if (type !== undefined) return `VS Code — ${type}`
	if (cmd.includes('server-main.js')) return 'VS Code — server'
	const extension = /\/extensions\/([^/\s]+)\//.exec(cmd)?.[1]
	if (extension !== undefined) return `Extension ${extension.replace(/-\d+\.\d+\.\d+.*$/, '')}`
	if (argv[1] === '-e' && cmd.includes('net.createConnection')) return 'VS Code — port relay'
	if (cmd.includes('vscode-remote-containers-server')) return 'VS Code — Dev Containers helper'
	const bin = baseName(exe)
	if (INTERPRETERS[bin]) {
		// `sh -c '<inline command>'`: the command text says nothing stable.
		if (argv.includes('-c')) return `${bin} -c`
		const script = argv.slice(1).find((arg) => !arg.startsWith('-'))
		return script === undefined ? bin : `${bin} ${baseName(script)}`
	}
	return bin
}

function totals(roots: MemRoots): MemTotals {
	const stat = parseTable(read(`${roots.cgroup}/memory.stat`), ' ')
	const meminfo = parseTable(read(`${roots.proc}/meminfo`), ':')
	const max = read(`${roots.cgroup}/memory.max`).trim()
	const current = parseInt(read(`${roots.cgroup}/memory.current`), 10) || 0
	const fileInactive = stat['inactive_file'] ?? 0
	const vmTotal = (meminfo['MemTotal'] ?? 0) * 1024
	const vmSwapTotal = (meminfo['SwapTotal'] ?? 0) * 1024
	const limited = max !== '' && max !== 'max'
	return {
		current,
		docker: current - fileInactive,
		limit: limited ? parseInt(max, 10) : vmTotal,
		limited,
		anon: stat['anon'] ?? 0,
		fileActive: stat['active_file'] ?? 0,
		fileInactive,
		kernel: stat['kernel'] ?? 0,
		shmem: stat['shmem'] ?? 0,
		swap: parseInt(read(`${roots.cgroup}/memory.swap.current`), 10) || 0,
		vmTotal,
		vmAvailable: (meminfo['MemAvailable'] ?? 0) * 1024,
		vmSwapTotal,
		vmSwapUsed: vmSwapTotal - (meminfo['SwapFree'] ?? 0) * 1024,
		pressure: Number(/some avg10=([\d.]+)/.exec(read(`${roots.proc}/pressure/memory`))?.[1] ?? 0),
	}
}

export function collect(roots: MemRoots = DEFAULT_ROOTS): MemSnapshot {
	const byLabel: Record<string, MemGroup> = {}
	const groups: MemGroup[] = []
	for (const name of readdirSync(roots.proc)) {
		const first = name.charCodeAt(0)
		if (first < 48 || first > 57) continue
		const argv = read(`${roots.proc}/${name}/cmdline`).split('\0').filter(Boolean)
		// Empty cmdline: a kernel thread, or a process that exited mid-scan.
		if (argv.length === 0) continue
		const rollup = parseTable(read(`${roots.proc}/${name}/smaps_rollup`), ':')
		const rss = rollup['Rss']
		if (!rss) continue
		const label = classify(argv)
		let group = byLabel[label]
		if (group === undefined) {
			group = byLabel[label] = { label, pss: 0, rss: 0, swap: 0, procs: [] }
			groups.push(group)
		}
		const proc: MemProcess = {
			pid: Number(name),
			cmd: argv.join(' ').replace(/\s+/g, ' ').slice(0, 300),
			pss: (rollup['Pss'] ?? 0) * 1024,
			rss: rss * 1024,
			swap: (rollup['Swap'] ?? 0) * 1024,
		}
		group.pss += proc.pss
		group.rss += proc.rss
		group.swap += proc.swap
		group.procs.push(proc)
	}
	for (const group of groups) group.procs.sort((a, b) => b.pss - a.pss)
	groups.sort((a, b) => b.pss - a.pss)
	return { t: Date.now(), host: hostname(), totals: totals(roots), groups }
}

/** One snapshot per line on stdout — what the host end of `docker exec` reads. */
export function stream(intervalMs: number, once: boolean): void {
	const emit = (): void => {
		process.stdout.write(`${JSON.stringify(collect())}\n`)
	}
	emit()
	if (!once) setInterval(emit, intervalMs)
}
