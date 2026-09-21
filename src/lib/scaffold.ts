// The scaffold as data: which files, with what content, owned by whom.
//
// Kept pure on purpose — `buildPlan` returns paths and bytes without touching
// the target, so the same object drives the write, the `--dry-run` listing,
// the assertion suite and the "what would differ" report over an existing
// tree. `applyPlan` is the only function here that writes.
//
// What is NOT here says as much as what is. install.sh dropped 364 files into
// a project; a v3 project owns ~25, because everything else — hooks, skills,
// knowledge, firewall infrastructure, the toolchain — lives in the published
// base image and is inherited at runtime. The templates directory is the
// complete list.

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { stackInfo, type StackId } from './detect-stack.js'
import { readDevcontainerJson } from './devcontainer-json.js'
import { BASE_IMAGE_REPOSITORY, baseImageRef, DEFAULT_CLAUDE_CODE_VERSION } from './docker.js'
import { applyUncomment } from './env-file.js'
import { render, type TemplateValues } from './template.js'
import { CLI_NAME, majorRange, PACKAGE_ROOT } from './version.js'

export const TEMPLATES_DIR = join(PACKAGE_ROOT, 'templates')

/**
 * Who owns a scaffolded file once it exists.
 *
 *   managed — the CLI's; compared against the current template on re-runs.
 *   seed    — written once with real content, then the project's to edit.
 *   user    — private or generated (`.env`, `LESSONS.md`); never compared.
 *
 * Nothing is ever overwritten regardless — the distinction is what a re-run
 * *reports*, and later what `devc update` may offer to refresh.
 */
export type Ownership = 'managed' | 'seed' | 'user'

export const OWNERSHIP: Readonly<Record<string, Ownership>> = {
	'.devcontainer/Dockerfile': 'seed',
	'.devcontainer/.env': 'user',
	'.devcontainer/LESSONS.md': 'user',
	'.devcontainer/vscode-settings.jsonc': 'seed',
	'.devcontainer/claude/CLAUDE-dev.md': 'seed',
	'.devcontainer/claude/CLAUDE-project.md': 'seed',
	'.devcontainer/firewall/CLAUDE.md': 'seed',
	'.devcontainer/firewall/domains.txt': 'seed',
	'.devcontainer/firewall/domains.d/README.md': 'seed',
	'.devcontainer/firewall/policy.d/README.md': 'seed',
	'.devcontainer/firewall/ports.txt': 'seed',
	'.devcontainer/firewall/default-mode': 'seed',
	'.devcontainer/hooks/disabled.txt': 'seed',
	'.devcontainer/hooks/on-create.d/README.md': 'seed',
	'.devcontainer/hooks/post-create.d/README.md': 'seed',
	'.devcontainer/hooks/post-start.d/README.md': 'seed',
	'.devcontainer/skills/disabled.txt': 'seed',
	'.claude/settings.local.json': 'user',
}

export interface ScaffoldAnswers {
	projectId: string
	displayName: string
	stack: StackId
	/** null = per-project volume, derived and created by `devc initialize`. */
	credsVolume: string | null
	claudeCodeVersion: string
}

export interface PlannedFile {
	/** Relative to the project root, forward slashes. */
	path: string
	content: string
	ownership: Ownership
}

export interface PlannedSymlink {
	path: string
	target: string
}

export interface ScaffoldPlan {
	files: PlannedFile[]
	symlinks: PlannedSymlink[]
	/** Appended to the root .gitignore; its first line is the idempotency sentinel. */
	gitignoreFragment: string
	imageRef: string
}

export function templateValues(answers: ScaffoldAnswers): TemplateValues {
	return {
		PROJECT_ID: answers.projectId,
		PROJECT_DISPLAY_NAME: answers.displayName,
		PROJECT_STACK: answers.stack === 'other' ? 'to be filled in' : stackInfo(answers.stack).label,
		DEVC_PACKAGE: CLI_NAME,
		DEVC_RANGE: majorRange(),
	}
}

/**
 * A template file named `_gitignore` lands as `.gitignore`.
 *
 * npm's packer drops any file literally named `.gitignore` from a tarball,
 * silently — the dev checkout has the file, a registry install does not, and
 * `buildPlan` walks the directory, so the scaffold would simply lack it. The
 * underscore is the convention create-vite and others settled on for the same
 * reason; `test/template.test.ts` asserts the pack listing matches the tree.
 */
export function scaffoldName(templateName: string): string {
	return templateName === '_gitignore' ? '.gitignore' : templateName
}

