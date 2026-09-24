// Opt-in diagnostic dump — the port of initialize/rebuild-debug.sh.
//
// Records everything that could plausibly signal "rebuild without cache" from
// VS Code or the Dev Container CLI, because that propagation is undocumented
// and had to be reverse-engineered from live captures. Cheap (~20 ms) and off
// by default so logs/ stays clean between builds.
//
// Enable with DEBUG_REBUILD_CONTEXT=1 in .devcontainer/.env or as an env prefix.

import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from './logger.js'
import { relativeTo } from './paths.js'
import { ancestry, readProcess } from './proc.js'

const SIGNAL_ENV_RE = /(VSCODE|REMOTE_|DEVCONTAINER|DOCKER|COMPOSE|BUILDKIT|NO_?CACHE|REBUILD|CI)/i

export interface RebuildContextOptions {
	logger: Logger
	devcontainerDir: string
	timestamp: string
}

export function dumpRebuildContext(options: RebuildContextOptions): void {
	const { logger, devcontainerDir } = options
	const logDir = join(devcontainerDir, 'tmp', 'logs')
	mkdirSync(logDir, { recursive: true })
	const logPath = join(logDir, `rebuild-context-${options.timestamp}.log`)

	const self = readProcess(process.pid)
	const lines: string[] = [
		`=== rebuild-context ${new Date().toString()} ===`,
		`self pid       : ${process.pid}`,
		`self args      : ${self?.args ?? process.argv.join(' ')}`,
		`self ppid      : ${process.ppid}`,
		'',
		'=== full ancestry (ps walk up to PID 1, max 15 hops) ===',
	]

	const chain = ancestry(process.pid, 15)
	if (chain.length === 0) {
		lines.push('(ps unavailable on this platform)')
	} else {
		for (const [depth, info] of chain.entries()) {
			lines.push(
				`depth=${String(depth).padEnd(2)} pid=${String(info.pid).padEnd(7)} ppid=${String(info.ppid ?? '?').padEnd(7)}`,
			)
			lines.push(`  args : ${info.args}`)
		}
	}

	lines.push(
		'',
		'=== env vars (VS Code / Dev Container / Docker / Compose / Buildkit / no-cache) ===',
	)
	const signalVars = Object.keys(process.env)
		.filter((key) => SIGNAL_ENV_RE.test(key))
		.sort()
		.map((key) => `${key}=${process.env[key] ?? ''}`)
	lines.push(...(signalVars.length > 0 ? signalVars : ['(no matches)']))

	lines.push('', '=== all env keys (names only, sorted) ===', ...columnise(Object.keys(process.env).sort(), 100))

	lines.push('', '=== signal files in .devcontainer/ ===', ...findDotFiles(devcontainerDir, 2))

	lines.push(
		'',
		'=== process context ===',
		`execPath        : ${process.execPath}`,
		`argv            : ${process.argv.join(' ')}`,
		`node            : ${process.version}`,
		`platform/arch   : ${process.platform}/${process.arch}`,
		`TERM            : ${process.env['TERM'] ?? '?'}`,
		`TTY stdout      : ${process.stdout.isTTY === true ? 'yes' : 'no'}`,
		`TTY stdin       : ${process.stdin.isTTY === true ? 'yes' : 'no'}`,
		'=== end ===',
		'',
	)

	writeFileSync(logPath, lines.join('\n'), 'utf8')
	logger.log(`ℹ Rebuild context dumped to: ${relativeTo(devcontainerDir, logPath)}`)
}

/** `column -c <width>` equivalent — pack short entries into padded rows. */
function columnise(entries: readonly string[], width: number): string[] {
	if (entries.length === 0) return []
	const cellWidth = Math.max(...entries.map((entry) => entry.length)) + 2
	const perRow = Math.max(1, Math.floor(width / cellWidth))
	const rows: string[] = []
	for (let i = 0; i < entries.length; i += perRow) {
		rows.push(
			entries
				.slice(i, i + perRow)
				.map((entry) => entry.padEnd(cellWidth))
				.join('')
				.trimEnd(),
		)
	}
	return rows
}

/** `find <dir> -maxdepth <n> -name '.*' -type f | sort`. */
function findDotFiles(root: string, maxDepth: number): string[] {
	const found: string[] = []
	const walk = (dir: string, depth: number): void => {
		if (depth > maxDepth) return
		let entries: string[]
		try {
			entries = readdirSync(dir)
		} catch {
			return
		}
		for (const name of entries) {
			const full = join(dir, name)
			let isDirectory = false
			try {
				isDirectory = statSync(full).isDirectory()
			} catch {
				continue
			}
			if (isDirectory) {
				walk(full, depth + 1)
				continue
			}
			if (name.startsWith('.')) found.push(full)
		}
	}
	walk(root, 1)
	return found.sort()
}
