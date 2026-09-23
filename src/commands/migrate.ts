// `devc migrate` — the report a tree made by install.sh gets, and nothing else.
//
// Measured over three real v2 trees before this was written: there is no
// pristine baseline to diff against (install.sh kept no manifest and the
// template moved on since each install), the three files a migration must
// change are the three most hand-edited (Dockerfile, docker-compose.yml,
// devcontainer.json — the last one JSONC this CLI can read but not rewrite),
// and every tree carries subsystems the v3 scaffold has no slot for. So this
// command reads, classifies and prints a checklist with the tree's own values
// in it. It has no write path at all — not behind a flag, not anywhere — and
// the test suite holds it to that by hashing the tree before and after.
//
// The additive half of a migration already exists: once the checklist is done
// the tree carries the customizations.stitchu-devc block and builds on the
// published image, so `devc init` reports it as its own and adds the missing
// config files without overwriting anything.

import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { baseImageRef, BASE_IMAGE_REPOSITORY, DEFAULT_CLAUDE_CODE_VERSION } from '../lib/docker.js'
import {
	CATEGORY_MEANING,
	detectLegacy,
	inventoryLegacy,
	LIFECYCLE_KEYS,
	type LegacyCategory,
	type LegacyEntry,
} from '../lib/legacy.js'
import { classifyTarget } from '../lib/scaffold.js'
import { CLI_NAME, CLI_VERSION, majorRange } from '../lib/version.js'

export interface MigrateOptions {
	cwd: string
	/** Project root to read; defaults to cwd. */
	targetDir?: string | undefined
	out?: NodeJS.WritableStream
	err?: NodeJS.WritableStream
}

export const MIGRATE_HELP = `devc migrate — what a tree made by install.sh needs to build on the published image

Usage:
  devc migrate [dir]

Arguments:
  dir                        Project root (default: the current directory)

Options:
  -h, --help                 Show this help

Reads .devcontainer/, names what was found, sorts its entries by what becomes
of them after the switch, and prints the checklist with this project's own
values filled in. It writes nothing, and no flag makes it write. Once the
checklist is done, \`devc init\` recognises the tree and adds the missing files.

Exit codes: 0 report printed; 1 nothing to migrate (what was found is said);
2 usage.
`

const CATEGORY_ORDER: readonly LegacyCategory[] = ['config', 'image', 'pending', 'retired', 'runtime', 'yours']
const LOCAL_LINEAGE = 'claude-devcontainer-base'

