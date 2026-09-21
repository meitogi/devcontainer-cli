// Machine-level config for the ext-patches wizard.
//
// Everything else this CLI writes lives inside the project being scaffolded.
// This is the one exception: a PAT is machine infrastructure, not
// project state — re-typing it for every new project is the same work
// moved, not saved. $XDG_CONFIG_HOME (or ~/.config) outlives any one
// project the way a project's own .env cannot.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readEnvFile } from './env-file.js'

export interface ExtPatchesConfig {
	repo: string
	ref: string
	token: string
}

/** `$XDG_CONFIG_HOME/devc/ext-patches.env`, falling back to `~/.config/devc/ext-patches.env`. */
export function extPatchesConfigPath(): string {
	const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
	return join(base, 'devc', 'ext-patches.env')
}

/** Null when nothing has been saved yet, or the saved repo was cleared. */
export function readExtPatchesConfig(path = extPatchesConfigPath()): ExtPatchesConfig | null {
	if (!existsSync(path)) return null
	const env = readEnvFile(path)
	const repo = env['EXT_PATCHES_REPO']
	if (repo === undefined || repo.length === 0) return null
	return { repo, ref: env['EXT_PATCHES_REF'] ?? '', token: env['EXT_PATCHES_TOKEN'] ?? '' }
}

/**
 * Mode 600: the token is a credential. Reuses {@link readEnvFile}'s
 * KEY=VALUE grammar for reading, but writing is new here — nothing else in
 * this codebase writes outside a project, and env-file.ts's writer doesn't
 * set a mode (it only ever touches a project's own .env).
 */
export function writeExtPatchesConfig(config: ExtPatchesConfig, path = extPatchesConfigPath()): void {
	mkdirSync(dirname(path), { recursive: true })
	const lines = [`EXT_PATCHES_REPO=${config.repo}`, `EXT_PATCHES_REF=${config.ref}`, `EXT_PATCHES_TOKEN=${config.token}`]
	writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
}
