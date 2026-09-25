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
	BASE_IMAGE_REPOSITORY,
	baseImageTag,
	DEFAULT_CLAUDE_CODE_VERSION,
	imageExists,
	PUBLISHED_CLAUDE_CODE_VERSIONS,
	type RebuildSignals,
	detectRebuildSignals,
	hasDocker,
	volumeCreate,
} from '../lib/docker.js'
import { readEnvFile, setEnvVar, uncommentEnvVar, unsetEnvVar } from '../lib/env-file.js'
import { ESC, Logger } from '../lib/logger.js'
import { readExtPatchesConfig, type ExtPatchesConfig } from '../lib/machine-config.js'
import { spawnNotifyDaemon, type NotifyReport } from '../lib/notify-daemon.js'
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
import { CLI_VERSION } from '../lib/version.js'

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

export const INITIALIZE_HELP = `devc initialize - host-side pre-container setup

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
			`[x] devc initialize does not support host kind: ${hostKind} (${probe.platform})\n` +
				'  Supported : Mac, native Linux, Windows-with-WSL, Windows-with-Git-Bash.\n',
		)
		return 1
	}
	if (isBareWin32(probe)) {
		// Unreachable today — bare win32 classifies as `unknown` and exits above.
		// Kept as the explicit home of the design §7 warning for when a native
		// Windows path is added.
		err.write('[!] Running on native Windows outside WSL - WSL2 is the supported route.\n')
	}

	// === Precondition (no bash counterpart — see classifyDevcontainer) =======
	// Runs before the logger, because creating the log file is itself a write
	// into the directory being judged.
	const state = classifyDevcontainer(paths.devcontainerDir)
	if (state.kind !== 'present') {
		err.write(
			state.kind === 'absent'
				? `[x] No .devcontainer at ${paths.devcontainerDir}\n` +
						'  devc initialize prepares an existing devcontainer before it starts;\n' +
						'  it does not create one. Run "devc init" to scaffold a project.\n'
				: `[x] ${paths.devcontainerDir} has no devcontainer.json\n` +
						'  Nothing identifies it as a devcontainer, so there is nothing to\n' +
						'  prepare. Run "devc init" to scaffold one, or point\n' +
						'  --devcontainer-dir at the right project.\n',
		)
		return 1
	}

	// === Lifecycle logging (initialize.sh:57-111) ============================
	const timestamp = stamp(new Date())
	const logsDir = join(paths.devcontainerDir, 'tmp', 'logs')
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

	// The stamped header and the trace pointer are diagnosis, and the log is
	// where diagnosis lives. What reaches the screen is the panel below.
	logger.rawToLogOnly(`=== devc initialize ${new Date().toString()} ===`)
	logger.rawToLogOnly(
		`  trace: ${logger.tracePath === null ? '(disabled - set DEBUG=1 in .env to enable)' : relativeTo(devcontainerDir, logger.tracePath)}`,
	)

	// The host OS is only knowable here: this is the one component that runs on
	// the host, so it is the only place that can answer. See platform.ts.
	if (!dryRun) writeHostOs(devcontainerDir, hostKind)
	logger.trace({ kind: 'fs', op: 'write', path: join(devcontainerDir, 'tmp', 'logs', 'host-os') })

	// === .env (initialize.sh:113-123) ========================================
	// `set -a; source .env` assigns unconditionally, so a value in the file wins
	// over one inherited from the environment. Merge order matches that.
	const env = { ...process.env, ...readEnvFile(envFile) }
	const projectId = env['DC_PROJECT'] ?? defaultProjectId(projectDir)
	const credsVolume = env['CLAUDE_CREDS_VOLUME'] ?? `claude-creds-${projectId}`
	// === Base image version pin (initialize.sh:613-616) =====================
	// Pin and probe both move above the panel: the panel's job is to say what
	// the next few minutes hold, and both facts live here. The write still comes
	// first, which is the ordering bash had a reason for — the .env lands even
	// when the probe dies.
	const version = env['CLAUDE_CODE_VERSION'] ?? DEFAULT_CLAUDE_CODE_VERSION
	if (!dryRun) setEnvVar(envFile, 'CLAUDE_CODE_VERSION', version)

	const image = describeBaseImage(resolveBaseImage(devcontainerDir, env))
	const signals = detectRebuildSignals({ hostKind, projectDir, devcontainerDir, logger })
	const start = startMode({ signals, image })
	logger.trace({ kind: 'decide', name: 'baseImageTag', value: baseImageTag(version, projectId), why: 'resolved' })

	// Temps 1. What is true before any work, and what the next few minutes hold.
	// A first boot pulls 2-3 GB behind this panel, so it answers the question
	// asked while waiting — is it building, and is the image already here.
	// What is true before anything happens. The two versions are named, not left
	// inside a tag: the container's own panel titles itself with the same pair,
	// and a reader should not have to take a colon apart to compare them.
	titledBlock(logger, `devc initialize ${CLI_VERSION}`, [
		['project', projectId],
		...imageRows(image),
		['creds', credsVolume],
		['host', hostKind],
		['mode', start.mode],
		...(dryRun ? [['dry-run', 'no writes, no build, no daemon'] as Row] : []),
		['log', dryRun ? '(none - dry-run writes nothing)' : relativeTo(devcontainerDir, logger.logPath)],
	])
	logger.log(start.warn ? `${MARK_WARN} ${start.consequence}` : `${MARK_STEP} ${start.consequence}`)
	const unpublished = unpublishedLine(image)
	if (unpublished !== null) logger.log(`${MARK_WARN} ${unpublished}`)

	// === Firewall + sidecar seeding (initialize.sh:125-158) ==================
	// Must run before compose builds — the Dockerfile COPYs this directory.
	seedProjectFiles({ devcontainerDir, projectDir, logger, dryRun })

	if (dryRun) {
		logger.log(`${MARK_STEP} [dry-run] would run: docker volume create ${credsVolume}`)
	} else if (hasDocker()) {
		volumeCreate(credsVolume)
	}

	const modeFlag = join(devcontainerDir, 'tmp', 'configured', 'claude-mode')
	const firewallFlag = join(devcontainerDir, 'firewall', 'default-mode')

	// === Team defaults -> .env projection (design §5.7) ======================
	projectTeamDefaults({ devcontainerDir, envFile, logger, dryRun })

	// === Ext-patches: machine config fills only what the project left empty ==
	applyExtPatchesConfig({ envFile, logger, dryRun })

	// === Optional rebuild diagnostic (initialize.sh:602-611) =================
	if (env['DEBUG_REBUILD_CONTEXT'] === '1' && !dryRun) {
		dumpRebuildContext({ logger, devcontainerDir, timestamp })
	}


	// === Non-interactive early exit (initialize.sh:618-632) ==================
	const input = options.input ?? process.stdin
	if (input.isTTY !== true) {
		if (!existsSync(modeFlag)) {
			logger.log(`${MARK_STEP} Non-interactive: defaulting Claude mode to dev.`)
			writeFlag(modeFlag, 'CLAUDE-dev.md', dryRun, logger)
		}
		if (!existsSync(firewallFlag)) {
			logger.log(`${MARK_STEP} Non-interactive: defaulting firewall to strict.`)
			writeFlag(firewallFlag, 'strict', dryRun, logger)
		}
		syncProxyEnv(envFile, readMode(firewallFlag), dryRun, logger)
		printSummary({ devcontainerDir, modeFlag, firewallFlag, logger, dryRun, projectId, notify: null, start })
		sayClosing(logger, start)
		return 0
	}

	// === Per-flag prompts (initialize.sh:634-643) ============================
	// No section header: the v2 script opened "=== DevContainer Setup ===" and
	// the only thing under it was "=== Claude Mode ===". Two frames, in a third
	// vocabulary, around one question.

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
		// Reachable on a genuine first run since the GitHub Auth step was
		// removed: that step seeded this flag as a side effect, which is what
		// used to make this prompt — the only real question here — unreachable.
		if (!existsSync(modeFlag)) {
			await promptClaudeMode({ modeFlag, logger, dryRun, ask })
			promptedClaudeMode = true
		}
		if (!existsSync(firewallFlag)) {
			// No prompt since A4: strict is the intentional max-security baseline.
			// Flip with firewall-mode.sh, then rebuild.
			writeFlag(firewallFlag, 'strict', dryRun, logger)
			syncProxyEnv(envFile, 'strict', dryRun, logger)
			logger.log(`${MARK_OK} Firewall mode: strict (default)`)
		}

		// Idempotent re-sync: aligns .env with a manual edit of
		// firewall/default-mode made between rebuilds (initialize.sh:645-647).
		syncProxyEnv(envFile, readMode(firewallFlag), dryRun, logger)

		// Spawned before the panel, not after: its outcome is one of the panel's
		// rows, and a panel that reports the boot has to be the last thing drawn.
		const notify = await spawnNotifyDaemon({ logger, devcontainerDir, projectDir, dryRun })
		printSummary({ devcontainerDir, modeFlag, firewallFlag, logger, dryRun, projectId, notify, start })

		// Pause only when an interactive prompt actually ran. The Claude-mode
		// prompt is the only one left, and since the GitHub Auth step stopped
		// seeding its flag it now fires on a genuine first run.
		//
		// It says what Enter does, from the same verdict the opening panel drew.
		// "Press Enter to continue..." was the last line on screen while 2-3 GB
		// waited behind it — and this command blocks the build until it returns,
		// so a content-free prompt is not only mute, it is in the way.
		// titledBlock already closes on a blank line, so this does not add one.
		// titledBlock closes on a blank line, so only the prompted path needs one:
		// the answer's newline lands on the prompt line, not after it.
		if (promptedClaudeMode && !dryRun) {
			await ask(`  ${start.next} `)
			logger.log('')
		}
		sayClosing(logger, start)

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
			`${MARK_STEP} ${dryRun ? '[dry-run] would migrate' : 'migrated'} firewall mode: .configured-firewall-mode -> firewall/default-mode`,
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
				? `${MARK_STEP} [dry-run] would bootstrap claude-bridge/config.json from config.example.json`
				: `${MARK_OK} claude-bridge/config.json bootstrapped from config.example.json`,
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
				? `${MARK_STEP} [dry-run] would create the .vscode/settings.json stub`
				: `${MARK_OK} .vscode/settings.json stub created`,
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
		logger.log(`${MARK_STEP} projected ${key}=${value} from customizations.stitchu-devc`)
		logger.trace({ kind: 'decide', name: key, value, why: 'devcontainer.json team default' })
	}
}

const PLACEHOLDERS = new Set(['<change-me>', 'change-me'])
function isPlaceholder(value: string): boolean {
	return PLACEHOLDERS.has(value.trim().toLowerCase())
}

/**
 * Fills EXT_PATCHES_REPO/REF/TOKEN from the machine config only where the
 * project's `.env` left them empty; warns (never overwrites) when a
 * project value disagrees with the machine config.
 */
export function applyExtPatchesConfig(options: { envFile: string; logger: Logger; dryRun: boolean; machine?: ExtPatchesConfig | null }): void {
	const { envFile, logger, dryRun } = options
	const machine = options.machine === undefined ? readExtPatchesConfig() : options.machine
	if (machine === null) return
	const env = readEnvFile(envFile)
	const pairs: readonly [string, string][] = [
		['EXT_PATCHES_REPO', machine.repo],
		['EXT_PATCHES_REF', machine.ref],
		['EXT_PATCHES_TOKEN', machine.token],
	]
	for (const [key, value] of pairs) {
		// An empty machine value (a ref left auto) fills nothing and disputes nothing.
		if (value.length === 0) continue
		const existing = env[key]
		// `<change-me>` is the placeholder .env.example ships so the line exists
		// to be filled: it counts as empty here, and the hook treats it the same.
		if (existing === undefined || existing.length === 0 || isPlaceholder(existing)) {
			if (!dryRun) uncommentEnvVar(envFile, key, value)
			logger.log(`${MARK_STEP} filled ${key} from ~/.config/devc/ext-patches.env`)
		} else if (existing !== value) {
			logger.log(`${MARK_WARN} ${key} in .env differs from ~/.config/devc/ext-patches.env - kept the project's value`)
		}
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