export function migrate(options: MigrateOptions): number {
	const out = options.out ?? process.stdout
	const err = options.err ?? process.stderr
	const say = (line = ''): void => {
		out.write(`${line}\n`)
	}

	const projectDir = resolve(options.cwd, options.targetDir ?? '.')
	if (!isDirectory(projectDir)) {
		err.write(`devc migrate: target directory does not exist: ${projectDir}\n`)
		return 2
	}

	const legacy = detectLegacy(projectDir)
	if (legacy === null) {
		const state = classifyTarget(projectDir)
		const why =
			state.kind === 'absent'
				? 'no .devcontainer/ here — devc init scaffolds one'
				: state.kind === 'same'
					? 'this .devcontainer/ was scaffolded by this CLI — devc init reports it'
					: `${state.found} — not a tree install.sh made`
		err.write(`devc migrate: nothing to migrate — ${why}\n`)
		return 1
	}

	const tree = inventoryLegacy(projectDir)
	const marker = legacy.marker
	const fields = marker?.fields ?? {}
	const projectId = fields['PROJECT_ID'] ?? tree.env['DC_PROJECT'] ?? null
	const credsVolume = fields['CLAUDE_CREDS_VOLUME'] ?? tree.env['CLAUDE_CREDS_VOLUME'] ?? null
	const envState = (key: string): string => (tree.env[key] === undefined ? 'MISSING in .env — step 5' : '.env: set')
	const npxLine = `npx --yes ${CLI_NAME}@${majorRange()} initialize`

	say(`devc migrate — ${CLI_NAME} v${CLI_VERSION}`)
	say(`  target: ${projectDir}`)
	say()
	say(`  This is ${legacy.found}. It is not migrated by this command: the switch is a`)
	say('  handful of edits to files this CLI cannot rewrite safely, listed below with')
	say("  this project's values. Nothing here is written — this command only reads.")
	say()

	say('  What was found')
	say(
		`    marker:             ${marker === null ? 'no .configured-setup (Dockerfile.base alone names the tree)' : `.configured-setup v${marker.version}${fields['INSTALLED_AT'] === undefined ? '' : `, installed ${fields['INSTALLED_AT']}`}`}`,
	)
	if (marker !== null) {
		say(`    project:            ${fields['PROJECT_ID'] ?? '?'} — "${fields['PROJECT_DISPLAY_NAME'] ?? '?'}" (${fields['PROJECT_TYPE'] ?? '?'})`)
	}
	say(`    DC_PROJECT:         ${projectId ?? '?'}  ${envState('DC_PROJECT')}`)
	say(`    creds volume:       ${credsVolume ?? '?'}  ${envState('CLAUDE_CREDS_VOLUME')}`)
	say(`    Dockerfile:         ${describeFrom(tree.dockerfileFrom)}`)
	if (tree.devcontainer === null) {
		say('    devcontainer.json:  missing or unparseable — the lifecycle lines below could not be read')
	}
	say(`    initializeCommand:  ${tree.initializeCommand ?? '(none)'}`)
	say(`    lifecycle:          ${LIFECYCLE_KEYS.map((key) => tree.lifecycle[key] ?? '(none)').join(' · ')}`)
	say(
		`    stitchu-devc block: ${tree.stitchuBlock ? 'present' : 'absent — until it is there this CLI does not recognise the tree (step 3)'}`,
	)
	say(
		`    skills loader:      ${tree.loader ? 'skills/sync-skills.sh present — your post-start.sh runs it today; remove it in step 6' : 'none'}`,
	)
	say()

	say(`  .devcontainer/ entries (${tree.entries.length})`)
	for (const category of CATEGORY_ORDER) {
		const entries = tree.entries.filter((entry) => entry.category === category)
		if (entries.length === 0) continue
		say(`    ${category} (${entries.length}) — ${CATEGORY_MEANING[category]}`)
		for (const line of wrap(entries.map((entry) => entry.name), 72)) say(`      ${line}`)
		for (const entry of entries.filter(hasNote)) say(`      · ${entry.name} — ${entry.note}`)
	}
	say()

	say('  Checklist — each step is a file edit; git shows it, git checkout -- <file> reverts it.')
	say('    1. Dockerfile          rebuild it on the published image: `devc init --yes` into an')
	say('                           empty directory writes the fw-bake template; keep your own RUN')
	say(`                           lines under its final FROM. The ${LOCAL_LINEAGE} lineage ends here.`)
	say('    2. docker-compose.yml  build args: BASE_IMAGE replaces CLAUDE_CODE_VERSION + DC_PROJECT')
	say(`                           (default ${baseImageRef(DEFAULT_CLAUDE_CODE_VERSION)}). Extra services stay.`)
	say('    3. devcontainer.json   onCreateCommand / postCreateCommand / postStartCommand become')
	say('                           "devc-hook on-create" / "devc-hook post-create" / "devc-hook post-start";')
	say('                           add "customizations": { "stitchu-devc": {} } — the block this CLI')
	say('                           recognises a v3 tree by. initializeCommand can stay as it is (step 4).')
	say('    4. initialize.sh       replace its body with the shim (templates/v3/project/initialize.sh in')
	say(`                           the devcontainer-tools repo): it execs \`${npxLine}\`.`)
	say('                           Or put that npx line in initializeCommand directly. Either way add the')
	say(`                           CLI as a root devDependency (npm i -D ${CLI_NAME}) so npx resolves it offline.`)
	say(`    5. .env                DC_PROJECT=${projectId ?? '<id>'} and CLAUDE_CREDS_VOLUME=${credsVolume ?? '<volume>'}`)
	say(`                           — from .configured-setup; ${tree.env['DC_PROJECT'] === undefined || tree.env['CLAUDE_CREDS_VOLUME'] === undefined ? 'at least one is missing here' : 'both already set here'}.`)
	say('    6. remove              Dockerfile.base, the Dockerfile.<stack> variants, .configured-setup,')
	say('                           and skills/sync-skills.sh — the published image lines still prefer a')
	say('                           workspace loader, which would install your skills alone and drop the')
	say('                           baked ones. To this CLI the tree is v3 from here on.')
	say('    7. devc init           now reports the tree as its own and adds the missing config files')
	say('                           (hooks/disabled.txt, skills/disabled.txt, firewall/ports.txt, …).')
	say('                           It never overwrites.')
	say('    8. first boot          `devc-hook post-start --dry-run` in the container shows the resolved')
	say('                           hook set (base < ext < this project). Then the `image` entries above can go.')
	say()
	say('  Nothing was written.')
	return 0
}

function describeFrom(from: string | null): string {
	if (from === null) return 'no Dockerfile'
	if (from.includes(BASE_IMAGE_REPOSITORY)) return `${from}  — already the published image`
	if (from.includes(LOCAL_LINEAGE)) return `${from}  — local lineage, built by initialize.sh`
	return from
}

function hasNote(entry: LegacyEntry): entry is LegacyEntry & { note: string } {
	return entry.note !== undefined
}

/** Names on lines of at most `width` characters, two spaces apart. */
function wrap(names: readonly string[], width: number): string[] {
	const lines: string[] = []
	let current = ''
	for (const name of names) {
		if (current.length > 0 && current.length + 2 + name.length > width) {
			lines.push(current)
			current = ''
		}
		current = current.length === 0 ? name : `${current}  ${name}`
	}
	if (current.length > 0) lines.push(current)
	return lines
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}
