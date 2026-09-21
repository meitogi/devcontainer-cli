// Guess the project's stack from what is on disk, so the wizard can preselect.
//
// The base image is Node 24 and self-sufficient; every other stack is a
// documented block the project adds to its own Dockerfile (ROLLOUT: one image,
// stacks as `stacks/*.md`). So the answer does not pick a Dockerfile any more
// — it picks which doc to point at and what to write in the CLAUDE-project.md
// stub. Two signals, both cheap: manifests at the project root, then an
// extension histogram three levels deep with the usual noise pruned.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type StackId =
	| 'node'
	| 'php'
	| 'android'
	| 'android-capacitor'
	| 'rust'
	| 'python'
	| 'go'
	| 'java'
	| 'ruby'
	| 'other'

export interface StackInfo {
	id: StackId
	label: string
	/** Path of the block doc in the base repo, when one exists. */
	doc: string | null
}

/** Order is the wizard's list order. */
export const STACKS: readonly StackInfo[] = [
	{ id: 'node', label: 'Node.js / TypeScript', doc: null },
	{ id: 'php', label: 'PHP', doc: 'stacks/php.md' },
	{ id: 'android', label: 'Android', doc: 'stacks/android.md' },
	{ id: 'android-capacitor', label: 'Capacitor Android plugin', doc: 'stacks/android-capacitor.md' },
	{ id: 'rust', label: 'Rust', doc: null },
	{ id: 'python', label: 'Python', doc: null },
	{ id: 'go', label: 'Go', doc: null },
	{ id: 'java', label: 'Java', doc: null },
	{ id: 'ruby', label: 'Ruby', doc: null },
	{ id: 'other', label: 'Other', doc: null },
]

export function stackInfo(id: StackId): StackInfo {
	return STACKS.find((stack) => stack.id === id) ?? (STACKS[STACKS.length - 1] as StackInfo)
}

export function isStackId(value: string): value is StackId {
	return STACKS.some((stack) => stack.id === value)
}

/** Files this repository has a stack doc for, or a name for, at the root. */
const MANIFESTS: readonly { file: RegExp; stack: StackId }[] = [
	// Most specific first: a Capacitor or PHP project usually has a package.json too.
	{ file: /^capacitor\.config\.(ts|js|json)$/, stack: 'android-capacitor' },
	{ file: /^(build|settings)\.gradle(\.kts)?$/, stack: 'android' },
	{ file: /^composer\.json$/, stack: 'php' },
	{ file: /^Cargo\.toml$/, stack: 'rust' },
	{ file: /^(pyproject\.toml|requirements\.txt)$/, stack: 'python' },
	{ file: /^go\.mod$/, stack: 'go' },
	{ file: /^pom\.xml$/, stack: 'java' },
	{ file: /^Gemfile$/, stack: 'ruby' },
	{ file: /^package\.json$/, stack: 'node' },
]

const EXTENSIONS: Readonly<Record<string, StackId>> = {
	rs: 'rust',
	php: 'php',
	py: 'python',
	go: 'go',
	kt: 'android',
	java: 'java',
	rb: 'ruby',
	ts: 'node',
	tsx: 'node',
	js: 'node',
	mjs: 'node',
	cjs: 'node',
}

const PRUNED = new Set(['node_modules', '.git', 'vendor', 'target', 'dist', 'build', '.devcontainer'])
const MAX_DEPTH = 3

export interface ExtensionCount {
	ext: string
	count: number
}

export interface Detection {
	stack: StackId
	/** Human-readable reasons, e.g. `["Cargo.toml", "38 .rs files"]`. */
	evidence: string[]
}

/**
 * The pure half: manifests present at the root, histogram sorted by count.
 *
 * A Capacitor config with no Android tree is a Capacitor *app*, whose native
 * side lives elsewhere — that still lands on the plugin stack because the
 * toolchain is the same; the doc says so.
 */
export function classifyStack(manifests: readonly string[], histogram: readonly ExtensionCount[]): Detection {
	for (const { file, stack } of MANIFESTS) {
		const hit = manifests.find((name) => file.test(name))
		if (hit !== undefined) {
			const top = histogram[0]
			const evidence = [hit]
			if (top !== undefined && top.count > 0) evidence.push(`${top.count} .${top.ext} file${top.count === 1 ? '' : 's'}`)
			return { stack, evidence }
		}
	}
	for (const { ext, count } of histogram) {
		const stack = EXTENSIONS[ext]
		if (stack !== undefined) return { stack, evidence: [`${count} .${ext} file${count === 1 ? '' : 's'}`] }
	}
	return { stack: 'other', evidence: [] }
}

/** Root manifest names plus the extension histogram, depth-bounded and pruned. */
export function inspectProject(projectDir: string): { manifests: string[]; histogram: ExtensionCount[] } {
	const counts: Record<string, number> = {}
	const manifests: string[] = []
	const walk = (dir: string, depth: number): void => {
		let entries: string[]
		try {
			entries = readdirSync(dir)
		} catch {
			return
		}
		for (const name of entries) {
			if (PRUNED.has(name)) continue
			const path = join(dir, name)
			let isDir = false
			try {
				isDir = statSync(path).isDirectory()
			} catch {
				continue
			}
			if (isDir) {
				if (depth < MAX_DEPTH) walk(path, depth + 1)
				continue
			}
			if (depth === 1) manifests.push(name)
			const dot = name.lastIndexOf('.')
			if (dot > 0 && dot < name.length - 1) {
				const ext = name.slice(dot + 1).toLowerCase()
				counts[ext] = (counts[ext] ?? 0) + 1
			}
		}
	}
	walk(projectDir, 1)
	const histogram: ExtensionCount[] = []
	for (const ext in counts) histogram.push({ ext, count: counts[ext] as number })
	histogram.sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext))
	return { manifests, histogram }
}

export function detectStack(projectDir: string): Detection {
	const { manifests, histogram } = inspectProject(projectDir)
	return classifyStack(manifests, histogram)
}
