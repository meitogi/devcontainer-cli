// What a tree made by install.sh looks like, and how this CLI reads it.
//
// Two commands need the same facts: `devc init` refuses such a tree by its
// fingerprints, `devc migrate` reports it. One reader, so the two cannot
// disagree — a second copy of the same fingerprints is the shape that once
// gave this project eight divergent ports.txt parsers.
//
// Measured on three real v2 trees (2026-09-23): every one has Dockerfile.base,
// a six-key .configured-setup, one initializeCommand form, the three lifecycle
// keys in their bash form and a skills/sync-skills.sh run by its own
// post-start.sh. None carries a 1.x marker, so the v1 path below has the
// fingerprint but no fixture.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDevcontainerJson } from './devcontainer-json.js'
import { readEnvFile } from './env-file.js'

// === The marker =============================================================

export interface LegacyMarker {
	/** `VERSION` as written, e.g. `2.1.0`; empty when the line is missing. */
	version: string
	/** Its first integer — `2` — or `?` when the line is missing. */
	major: string
	/** Every `KEY="value"` line, quotes stripped. */
	fields: Readonly<Record<string, string>>
}

const MARKER_LINE = /^([A-Z_]+)=("?)(.*)\2\s*$/

/** `.configured-setup`, as install.sh's `write_v2_marker` writes it. Null when absent. */
export function readLegacyMarker(file: string): LegacyMarker | null {
	if (!existsSync(file)) return null
	const fields: Record<string, string> = {}
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const match = MARKER_LINE.exec(line)
		if (match !== null) fields[match[1] as string] = match[3] as string
	}
	const version = fields['VERSION'] ?? ''
	return { version, major: /^([0-9]+)/.exec(version)?.[1] ?? '?', fields }
}

// === The fingerprints =======================================================

export interface LegacyTree {
	/** `.devcontainer/Dockerfile.base` — the local image lineage install.sh built. */
	dockerfileBase: boolean
	marker: LegacyMarker | null
	/** What `devc init` says it refused; the same words whichever fingerprint fired. */
	found: string
}

/**
 * The two install.sh fingerprints, in the order `devc init` has always tested
 * them: Dockerfile.base first, so a v2 tree is named by its image lineage and
 * the marker alone names a v1 (or any other major).
 */
export function detectLegacy(projectDir: string): LegacyTree | null {
	const dc = join(projectDir, '.devcontainer')
	const dockerfileBase = existsSync(join(dc, 'Dockerfile.base'))
	const marker = readLegacyMarker(join(dc, '.configured-setup'))
	if (dockerfileBase) {
		return { dockerfileBase, marker, found: 'a v2 layout made by install.sh (Dockerfile.base is present)' }
	}
	if (marker !== null) {
		return { dockerfileBase, marker, found: `a v${marker.major} layout made by install.sh (.configured-setup is present)` }
	}
	return null
}

// === The layout =============================================================

/**
 * What becomes of a v2 entry once the tree builds on the published image.
 *
 *   image    — the base image ships it now; inert after the switch, remove
 *              once the new boot works.
 *   config   — v3 reads it in place; keep (and, for three of them, edit —
 *              that is the switch itself).
 *   pending  — nothing in v3 replaces it yet; keep, a later session owns it.
 *   retired  — nothing reads it after the switch and nothing replaces it.
 *   runtime  — generated state, never migrated.
 *   yours    — not from the template; the CLI has no opinion.
 */
export type LegacyCategory = 'image' | 'config' | 'pending' | 'retired' | 'runtime' | 'yours'

export const CATEGORY_MEANING: Readonly<Record<LegacyCategory, string>> = {
	image: 'shipped by the base image now — inert after the switch, remove once the new boot works',
	config: 'read by v3 in place — keep',
	pending: 'no v3 home yet — keep; a function v3 does not have back is a decision to make, not a loss to accept',
	retired: 'nothing reads it after the switch — decide what replaces it before removing; ask, do not drop',
	runtime: 'generated — never migrated',
	yours: 'not from the template — yours to keep',
}

export interface LayoutEntry {
	category: LegacyCategory
	/** For an entry that is several things at once, what is what. */
	note?: string
}