async function promptClaudeMode(options: {
	modeFlag: string
	logger: Logger
	dryRun: boolean
	ask: (question: string) => Promise<string>
}): Promise<void> {
	const { modeFlag, logger, dryRun, ask } = options
	logger.log('')
	logger.log('  Claude mode')
	logger.log('    [1] Dev       full coding assistant (default)')
	logger.log('    [2] Reviewer  code review + PR management')
	const answer = (await ask('  Choose [1/2] (default: 1): ')).trim()
	const value = answer === '2' ? 'CLAUDE-reviewer.md' : 'CLAUDE-dev.md'
	// The answer echoes on the prompt line; without this the consequence lands
	// glued to the question it answers.
	logger.log('')
	writeFlag(modeFlag, value, dryRun, logger)
	// The label the panel will carry, not the filename it writes — one name for
	// one thing, or the reader has to work out that they are the same.
	logger.log(`${MARK_OK} Claude mode: ${value.replace(/^CLAUDE-/, '').replace(/\.md$/, '')}`)
}

interface SummaryOptions {
	devcontainerDir: string
	modeFlag: string
	firewallFlag: string
	logger: Logger
	dryRun: boolean
	projectId: string
	notify: NotifyReport | null
	start: StartMode
}

function printSummary(options: SummaryOptions): void {
	const { devcontainerDir, modeFlag, firewallFlag, logger, dryRun, notify, start } = options
	const claudeLabel = existsSync(modeFlag)
		? readFileSync(modeFlag, 'utf8').trim().replace(/^CLAUDE-/, '').replace(/\.md$/, '')
		: 'dev'
	const firewallMode = readMode(firewallFlag)
	const { hosts, policy } = countLocalOverrides(devcontainerDir)
	const logRel = relativeTo(devcontainerDir, logger.logPath)

	// The closing block is the opening block's twin — same device, same column,
	// same indentation. Before this, notify said its name three times: a step
	// line, the verdict, and its own reason, two of them marked [!]. One subject,
	// one row, and the reasons as a continuation of it.
	const warnings: string[] = []
	if (hosts > 0 || policy > 0) warnings.push('overrides')
	if (notify?.state === 'warn') warnings.push('notify')

	// The verdict names what is wrong rather than only counting it: these lines
	// get pasted into tickets, where every escape is stripped, and "1 warning"
	// with no colour left is a riddle.
	const verdict =
		warnings.length === 0
			? 'ready, all clear'
			: `ready, ${warnings.length} warning${warnings.length > 1 ? 's' : ''}: ${warnings.join(', ')}`

	// Two groups, and a blank line between them. Every row that has a state takes
	// a marker, so the left edge is a column rather than a picket fence; `next`
	// and `log` are a consequence and a path, not states that passed, and a [+]
	// on either would claim a verdict neither has.
	titledBlock(
		logger,
		verdict,
		[
			['claude', claudeLabel, 'ok'],
			['firewall', firewallMode, 'ok'],
			hosts > 0 || policy > 0
				? (['overrides', countOverrides(hosts, policy), 'warn'] as Row)
				: (['overrides', 'none', 'ok'] as Row),
			// The reasons are the notify row continued, not a row of their own: a
			// second marker for the same subject is the duplication just removed.
			...(notify === null
				? []
				: [
						[
							'notify',
							notify.why === null ? notify.value : [notify.value, ...notify.why.split('; ')].join('\n'),
							notify.state,
						] as Row,
					]),
			['', ''],
			...(dryRun ? [] : [['log', logRel] as Row]),
		],
		warnings.length === 0 ? SGR_VERDICT_OK : SGR_WARN,
	)

	logger.rawToLogOnly('')
	logger.rawToLogOnly('  Flip the firewall mode, then rebuild the container:')
	logger.rawToLogOnly('    echo basic > .devcontainer/firewall/default-mode')
	logger.rawToLogOnly('    strict - default, max security')
	logger.rawToLogOnly('    basic  - DNS allowlist only')
	logger.rawToLogOnly('    off    - kill-switch, no filter')
	logger.rawToLogOnly('  Reset either one, then rebuild:')
	logger.rawToLogOnly('    rm .devcontainer/tmp/configured/claude-mode')
	logger.rawToLogOnly('    rm .devcontainer/firewall/default-mode')
}

