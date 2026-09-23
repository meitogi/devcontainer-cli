// Docker orchestration: volume/image helpers and the rebuild-vs-reopen probe.
// The base image is not built here — compose pulls the published
// ghcr.io/meitogi/devcontainer-sandbox tag, and bumping that tag is what an
// upgrade means.

import { join } from 'node:path'
import type { Logger } from './logger.js'
import type { HostKind } from './platform.js'
import { toHostPath } from './platform.js'
import { hasCommand, runCapture } from './proc.js'

/**
 * Fallback Claude Code version when `.env` does not pin one.
 *
 * Lives here rather than in the command so there is one place to change when
 * the pin moves. The published matrix is owned by the devcontainer-sandbox repo
 * (`cc-versions.json`, tag scheme `<base-version>-cc<cc-version>`); this
 * fallback must name a version that repo publishes.
 */
export const DEFAULT_CLAUDE_CODE_VERSION = '2.1.280'

/** Base-image version the scaffold pins; bumps with the base repo's releases. */
export const DEFAULT_BASE_VERSION = '1.4.1'

/**
 * The Claude Code versions the base repo currently publishes an image for —
 * its `cc-versions.json`. A table rather than a closed type so an unlisted
 * value is a warning, not a CLI release: a new pair upstream must not require
 * a new CLI to be scaffolded against.
 */
export const PUBLISHED_CLAUDE_CODE_VERSIONS: readonly string[] = ['2.1.220', '2.1.272', '2.1.280']

export const BASE_IMAGE_REPOSITORY = 'ghcr.io/meitogi/devcontainer-sandbox'

/** `ghcr.io/meitogi/devcontainer-sandbox:<base>-cc<cc>` — the tag scheme. */
export function baseImageRef(claudeCodeVersion: string, baseVersion = DEFAULT_BASE_VERSION): string {
	return `${BASE_IMAGE_REPOSITORY}:${baseVersion}-cc${claudeCodeVersion}`
}

export function hasDocker(): boolean {
	return hasCommand('docker')
}

export function volumeCreate(name: string): void {
	// `|| true` in bash — an existing volume is the normal case, not an error.
	runCapture(['docker', 'volume', 'create', name])
}

export function imageExists(tag: string): boolean {
	return runCapture(['docker', 'image', 'inspect', tag]) !== null
}

export interface RebuildSignals {
	/** True when no container matches this workspace — rebuild or first-time. */
	requested: boolean
}

export interface DetectContext {
	hostKind: HostKind
	projectDir: string
	devcontainerDir: string
	logger: Logger
}

/**
 * Distinguish "Rebuild Container" from "Reopen in Container" from first-time.
 *
 * Ports the container-presence half of `detect_no_cache_request`
 * (initialize.sh:329-395), whose reasoning is worth restating because it is
 * counter-intuitive:
 *
 * VS Code passes **no** distinguishing flag. Rebuild and Reopen both invoke
 * `devContainersSpecCLI.js up` with identical arguments; the rebuild semantic
 * is that VS Code stops and removes the container *before* calling `up`. So the
 * container itself is the signal, not the command line. `-a` is mandatory:
 * Reopen stops the container before `initializeCommand` runs, so without it the
 * probe misses an existing container and falsely reports a rebuild.
 *
 * The probe's outcome is informational now that no local build hangs off it —
 * it feeds the log line that tells a human (and rebuild-debug traces) which of
 * the three states VS Code is in.
 */
export function detectRebuildSignals(context: DetectContext): RebuildSignals {
	const { logger } = context

	if (!hasDocker()) return { requested: false }

	// VS Code writes these labels in host-native format (C:\… on Windows).
	// The POSIX form held here never matches on WSL / Git Bash, so translate.
	const localFolder = toHostPath(context.hostKind, context.projectDir)
	const configFile = toHostPath(context.hostKind, join(context.devcontainerDir, 'devcontainer.json'))
	// The compose-project filter excludes manually-run zombies: a bare
	// `docker run` carrying the devcontainer labels but no compose orchestration.
	const output = runCapture([
		'docker',
		'ps',
		'-a',
		'-q',
		'--filter',
		`label=devcontainer.local_folder=${localFolder}`,
		'--filter',
		`label=devcontainer.config_file=${configFile}`,
		'--filter',
		'label=com.docker.compose.project',
	])
	const containerId = (output ?? '').split('\n')[0]?.trim() ?? ''

	if (containerId.length === 0) {
		logger.log('  ↳ No matching devcontainer for this workspace — rebuild or first-time')
		logger.trace({ kind: 'decide', name: 'BUILD_BASE_REQUESTED', value: '1', why: 'no container matched labels' })
		return { requested: true }
	}
	logger.log(`  ↳ Devcontainer present (${containerId}, any state) — reopen, no base rebuild`)
	logger.trace({ kind: 'decide', name: 'BUILD_BASE_REQUESTED', value: '0', why: `container ${containerId} present` })
	return { requested: false }
}

/**
 * `claude-devcontainer-base:<cc-version>-<project-id>` — the legacy local tag.
 *
 * Still traced so a host that has not switched onto the published image can be
 * diagnosed; the dogfood's escape hatch (`BASE_IMAGE` in `.env`) names it.
 */
export function baseImageTag(version: string, projectId: string): string {
	return `claude-devcontainer-base:${version}-${projectId}`
}

/**
 * Volume names that hold Claude credentials.
 *
 * `claude-creds-*` is what `devc initialize` creates (per project) and what
 * the design calls the shared one; `claude-credentials-*` is the default
 * install.sh offered for years, so hosts carrying it must still see it.
 */
export const CREDS_VOLUME_PATTERN = /^claude-(creds|credentials)-/

export interface CredsVolume {
	name: string
	/** Compose projects (with the `-claude-code` suffix stripped) whose containers mount it. */
	projects: string[]
}

/**
 * Every credentials volume on this host, most shared first.
 *
 * Returns null when docker is absent or the daemon does not answer, so the
 * caller can say so instead of presenting an empty list as "none exist".
 * Per-volume `docker ps -a --filter volume=` is the cheapest way to learn who
 * uses a volume: an external volume carries no compose labels of its own.
 */
export function discoverCredsVolumes(): CredsVolume[] | null {
	if (!hasDocker()) return null
	const listed = runCapture(['docker', 'volume', 'ls', '--format', '{{.Name}}'])
	if (listed === null) return null
	const names = listed
		.split('\n')
		.map((line) => line.trim())
		.filter((name) => CREDS_VOLUME_PATTERN.test(name))
	return rankCredsVolumes(
		names.map((name) => {
			const users = runCapture([
				'docker',
				'ps',
				'-a',
				'--filter',
				`volume=${name}`,
				'--format',
				'{{.Label "com.docker.compose.project"}}',
			])
			return { name, projects: (users ?? '').split('\n') }
		}),
	)
}

/** The pure half: dedupe project names, strip the compose suffix, sort by reach. */
export function rankCredsVolumes(rows: readonly { name: string; projects: readonly string[] }[]): CredsVolume[] {
	const ranked: CredsVolume[] = rows.map((row) => {
		const projects: string[] = []
		for (const raw of row.projects) {
			const project = raw.trim().replace(/-claude-code$/, '')
			if (project.length > 0 && !projects.includes(project)) projects.push(project)
		}
		projects.sort()
		return { name: row.name, projects }
	})
	ranked.sort((a, b) => b.projects.length - a.projects.length || a.name.localeCompare(b.name))
	return ranked
}
