// `devc initialize` — the host-side step VS Code runs before the container
// exists, via `initializeCommand`.
//
// Port of .devcontainer/initialize.sh (663 lines). Execution order below is
// the bash file's order; each block names the lines it came from so the two
// can be diffed by hand for as long as both exist.
//
// One behaviour is a union rather than a copy: the dogfood script writes
// logs/host-os and the shipped template copies bootstrap a .vscode/settings.json
// stub. Neither has both. This command supersedes both files, and each half is
// a real fix, so both are here.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline/promises'
import { dirname, join } from 'node:path'
import { projectCustomizations, readStitchuCustomizations } from '../lib/devcontainer-json.js'
import {
	baseImageTag,
	DEFAULT_CLAUDE_CODE_VERSION,
	detectRebuildSignals,
	hasDocker,
	volumeCreate,
} from '../lib/docker.js'
import { readEnvFile, setEnvVar, unsetEnvVar } from '../lib/env-file.js'
import { Logger } from '../lib/logger.js'
import { spawnNotifyDaemon } from '../lib/notify-daemon.js'
import {
	classifyDevcontainer,
	defaultProjectId,
	relativeTo,
	resolveProjectPaths,
	type ProjectPaths,
} from '../lib/paths.js'
import {
	detectHostKind,
	isBareWin32,
	isSupported,
	readHostProbe,
	writeHostOs,
	type HostKind,
	type HostProbe,
} from '../lib/platform.js'
import { dumpRebuildContext } from '../lib/rebuild-debug.js'

export interface InitializeOptions {
	devcontainerDir?: string | undefined
	dryRun: boolean
	cwd: string
	/** Stream whose TTY-ness decides interactive vs non-interactive. */
	input?: NodeJS.ReadableStream & { isTTY?: boolean }
	/**
	 * How a question gets answered. Defaults to a readline interface over
	 * `input`, opened on first use and closed once the prompts are done.
	 *
	 * Injectable because driving readline from a test means feeding a fake
	 * stream, and readline's auto-close-on-EOF makes that a fight rather than a
	 * test. The seam is the question, not the bytes behind it.
	 */
	ask?: (question: string) => Promise<string>
	/**
	 * Where human-facing output goes. Defaults to the real terminal.
	 *
	 * Injectable for the same reason `ask` is: a test that lets this command
	 * write to the real stdout dumps hundreds of lines into whatever is reading
	 * it. Under `node --test` that is the runner's own IPC channel, and enough
	 * interleaved output corrupts its frames outright.
	 */
	out?: NodeJS.WritableStream
	err?: NodeJS.WritableStream
	probe?: HostProbe
}

export const INITIALIZE_HELP = `devc initialize — host-side pre-container setup

Runs before the devcontainer is built (VS Code initializeCommand): host-OS
detection, firewall file seeding, .env synchronisation, credentials volume,
and the first-run prompts. The base image is pulled by compose from its
published tag, never built here.

Usage:
  devc initialize [options]

Options:
  --devcontainer-dir <path>  Target .devcontainer directory
                             (default: ./.devcontainer, or . when already inside)
  --dry-run                  Report every decision, write nothing, run no docker
  -h, --help                 Show this help

Environment:
  DEBUG=1                    Write a structured decision trace next to the log
  DEBUG_REBUILD_CONTEXT=1    Dump the rebuild-signal diagnostic
`

/** Modes that keep the proxy/CA variables. Legacy names remain accepted. */
const PROXY_MODES = new Set(['strict', 'paranoid'])

const PROXY_SETTINGS: readonly { key: string; value: string }[] = [
	{ key: 'HTTPS_PROXY', value: 'http://127.0.0.1:8080' },
	{ key: 'HTTP_PROXY', value: 'http://127.0.0.1:8080' },
	{ key: 'NO_PROXY', value: 'localhost,127.0.0.0/8,host.docker.internal,.local' },
	{ key: 'NODE_EXTRA_CA_CERTS', value: '/var/lib/mitmproxy/mitmproxy-ca-cert.pem' },
]