/**
 * The image this tree actually builds on, read where compose reads it.
 *
 * Deriving it from DEFAULT_BASE_VERSION and CLAUDE_CODE_VERSION was a second
 * source of truth for a fact the tree already states, and it drifted the first
 * time anyone looked: inside a container the baked CLAUDE_CODE_VERSION won and
 * the panel named a tag that was never published. Order is compose's own —
 * BASE_IMAGE from .env, else the `${BASE_IMAGE:-…}` default in
 * docker-compose.yml, else the `ARG BASE_IMAGE=…` the Dockerfile declares.
 */
function resolveBaseImage(devcontainerDir: string, env: NodeJS.ProcessEnv): string | null {
	const fromEnv = env['BASE_IMAGE']
	if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
	const compose = readIfPresent(join(devcontainerDir, 'docker-compose.yml'))
	const fromCompose = /\$\{BASE_IMAGE:-([^}]+)\}/.exec(compose ?? '')?.[1]
	if (fromCompose !== undefined) return fromCompose.trim()
	const dockerfile = readIfPresent(join(devcontainerDir, 'Dockerfile'))
	return /^ARG BASE_IMAGE=(.+)$/m.exec(dockerfile ?? '')?.[1]?.trim() ?? null
}

const readIfPresent = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null)

/**
 * Line markers.
 *
 * ASCII on purpose. The glyphs they replace tip into emoji presentation on some
 * terminals, where they stop taking colour and start taking two columns; these
 * are two wide by construction, so the text after them forms a column whatever
 * the font decides to do.
 */