/** Every file under `templates/devcontainer/`, rendered, plus the generated ones. */
export function buildPlan(answers: ScaffoldAnswers, templatesDir = TEMPLATES_DIR): ScaffoldPlan {
	const values = templateValues(answers)
	const root = join(templatesDir, 'devcontainer')
	const files: PlannedFile[] = walk(root).map((relative) => {
		const path = `.devcontainer/${relative.split('/').map(scaffoldName).join('/')}`
		const source = readFileSync(join(root, ...relative.split('/')), 'utf8')
		return { path, content: render(source, values, relative), ownership: OWNERSHIP[path] ?? 'managed' }
	})

	// .env — the rendered .env.example with the answers made live on their own
	// documented lines (install.sh's generate_env, minus the sed).
	const example = files.find((file) => file.path === '.devcontainer/.env.example')
	if (example === undefined) throw new Error(`${root}: no .env.example template`)
	let env = applyUncomment(example.content, 'DC_PROJECT', answers.projectId)
	if (answers.credsVolume !== null) env = applyUncomment(env, 'CLAUDE_CREDS_VOLUME', answers.credsVolume)
	if (answers.claudeCodeVersion !== DEFAULT_CLAUDE_CODE_VERSION) {
		env = applyUncomment(env, 'BASE_IMAGE', baseImageRef(answers.claudeCodeVersion))
	}
	files.push({ path: '.devcontainer/.env', content: env, ownership: 'user' })

	// Root-side: the read-only permissions baseline, example refreshed by the
	// CLI, live copy the user's (install.sh's install_claude_settings).
	const settings = readFileSync(join(templatesDir, 'root', 'claude-settings.local.json.example'), 'utf8')
	files.push({ path: '.claude/settings.local.json.example', content: settings, ownership: 'managed' })
	files.push({ path: '.claude/settings.local.json', content: settings, ownership: 'user' })

	// Code-point order, not localeCompare: the latter folds case by locale, and
	// the plan's order must be the same on every machine.
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
	return {
		files,
		// The literal targets install.sh wrote (link_lessons_root, link_claude_rules_root).
		symlinks: [
			{ path: 'LESSONS.md', target: '.devcontainer/LESSONS.md' },
			{ path: '.claude/rules/mandatory.md', target: '../../.devcontainer/claude/CLAUDE-dev.md' },
			{ path: '.claude/rules/project.md', target: '../../.devcontainer/claude/CLAUDE-project.md' },
		],
		gitignoreFragment: readFileSync(join(templatesDir, 'root', 'gitignore-root'), 'utf8'),
		imageRef: baseImageRef(answers.claudeCodeVersion),
	}
}

/** Files under `dir`, relative, forward slashes, sorted. */
function walk(dir: string, prefix = ''): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name)
		const relative = prefix.length === 0 ? name : `${prefix}/${name}`
		if (statSync(path).isDirectory()) out.push(...walk(path, relative))
		else out.push(relative)
	}
	return out
}

// === The three states ======================================================

export type TargetState =
	/** No .devcontainer — scaffold. */
	| { kind: 'absent' }
	/** A v3 tree this CLI recognises — report, add what is missing, never overwrite. */
	| { kind: 'same' }
	/** Something else — refuse, say what was found. */
	| { kind: 'different'; found: string; detail: string[] }

const MARKER_VERSION = /^VERSION="?([0-9]+)/m

/**
 * Decide before anything is written. Negatives first: a `stitchu-devc` block
 * is not proof of a v3 tree (the v2-shaped dockerbase template carries one
 * too, and v2 users were told to add it), so the install.sh fingerprints
 * are checked before the positive test.
 */
export function classifyTarget(projectDir: string): TargetState {
	const dc = join(projectDir, '.devcontainer')
	const different = (found: string, detail: string[] = []): TargetState => ({ kind: 'different', found, detail })

	if (existsSync(join(dc, 'Dockerfile.base'))) {
		return different('a v2 layout made by install.sh (Dockerfile.base is present)', [
			'This CLI does not migrate a v2 tree; "devc migrate" is not available in this version.',
		])
	}
	const marker = join(dc, '.configured-setup')
	if (existsSync(marker)) {
		const major = MARKER_VERSION.exec(readFileSync(marker, 'utf8'))?.[1] ?? '?'
		return different(`a v${major} layout made by install.sh (.configured-setup is present)`, [
			'This CLI does not migrate it; "devc migrate" is not available in this version.',
		])
	}
	if (existsSync(join(projectDir, '.devcontainer.json'))) {
		return different('a .devcontainer.json at the project root', [
			'That is a devcontainer this CLI does not manage; it scaffolds .devcontainer/ only.',
		])
	}
	if (!isDirectory(dc)) return { kind: 'absent' }
	const entries = readdirSync(dc).filter((name) => name !== '.gitkeep' && name !== '.DS_Store')
	const nested = entries.filter((name) => existsSync(join(dc, name, 'devcontainer.json')))
	if (nested.length > 0) {
		return different(`nested configurations (.devcontainer/${nested[0]}/devcontainer.json)`, [
			'Multi-configuration layouts are not managed by this CLI.',
		])
	}
	if (entries.length === 0) return { kind: 'absent' }

	const json = join(dc, 'devcontainer.json')
	if (!existsSync(json)) {
		return different('a .devcontainer/ directory with no devcontainer.json', [
			'Nothing identifies it as a devcontainer. Move it aside if it is a leftover.',
		])
	}
	const parsed = readDevcontainerJson(json)
	if (parsed === null) {
		return different('a devcontainer.json this CLI cannot parse', [
			'Only // line comments and trailing commas are tolerated; /* */ block comments are not.',
		])
	}
	const customizations = parsed['customizations']
	const stitchu = isRecord(customizations) ? customizations['stitchu-devc'] : undefined
	if (!isRecord(stitchu)) {
		return different('a devcontainer.json without a customizations.stitchu-devc block', [
			'It was made by another tool or by hand; this CLI only manages trees it scaffolded.',
		])
	}
	const onBase = ['Dockerfile', 'docker-compose.yml'].some((name) => {
		const file = join(dc, name)
		return existsSync(file) && readFileSync(file, 'utf8').includes(BASE_IMAGE_REPOSITORY)
	})
	if (!onBase) {
		return different(`a devcontainer that does not build on ${BASE_IMAGE_REPOSITORY}`, [
			'Neither Dockerfile nor docker-compose.yml references the published base image.',
		])
	}
	return { kind: 'same' }
}