/**
 * install.sh's top-level entries (templates/v2/), plus the runtime debris a
 * live tree grows. Anything not listed is `yours`. The test suite checks the
 * template side of this table against templates/v2/ when that tree is present,
 * and the three real trees' entry lists against the whole of it.
 */
export const LEGACY_LAYOUT: Readonly<Record<string, LayoutEntry>> = {
	// --- the switch: three hand-edited files v3 reads in place ---
	'Dockerfile': { category: 'config', note: 'the switch: FROM the published image instead of the local claude-devcontainer-base' },
	'docker-compose.yml': { category: 'config', note: 'the switch: BASE_IMAGE build arg instead of CLAUDE_CODE_VERSION + DC_PROJECT' },
	'devcontainer.json': { category: 'config', note: 'the switch: devc-hook lifecycle commands + the customizations.stitchu-devc block' },
	'initialize.sh': { category: 'config', note: 'the shim: its body hands the step to the published CLI' },
	// --- config v3 reads as is ---
	'.env': { category: 'config' },
	'.env.example': { category: 'config' },
	'.gitignore': { category: 'config' },
	'.dockerignore': { category: 'config' },
	'.claude': { category: 'config', note: 'lands at the project root; v3 scaffolds the same files' },
	'LESSONS.md': { category: 'config' },
	'LESSONS.local.md': { category: 'config' },
	'vscode-settings.jsonc': { category: 'config' },
	'zshrc.local': { category: 'config' },
	'zshrc.local.example': { category: 'config' },
	'firewall': {
		category: 'config',
		note: 'domains*.txt, domains.d/, policy*.d/, default-mode stay and are read; compile-policy.py, addons/, tests/, dnsmasq.conf, mitm-init.sh, firewall-docker-setup.sh, firewall-blocks ship in the image',
	},
	'claude': {
		category: 'config',
		note: 'CLAUDE-*.md stay and are read; the template patchers under vscode-ext-patchs/ ship in the image and your own are still read from here; scripts/, sync-creds.sh, outbound-tester.js are yours',
	},
	'skills': {
		category: 'config',
		note: 'your own skill directories stay and resolve as the project layer; the template skills ship in the image; sync-skills.sh was the v2 single-layer loader — remove it with step 6: the published image lines still prefer a workspace loader, which would install your skills alone and drop the baked ones',
	},
	// --- shipped by the image ---
	'Dockerfile.base': { category: 'image', note: 'the local lineage ends with the switch; removing it is what makes this CLI see a v3 tree' },
	'Dockerfile.AndroidMin': { category: 'image', note: 'documented block: stacks/android.md in the base repo' },
	'Dockerfile.AndroidStd': { category: 'image', note: 'documented block: stacks/android.md in the base repo' },
	'Dockerfile.CapacitorAndroidMin': { category: 'image', note: 'documented block: stacks/android-capacitor.md in the base repo' },
	'Dockerfile.CapacitorAndroidStd': { category: 'image', note: 'documented block: stacks/android-capacitor.md in the base repo' },
	'Dockerfile.php': { category: 'image', note: 'documented block: stacks/php.md in the base repo' },
	'on-create.sh': { category: 'image', note: 'devc-hook runs hooks/on-create.d/ fragments; a flat hooks/on-create.sh is still honoured, this path is not' },
	'post-create.sh': { category: 'image', note: 'same, hooks/post-create.d/' },
	'post-start.sh': { category: 'image', note: 'same, hooks/post-start.d/' },
	'shell-init.sh': { category: 'image' },
	'zshrc-base': { category: 'image', note: 'the image sources its own copy, then this one on top — remove to avoid sourcing the same file twice' },
	'install-extensions.sh': { category: 'image' },
	'init-firewall.sh': { category: 'image' },
	'test-firewall.sh': { category: 'image' },
	'reload-local.sh': { category: 'image', note: 'reload-firewall in the image' },
	'knowledge': { category: 'image', note: 'reference files, deliberately unlayered — nothing reads them at runtime' },
	// --- no v3 home yet ---
	'notify': { category: 'pending', note: 'the notifier ships as its own binary later' },
	'claude-bridge': { category: 'pending', note: 'its compose service stays yours' },
	'host-helpers': { category: 'pending' },
	'scripts': { category: 'pending' },
	'tests': { category: 'pending' },
	// --- retired ---
	'initialize': { category: 'retired', note: 'notify-daemon.sh and rebuild-debug.sh are ported into the CLI' },
	'firewall-mode.sh': { category: 'retired', note: 'edit firewall/default-mode and rebuild — no v3 script yet, and the image banner still names this one' },
	'diag-ollama-local.sh': { category: 'retired' },
	'.gitignore-root': { category: 'retired', note: 'install.sh appended it to the root .gitignore; devc init appends its own fragment' },
	// --- docs: the template wrote them, the project may have edited them ---
	'README.md': { category: 'yours', note: 'template docs' },
	'RUNBOOK.md': { category: 'yours', note: 'template docs' },
	'SECURITY.md': { category: 'yours', note: 'template docs' },
	'RESEARCH.md': { category: 'yours', note: 'template docs' },
	'HOW-TO-CAPACITOR-PLUGIN.md': { category: 'yours', note: 'template docs' },
	// --- runtime ---
	'.configured-setup': { category: 'runtime', note: 'install.sh\'s marker; removing it is part of the switch' },
	'.configured-auth': { category: 'runtime' },
	'.configured-claude-mode': { category: 'runtime' },
	'logs': { category: 'runtime' },
	'cache': { category: 'runtime' },
	'pending': { category: 'runtime' },
	'pr-drafts': { category: 'runtime' },
	'research-bundles': { category: 'runtime' },
	'scan-deps': { category: 'runtime' },
	'.DS_Store': { category: 'runtime' },
}

