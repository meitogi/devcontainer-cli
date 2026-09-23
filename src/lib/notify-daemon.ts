// Host-side notify daemon spawn — the port of initialize/notify-daemon.sh.
//
// The daemon is a long-lived Node process that watches the container's JSONL
// notification queue and raises desktop notifications. It outlives this CLI,
// self-exits once the container is gone, and owns its own pid lockfile, so
// re-spawning is idempotent.
//
// === What was dropped, and why ===
//
// The bash file is 357 lines, of which 180 are `_notify_daemon_diag`: an
// exhaustive host / shell / PATH / node-manager dump printed when `command -v
// node` came up empty. That failure had one cause — VS Code's
// initializeCommand runs a non-login shell, so the ~/.zshrc line that
// initialises nvm never ran, and a host with node installed looked like a host
// without one.
//
// A Node CLI cannot reach that state. `process.execPath` is the interpreter
// already executing this code: always present, and always satisfying the
// package's own `engines: >=18`. The nvm auto-sourcing branch, the
// node-not-found diagnostic and the node-major-version check are therefore all
// structurally unreachable, and are gone rather than ported into code that can
// never run. If node is missing from the host, the failure now happens
// upstream — at `npx`, before this package is even fetched.

import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs'
import { readEnvFile } from './env-file.js'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Logger } from './logger.js'
import { relativeTo } from './paths.js'
import { isAlive, sleep, tailFile } from './proc.js'

export interface NotifyDaemonOptions {
	logger: Logger
	devcontainerDir: string
	projectDir: string
	dryRun: boolean
	/** Overridable so the differential harness can keep the wait short. */
	settleMs?: number
	startupPollMs?: number
	startupPollAttempts?: number
}

/**
 * Spawn the daemon and report what happened.
 *
 * Never throws: the bash version was invoked as `spawn_notify_daemon || true`,
 * because a missing desktop notifier must not stop a container from coming up.
 */
export async function spawnNotifyDaemon(options: NotifyDaemonOptions): Promise<void> {
	try {
		await spawnNotifyDaemonUnguarded(options)
	} catch (error) {
		// `spawn_notify_daemon || true` (initialize.sh:656). An unwritable queue
		// directory or a full disk must not be the reason a container fails to
		// come up — the daemon is a convenience, not a dependency.
		options.logger.log(`⚠ Notify daemon : ${error instanceof Error ? error.message : String(error)} — skipping`)
	}
}

async function spawnNotifyDaemonUnguarded(options: NotifyDaemonOptions): Promise<void> {
	const { logger, devcontainerDir, projectDir } = options
	const daemonDir = join(devcontainerDir, 'notify')
	const entrypoint = join(daemonDir, 'index.js')
	const queueDir = join(daemonDir, 'queue')
	const logFile = join(queueDir, 'daemon.log')
	const pidFile = join(queueDir, '.daemon.pid')
	const startupFile = join(queueDir, '.daemon.startup')

	if (!existsSync(entrypoint)) return

	if (options.dryRun) {
		logger.log(`ℹ Notify daemon : [dry-run] would spawn ${relativeTo(devcontainerDir, entrypoint)}`)
		return
	}

	mkdirSync(queueDir, { recursive: true })

	logger.log(`ℹ Notify daemon : node=${process.execPath}`)
	logger.log(`ℹ Notify daemon : entrypoint=${relativeTo(devcontainerDir, entrypoint)}`)
	logger.log(`ℹ Notify daemon : logfile=${relativeTo(devcontainerDir, logFile)}`)

	// Marker in daemon.log so whatever the daemon writes (or fails to write)
	// after this point can be correlated with this particular attempt.
	appendFileSync(logFile, `\n=== devc initialize spawn attempt ${new Date().toISOString()} ===\n`, 'utf8')

	// Wipe any residual status file BEFORE spawning, otherwise the poll below
	// could read STATUS lines left by a crashed daemon that wrote its readback
	// and then died. The new daemon rewrites this file atomically once its
	// consumers have initialised.
	rmSync(startupFile, { force: true })

	// The daemon reads NOTIFY_CHANNELS, NOTIFY_SOUND, NOTIFY_DISCORD_WEBHOOK_URL…
	// from its environment, and initialize.sh gave it the whole .env through
	// `set -a; source "$ENV_FILE"` (initialize.sh:115). Without this the daemon
	// booted with NOTIFY_CHANNELS unset — `all`, so the opt-in `notify` binary
	// never came up and the osascript fallback fired instead. .env wins over
	// the host environment, as `source` did.
	const env = { ...process.env, ...readEnvFile(join(devcontainerDir, '.env')) }
	const newPid = launchDetached(entrypoint, projectDir, logFile, env)
	if (newPid === null) {
		logger.log('⚠ Notify daemon : spawn failed — skipping')
		return
	}

	// Give it ~1 s to claim the lockfile, bow out via the existing-daemon
	// guard, or crash.
	await sleep(options.settleMs ?? 1000)
	const outcome = classifySpawn(pidFile, newPid)
	const logRel = relativeTo(devcontainerDir, logFile)
	switch (outcome.kind) {
		case 'owned':
			logger.log(`✓ Notify daemon spawned (pid ${newPid} owns lockfile, log: ${logRel})`)
			break
		case 'already-running':
			logger.log(
				`ℹ Notify daemon already running (pid ${outcome.ownerPid}) — attempt pid ${newPid} exited cleanly`,
			)
			break
		case 'booting':
			logger.log(
				`ℹ Notify daemon : pid ${newPid} still alive but no lockfile yet — may still be initializing (log: ${logRel})`,
			)
			break
		case 'crashed':
			logger.log(`⚠ Notify daemon : pid ${newPid} gone, no lockfile claim — likely crashed silently.`)
			logger.log(`  Last 20 lines of ${logRel} :`)
			for (const line of tailFile(logFile, 20)) logger.log(`    ${line}`)
			return
	}

	await reportChannels({
		logger,
		startupFile,
		logFile,
		logRel,
		pollMs: options.startupPollMs ?? 100,
		attempts: options.startupPollAttempts ?? 30,
	})
}