export async function initialize(options: InitializeOptions): Promise<number> {
	const paths = resolveProjectPaths(options.cwd, options.devcontainerDir)
	const probe = options.probe ?? readHostProbe()

	// === Host-OS detection (initialize.sh:14-41) =============================
	const err = options.err ?? process.stderr
	const hostKind = detectHostKind(probe)
	if (!isSupported(hostKind)) {
		err.write(
			`✗ devc initialize does not support host kind: ${hostKind} (${probe.platform})\n` +
				'  Supported : Mac, native Linux, Windows-with-WSL, Windows-with-Git-Bash.\n',
		)
		return 1
	}
	if (isBareWin32(probe)) {
		// Unreachable today — bare win32 classifies as `unknown` and exits above.
		// Kept as the explicit home of the design §7 warning for when a native
		// Windows path is added.
		err.write('⚠ Running on native Windows outside WSL — WSL2 is the supported route.\n')
	}

	// === Precondition (no bash counterpart — see classifyDevcontainer) =======
	// Runs before the logger, because creating the log file is itself a write
	// into the directory being judged.
	const state = classifyDevcontainer(paths.devcontainerDir)
	if (state.kind !== 'present') {
		err.write(
			state.kind === 'absent'
				? `✗ No .devcontainer at ${paths.devcontainerDir}\n` +
						'  devc initialize prepares an existing devcontainer before it starts;\n' +
						'  it does not create one. Run "devc init" to scaffold a project.\n'
				: `✗ ${paths.devcontainerDir} has no devcontainer.json\n` +
						'  Nothing identifies it as a devcontainer, so there is nothing to\n' +
						'  prepare. Run "devc init" to scaffold one, or point\n' +
						'  --devcontainer-dir at the right project.\n',
		)
		return 1
	}

	// === Lifecycle logging (initialize.sh:57-111) ============================
	const timestamp = stamp(new Date())
	const logsDir = join(paths.devcontainerDir, 'logs')
	if (!options.dryRun) mkdirSync(logsDir, { recursive: true })
	const logger = Logger.create({
		logFile: join(logsDir, `initialize-${timestamp}.log`),
		traceFile: join(logsDir, `initialize-${timestamp}.trace`),
		debug: process.env['DEBUG'] === '1',
		silentSink: options.dryRun,
		...(options.out === undefined ? {} : { out: options.out }),
		...(options.err === undefined ? {} : { err: options.err }),
	})

	try {
		return await runInitialize({ options, paths, hostKind, logger, timestamp })
	} finally {
		logger.close()
	}
}

interface Context {
	options: InitializeOptions
	paths: ProjectPaths
	hostKind: HostKind
	logger: Logger
	timestamp: string
}

