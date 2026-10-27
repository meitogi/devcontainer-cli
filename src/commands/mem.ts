// devc mem — live memory of the devcontainer, and what takes it.
//
// Same command on both sides. Inside the container it reads /proc and the
// cgroup directly. On the host it finds the workspace's running devcontainer
// and runs the very same collector there: the compiled mem-collect.js is piped
// to `node --input-type=module -` through `docker exec`, so nothing has to be
// installed in the image beyond the node it already has.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { devcontainerFilters, hasDocker } from '../lib/docker.js'
import { collect, type MemSnapshot } from '../lib/mem-collect.js'
import { render } from '../lib/mem-render.js'
import { resolveProjectPaths } from '../lib/paths.js'
import { detectHostKind, readHostProbe } from '../lib/platform.js'
import { runCapture } from '../lib/proc.js'

export interface MemOptions {
	cwd: string
	devcontainerDir?: string | undefined
	/** Container id or name; skips the workspace lookup. */
	container?: string | undefined
	once?: boolean
	json?: boolean
	procs?: boolean
	intervalMs?: number
	/** Force the host path (docker exec) even when this looks like a container. */
	host?: boolean
	out?: NodeJS.WriteStream | NodeJS.WritableStream
	err?: NodeJS.WritableStream
}

export const MEM_HELP = `devc mem — live memory of the devcontainer, and what takes it

Usage:
  devc mem [options]

Options:
      --once                 Print one snapshot and exit
      --json                 Raw snapshots, one JSON object per line
      --procs                List every process under its group
      --interval <seconds>   Sampling period (default: 2)
      --container <id|name>  Container to inspect (host side; default: this
                             workspace's running devcontainer)
      --devcontainer-dir <p> Path to .devcontainer/ (default: found from cwd)
  -h, --help                 Show this help

Inside the container it reads /proc and /sys/fs/cgroup. On the host it finds
the devcontainer of the current workspace (or the only one running) and runs
the same collector in it through docker exec — nothing to install in the image.

"Container" is the figure Docker Desktop shows: cgroup usage minus the
inactive file cache. Groups are sorted by PSS, which splits shared pages
between their users so the column adds up; RSS counts them in full for each.

  Host:       npx @meitogi/devcontainer-cli mem
  Container:  npx devc mem

Exit codes: 0 done; 1 no container to inspect, or the collector failed; 2 usage.
`

/** Whether this process already runs inside a container. */
export function insideContainer(): boolean {
	return existsSync('/.dockerenv') || existsSync('/run/.containerenv') || process.env['REMOTE_CONTAINERS'] === 'true'
}

interface RunningContainer {
	id: string
	name: string
	folder: string
}

function runningDevcontainers(filters: readonly string[]): RunningContainer[] {
	const output = runCapture(['docker', 'ps', ...filters, '--format', '{{.ID}}\t{{.Names}}\t{{.Label "devcontainer.local_folder"}}'])
	const list: RunningContainer[] = []
	for (const line of (output ?? '').split('\n')) {
		const [id, name, folder] = line.split('\t')
		if (id && name) list.push({ id, name, folder: folder ?? '' })
	}
	return list
}

/** The workspace's running devcontainer, else the only running devcontainer at all. */
function findContainer(options: MemOptions, err: NodeJS.WritableStream): RunningContainer | null {
	const paths = resolveProjectPaths(options.cwd, options.devcontainerDir)
	const hostKind = detectHostKind(readHostProbe())
	const exact = runningDevcontainers(devcontainerFilters({ hostKind, ...paths }))[0]
	if (exact !== undefined) return exact
	const all = runningDevcontainers(['--filter', 'label=devcontainer.local_folder'])
	if (all.length === 1) return all[0] as RunningContainer
	if (all.length === 0) {
		err.write(`devc mem: no running devcontainer (looked for ${paths.projectDir} first)\n`)
		return null
	}
	err.write(`devc mem: no running devcontainer for ${paths.projectDir}, and ${all.length} others run — pick one with --container:\n`)
	for (const container of all) err.write(`  ${container.name.padEnd(36)} ${container.folder}\n`)
	return null
}

/** The collector's compiled source plus the call that starts it streaming. */
export function collectorScript(intervalMs: number, once: boolean): string {
	const source = readFileSync(new URL('../lib/mem-collect.js', import.meta.url), 'utf8')
	return `${source}\nstream(${intervalMs}, ${once})\n`
}

export function mem(options: MemOptions): Promise<number> {
	const out = (options.out ?? process.stdout) as NodeJS.WriteStream
	const err = options.err ?? process.stderr
	const intervalMs = options.intervalMs ?? 2000
	const once = options.once ?? false
	const live = !once && !options.json && out.isTTY === true

	const history: MemSnapshot[] = []
	let source = 'this container'
	const show = (snapshot: MemSnapshot): void => {
		if (options.json) {
			out.write(`${JSON.stringify(snapshot)}\n`)
			return
		}
		// Δ is measured against the oldest snapshot still inside the last minute.
		history.push(snapshot)
		while (history.length > 1 && (history[0] as MemSnapshot).t < snapshot.t - 60_000) history.shift()
		const baseline = history.length > 1 ? history[0] : undefined
		const text = render(snapshot, baseline, {
			width: out.columns ?? 120,
			height: live ? out.rows : undefined,
			procs: options.procs ?? false,
			source: `${source} (${snapshot.host})`,
			intervalMs: once ? undefined : intervalMs,
		})
		out.write(live ? `\x1b[H\x1b[2J${text}` : text)
	}

	if (live) out.write('\x1b[?25l')
	const restore = (): void => {
		if (live) out.write('\x1b[?25h')
	}

	if (!options.host && insideContainer()) {
		show(collect())
		if (once) return Promise.resolve(0)
		const timer = setInterval(() => show(collect()), intervalMs)
		return new Promise((resolve) => {
			process.once('SIGINT', () => {
				clearInterval(timer)
				restore()
				resolve(0)
			})
		})
	}

	let containerId = options.container
	if (containerId === undefined) {
		if (!hasDocker()) {
			err.write('devc mem: not inside a container and docker is not on PATH\n')
			restore()
			return Promise.resolve(1)
		}
		const found = findContainer(options, err)
		if (found === null) {
			restore()
			return Promise.resolve(1)
		}
		containerId = found.id
		source = `container ${found.name}`
	} else {
		source = `container ${containerId}`
	}

	const child = spawn('docker', ['exec', '-i', containerId, 'node', '--input-type=module', '-'], {
		stdio: ['pipe', 'pipe', 'inherit'],
	})
	child.stdin.end(collectorScript(intervalMs, once))
	createInterface({ input: child.stdout }).on('line', (line) => {
		if (line.startsWith('{')) show(JSON.parse(line) as MemSnapshot)
	})
	return new Promise((resolve) => {
		let interrupted = false
		process.once('SIGINT', () => {
			interrupted = true
			child.kill()
		})
		child.on('error', (error) => {
			err.write(`devc mem: docker exec failed: ${error.message}\n`)
		})
		child.on('close', (code) => {
			restore()
			resolve(interrupted || code === 0 ? 0 : 1)
		})
	})
}
