// Lifecycle logging — the Node answer to initialize.sh:57-111.
//
// Bash solved this with file descriptors. `exec 3>&1` saved the real terminal,
// `exec > >(tee -a "$INIT_LOG") 2>&1` teed everything (the script's own output
// AND every child's) into the log, `BASH_XTRACEFD` sent xtrace to a third
// channel, and a `trap ERR` reported the failing line.
//
// None of that has an equivalent here, and none of it is needed. There is one
// rule instead: every byte goes through a Logger, which fans out to the
// terminal and to an append sink. Two consequences fall out for free —
// `ORIG_STDOUT_TTY` disappears (nothing is redirected, so process.stdout.isTTY
// is already the truth), and the "cursor escapes must not reach the .log"
// problem vanishes with the shared fd that caused it.

import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** ESC, spelled out rather than embedded raw so the source stays greppable. */
export const ESC = '\u001B'

/** Minimal append-only sink. Abstracted so tests can capture in memory. */
export interface LineSink {
	write(text: string): void
	close(): void
}

export interface LoggerOptions {
	logFile: string
	traceFile?: string | undefined
	debug?: boolean
	out?: NodeJS.WritableStream
	err?: NodeJS.WritableStream
	isTTY?: boolean
	openSink?: (path: string) => LineSink
	/** Injected so `--dry-run` and tests can suppress every file write. */
	silentSink?: boolean
}

/**
 * A structured trace event.
 *
 * @remarks
 * `DEBUG=1` used to enable `set -x`, one line per shell command. Node has no
 * such granularity and never will, so pretending to reproduce it would be a
 * lie. What the xtrace channel was actually *used* for — reconstructing which
 * branch fired, what argv was spawned, what the environment looked like — is
 * captured directly instead, in the same `+ file: ` shape so the old
 * `grep '^+ '` habit still works. Timings and the env delta are new; the
 * bash xtrace never had either.
 */
export type TraceEvent =
	| { kind: 'step'; message: string }
	| { kind: 'spawn'; argv: readonly string[]; cwd?: string; unsetEnv?: readonly string[] }
	| { kind: 'exit'; argv: readonly string[]; code: number | null; ms: number }
	| { kind: 'fs'; op: 'write' | 'mkdir' | 'remove' | 'copy'; path: string }
	| { kind: 'decide'; name: string; value: string; why: string }

/** Thrown when a spawned command exits non-zero and the caller asked to check. */
export class CommandFailed extends Error {
	constructor(
		readonly argv: readonly string[],
		readonly code: number,
		readonly logPath?: string,
	) {
		super(`command failed (exit ${code}): ${argv.join(' ')}`)
		this.name = 'CommandFailed'
	}
}

export class Logger {
	private constructor(
		readonly logPath: string,
		readonly tracePath: string | null,
		readonly isTTY: boolean,
		private readonly out: NodeJS.WritableStream,
		private readonly err: NodeJS.WritableStream,
		private readonly sink: LineSink | null,
		private readonly traceSink: LineSink | null,
	) {}

	static create(options: LoggerOptions): Logger {
		const debug = options.debug ?? false
		const open = options.openSink ?? openFileSink
		const sink = options.silentSink === true ? null : open(options.logFile)

		// Mirrors the bash `rm -f "$INIT_TRACE"` in the non-debug branch: a
		// stale trace from a previous DEBUG run must not look like this run's.
		let traceSink: LineSink | null = null
		let tracePath: string | null = null
		if (options.traceFile !== undefined) {
			if (debug && options.silentSink !== true) {
				traceSink = open(options.traceFile)
				tracePath = options.traceFile
			} else if (options.silentSink !== true) {
				rmSync(options.traceFile, { force: true })
			}
		}

		return new Logger(
			options.logFile,
			tracePath,
			options.isTTY ?? Boolean(process.stdout.isTTY),
			options.out ?? process.stdout,
			options.err ?? process.stderr,
			sink,
			traceSink,
		)
	}

	/** Plain line to terminal + log. */
	log(message = ''): void {
		this.out.write(`${message}\n`)
		this.sink?.write(`${message}\n`)
	}

	/**
	 * Coloured on the terminal, plain in the log.
	 *
	 * This is the whole reason bash needed fd 3. Here the two destinations are
	 * simply written differently.
	 */
	styled(sgr: string, message: string): void {
		this.out.write(this.isTTY ? `${ESC}[${sgr}m${message}${ESC}[0m\n` : `${message}\n`)
		this.sink?.write(`${message}\n`)
	}