// === The inventory ==========================================================

export interface LegacyEntry {
	/** Directory names carry a trailing slash. */
	name: string
	category: LegacyCategory
	note: string | undefined
}

export type LifecycleKey = 'onCreateCommand' | 'postCreateCommand' | 'postStartCommand'
export const LIFECYCLE_KEYS: readonly LifecycleKey[] = ['onCreateCommand', 'postCreateCommand', 'postStartCommand']

export interface LegacyInventory {
	entries: LegacyEntry[]
	/** `null` when devcontainer.json is missing or unparseable. */
	devcontainer: Record<string, unknown> | null
	initializeCommand: string | null
	lifecycle: Record<LifecycleKey, string | null>
	stitchuBlock: boolean
	/** The first `FROM` line of .devcontainer/Dockerfile, or null. */
	dockerfileFrom: string | null
	/** `.devcontainer/skills/sync-skills.sh` — the v2 loader the tree's own post-start.sh ran. */
	loader: boolean
	/** `.env`, as the tree has it (empty when absent). */
	env: Readonly<Record<string, string>>
}

/** Read everything the report needs. Reads only. */
export function inventoryLegacy(projectDir: string): LegacyInventory {
	const dc = join(projectDir, '.devcontainer')
	const entries = readdirSync(dc, { withFileTypes: true })
		.map((entry) => {
			const layout = LEGACY_LAYOUT[entry.name]
			return {
				name: entry.isDirectory() ? `${entry.name}/` : entry.name,
				category: layout?.category ?? 'yours',
				note: layout?.note,
			}
		})
		.sort((a, b) => a.name.localeCompare(b.name))

	const jsonFile = join(dc, 'devcontainer.json')
	const devcontainer = existsSync(jsonFile) ? readDevcontainerJson(jsonFile) : null
	const stringAt = (key: string): string | null => {
		const value = devcontainer?.[key]
		return typeof value === 'string' ? value : null
	}
	const customizations = devcontainer?.['customizations']
	const stitchuBlock =
		typeof customizations === 'object' && customizations !== null && 'stitchu-devc' in customizations

	const dockerfile = join(dc, 'Dockerfile')
	const dockerfileFrom = existsSync(dockerfile)
		? (readFileSync(dockerfile, 'utf8').split('\n').find((line) => /^FROM\s/.test(line)) ?? null)
		: null

	return {
		entries,
		devcontainer,
		initializeCommand: stringAt('initializeCommand'),
		lifecycle: {
			onCreateCommand: stringAt('onCreateCommand'),
			postCreateCommand: stringAt('postCreateCommand'),
			postStartCommand: stringAt('postStartCommand'),
		},
		stitchuBlock,
		dockerfileFrom,
		loader: existsSync(join(dc, 'skills', 'sync-skills.sh')),
		env: readEnvFile(join(dc, '.env')),
	}
}