const MARK_OK = '[+]'
const MARK_STEP = '[>]'
const MARK_WARN = '[!]'

/** The label column of a header block, so a column of labels stays a column. */
const HEADER_LABEL = 12
const SGR_WARN = '1;33'
const SGR_VERDICT_OK = '1;32'
const SGR_TITLE = '1'

/**
 * `[label, value]`, or `[label, value, state]` when the row carries one.
 *
 * A stateful row takes a marker in column 0 — the same column the step lines
 * use, so a scan down the left edge finds everything that has a state, in one
 * grid rather than two. Without it the verdict named a warning and the reader
 * had to hunt for which row it meant.
 */
type Row = [string, string] | [string, string, 'ok' | 'warn']

/**
 * A title, then an aligned column of facts. Used for both blocks.
 *
 * No frame. The container's boot panel is boxed and printed once, at the end,
 * into a log people paste into tickets. This half prints a header, asks a
 * question, and prints a verdict, and two heavy frames around an interactive
 * exchange is where the rhythm broke: a frame opened, closed, plain text, a
 * frame reopened. A title with an indented column cannot go ragged and cannot
 * fold on a narrow terminal. The two halves are allowed to differ — this one
 * opens the session, that one closes it.
 */
function titledBlock(logger: Logger, title: string, rows: readonly Row[], titleSgr = SGR_TITLE): void {
	logger.log('')
	logger.composed(`${ESC}[${titleSgr}m${title}${ESC}[0m`, title)
	logger.log('')
	for (const [label, value, state] of rows) {
		if (label === '' && value === '') {
			logger.log('')
			continue
		}
		const mark = state === 'warn' ? MARK_WARN : state === 'ok' ? MARK_OK : '   '
		const sgr = state === 'warn' ? SGR_WARN : null
		// A value may carry its own lines — a list of reasons is still one fact,
		// and hanging it under its own label keeps the column intact.
		const [first = '', ...rest] = value.split('\n')
		const head = `${mark} ${label.padEnd(HEADER_LABEL)} ${first}`
		if (sgr === null) logger.log(head)
		else logger.composed(`${ESC}[${sgr}m${head}${ESC}[0m`, head)
		// Aligns under the value: marker(3) + space + label(12) + space.
		const hang = ' '.repeat(4 + HEADER_LABEL + 1)
		for (const line of rest) {
			if (sgr === null) logger.log(`${hang}${line}`)
			else logger.composed(`${ESC}[${sgr}m${hang}${line}${ESC}[0m`, `${hang}${line}`)
		}
	}
	logger.log('')
}

