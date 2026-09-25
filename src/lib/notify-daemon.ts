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
import { isAbsolute, join, resolve } from 'node:path'
import type { Logger } from './logger.js'
import { relativeTo } from './paths.js'
import { isAlive, sleep, tailFile } from './proc.js'
import { CLI_NAME, CLI_VERSION, PACKAGE_ROOT } from './version.js'

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

/** The daemon this package vendors. Exported for the tarball coverage test. */
export const VENDORED_NOTIFY_DIR: string = join(PACKAGE_ROOT, 'notify')

/** A resolved daemon: where it is, where that came from, and how to fix it. */
interface DaemonSource {
	entrypoint: string
	origin: string
	repair: string
}

/**
 * NOTIFY_DAEMON_DIR, else the copy this package ships.
 *
 * The override takes an absolute path or one relative to `devcontainerDir`, so
 * the dogfood's .env can say `NOTIFY_DAEMON_DIR=notify` — the tree that
 * develops the daemon must not run the published copy — and stay portable
 * between machines.
 *
 * It is read from the merged map, where .env wins over the host environment.
 * That is the rule every other key follows (`set -a; source .env`,
 * initialize.ts:189-192); a second precedence rule for one key would be the
 * surprise, not the consistency.
 */
function resolveDaemon(devcontainerDir: string, env: NodeJS.ProcessEnv): DaemonSource {
	const override = env['NOTIFY_DAEMON_DIR']
	if (override !== undefined && override.length > 0) {
		const dir = isAbsolute(override) ? override : resolve(devcontainerDir, override)
		return {
			entrypoint: join(dir, 'index.js'),
			origin: `NOTIFY_DAEMON_DIR=${override}`,
			repair: 'unset NOTIFY_DAEMON_DIR in .devcontainer/.env to use the copy this package ships',
		}
	}
	return {
		entrypoint: join(VENDORED_NOTIFY_DIR, 'index.js'),
		origin: `vendored ${CLI_NAME}@${CLI_VERSION}`,
		repair: `reinstall ${CLI_NAME} — the notify/ directory it ships is missing`,
	}
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

	// Read once, above everything else: the same map chooses the daemon directory
	// and is handed to the spawned process, so the two cannot diverge. The daemon
	// reads NOTIFY_CHANNELS, NOTIFY_SOUND, NOTIFY_DISCORD_WEBHOOK_URL… from its
	// environment, and initialize.sh gave it the whole .env through
	// `set -a; source "$ENV_FILE"` (initialize.sh:115). Without it the daemon
	// booted with NOTIFY_CHANNELS unset — `all`, so the opt-in `notify` binary
	// never came up and the osascript fallback fired instead. .env wins over the
	// host environment, as `source` did.
	const env = { ...process.env, ...readEnvFile(join(devcontainerDir, '.env')) }
	const source = resolveDaemon(devcontainerDir, env)

	// The queue does not follow the daemon. locate.js derived it from the cwd,
	// and the spawn passed cwd = projectDir; now that the daemon can run from the
	// npx cache, that would put the queue under ~/.npm/_npx/<hash>/…/notify/queue/
	// while this CLI watched the project — lockfile never seen, every spawn
	// classified `crashed`. It is passed as a positional instead (locate.js rule
	// 1, index.js:203), which retires the dependency on cwd altogether: index.js:204
	// derives projectDir from it too.
	const queueDir = join(devcontainerDir, 'tmp', 'notify')
	const logFile = join(queueDir, 'daemon.log')
	const pidFile = join(queueDir, '.daemon.pid')
	const startupFile = join(queueDir, '.daemon.startup')

	if (!existsSync(source.entrypoint)) {
		// A bare tree used to mean "no daemon here", and the silent return was
		// right. With a copy shipped in the tarball, it is an anomaly.
		logger.log(`⚠ Notify daemon : no index.js at ${source.entrypoint} (${source.origin})`)
		logger.log(`  ${source.repair}`)
		return
	}

	if (options.dryRun) {
		const rel = relativeTo(devcontainerDir, source.entrypoint)
		logger.log(`→ Notify daemon : [dry-run] would spawn ${rel} (${source.origin})`)
		return
	}

	mkdirSync(queueDir, { recursive: true })

	// The screen gets the outcome, the log gets the diagnosis. The origin suffix
	// is what was missing: no copy of the daemon carried a version marker, so a
	// project 20 days stale read exactly like one on the current build.
	const entrypointRel = relativeTo(devcontainerDir, source.entrypoint)
	logger.rawToLogOnly(`ℹ Notify daemon : node=${process.execPath}`)
	logger.rawToLogOnly(`ℹ Notify daemon : entrypoint=${entrypointRel} (${source.origin})`)
	logger.rawToLogOnly(`ℹ Notify daemon : logfile=${relativeTo(devcontainerDir, logFile)}`)

	// Marker in daemon.log so whatever the daemon writes (or fails to write)
	// after this point can be correlated with this particular attempt.
	appendFileSync(logFile, `\n=== devc initialize spawn attempt ${new Date().toISOString()} ===\n`, 'utf8')

	// Wipe any residual status file BEFORE spawning, otherwise the poll below
	// could read STATUS lines left by a crashed daemon that wrote its readback
	// and then died. The new daemon rewrites this file atomically once its
	// consumers have initialised.
	rmSync(startupFile, { force: true })

	const newPid = launchDetached(source.entrypoint, queueDir, projectDir, logFile, env)
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
			logger.rawToLogOnly(
				`ℹ Notify daemon already running (pid ${outcome.ownerPid}) — attempt pid ${newPid} exited cleanly`,
			)
			break
		case 'booting':
			logger.rawToLogOnly(
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
 * The queue directory is passed as the daemon's positional argument, which is
 * what makes the daemon's own location irrelevant — it derives both the queue
 * and the project root from it (index.js:203-204). cwd stays the project root
 * anyway, as the last resort of locate.js's rules.
 *
 * @remarks
 * `--launcher-pid` is a divergence worth naming. Bash passed `$PPID`, the
 * parent of the shell VS Code invoked. Here it is `process.ppid`, the parent of
 * *this* process — the same thing today, but under the planned
 * `exec npx @meitogi/devcontainer-cli` shim it would name the npx process
 * instead. `notify/lib/launcher-watch.js` already walks up the tree, so this is
 * flagged for host verification rather than worked around blind.
 */
function launchDetached(
	entrypoint: string,
	queueDir: string,
	cwd: string,
	logFile: string,
	env: NodeJS.ProcessEnv,
): number | null {
	let fd: number | null = null
	try {
		fd = openSync(logFile, 'a')
		const child = spawn(process.execPath, [entrypoint, queueDir, `--launcher-pid=${process.ppid}`], {
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
			logger.rawToLogOnly(`ℹ Notify daemon : channels=${channels}`)
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