async function runInitialize(context: Context): Promise<number> {
	const { options, paths, hostKind, logger, timestamp } = context
	const { devcontainerDir, projectDir, envFile } = paths
	const dryRun = options.dryRun

	logger.log(`=== devc initialize ${new Date().toString()} ===`)
	logger.log(`  log:   ${relativeTo(devcontainerDir, logger.logPath)}`)
	logger.log(
		`  trace: ${logger.tracePath === null ? '(disabled — set DEBUG=1 in .env to enable)' : relativeTo(devcontainerDir, logger.tracePath)}`,
	)
	if (dryRun) logger.log('  mode:  dry-run (no writes, no build, no daemon — read-only probes still run)')

	// The host OS is only knowable here: this is the one component that runs on
	// the host, so it is the only place that can answer. See platform.ts.
	if (!dryRun) writeHostOs(devcontainerDir, hostKind)
	logger.trace({ kind: 'fs', op: 'write', path: join(devcontainerDir, 'logs', 'host-os') })

	// === .env (initialize.sh:113-123) ========================================
	// `set -a; source .env` assigns unconditionally, so a value in the file wins
	// over one inherited from the environment. Merge order matches that.
	const env = { ...process.env, ...readEnvFile(envFile) }
	const projectId = env['DC_PROJECT'] ?? defaultProjectId(projectDir)
	const credsVolume = env['CLAUDE_CREDS_VOLUME'] ?? `claude-creds-${projectId}`
	logger.log(`  DC_PROJECT:   ${projectId}`)
	logger.log(`  claude-creds: ${credsVolume}`)

	// === Firewall + sidecar seeding (initialize.sh:125-158) ==================
	// Must run before compose builds — the Dockerfile COPYs this directory.
	seedProjectFiles({ devcontainerDir, projectDir, logger, dryRun })

	if (dryRun) {
		logger.log(`ℹ [dry-run] would run: docker volume create ${credsVolume}`)
	} else if (hasDocker()) {
		volumeCreate(credsVolume)
	}

	const authFlag = join(devcontainerDir, '.configured-auth')
	const modeFlag = join(devcontainerDir, '.configured-claude-mode')
	const firewallFlag = join(devcontainerDir, 'firewall', 'default-mode')

	// === Team defaults -> .env projection (design §5.7) ======================
	projectTeamDefaults({ devcontainerDir, envFile, logger, dryRun })

	// === Optional rebuild diagnostic (initialize.sh:602-611) =================
	if (env['DEBUG_REBUILD_CONTEXT'] === '1' && !dryRun) {
		dumpRebuildContext({ logger, devcontainerDir, timestamp })
	}

	// === Base image version pin (initialize.sh:613-616) ======================
	const version = env['CLAUDE_CODE_VERSION'] ?? DEFAULT_CLAUDE_CODE_VERSION
	// Pin the version before anything probes docker. Bash did this at
	// initialize.sh:415, one line ahead of detect_no_cache_request at :417 —
	// nothing reads the value in between, but keeping the order means the .env
	// lands even when the probe dies.
	if (!dryRun) setEnvVar(envFile, 'CLAUDE_CODE_VERSION', version)

	// Rebuild-vs-reopen probe — informational since nothing is built locally:
	// compose resolves the published base tag. detectRebuildSignals self-guards
	// on docker.
	detectRebuildSignals({ hostKind, projectDir, devcontainerDir, logger })
	logger.trace({ kind: 'decide', name: 'baseImageTag', value: baseImageTag(version, projectId), why: 'resolved' })

	// === Non-interactive early exit (initialize.sh:618-632) ==================
	const input = options.input ?? process.stdin
	if (input.isTTY !== true) {
		if (!existsSync(authFlag)) {
			logger.log('ℹ Non-interactive: defaulting auth to standard.')
			writeFlag(authFlag, 'standard', dryRun, logger)
			if (!existsSync(modeFlag)) writeFlag(modeFlag, 'CLAUDE-dev.md', dryRun, logger)
		}
		if (!existsSync(firewallFlag)) {
			logger.log('ℹ Non-interactive: defaulting firewall to strict.')
			writeFlag(firewallFlag, 'strict', dryRun, logger)
		}
		syncProxyEnv(envFile, readMode(firewallFlag), dryRun, logger)
		printSummary({ devcontainerDir, modeFlag, firewallFlag, logger })
		return 0
	}

	// === Per-flag prompts (initialize.sh:634-643) ============================
	logger.log('')
	logger.log('=== DevContainer Setup ===')

	// One readline interface for the whole interactive section, created lazily.
	// Two separate interfaces over the same stream would lose whatever the first
	// had already buffered — bash's `read` shares stdin for the same reason.
	// Held in an object so the `finally` below still sees the interface the
	// closure created — a bare `let` gets narrowed to null across the call.
	const held: { readline: Interface | null } = { readline: null }
	const ask =
		options.ask ??
		(async (question: string): Promise<string> => {
			held.readline ??= createInterface({ input, output: options.out ?? process.stdout })
			return held.readline.question(question)
		})

	try {
		let promptedClaudeMode = false
		if (!existsSync(authFlag)) promptAuth({ authFlag, modeFlag, logger, dryRun })
		// Reachable only when .configured-claude-mode was deleted on its own:
		// promptAuth writes that flag itself when it is missing, exactly as
		// initialize.sh:526 does, so a genuine first run never gets here.
		if (!existsSync(modeFlag)) {
			await promptClaudeMode({ modeFlag, logger, dryRun, ask })
			promptedClaudeMode = true
		}
		if (!existsSync(firewallFlag)) {
			// No prompt since A4: strict is the intentional max-security baseline.
			// Flip with firewall-mode.sh, then rebuild.
			writeFlag(firewallFlag, 'strict', dryRun, logger)
			syncProxyEnv(envFile, 'strict', dryRun, logger)
			logger.log('✓ Firewall mode: strict (default — flip via firewall-mode.sh)')
		}

		// Idempotent re-sync: aligns .env with a manual edit of
		// firewall/default-mode made between rebuilds (initialize.sh:645-647).
		syncProxyEnv(envFile, readMode(firewallFlag), dryRun, logger)

		printSummary({ devcontainerDir, modeFlag, firewallFlag, logger })

		await spawnNotifyDaemon({ logger, devcontainerDir, projectDir, dryRun })

		// Pause only when an interactive prompt actually ran. promptAuth is a
		// silent info banner, so the Claude-mode prompt is the only trigger —
		// and per the comment above, it is rarely the one that fires.
		if (promptedClaudeMode && !dryRun) await ask('Press Enter to continue...')

		return 0
	} finally {
		held.readline?.close()
	}
}