/** The two versions the image carries, when its ref is one of ours. */
interface BaseImage {
	ref: string
	sandbox: string | null
	claudeCode: string | null
}

/**
 * Take the ref apart, when it is ours.
 *
 * String work rather than a regex: BASE_IMAGE_REPOSITORY is full of dots and
 * slashes, and an unescaped one in a pattern is a bug that shows up only on the
 * day someone edits the constant.
 */
function describeBaseImage(ref: string | null): BaseImage | null {
	if (ref === null) return null
	const prefix = `${BASE_IMAGE_REPOSITORY}:`
	if (!ref.startsWith(prefix)) return { ref, sandbox: null, claudeCode: null }
	const tag = ref.slice(prefix.length)
	const at = tag.lastIndexOf('-cc')
	if (at < 0) return { ref, sandbox: null, claudeCode: null }
	return { ref, sandbox: tag.slice(0, at), claudeCode: tag.slice(at + 3) }
}

/**
 * The image, as rows.
 *
 * Two named versions when the ref parses — the pair the container's own panel
 * titles itself with, so the two halves can be compared without taking a colon
 * apart. The full ref only when it deviates, which is exactly when it is worth
 * seeing: a local tag, another registry, a hand-set BASE_IMAGE. No Claude Code
 * row in that case, because the tree's pin is not a promise about someone
 * else's image.
 */
