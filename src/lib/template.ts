// `{{KEY}}` substitution — the whole templating mechanism.
//
// install.sh had exactly two placeholders, substituted with a two-rule `sed`.
// The v3 templates need nothing more: no conditionals, no loops, no partials.
// Anything that varies by answer is a separate file or an `.env` line, never a
// branch inside a template. A template engine would buy a runtime dependency
// for features no file uses.
//
// Strict on purpose: a placeholder with no value throws instead of leaking
// `{{X}}` into a scaffolded file, which is exactly the defect the 4.2 harness
// had to guard against with a post-hoc grep.

const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g

export type TemplateValues = Readonly<Record<string, string>>

export class TemplateError extends Error {}

/** Substitute every `{{KEY}}`; throw on a key `values` does not provide. */
export function render(source: string, values: TemplateValues, name = 'template'): string {
	return source.replace(PLACEHOLDER, (_match, key: string) => {
		const value = values[key]
		if (value === undefined) throw new TemplateError(`${name}: no value for {{${key}}}`)
		return value
	})
}

/** The distinct placeholder keys a template carries, in order of appearance. */
export function placeholders(source: string): string[] {
	const seen: string[] = []
	for (const match of source.matchAll(PLACEHOLDER)) {
		const key = match[1] as string
		if (!seen.includes(key)) seen.push(key)
	}
	return seen
}