interface SeedOptions {
	devcontainerDir: string
	projectDir: string
	logger: Logger
	dryRun: boolean
}

/**
 * Files that must exist before compose builds, because the Dockerfile COPYs
 * the directory recursively (initialize.sh:125-155, plus the template-only
 * .vscode stub).
 */
function seedProjectFiles(options: SeedOptions): void {
	const { devcontainerDir, projectDir, logger, dryRun } = options
	const firewallDir = join(devcontainerDir, 'firewall')

	// domains.local.txt is gitignored; default-mode and ports.txt are committed,
	// but a fresh clone may still need them seeded.
	touch(join(firewallDir, 'domains.local.txt'), dryRun, logger)
	if (isEmptyOrMissing(join(firewallDir, 'default-mode'))) {
		writeFlag(join(firewallDir, 'default-mode'), 'strict', dryRun, logger)
	}
	// ports.txt was called direct-tcp-allow.txt until 2026-08-10. Seed the new
	// name only when neither exists: a project still carrying the old file keeps
	// working, and never ends up with both (the firewall flags that).
	if (!existsSync(join(firewallDir, 'direct-tcp-allow.txt'))) {
		touch(join(firewallDir, 'ports.txt'), dryRun, logger)
	}
	if (!dryRun) mkdirSync(join(firewallDir, 'policy.local.d'), { recursive: true })

	// One-shot migration: .configured-firewall-mode -> firewall/default-mode.
	// After it, the flag file is the baked source of truth.
	const legacyFlag = join(devcontainerDir, '.configured-firewall-mode')
	if (existsSync(legacyFlag) && isEmptyOrMissing(join(firewallDir, 'default-mode'))) {
		if (!dryRun) copyFileSync(legacyFlag, join(firewallDir, 'default-mode'))
		logger.log(
			`${dryRun ? '  [dry-run] would migrate' : '→ migrated'} firewall mode : .configured-firewall-mode → firewall/default-mode`,
		)
	}

	// claude-bridge config must exist before compose runs: the bind mount
	// (./claude-bridge/config.json:/app/config.json:ro) would otherwise make
	// Docker create an empty directory there and the sidecar would crash.
	// A manual edit is preserved — the copy only fires when the file is absent.
	const bridgeDir = join(devcontainerDir, 'claude-bridge')
	const bridgeExample = join(bridgeDir, 'config.example.json')
	const bridgeConfig = join(bridgeDir, 'config.json')
	if (existsSync(bridgeExample) && !existsSync(bridgeConfig)) {
		if (!dryRun) copyFileSync(bridgeExample, bridgeConfig)
		logger.log(
			dryRun
				? '  [dry-run] would bootstrap claude-bridge/config.json from config.example.json'
				: '✓ Bootstrapped claude-bridge/config.json from config.example.json',
		)
	}

	// Docker Desktop on macOS (virtiofs) refuses to bind a file onto a host path
	// that does not exist: the pre-check runs outside the container namespace,
	// and ./vscode-settings.jsonc:/workspace/.vscode/settings.json translates to
	// a host path under the workspace bind. Linux overlayfs tolerates on-the-fly
	// mountpoint creation, so this is a no-op there. Existence, not file-ness,
	// is the test — any pre-existing user content is preserved and the bind
	// still overlays it inside the container.
	const vscodeStub = join(projectDir, '.vscode', 'settings.json')
	if (!existsSync(vscodeStub)) {
		if (!dryRun) {
			mkdirSync(join(projectDir, '.vscode'), { recursive: true })
			writeFileSync(vscodeStub, '', 'utf8')
		}
		logger.log(
			dryRun
				? '  [dry-run] would bootstrap .vscode/settings.json stub (host-side bind-mount prep)'
				: '✓ Bootstrapped .vscode/settings.json stub (host-side bind-mount prep)',
		)
	}
}

