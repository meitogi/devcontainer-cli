// devc firewall-mode — report the firewall mode, or set it.
//
// Supersedes the v2 `firewall-mode.sh`, which the migration notes already named
// this command as the successor to. It writes two files and shells out to
// nothing: the same call works on the host and inside the container, which is
// the property the old script claimed and this one keeps by needing no docker.

import { existsSync } from 'node:fs'
import {
	canonicaliseMode,
	firewallFlagPath,
	MODE_SUMMARY,
	PROXY_KEYS,
	proxyEnvMatches,
	readMode,
	syncProxyEnv,
	writeMode,
	type FirewallMode,
} from '../lib/firewall.js'
import { Logger } from '../lib/logger.js'
import { classifyDevcontainer, relativeTo, resolveProjectPaths } from '../lib/paths.js'

const MARK_OK = '[+]'
const MARK_WARN = '[!]'

export interface FirewallModeOptions {
	cwd: string
	/** Absent = report the current mode and write nothing. */
	mode?: string | undefined
	devcontainerDir?: string | undefined
	dryRun?: boolean
	out?: NodeJS.WritableStream
	err?: NodeJS.WritableStream
}

export const FIREWALL_MODE_HELP = `devc firewall-mode — report the firewall mode, or set it

Usage:
  devc firewall-mode [mode]

Arguments:
  mode                       off | basic | strict. Omit to report.

Options:
      --devcontainer-dir <p> Path to .devcontainer/ (default: found from cwd)
      --dry-run              Say what would change, write nothing
  -h, --help                 Show this help

  off     ${MODE_SUMMARY.off}
  basic   ${MODE_SUMMARY.basic}
  strict  ${MODE_SUMMARY.strict}

Writes firewall/default-mode, then aligns the proxy/CA variables in .env with
it — which a bare \`echo strict > firewall/default-mode\` does not, leaving .env
saying the opposite of the flag. Running it for the mode already set is the
repair for exactly that.

Takes effect on the next rebuild: firewall/ is COPYed into the image at build
time, so Reload Window is not enough.

  Host:       npx @meitogi/devcontainer-cli firewall-mode <mode>
  Container:  npx devc firewall-mode <mode>

Exit codes: 0 reported or written; 1 no .devcontainer/ found; 2 usage.
`

export function firewallMode(options: FirewallModeOptions): number {
	const out = options.out ?? process.stdout
	const err = options.err ?? process.stderr
	const say = (line = ''): void => {
		out.write(`${line}\n`)
	}
	const dryRun = options.dryRun ?? false

	// A mistyped mode is a usage error wherever you are standing, so it is caught
	// before the tree is even looked at: reporting "no devcontainer here" to
	// someone who simply typo'd the word sends them to fix the wrong thing.
	let mode: FirewallMode | undefined
	if (options.mode !== undefined) {
		const parsed = canonicaliseMode(options.mode)
		if ('error' in parsed) {
			err.write(`devc firewall-mode: ${parsed.error}\n`)
			return 2
		}
		if (parsed.deprecated !== undefined) {
			err.write(
				`devc firewall-mode: "${parsed.deprecated}" is the v2 name for "${parsed.mode}" - accepted, but "${parsed.mode}" is written\n`,
			)
		}
		mode = parsed.mode
	}

	const paths = resolveProjectPaths(options.cwd, options.devcontainerDir)
	// Refuse before writing anything, for the same reason initialize does: a path
	// from the caller carries no guarantee that it is a devcontainer at all, and
	// seeding firewall/default-mode into an unrelated directory is worse than
	// saying no.
	const state = classifyDevcontainer(paths.devcontainerDir)
	if (state.kind !== 'present') {
		err.write(
			state.kind === 'absent'
				? `devc firewall-mode: no .devcontainer directory at ${paths.devcontainerDir}\n` +
						'  point --devcontainer-dir at the right project.\n'
				: `devc firewall-mode: ${paths.devcontainerDir} has no devcontainer.json\n` +
						'  Nothing identifies it as a devcontainer. Run "devc init" to scaffold\n' +
						'  one, or point --devcontainer-dir at the right project.\n',
		)
		return 1
	}

	const flagFile = firewallFlagPath(paths.devcontainerDir)
	const previous = readMode(flagFile)
	const shown = relativeTo(paths.projectDir, flagFile)

	// No argument reports. The mode is otherwise invisible between boots — the
	// image banners `basic` only — and the write half is inert until a rebuild,
	// which makes an accidental write a slow-acting footgun and a read harmless.
	if (mode === undefined) {
		say(`firewall mode: ${previous}   (${shown}, baked at build time)`)
		const summary = MODE_SUMMARY[previous as FirewallMode]
		if (summary !== undefined) say(`  ${previous} - ${summary}`)
		if (proxyEnvMatches(paths.envFile, previous)) {
			say(`  .env: proxy/CA variables consistent with the mode`)
		} else {
			say(`  ${MARK_WARN} .env: proxy/CA variables disagree with the mode - stale.`)
			say(`      Run: devc firewall-mode ${previous}   (re-writes .env from the flag)`)
		}
		say(`Set it with: devc firewall-mode <off|basic|strict>   (takes effect on rebuild)`)
		return 0
	}

	const logger = Logger.create({ logFile: '', silentSink: true, out, err })
	const prefix = dryRun ? '[dry-run] would write' : 'firewall mode:'

	// The flag first, .env second. `devc initialize` re-derives .env from the flag
	// on every run, which makes the flag the authoritative half and .env the
	// self-healing one: a torn write that landed the flag is repaired at the next
	// start, one that landed only .env is a silent lie about the mode.
	writeMode(flagFile, mode, dryRun, logger)
	syncProxyEnv(paths.envFile, mode, dryRun, logger)

	const unchanged = previous === mode
	say(`${MARK_OK} ${prefix} ${unchanged ? `${mode} (unchanged)` : `${previous} -> ${mode}`}`)
	const verb = mode === 'strict' ? 'set' : 'cleared'
	say(`${MARK_OK} .env: proxy/CA variables ${verb} (${PROXY_KEYS.join(', ')})`)
	say(`    ${mode} - ${MODE_SUMMARY[mode]}`)
	say()
	say(`${MARK_WARN} Not in effect until the container is rebuilt: the firewall config is`)
	say(`    baked into the image, so Reload Window is not enough.`)
	say(`      VS Code -> Cmd/Ctrl+Shift+P -> "Dev Containers: Rebuild Container"`)
	if (existsSync(`${paths.devcontainerDir}/.configured-firewall-mode`)) {
		say(`${MARK_WARN} .configured-firewall-mode is a v2 file; nothing in v3 reads it.`)
	}
	return 0
}
