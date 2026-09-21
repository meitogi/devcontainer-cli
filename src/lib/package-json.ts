// The bootstrap manifest: a root package.json carrying the CLI as a devDependency.
//
// `npx @meitogi/devcontainer-cli init` runs cold, with nothing installed. The
// scaffold leaves a package.json behind so `npm install` pins the CLI locally
// and the container's initializeCommand runs that copy — lockfile-pinned, no
// registry round-trip per start.
//
// When a package.json already exists it belongs to the project, and the same
// lesson as env-file.ts applies: never round-trip someone's manifest through
// JSON.parse/stringify. JSON.parse is used to VALIDATE, the edit is textual —
// one line inserted at the file's own indentation and line ending — and any
// shape this cannot recognise falls back to printing the line to add by hand.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CLI_PACKAGE_NAME = '@meitogi/devcontainer-cli'

export type ManifestPlan =
	/** No package.json: write a minimal one. */
	| { kind: 'create'; content: string }
	/** One line inserted into the existing file. */
	| { kind: 'insert'; content: string }
	/** The devDependency is already there. */
	| { kind: 'present' }
	/** Shape not recognised: leave the file alone, tell the user what to add. */
	| { kind: 'manual'; reason: string }

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun'

/** Pure: given the current file content (or null when absent), what to write. */
export function planPackageJson(existing: string | null, name: string, range: string): ManifestPlan {
	if (existing === null) {
		return {
			kind: 'create',
			content: `{\n\t"private": true,\n\t"devDependencies": {\n\t\t"${name}": "${range}"\n\t}\n}\n`,
		}
	}
	if (existing.charCodeAt(0) === 0xfeff) return { kind: 'manual', reason: 'the file starts with a byte-order mark' }

	let parsed: unknown
	try {
		parsed = JSON.parse(existing)
	} catch {
		return { kind: 'manual', reason: 'the file is not valid JSON' }
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { kind: 'manual', reason: 'the file is not a JSON object' }
	}
	const devDependencies = (parsed as Record<string, unknown>)['devDependencies']
	if (typeof devDependencies === 'object' && devDependencies !== null && name in devDependencies) {
		return { kind: 'present' }
	}

	const eol = existing.includes('\r\n') ? '\r\n' : '\n'
	const indent = topLevelIndent(existing)
	if (indent === null) return { kind: 'manual', reason: 'could not tell the indentation' }
	const entry = `${indent}${indent}"${name}": "${range}"`

	const blocks = [...existing.matchAll(/^([ \t]*)"devDependencies"[ \t]*:[ \t]*\{/gm)]
	if (blocks.length > 1) return { kind: 'manual', reason: 'more than one "devDependencies" key' }

	const block = blocks[0]
	if (block !== undefined) {
		if (block[1] !== indent) return { kind: 'manual', reason: '"devDependencies" is not a top-level key' }
		const openBrace = (block.index as number) + block[0].length
		const rest = existing.slice(openBrace)
		const empty = /^\s*\}/.exec(rest)
		if (empty !== null) {
			// `"devDependencies": {}` → open it up onto three lines.
			const closeBrace = openBrace + empty[0].length
			return {
				kind: 'insert',
				content: `${existing.slice(0, openBrace)}${eol}${entry}${eol}${indent}}${existing.slice(closeBrace)}`,
			}
		}
		// Non-empty block: the next line is an existing entry, so ours takes the comma.
		return { kind: 'insert', content: `${existing.slice(0, openBrace)}${eol}${entry},${existing.slice(openBrace)}` }
	}

	// No block at all: add one before the final brace.
	const close = existing.lastIndexOf('}')
	if (close === -1) return { kind: 'manual', reason: 'no closing brace' }
	const head = existing.slice(0, close).replace(/\s+$/, '')
	const comma = head.endsWith('{') ? '' : ','
	const tail = existing.slice(close)
	return {
		kind: 'insert',
		content: `${head}${comma}${eol}${indent}"devDependencies": {${eol}${entry}${eol}${indent}}${eol}${tail}`,
	}
}

/** Indentation of the first top-level key, or null when there is none. */
function topLevelIndent(content: string): string | null {
	const match = /^([ \t]+)"[^"\r\n]+"[ \t]*:/m.exec(content)
	return match === null ? null : (match[1] as string)
}

/** Which install command to print, from the lockfile present at the root. */
export function detectPackageManager(projectDir: string): PackageManager {
	if (existsSync(join(projectDir, 'yarn.lock'))) return 'yarn'
	if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm'
	if (existsSync(join(projectDir, 'bun.lockb')) || existsSync(join(projectDir, 'bun.lock'))) return 'bun'
	return 'npm'
}

export function installCommand(manager: PackageManager): string {
	return manager === 'npm' ? 'npm install' : `${manager} install`
}

export function readPackageJson(projectDir: string): string | null {
	const file = join(projectDir, 'package.json')
	return existsSync(file) ? readFileSync(file, 'utf8') : null
}