interface ProjectionOptions {
	devcontainerDir: string
	envFile: string
	logger: Logger
	dryRun: boolean
}

/** Team defaults from devcontainer.json into `.env`, user overrides untouched. */
function projectTeamDefaults(options: ProjectionOptions): void {
	const { devcontainerDir, envFile, logger, dryRun } = options
	const customizations = readStitchuCustomizations(join(devcontainerDir, 'devcontainer.json'))
	const existing = readEnvFile(envFile)
	for (const { key, value } of projectCustomizations(customizations, existing)) {
		if (!dryRun) setEnvVar(envFile, key, value)
		logger.log(`→ projected ${key}=${value} from customizations.stitchu-devc`)
		logger.trace({ kind: 'decide', name: key, value, why: 'devcontainer.json team default' })
	}
}

/**
 * Align the proxy / CA variables with the firewall mode (initialize.sh:206-222).
 *
 *   strict (alias paranoid) — variables set
 *   basic  (alias okeish)   — variables cleared
 *   off                     — variables cleared
 */
export function syncProxyEnv(envFile: string, mode: string, dryRun: boolean, logger: Logger): void {
	if (PROXY_MODES.has(mode)) {
		for (const { key, value } of PROXY_SETTINGS) {
			if (!dryRun) setEnvVar(envFile, key, value)
		}
		logger.trace({ kind: 'decide', name: 'proxyEnv', value: 'set', why: `firewall mode ${mode}` })
		return
	}
	for (const { key } of PROXY_SETTINGS) {
		if (!dryRun) unsetEnvVar(envFile, key)
	}
	logger.trace({ kind: 'decide', name: 'proxyEnv', value: 'cleared', why: `firewall mode ${mode}` })
}

function promptAuth(options: { authFlag: string; modeFlag: string; logger: Logger; dryRun: boolean }): void {
	const { authFlag, modeFlag, logger, dryRun } = options
	logger.log('')
	logger.log('=== GitHub Auth ===')
	logger.log("  Standard: open a terminal after startup and run 'gh auth login'.")
	logger.log('  (gh-secure mode dropped in Phase 3 A3 — Level 1 strict blocks')
	logger.log('  POST github.com/* outside /anthropics/* at the firewall layer.)')
	logger.log('')
	writeFlag(authFlag, 'standard', dryRun, logger)
	if (!existsSync(modeFlag)) writeFlag(modeFlag, 'CLAUDE-dev.md', dryRun, logger)
	logger.log('✓ Standard auth configured.')
}

async function promptClaudeMode(options: {
	modeFlag: string
	logger: Logger
	dryRun: boolean
	ask: (question: string) => Promise<string>
}): Promise<void> {
	const { modeFlag, logger, dryRun, ask } = options
	logger.log('')
	logger.log('=== Claude Mode ===')
	logger.log('')
	logger.log('  [1] Dev       — full coding assistant (default)')
	logger.log('  [2] Reviewer  — code review + PR management')
	logger.log('')

	const answer = (await ask('Choose [1/2] (default: 1): ')).trim()
	const value = answer === '2' ? 'CLAUDE-reviewer.md' : 'CLAUDE-dev.md'
	writeFlag(modeFlag, value, dryRun, logger)
	logger.log(`✓ Claude mode: ${value}`)
}

