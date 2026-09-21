// Child processes: spawning, environment scrubbing, and the POSIX ancestry
// walk that `detect_no_cache_request` and `dump_rebuild_context` both need.

import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { LineSplitter } from './lines.js'
import { CommandFailed } from './logger.js'

/**
 * The six variables stripped before `docker build`.
 *
 * mitmproxy listens on 127.0.0.1:8080 *inside the runtime container only*.
 * Leaking these into the build makes apt / curl / npm inside the image dial a
 * dead port. Both cases are listed because `env -u` in the bash version listed
 * both, and a build tool may read either.
 */
export const PROXY_VARS: readonly string[] = [
	'HTTPS_PROXY',
	'HTTP_PROXY',
	'NO_PROXY',
	'https_proxy',
	'http_proxy',
	'no_proxy',
]

/** `env -u A -u B …` as a plain object. Never mutates the input. */
export function scrubEnv(base: NodeJS.ProcessEnv, unset: readonly string[]): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...base }
	for (const key of unset) delete out[key]
	return out
}

export interface RunOptions {
	argv: readonly string[]
	cwd?: string
	env?: NodeJS.ProcessEnv
	unsetEnv?: readonly string[]
	/** Called once per whole line, stdout and stderr merged in arrival order. */
	onLine?: (line: string) => void
	/** `set -e` equivalent — throw {@link CommandFailed} on a non-zero exit. */
	check?: boolean
	/** Extra context attached to a thrown {@link CommandFailed}. */
	logPath?: string
	/** Injected in tests. */
	spawnFn?: typeof spawn
}

export interface RunResult {
	code: number
	ms: number
}

/**
 * Spawn a command, stream its merged output line by line, resolve its exit code.
 *
 * `shell: false` always — there is no shell to need, and array argv sidesteps
 * the Windows quoting minefield entirely (design §7 "Node pur, spawn avec
 * array args").
 *
 * stdin is `ignore` rather than `inherit`: a `docker build` that inherited the
 * terminal could swallow the keystrokes meant for the Claude-mode prompt that
 * runs later.
 */
export function run(options: RunOptions): Promise<RunResult> {
	const argv = options.argv
	const command = argv[0]
	if (command === undefined) throw new Error('run() called with an empty argv')

	const env = options.unsetEnv === undefined ? options.env : scrubEnv(options.env ?? process.env, options.unsetEnv)
	const spawnOptions: SpawnOptions = {
		cwd: options.cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: false,
	}

	return new Promise<RunResult>((resolve, reject) => {
		const started = Date.now()
		const child = (options.spawnFn ?? spawn)(command, argv.slice(1), spawnOptions)

		const emit = options.onLine ?? ((): void => {})
		const splitters = [new LineSplitter(emit), new LineSplitter(emit)]
		child.stdout?.on('data', (chunk: Buffer) => splitters[0]?.push(chunk))
		child.stderr?.on('data', (chunk: Buffer) => splitters[1]?.push(chunk))

		child.on('error', (error) => reject(error))
		child.on('close', (code) => {
			for (const splitter of splitters) splitter.flush()
			const result: RunResult = { code: code ?? 1, ms: Date.now() - started }
			if (result.code !== 0 && options.check !== false) {
				reject(new CommandFailed(argv, result.code, options.logPath))
				return
			}
			resolve(result)
		})
	})
}

/**
 * Synchronous capture of a short command's stdout, or `null` when it is not
 * usable.
 *
 * The bash idiom `x=$(cmd 2>/dev/null) || fallback` shows up throughout
 * initialize.sh for things that must not be allowed to abort the run:
 * `wslpath`, `ps`, `docker --version`. Synchronous because every call site is
 * a one-shot value read in the middle of otherwise linear code.
 */
export function runCapture(argv: readonly string[], cwd?: string): string | null {
	const command = argv[0]
	if (command === undefined) return null
	try {
		const result = spawnSync(command, argv.slice(1), {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			shell: false,
		})
		if (result.error !== undefined || result.status !== 0) return null
		return result.stdout
	} catch {
		return null
	}
}

/**
 * `command -v <name>` — whether an executable is reachable.
 *
 * `command` is a shell builtin and there is no shell here, so the spawnable
 * equivalents stand in: `which` on POSIX, `where` on Windows.
 */
export function hasCommand(name: string): boolean {
	const argv = process.platform === 'win32' ? ['where', name] : ['which', name]
	return runCapture(argv) !== null
}

export interface ProcessInfo {
	pid: number
	ppid: number | null
	args: string
}

/**
 * One `ps` reading. POSIX only.
 *
 * Windows has no `ps`, and the callers already treat a missing reading as
 * "unknown" rather than an error — see the ancestry walk below.
 */
export function readProcess(pid: number): ProcessInfo | null {
	if (process.platform === 'win32') return null
	const args = runCapture(['ps', '-o', 'args=', '-p', String(pid)])
	if (args === null) return null
	const ppidRaw = runCapture(['ps', '-o', 'ppid=', '-p', String(pid)])
	const ppid = ppidRaw === null ? null : Number.parseInt(ppidRaw.trim(), 10)
	return {
		pid,
		ppid: ppid === null || Number.isNaN(ppid) ? null : ppid,
		args: args.trim(),
	}
}

/** Walk from `startPid` towards PID 1, at most `maxDepth` hops. */
export function ancestry(startPid: number, maxDepth: number): ProcessInfo[] {
	const chain: ProcessInfo[] = []
	let pid: number | null = startPid
	for (let depth = 0; depth < maxDepth && pid !== null && pid > 1; depth++) {
		const info: ProcessInfo | null = readProcess(pid)
		if (info === null) break
		chain.push(info)
		pid = info.ppid
	}
	return chain
}

/** Last `count` lines of a file, for the failure tails. */
export function tailFile(path: string, count: number): string[] {
	if (!existsSync(path)) return []
	const lines = readFileSync(path, 'utf8').split('\n')
	if (lines[lines.length - 1] === '') lines.pop()
	return lines.slice(-count)
}

/** `kill -0 <pid>` — liveness without signalling. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