/**
 * `nohup … & disown` in Node.
 *
 * `detached: true` puts the child in its own process group so a signal aimed at
 * this CLI does not reach it, and `unref()` lets this process exit while the
 * daemon keeps running.
 *
 * cwd is the project root because the daemon derives its queue directory from
 * the working directory.
 *
 * @remarks
 * `--launcher-pid` is a divergence worth naming. Bash passed `$PPID`, the
 * parent of the shell VS Code invoked. Here it is `process.ppid`, the parent of
 * *this* process — the same thing today, but under the planned
 * `exec npx @meitogi/devcontainer-cli` shim it would name the npx process
 * instead. `notify/lib/launcher-watch.js` already walks up the tree, so this is
 * flagged for host verification rather than worked around blind.
 */
function launchDetached(entrypoint: string, cwd: string, logFile: string, env: NodeJS.ProcessEnv): number | null {
	let fd: number | null = null
	try {
		fd = openSync(logFile, 'a')
		const child = spawn(process.execPath, [entrypoint, `--launcher-pid=${process.ppid}`], {
			cwd,
			env,
			detached: true,
			stdio: ['ignore', fd, fd],
		})
		child.unref()
		return child.pid ?? null
	} catch {
		return null
	} finally {
		if (fd !== null) closeSync(fd)
	}
}

type SpawnOutcome =
	| { kind: 'owned' }
	| { kind: 'already-running'; ownerPid: number }
	| { kind: 'booting' }
	| { kind: 'crashed' }

function classifySpawn(pidFile: string, newPid: number): SpawnOutcome {
	const ownerPid = readPid(pidFile)
	if (ownerPid === newPid) return { kind: 'owned' }
	if (ownerPid !== null && isAlive(ownerPid)) return { kind: 'already-running', ownerPid }
	if (isAlive(newPid)) return { kind: 'booting' }
	return { kind: 'crashed' }
}

function readPid(pidFile: string): number | null {
	if (!existsSync(pidFile)) return null
	const parsed = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
	return Number.isNaN(parsed) ? null : parsed
}

interface ChannelReportOptions {
	logger: Logger
	startupFile: string
	logFile: string
	logRel: string
	pollMs: number
	attempts: number
}

/**
 * Read back which notification channels came up.
 *
 * The daemon writes `queue/.daemon.startup` atomically once every consumer's
 * `start()` has returned. Two line shapes:
 *
 *     STATUS <name> <ok|skipped|fail> [k=v]...
 *     READY  pid=<n> channels=<csv>
 *
 * ~3 s of polling covers the worst case, which is the Linux sound probe walking
 * paplay / aplay / ffplay; consumer init is under 100 ms in practice.
 */
async function reportChannels(options: ChannelReportOptions): Promise<void> {
	const { logger, startupFile } = options
	for (let i = 0; i < options.attempts && !existsSync(startupFile); i++) {
		await sleep(options.pollMs)
	}

	if (!existsSync(startupFile)) {
		const seconds = Math.round((options.attempts * options.pollMs) / 100) / 10
		logger.log(`⚠ Notify daemon : startup file absent after ${seconds}s — tail ${options.logRel} :`)
		for (const line of tailFile(options.logFile, 5)) logger.log(`    ${line}`)
		return
	}

	for (const line of readFileSync(startupFile, 'utf8').split('\n')) {
		const status = parseStatusLine(line)
		if (status !== null) {
			logger.styled(SGR_BY_STATUS[status.state], `  ${GLYPH_BY_STATUS[status.state]} ${status.rest}`)
			continue
		}
		if (line.startsWith('READY ')) {
			const channels = /channels=(\S*)/.exec(line)?.[1] ?? ''
			logger.log(`ℹ Notify daemon : channels=${channels}`)
		}
	}
}

type ChannelState = 'ok' | 'skipped' | 'fail'

const GLYPH_BY_STATUS: Record<ChannelState, string> = { ok: '[✓]', skipped: '[-]', fail: '[x]' }
const SGR_BY_STATUS: Record<ChannelState, string> = { ok: '32', skipped: '90', fail: '31' }

function parseStatusLine(line: string): { state: ChannelState; rest: string } | null {
	if (!line.startsWith('STATUS ')) return null
	const rest = line.slice('STATUS '.length)
	// `STATUS <name> <state> [k=v]...` — the state is the second field.
	const state = rest.split(/\s+/)[1]
	if (state !== 'ok' && state !== 'skipped' && state !== 'fail') return null
	return { state, rest }
}