// === Re-run over an existing tree ==========================================

export type FileStatus = 'identical' | 'differs' | 'yours' | 'missing'

export interface FileReport {
	path: string
	status: FileStatus
	ownership: Ownership
}

/** Compare a plan with the tree on disk. Pure apart from the reads. */
export function diffPlan(projectDir: string, plan: ScaffoldPlan): FileReport[] {
	return plan.files.map((file) => {
		const abs = join(projectDir, ...file.path.split('/'))
		if (!existsSync(abs)) return { path: file.path, status: 'missing', ownership: file.ownership }
		if (file.ownership !== 'managed') return { path: file.path, status: 'yours', ownership: file.ownership }
		const same = readFileSync(abs, 'utf8') === file.content
		return { path: file.path, status: same ? 'identical' : 'differs', ownership: file.ownership }
	})
}

// === Writing ===============================================================

export interface ApplyOptions {
	projectDir: string
	plan: ScaffoldPlan
	dryRun: boolean
}

export interface ApplyResult {
	/** Files created (or, in dry-run, that would be). */
	written: string[]
	/** Files left alone because they already existed. */
	kept: string[]
	/** Symlinks that could not be made, with the command to run by hand. */
	symlinkProblems: string[]
	gitignore: 'appended' | 'unchanged'
}

/**
 * Write what is missing, never overwrite. That single rule is what makes a
 * re-run safe and what install.sh only had for .env and LESSONS.md.
 */
export function applyPlan(options: ApplyOptions): ApplyResult {
	const { projectDir, plan, dryRun } = options
	const result: ApplyResult = { written: [], kept: [], symlinkProblems: [], gitignore: 'unchanged' }

	for (const file of plan.files) {
		const abs = join(projectDir, ...file.path.split('/'))
		if (existsSync(abs)) {
			result.kept.push(file.path)
			continue
		}
		if (!dryRun) {
			mkdirSync(dirname(abs), { recursive: true })
			writeFileSync(abs, file.content, 'utf8')
		}
		result.written.push(file.path)
	}

	for (const link of plan.symlinks) {
		const abs = join(projectDir, ...link.path.split('/'))
		let existing: string | null = null
		try {
			existing = lstatSync(abs).isSymbolicLink() ? readlinkSync(abs) : ''
		} catch {
			existing = null
		}
		if (existing === link.target) {
			result.kept.push(link.path)
			continue
		}
		if (existing !== null) {
			result.symlinkProblems.push(`${link.path} exists and is not a symlink to ${link.target} — left alone`)
			continue
		}
		if (dryRun) {
			result.written.push(`${link.path} -> ${link.target}`)
			continue
		}
		try {
			mkdirSync(dirname(abs), { recursive: true })
			symlinkSync(link.target, abs)
			result.written.push(`${link.path} -> ${link.target}`)
		} catch (error) {
			// Windows outside Developer Mode throws EPERM here. The scaffold is
			// still complete without the links; say what to run by hand.
			const code = (error as NodeJS.ErrnoException).code ?? 'error'
			result.symlinkProblems.push(`${link.path}: ${code} — run: ln -s ${link.target} ${link.path}`)
		}
	}

	result.gitignore = appendGitignore(join(projectDir, '.gitignore'), plan.gitignoreFragment, dryRun)
	return result
}

/**
 * install.sh's update_gitignore: append the fragment once, keyed on its first
 * line. A project that ran install.sh before keeps the v2 block too — the
 * sentinels differ on purpose, and the patterns overlap harmlessly.
 */
export function appendGitignore(file: string, fragment: string, dryRun: boolean): 'appended' | 'unchanged' {
	const sentinel = fragment.split('\n')[0] ?? ''
	const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
	if (existing.split('\n').includes(sentinel)) return 'unchanged'
	if (!dryRun) {
		let head = existing
		if (head.length > 0 && !head.endsWith('\n')) head += '\n'
		if (head.length > 0) head += '\n'
		writeFileSync(file, `${head}${fragment}`, 'utf8')
	}
	return 'appended'
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
