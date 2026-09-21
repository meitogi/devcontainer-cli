// Surgical .env editing.
//
// The file this module edits is consumed by three different readers with three
// different grammars: bash `source` (initialize.sh did `set -a; source .env`),
// docker-compose `env_file:`, and this CLI. It is also 90% comments — the
// shipped .env.example is 9 KB of documented defaults with a handful of live
// KEY=VALUE lines between them.
//
// That rules out the obvious implementation. A parse -> mutate -> serialize
// round-trip through any dotenv library destroys every comment, every blank
// line and the section ordering. So this is a LINE EDITOR: it rewrites the one
// line it was asked about and copies every other byte through untouched.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

/**
 * Idempotent `KEY=VALUE` write.
 *
 * Ports `set_env_var` from initialize.sh:174-189, including the two
 * non-obvious behaviours:
 *
 * - A missing trailing newline is repaired *first*, otherwise appending would
 *   concatenate onto the last line and silently corrupt it.
 * - **Every** line matching the key is rewritten, not just the first. The bash
 *   version used `awk '$0 ~ "^"k"=" { print k"="v; next }'`, which fires on
 *   each match; a file that somehow grew a duplicate key converges to a single
 *   value rather than keeping a stale one below.
 *
 * The write goes through a temp file + rename. Bash did this for GNU/BSD `sed`
 * portability; here it buys atomicity, which matters because docker-compose
 * may read this file while the CLI is still running.
 */
export function setEnvVar(file: string, key: string, value: string): void {
	const original = existsSync(file) ? readFileSync(file, 'utf8') : ''
	writeIfChanged(file, original, applySet(original, key, value))
}

/** Ports `unset_env_var` (initialize.sh:191-197) — drop every `^KEY=` line. */
export function unsetEnvVar(file: string, key: string): void {
	if (!existsSync(file)) return
	const original = readFileSync(file, 'utf8')
	writeIfChanged(file, original, applyUnset(original, key))
}

/** File-level {@link applyUncomment} — the answer lands next to the comment documenting it. */
export function uncommentEnvVar(file: string, key: string, value: string): void {
	const original = existsSync(file) ? readFileSync(file, 'utf8') : ''
	writeIfChanged(file, original, applyUncomment(original, key, value))
}

/**
 * The pure half of {@link setEnvVar}, exported for tests and for `--dry-run`.
 */
export function applySet(content: string, key: string, value: string): string {
	const prefix = `${key}=`
	const withNewline = content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content

	if (!hasKey(withNewline, key)) return `${withNewline}${prefix}${value}\n`

	// split('\n') on a newline-terminated string yields a trailing '' that
	// rejoins into the same terminator, so the file keeps its exact shape.
	const lines = withNewline.split('\n')
	return lines.map((line) => (line.startsWith(prefix) ? `${prefix}${value}` : line)).join('\n')
}

/**
 * The pure half of {@link unsetEnvVar}.
 *
 * Reproduces `grep -v "^KEY=" > tmp` exactly: every surviving line is emitted
 * newline-terminated (so a file that lacked a final newline gains one), and a
 * file whose every line matched becomes empty rather than a lone newline.
 */
export function applyUnset(content: string, key: string): string {
	const prefix = `${key}=`
	const lines = content.split('\n')
	// A newline-terminated file yields a trailing '' that is not a line.
	if (lines[lines.length - 1] === '') lines.pop()
	const kept = lines.filter((line) => !line.startsWith(prefix))
	return kept.length === 0 ? '' : `${kept.join('\n')}\n`
}

/**
 * Turn the first `#KEY=…` documented default into a live `KEY=VALUE`.
 *
 * install.sh's `generate_env` did this with `sed -E "s|^#DC_PROJECT=…|…|"`
 * after copying .env.example: the template documents every key as a commented
 * default, and the wizard's answers should land *on that line*, next to the
 * comment explaining them, rather than as a bare assignment appended at the
 * end of a 10 KB file. {@link applySet} cannot express that — it matches live
 * keys only. Falls back to it when no commented line exists, and defers to it
 * when a live key already exists (rewrite in place, as always).
 *
 * First match only: a template may document several alternatives for one key
 * (`#ANTHROPIC_BASE_URL=` appears three times), and uncommenting all of them
 * would be exactly the wrong thing.
 */
export function applyUncomment(content: string, key: string, value: string): string {
	if (hasKey(content, key)) return applySet(content, key, value)
	const prefix = `#${key}=`
	const lines = content.split('\n')
	const index = lines.findIndex((line) => line.startsWith(prefix))
	if (index === -1) return applySet(content, key, value)
	lines[index] = `${key}=${value}`
	return lines.join('\n')
}

/**
 * Whether a live (non-comment) assignment for `key` exists.
 *
 * Uses a literal prefix match rather than the bash `grep "^${key}="`, whose
 * argument is a regex — a key containing `.` or `+` would have matched more
 * than intended there. Strictly safer, and no real key has ever contained one.
 */
export function hasKey(content: string, key: string): boolean {
	const prefix = `${key}=`
	return content.split('\n').some((line) => line.startsWith(prefix))
}

/**
 * Read `.env` into a plain object.
 *
 * @remarks
 * **This is a divergence, and a deliberate one.** initialize.sh did
 * `set -a; source .env`, which hands the file to bash: `$VAR` interpolates,
 * `$(...)` executes, quoting follows shell rules. docker-compose's `env_file:`
 * reader does none of that — it is a flat KEY=VALUE parser. So the two
 * consumers of this same file already disagreed, and bash was the outlier.
 *
 * This parser matches compose: no interpolation, no command substitution, a
 * single layer of matching quotes stripped, `export ` prefix tolerated,
 * comments and blank lines skipped. A `.env` that relied on shell expansion
 * would already have been broken for compose.
 */
export function readEnvFile(file: string): Record<string, string> {
	if (!existsSync(file)) return {}
	const out: Record<string, string> = {}
	for (const raw of readFileSync(file, 'utf8').split('\n')) {
		const line = raw.trim()
		if (line.length === 0 || line.startsWith('#')) continue
		const withoutExport = line.startsWith('export ') ? line.slice(7).trimStart() : line
		const eq = withoutExport.indexOf('=')
		if (eq <= 0) continue
		const key = withoutExport.slice(0, eq).trim()
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
		out[key] = stripMatchingQuotes(withoutExport.slice(eq + 1).trim())
	}
	return out
}

function stripMatchingQuotes(value: string): string {
	if (value.length < 2) return value
	const first = value[0]
	if (first === undefined) return value
	if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1)
	return value
}

function writeIfChanged(file: string, original: string, next: string): void {
	if (next === original && existsSync(file)) return
	const tmp = `${file}.devc-tmp`
	writeFileSync(tmp, next, 'utf8')
	renameSync(tmp, file)
}