function imageRows(image: BaseImage | null): Row[] {
	if (image === null) return []
	if (image.sandbox === null || image.claudeCode === null) return [['image', image.ref]]
	return [
		['sandbox', image.sandbox],
		['claude code', image.claudeCode],
	]
}

/**
 * Why the pinned tag will not pull, or null when it will.
 *
 * `devc init` checks the line at scaffold time; this is the same check at the
 * moment it bites, because the pin is edited long after scaffolding. A ref that
 * is not ours is not judged: there is nothing to compare it against.
 */
function unpublishedLine(image: BaseImage | null): string | null {
	if (image === null || image.claudeCode === null) return null
	if (PUBLISHED_CLAUDE_CODE_VERSIONS.includes(image.claudeCode)) return null
	return `claude code ${image.claudeCode} is not a published line (${PUBLISHED_CLAUDE_CODE_VERSIONS.join(', ')}) - the pull will fail`
}

interface StartMode {
	/** `first build`, `rebuild`, `reopen`, or that docker is missing. */
	mode: string
	/** What happens next, as one step line. */
	consequence: string
	warn: boolean
	/** What the Enter that ends a first run hands over to. */
	next: string
	/** The closing sentence, printed once the hand-over actually happens. */
	closing: string
}

/**
 * Which of the three starts this is.
 *
 * detectRebuildSignals knows `reopen` for certain: a container matching this
 * workspace exists. It cannot separate a rebuild from a first build — VS Code
 * removes the container before calling `up` for both, so neither leaves a
 * distinguishing trace. What separates them here is whether the base image is
 * already on this host, which is an inference and not a certainty: a machine
 * that pulled the image by hand reads as a rebuild on its first build. Worth
 * the trade, because `first build` is the one that costs 2-3 GB and getting
 * that one right is what the line is for.
 */
function startMode(context: { signals: RebuildSignals; image: BaseImage | null }): StartMode {
	if (!hasDocker()) {
		return {
			mode: 'unknown - docker not found',
			consequence: 'docker is not on PATH, so VS Code cannot build this container',
			warn: true,
			next: 'Press Enter to continue',
			closing: 'Nothing happens next: docker is not available, so the container cannot be built.',
		}
	}
	if (!context.signals.requested) {
		return {
			mode: 'reopen',
			consequence: 'the container exists, so nothing is pulled or built',
			warn: false,
			next: 'Press Enter to hand over to VS Code',
			closing: 'VS Code is reopening the container. Nothing is pulled and nothing is built.',
		}
	}
	if (context.image !== null && imageExists(context.image.ref)) {
		return {
			mode: 'rebuild',
			consequence: 'the base image is already on this host, so the build starts straight away',
			warn: false,
			next: 'Press Enter to hand over to VS Code',
			closing: 'VS Code is building the container. The base image is already here, so expect a minute or two.',
		}
	}
	return {
		mode: 'first build',
		consequence: 'the base image is pulled next, about 2-3 GB, once',
		warn: false,
		next: 'Press Enter to hand over to VS Code',
		closing:
			'VS Code is building the container. The base image is pulled first, about 2-3 GB, so expect several minutes.',
	}
}


/**
 * The last line, and the only one at column 0.
 *
 * Printed after the pause, never before it: a run that asks for Enter has not
 * handed over until Enter is pressed, and announcing the build above the prompt
 * that gates it describes something that is not happening yet. On the runs with
 * no prompt — most of them — it follows the report directly.
 */
function sayClosing(logger: Logger, start: StartMode): void {
	logger.composed(`${ESC}[${SGR_TITLE}m${start.closing}${ESC}[0m`, start.closing)
}

/** `2 hosts`, `1 host and 2 policy files` — never a `0 policy file(s)` limb. */
function countOverrides(hosts: number, policy: number): string {
	const parts: string[] = []
	if (hosts > 0) parts.push(`${hosts} host${hosts > 1 ? 's' : ''}`)
	if (policy > 0) parts.push(`${policy} policy file${policy > 1 ? 's' : ''}`)
	return parts.join(' and ')
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
		logger.log(`${MARK_STEP} [dry-run] would write ${path} = ${value}`)
		return
	}
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${value}\n`, 'utf8')
	logger.trace({ kind: 'fs', op: 'write', path })
}

function touch(path: string, dryRun: boolean, logger: Logger): void {
	if (existsSync(path)) return
	if (dryRun) {
		logger.log(`${MARK_STEP} [dry-run] would create ${path}`)
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
