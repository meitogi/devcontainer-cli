// Argument parsing and subcommand dispatch.
//
// Hand-rolled rather than pulled from a library: the surface is three real
// commands with a handful of flags, and a zero-dependency package is easier to
// audit and faster to `npx` than one that fetches an argument parser to read
// `--dry-run`.
//
// Exit codes:
//   0  success
//   1  the command ran and failed (or refused, or is a stub)
//   2  usage error — unknown command, unknown flag, missing or invalid flag value

import { init, INIT_HELP } from './commands/init.js'
import { initialize, INITIALIZE_HELP } from './commands/initialize.js'
import { migrate, MIGRATE_HELP } from './commands/migrate.js'
import { runStub, STUB_COMMANDS } from './commands/stubs.js'
import { installFailureHandlers, Logger } from './lib/logger.js'
import { PathResolutionError } from './lib/paths.js'
import { CLI_NAME, CLI_VERSION } from './lib/version.js'

/** A logger with no file sink — formats failures identically, writes no file. */
function terminalLogger(): Logger {
	return Logger.create({ logFile: '', silentSink: true })
}

export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

const HELP = `devc — devcontainer control plane (${CLI_NAME} v${CLI_VERSION})

Usage:
  devc <command> [options]

Commands:
  init [dir]                 Scaffold a .devcontainer/ into a project (wizard)
  initialize                 Host-side pre-container setup (initializeCommand)
  migrate [dir]              Report what a tree made by install.sh needs to move to v3
${STUB_COMMANDS.map((stub) => `  ${stub.name.padEnd(26)} ${stub.summary} (not implemented)`).join('\n')}

Options:
  -h, --help                 Show this help
  -v, --version              Print the version

Run "devc <command> --help" for command-specific options.
`

export async function main(argv: readonly string[]): Promise<number> {
	// The other half of the ERR-trap analogue. `run()` defaulting to
	// `check: true` reproduces `set -e` for child processes; this catches what
	// escapes that — a throw from anywhere else, and the forgotten `await` that
	// would otherwise surface as a silent unhandled rejection.
	installFailureHandlers(terminalLogger())

	const first = argv[0]

	if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
		process.stdout.write(HELP)
		return EXIT_OK
	}
	if (first === '--version' || first === '-v') {
		process.stdout.write(`${CLI_VERSION}\n`)
		return EXIT_OK
	}

	const rest = argv.slice(1)

	if (first === 'init') return runInit(rest)
	if (first === 'initialize') return runInitialize(rest)
	if (first === 'migrate') return runMigrate(rest)

	const stub = STUB_COMMANDS.find((candidate) => candidate.name === first)
	if (stub !== undefined) {
		if (rest.includes('--help') || rest.includes('-h')) {
			process.stdout.write(`devc ${stub.name} — ${stub.summary}\n\nNot implemented in this version.\n`)
			return EXIT_OK
		}
		return runStub(stub)
	}

	process.stderr.write(`devc: unknown command "${first}"\n\n${HELP}`)
	return EXIT_USAGE
}

/** `--flag value` and `--flag=value`, one place. */
function flagValue(
	args: readonly string[],
	index: number,
	flag: string,
): { value: string; consumed: number } | { error: string } {
	const arg = args[index] as string
	if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), consumed: 0 }
	const next = args[index + 1]
	if (next === undefined || next.startsWith('-')) return { error: `${flag} requires a value` }
	return { value: next, consumed: 1 }
}

type InitValueKey =
	| 'projectId'
	| 'displayName'
	| 'credsVolume'
	| 'stack'
	| 'claudeCodeVersion'
	| 'extPatchesRepo'
	| 'extPatchesRef'

const INIT_VALUE_FLAGS: Readonly<Record<string, InitValueKey>> = {
	'--project-id': 'projectId',
	'--display-name': 'displayName',
	'--creds-volume': 'credsVolume',
	'--stack': 'stack',
	'--cc': 'claudeCodeVersion',
	'--ext-patches-repo': 'extPatchesRepo',
	'--ext-patches-ref': 'extPatchesRef',
}

async function runInit(args: readonly string[]): Promise<number> {
	let targetDir: string | undefined
	let yes = false
	let dryRun = false
	let install = true
	const values: Partial<Record<InitValueKey, string>> = {}

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string
		if (arg === '--help' || arg === '-h') {
			process.stdout.write(INIT_HELP)
			return EXIT_OK
		}
		if (arg === '--yes' || arg === '-y') {
			yes = true
			continue
		}
		if (arg === '--dry-run') {
			dryRun = true
			continue
		}
		if (arg === '--no-install') {
			install = false
			continue
		}
		let matched = false
		for (const flag in INIT_VALUE_FLAGS) {
			if (arg !== flag && !arg.startsWith(`${flag}=`)) continue
			const parsed = flagValue(args, i, flag)
			if ('error' in parsed) {
				process.stderr.write(`devc init: ${parsed.error}\n`)
				return EXIT_USAGE
			}
			values[INIT_VALUE_FLAGS[flag] as InitValueKey] = parsed.value
			i += parsed.consumed
			matched = true
			break
		}
		if (matched) continue
		if (arg.startsWith('-')) {
			process.stderr.write(`devc init: unknown option "${arg}"\n\n${INIT_HELP}`)
			return EXIT_USAGE
		}
		if (targetDir !== undefined) {
			process.stderr.write(`devc init: unexpected argument "${arg}" (one directory at most)\n`)
			return EXIT_USAGE
		}
		targetDir = arg
	}

	return init({ cwd: process.cwd(), targetDir, yes, dryRun, install, ...values })
}

async function runInitialize(args: readonly string[]): Promise<number> {
	let devcontainerDir: string | undefined
	let dryRun = false

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string
		if (arg === '--help' || arg === '-h') {
			process.stdout.write(INITIALIZE_HELP)
			return EXIT_OK
		}
		if (arg === '--dry-run') {
			dryRun = true
			continue
		}
		if (arg === '--devcontainer-dir' || arg.startsWith('--devcontainer-dir=')) {
			const parsed = flagValue(args, i, '--devcontainer-dir')
			if ('error' in parsed) {
				process.stderr.write('devc initialize: --devcontainer-dir requires a path\n')
				return EXIT_USAGE
			}
			devcontainerDir = parsed.value
			i += parsed.consumed
			continue
		}
		process.stderr.write(`devc initialize: unknown option "${arg}"\n\n${INITIALIZE_HELP}`)
		return EXIT_USAGE
	}

	try {
		return await initialize({ devcontainerDir, dryRun, cwd: process.cwd() })
	} catch (error) {
		if (error instanceof PathResolutionError) {
			process.stderr.write(`devc initialize: ${error.message}\n`)
			return EXIT_USAGE
		}
		throw error
	}
}

function runMigrate(args: readonly string[]): number {
	let targetDir: string | undefined
	for (const arg of args) {
		if (arg === '--help' || arg === '-h') {
			process.stdout.write(MIGRATE_HELP)
			return EXIT_OK
		}
		if (arg.startsWith('-')) {
			process.stderr.write(`devc migrate: unknown option "${arg}"\n\n${MIGRATE_HELP}`)
			return EXIT_USAGE
		}
		if (targetDir !== undefined) {
			process.stderr.write(`devc migrate: unexpected argument "${arg}" (one directory at most)\n`)
			return EXIT_USAGE
		}
		targetDir = arg
	}
	return migrate({ cwd: process.cwd(), targetDir })
}