interface SummaryOptions {
	devcontainerDir: string
	modeFlag: string
	firewallFlag: string
	logger: Logger
}

function printSummary(options: SummaryOptions): void {
	const { devcontainerDir, modeFlag, firewallFlag, logger } = options
	const claudeLabel = existsSync(modeFlag)
		? readFileSync(modeFlag, 'utf8').trim().replace(/^CLAUDE-/, '').replace(/\.md$/, '')
		: 'dev'
	const firewallMode = readMode(firewallFlag)
	const { hosts, policy } = countLocalOverrides(devcontainerDir)

	logger.log('')
	logger.log('──────────────────────────────────')
	logger.log('  GitHub:           gh token only')
	logger.log(`  Claude:           ${claudeLabel}`)
	logger.log(`  Firewall mode:    ${firewallMode}`)
	logger.log(
		hosts > 0 || policy > 0
			? `  Local overrides:  ⚠  ${hosts} host(s) + ${policy} policy.local.d file(s)`
			: '  Local overrides:  (none)',
	)
	logger.log('──────────────────────────────────')
	logger.log('  Flip firewall mode (then rebuild):')
	logger.log('    .devcontainer/firewall-mode.sh strict   # default (max security)')
	logger.log('    .devcontainer/firewall-mode.sh basic    # DNS allowlist only')
	logger.log('    .devcontainer/firewall-mode.sh off      # kill-switch (no filter)')
	logger.log('  Reconfigure (each can be reset independently):')
	logger.log('    rm .devcontainer/.configured-auth            # reset GitHub auth')
	logger.log('    rm .devcontainer/.configured-claude-mode     # reset Claude mode')
	logger.log('    rm .devcontainer/firewall/default-mode       # reset firewall mode')
	logger.log('  Then rebuild the container.')
	logger.log('──────────────────────────────────')
}

/**
 * Active local overrides (initialize.sh:499-512).
 *
 * Hosts = non-comment, non-empty lines in domains.local.txt.
 * Policy = *.yaml directly under policy.local.d/ (one file may carry many rules).
 */
export function countLocalOverrides(devcontainerDir: string): { hosts: number; policy: number } {
	const domainsFile = join(devcontainerDir, 'firewall', 'domains.local.txt')
	const policyDir = join(devcontainerDir, 'firewall', 'policy.local.d')

	let hosts = 0
	if (existsSync(domainsFile)) {
		hosts = readFileSync(domainsFile, 'utf8')
			.split('\n')
			.filter((line) => /^\s*[^#\s]/.test(line)).length
	}

	let policy = 0
	if (existsSync(policyDir)) {
		try {
			policy = readdirSync(policyDir).filter(
				(name) => name.endsWith('.yaml') && statSync(join(policyDir, name)).isFile(),
			).length
		} catch {
			policy = 0
		}
	}
	return { hosts, policy }
}

function readMode(flagFile: string): string {
	if (!existsSync(flagFile)) return 'strict'
	const value = readFileSync(flagFile, 'utf8').trim()
	return value.length > 0 ? value : 'strict'
}

/**
 * Whether `.env` is where a no-cache request came from.
 *
 */
function writeFlag(path: string, value: string, dryRun: boolean, logger: Logger): void {
	if (dryRun) {
		logger.log(`  [dry-run] would write ${path} = ${value}`)
		return
	}
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${value}\n`, 'utf8')
	logger.trace({ kind: 'fs', op: 'write', path })
}

function touch(path: string, dryRun: boolean, logger: Logger): void {
	if (existsSync(path)) return
	if (dryRun) {
		logger.log(`  [dry-run] would create ${path}`)
		return
	}
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, '', 'utf8')
	logger.trace({ kind: 'fs', op: 'write', path })
}

function isEmptyOrMissing(path: string): boolean {
	if (!existsSync(path)) return true
	try {
		return statSync(path).size === 0
	} catch {
		return true
	}
}

/** `date +%Y%m%d-%H%M%S`, in local time like the bash original. */
export function stamp(date: Date): string {
	const pad = (n: number): string => String(n).padStart(2, '0')
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	)
}
