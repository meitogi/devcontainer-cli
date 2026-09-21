// Reading devcontainer.json — team defaults, as opposed to .env user overrides.
//
// Per the rollout decisions, project configuration reuses the native
// `customizations` slot rather than inventing a new config file:
// `customizations.stitchu-devc.*`. Design §5.7 makes `devc initialize` the
// component that projects those team defaults into `.env`, without ever
// clobbering a value the user set by hand.

import { existsSync, readFileSync } from 'node:fs'

/**
 * Strip `//` line comments so `JSON.parse` accepts a devcontainer.json.
 *
 * The format is JSONC and every file in this repo uses comments heavily. The
 * `devc-hook` dispatcher already does the same thing with
 * `sed -E 's://.*$::'` before piping to `jq`; this is the same trick with the
 * string-literal awareness `sed` never had, so a `//` inside a URL or a Windows
 * path survives.
 *
 * Block comments are not handled — no file in the repo uses them, and adding a
 * second state machine for a case that does not occur is speculative.
 */
export function stripJsonComments(source: string): string {
	let out = ''
	let inString = false
	let escaped = false
	for (let i = 0; i < source.length; i++) {
		const ch = source[i] as string
		if (inString) {
			out += ch
			if (escaped) escaped = false
			else if (ch === '\\') escaped = true
			else if (ch === '"') inString = false
			continue
		}
		if (ch === '"') {
			inString = true
			out += ch
			continue
		}
		if (ch === '/' && source[i + 1] === '/') {
			// Skip to end of line, keeping the newline so line numbers survive.
			while (i < source.length && source[i] !== '\n') i++
			out += '\n'
			continue
		}
		out += ch
	}
	return out
}

/** Trailing commas are legal in devcontainer.json and fatal to JSON.parse. */
function stripTrailingCommas(source: string): string {
	return source.replace(/,(\s*[}\]])/g, '$1')
}

export function readDevcontainerJson(file: string): Record<string, unknown> | null {
	if (!existsSync(file)) return null
	try {
		const parsed: unknown = JSON.parse(stripTrailingCommas(stripJsonComments(readFileSync(file, 'utf8'))))
		return isRecord(parsed) ? parsed : null
	} catch {
		return null
	}
}

/** `customizations["stitchu-devc"]`, or `{}` when absent or malformed. */
export function readStitchuCustomizations(file: string): Record<string, unknown> {
	const root = readDevcontainerJson(file)
	if (root === null) return {}
	const customizations = root['customizations']
	if (!isRecord(customizations)) return {}
	const stitchu = customizations['stitchu-devc']
	return isRecord(stitchu) ? stitchu : {}
}

/**
 * The `devcontainer.json` -> `.env` projection table.
 *
 * Design §5.7 lists four rows. Only this one is wired to anything today —
 * `docker-compose.yml` reads `FIREWALL_ALLOW_LOCAL_AT_REBUILD` as a build arg
 * (session 2). `firewallMode`, `firewallBase` and `notifyMode` have no
 * consumer yet, and writing `.env` keys nothing reads would put an inert
 * `FIREWALL_MODE` next to the live `firewall/default-mode` flat file — an
 * ambiguity someone would eventually trip on. Adding a row here is all a later
 * session needs; the mechanism is already generic.
 */
export const PROJECTION_TABLE: readonly { customizationKey: string; envKey: string }[] = [
	{ customizationKey: 'allowLocalAtRebuild', envKey: 'FIREWALL_ALLOW_LOCAL_AT_REBUILD' },
]

/**
 * Compute the projected `KEY=VALUE` pairs.
 *
 * A key already present in `.env` is skipped: the user override wins, which is
 * the whole point of the "team default -> user override -> build arg" flow.
 * Booleans render as `1`/`0` since that is what the compose build arg and the
 * bake script expect.
 */
export function projectCustomizations(
	customizations: Record<string, unknown>,
	existingEnv: Record<string, string>,
): { key: string; value: string }[] {
	const out: { key: string; value: string }[] = []
	for (const { customizationKey, envKey } of PROJECTION_TABLE) {
		if (envKey in existingEnv) continue
		const raw = customizations[customizationKey]
		if (raw === undefined || raw === null) continue
		out.push({ key: envKey, value: typeof raw === 'boolean' ? (raw ? '1' : '0') : String(raw) })
	}
	return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
