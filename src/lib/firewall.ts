// The firewall mode: the vocabulary, the flag file, and the .env consequence.
//
// Extracted from commands/initialize.ts rather than duplicated. `syncProxyEnv`
// is live v3 behaviour — it runs on every `devc initialize`, and the suite pins
// both of its arms — so a second copy in the new command would be a second
// source of truth for which variables a mode implies. It had no caller outside
// its own module, which made the move free.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readEnvFile, setEnvVar, unsetEnvVar } from './env-file.js'
import type { Logger } from './logger.js'

export type FirewallMode = 'off' | 'basic' | 'strict'

export const FIREWALL_MODES: readonly FirewallMode[] = ['off', 'basic', 'strict']

/** Modes that keep the proxy/CA variables. Legacy names remain accepted. */
const PROXY_MODES = new Set(['strict', 'paranoid'])

const PROXY_SETTINGS: readonly { key: string; value: string }[] = [
	{ key: 'HTTPS_PROXY', value: 'http://127.0.0.1:8080' },
	{ key: 'HTTP_PROXY', value: 'http://127.0.0.1:8080' },
	{ key: 'NO_PROXY', value: 'localhost,127.0.0.0/8,host.docker.internal,.local' },
	{ key: 'NODE_EXTRA_CA_CERTS', value: '/var/lib/mitmproxy/mitmproxy-ca-cert.pem' },
]

/**
 * v2 vocabulary. Accepted on input, never written back.
 *
 * Refusing them outright would be dishonest while `PROXY_MODES` above still
 * matches `paranoid` and the image's own boot banner still matches `okeish`: a
 * live tree can hold either word. Accepting them while only ever writing the
 * canonical one is what actually drains them.
 */
const MODE_ALIASES: Readonly<Record<string, FirewallMode>> = { okeish: 'basic', paranoid: 'strict' }

export const MODE_SUMMARY: Readonly<Record<FirewallMode, string>> = {
	off: 'no filter at all, direct internet (emergency kill-switch)',
	basic: 'DNS allowlist only, no L7 filter - path scopes are NOT enforced',
	strict: 'DNS + mitmproxy force-proxy + path-scope enforcement (the default)',
}

export type ModeParse = { mode: FirewallMode; deprecated?: string } | { error: string }

export function canonicaliseMode(word: string): ModeParse {
	const w = word.trim().toLowerCase()
	if ((FIREWALL_MODES as readonly string[]).includes(w)) return { mode: w as FirewallMode }
	const alias = MODE_ALIASES[w]
	if (alias !== undefined) return { mode: alias, deprecated: w }
	return { error: `invalid mode "${word}" (expected: off, basic or strict)` }
}

/** The v3 source of truth, baked into the image at build time. */
export function firewallFlagPath(devcontainerDir: string): string {
	return join(devcontainerDir, 'firewall', 'default-mode')
}

/**
 * The mode the next rebuild will apply. Absent or blank reads as `strict`,
 * matching what the image assumes when the file did not ship.
 */
export function readMode(flagFile: string): string {
	if (!existsSync(flagFile)) return 'strict'
	const value = readFileSync(flagFile, 'utf8').trim()
	return value.length > 0 ? value : 'strict'
}

export function writeMode(flagFile: string, mode: FirewallMode, dryRun: boolean, logger: Logger): void {
	if (dryRun) return
	mkdirSync(dirname(flagFile), { recursive: true })
	writeFileSync(flagFile, `${mode}\n`, 'utf8')
	logger.trace({ kind: 'fs', op: 'write', path: flagFile })
}

/**
 * Align the proxy / CA variables with the firewall mode (initialize.sh:206-222).
 *
 *   strict (alias paranoid) — variables set
 *   basic  (alias okeish)   — variables cleared
 *   off                     — variables cleared
 */
export function syncProxyEnv(envFile: string, mode: string, dryRun: boolean, logger: Logger): void {
	if (PROXY_MODES.has(mode)) {
		for (const { key, value } of PROXY_SETTINGS) {
			if (!dryRun) setEnvVar(envFile, key, value)
		}
		logger.trace({ kind: 'decide', name: 'proxyEnv', value: 'set', why: `firewall mode ${mode}` })
		return
	}
	for (const { key } of PROXY_SETTINGS) {
		if (!dryRun) unsetEnvVar(envFile, key)
	}
	logger.trace({ kind: 'decide', name: 'proxyEnv', value: 'cleared', why: `firewall mode ${mode}` })
}

/** The names, for a report that lists what it changed. */
export const PROXY_KEYS: readonly string[] = PROXY_SETTINGS.map(s => s.key)

/**
 * Does `.env` agree with the flag? Drift is not an error — it is the thing the
 * report exists to surface, and re-running the command for the current mode is
 * the repair.
 */
export function proxyEnvMatches(envFile: string, mode: string): boolean {
	if (!existsSync(envFile)) return !PROXY_MODES.has(mode)
	const env = readEnvFile(envFile)
	const present = PROXY_SETTINGS.every(({ key }) => (env[key] ?? '').length > 0)
	return PROXY_MODES.has(mode) ? present : PROXY_SETTINGS.every(({ key }) => (env[key] ?? '').length === 0)
}
