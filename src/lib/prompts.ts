// Terminal prompts over node:readline/promises — text, choice, confirmation.
//
// No prompt library: the wizard asks a handful of questions once per project,
// and a zero-dependency package is the point of the CLI. Everything here goes
// through the same `ask` seam `devc initialize` established: the question is
// the injectable unit, not the bytes behind it, because driving readline from a
// test is a fight rather than a test.
//
// Every prompt takes `explain` lines printed above the question — what the
// answer is used for. A wizard that asks for a "project id" without saying
// what it feeds is the kind of thing that gets answered wrong.

import { createInterface, type Interface } from 'node:readline/promises'

export type Ask = (question: string) => Promise<string>

export interface PromptContext {
	ask: Ask
	out: NodeJS.WritableStream
}

/** Thrown after {@link MAX_ATTEMPTS} invalid answers — the caller maps it to a usage exit. */
export class PromptAbandoned extends Error {}

/**
 * Three strikes. Bounded because a test helper with an exhausted answer queue
 * returns '' forever, and a user piping a file into stdin hits the same shape;
 * an unbounded loop there is a hang, not a prompt.
 */
export const MAX_ATTEMPTS = 3

/**
 * One readline interface for the whole interactive section, created lazily.
 * Two interfaces over the same stream lose whatever the first had buffered.
 */
export function readlineAsk(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
): { ask: Ask; close: () => void } {
	const held: { readline: Interface | null } = { readline: null }
	return {
		ask: async (question) => {
			held.readline ??= createInterface({ input, output })
			return held.readline.question(question)
		},
		close: () => held.readline?.close(),
	}
}

export interface TextOptions {
	question: string
	explain?: readonly string[]
	defaultValue: string
	/** Return null when valid, else the message to print before re-asking. */
	validate?: (value: string) => string | null
}

export async function text(context: PromptContext, options: TextOptions): Promise<string> {
	const { ask, out } = context
	printExplain(out, options.explain)
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const raw = (await ask(`  ${options.question} [${options.defaultValue}]: `)).trim()
		const value = raw.length === 0 ? options.defaultValue : raw
		const problem = options.validate?.(value) ?? null
		if (problem === null) return value
		out.write(`  ✗ ${problem}\n`)
	}
	throw new PromptAbandoned(`no valid answer for "${options.question}" after ${MAX_ATTEMPTS} attempts`)
}

export interface ChooseOption {
	label: string
	hint?: string
}

export interface ChooseOptions {
	question: string
	explain?: readonly string[]
	options: readonly ChooseOption[]
	defaultIndex: number
}

/** Numbered list; a digit picks, Enter takes the default. Returns the index. */
export async function choose(context: PromptContext, options: ChooseOptions): Promise<number> {
	const { ask, out } = context
	printExplain(out, options.explain)
	const width = Math.max(...options.options.map((option) => option.label.length))
	options.options.forEach((option, index) => {
		const marker = index === options.defaultIndex ? '  ← default' : ''
		const hint = option.hint === undefined ? '' : `  ${option.hint}`
		out.write(`    ${index + 1}. ${option.label.padEnd(width)}${hint}${marker}\n`)
	})
	const range = options.options.length === 1 ? '1' : `1-${options.options.length}`
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const raw = (await ask(`  ${options.question} [${range}] (default: ${options.defaultIndex + 1}): `)).trim()
		if (raw.length === 0) return options.defaultIndex
		const picked = Number.parseInt(raw, 10)
		if (Number.isInteger(picked) && picked >= 1 && picked <= options.options.length) return picked - 1
		out.write(`  ✗ Enter a number between 1 and ${options.options.length}.\n`)
	}
	throw new PromptAbandoned(`no valid choice for "${options.question}" after ${MAX_ATTEMPTS} attempts`)
}

export interface ConfirmOptions {
	question: string
	defaultYes: boolean
}

export async function confirm(context: PromptContext, options: ConfirmOptions): Promise<boolean> {
	const suffix = options.defaultYes ? 'Y/n' : 'y/N'
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const raw = (await context.ask(`  ${options.question} [${suffix}]: `)).trim().toLowerCase()
		if (raw.length === 0) return options.defaultYes
		if (raw === 'y' || raw === 'yes') return true
		if (raw === 'n' || raw === 'no') return false
		context.out.write('  ✗ Answer y or n.\n')
	}
	throw new PromptAbandoned(`no valid answer for "${options.question}" after ${MAX_ATTEMPTS} attempts`)
}

function printExplain(out: NodeJS.WritableStream, lines: readonly string[] | undefined): void {
	if (lines === undefined || lines.length === 0) return
	out.write('\n')
	for (const line of lines) out.write(`  ${line}\n`)
}