	error(message: string): void {
		this.err.write(`${message}\n`)
		this.sink?.write(`${message}\n`)
	}

	/** A line produced by a child process. */
	raw(line: string): void {
		this.out.write(`${line}\n`)
		this.sink?.write(`${line}\n`)
	}

	/** A child line that belongs in the log only (the rolling window draws it). */
	rawToLogOnly(line: string): void {
		this.sink?.write(`${line}\n`)
	}

	/**
	 * A line that carries its own SGR, already composed.
	 *
	 * `styled` wraps a whole message, which is enough for a standalone line. A
	 * panel row is not one: the frame must stay plain while the value inside it
	 * carries the state, the way the image's boot panel draws it. The caller
	 * composes both halves; this keeps the fork — escapes to the terminal, plain
	 * text to the log — in the one place that owns it.
	 */
	composed(terminal: string, plain: string): void {
		this.out.write(`${this.isTTY ? terminal : plain}\n`)
		this.sink?.write(`${plain}\n`)
	}

	trace(event: TraceEvent): void {
		if (this.traceSink === null) return
		this.traceSink.write(`+ ${formatTrace(event)}\n`)
	}

	/**
	 * The `trap ERR` analogue (initialize.sh:108).
	 *
	 * Bash printed `file:line (exit N): command`. `CommandFailed` carries the
	 * argv, and the top user frame supplies file:line — provided source maps
	 * are on, which `bin/devc.mjs` arranges.
	 */
	fail(error: unknown): void {
		if (error instanceof CommandFailed) {
			this.error(`✗ FAIL at ${topFrame(error)} (exit ${error.code}): ${error.argv.join(' ')}`)
			if (error.logPath !== undefined) this.error(`  Full log: ${error.logPath}`)
			return
		}
		const message = error instanceof Error ? error.message : String(error)
		this.error(`✗ FAIL at ${topFrame(error)}: ${message}`)
	}

	close(): void {
		this.sink?.close()
		this.traceSink?.close()
	}
}

/**
 * Synchronous append sink.
 *
 * Deliberately `writeSync` rather than a `createWriteStream`. It buys
 * line-granular durability (a hard kill loses nothing, matching `tee -a`),
 * guaranteed ordering against `process.stdout` writes, and no flush-before-exit
 * dance. The cost is irrelevant for a host script writing a few hundred KB.
 */
function openFileSink(path: string): LineSink {
	mkdirSync(dirname(path), { recursive: true })
	const fd = openSync(path, 'a')
	let closed = false
	return {
		write(text) {
			if (!closed) writeSync(fd, text)
		},
		close() {
			if (closed) return
			closed = true
			closeSync(fd)
		},
	}
}

function formatTrace(event: TraceEvent): string {
	switch (event.kind) {
		case 'step':
			return `step ${event.message}`
		case 'spawn': {
			const cwd = event.cwd === undefined ? '' : ` cwd=${event.cwd}`
			const unset =
				event.unsetEnv === undefined || event.unsetEnv.length === 0
					? ''
					: ` unset=[${event.unsetEnv.join(',')}]`
			return `spawn argv=${JSON.stringify(event.argv)}${cwd}${unset}`
		}
		case 'exit':
			return `exit code=${String(event.code)} ms=${event.ms} argv=${JSON.stringify(event.argv)}`
		case 'fs':
			return `fs ${event.op} ${event.path}`
		case 'decide':
			return `decide ${event.name}=${event.value} why="${event.why}"`
	}
}

/** First stack frame belonging to this package, formatted `file:line`. */
function topFrame(error: unknown): string {
	const stack = error instanceof Error ? (error.stack ?? '') : ''
	for (const line of stack.split('\n').slice(1)) {
		const match = /\(?([^()\s]+[/\\][^()\s]+):(\d+):\d+\)?$/.exec(line.trim())
		if (match === null) continue
		const file = match[1] as string
		if (file.includes('node:internal')) continue
		return `${file.split('/').pop() ?? file}:${match[2] as string}`
	}
	return 'devc'
}

/**
 * Install the process-level halves of the ERR trap.
 *
 * `set -e` itself is reproduced elsewhere: `run()` defaults to `check: true`,
 * so a non-zero child throws rather than being silently stepped over. This
 * catches what escapes that — a throw from anywhere else, and the forgotten
 * `await` that would otherwise surface as an unhandled rejection.
 */
export function installFailureHandlers(logger: Logger): void {
	const report = (error: unknown): void => {
		logger.fail(error)
		logger.close()
		process.exit(1)
	}
	process.on('uncaughtException', report)
	process.on('unhandledRejection', report)
}
