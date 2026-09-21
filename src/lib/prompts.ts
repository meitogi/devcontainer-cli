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
import { createInterface as createInterfaceCb, emitKeypressEvents, type Interface as CallbackInterface } from 'node:readline'

export type Ask = (question: string) => Promise<string>

export interface PromptContext {
	ask: Ask
	/** Masked input (ctrl-R reveals). Absent in most contexts — see {@link secret}. */
	askSecret?: Ask
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
): { ask: Ask; askSecret: Ask; close: () => void } {
	const held: { readline: Interface | null } = { readline: null }
	return {
		ask: async (question) => {
			held.readline ??= createInterface({ input, output })
			return held.readline.question(question)
		},
		askSecret: (question) => askMasked(input, output, question),
		close: () => held.readline?.close(),
	}
}

/** What a masked prompt draws for one line: as typed, or starred out. */
export function maskedLine(value: string, revealed: boolean): string {
	return revealed ? value : '*'.repeat(value.length)
}

const CLEAR_LINE = '\r\x1b[K'

/**
 * A masked prompt: characters are drawn as `*` as typed, ctrl-R toggles
 * reveal.
 *
 * NOTE: masking needs the callback-style `node:readline`'s private
 * `_writeToOutput` hook (stable — npm's own prompt tooling and inquirer
 * both rely on it). `node:readline/promises`, used everywhere else in this
 * file, does not expose the same hook, so this builds its own
 * single-purpose interface rather than extending the shared one. Falls
 * through to a plain, visible prompt when `input` is not a real TTY (piped
 * input, or a test's fake stream) — ctrl-R has no meaning there, and
 * raw-mode plus keypress events require one.
 */
function askMasked(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, question: string): Promise<string> {
	const tty = input as NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void }
	if (tty.isTTY !== true || typeof tty.setRawMode !== 'function') {
		const plain = createInterfaceCb({ input, output, historySize: 0 })
		return new Promise((resolve) => {
			plain.question(question, (line) => {
				plain.close()
				resolve(line)
			})
		})
	}

	return new Promise<string>((resolve, reject) => {
		let revealed = false
		const rl = createInterfaceCb({ input, output, terminal: true, historySize: 0 }) as CallbackInterface & {
			line: string
			_writeToOutput?: (text: string) => void
		}
		// Repaints the whole line on every keystroke rather than trying to
		// interpret readline's own partial writes — simpler, and correct for
		// typing/backspace, which is all this prompt needs to support.
		rl._writeToOutput = () => output.write(`${CLEAR_LINE}${question}${maskedLine(rl.line, revealed)}`)

		const onKeypress = (_chunk: string, key: { ctrl?: boolean; name?: string } | undefined): void => {
			if (key?.ctrl === true && key.name === 'r') {
				revealed = !revealed
				rl._writeToOutput?.('')
			}
		}
		emitKeypressEvents(input, rl)
		tty.setRawMode?.(true)
		input.on('keypress', onKeypress)

		const cleanup = (): void => {
			tty.setRawMode?.(false)
			input.removeListener('keypress', onKeypress)
		}
		rl.question(question, (line) => {
			cleanup()
			rl.close()
			output.write('\n')
			resolve(line)
		})
		rl.once('error', (error) => {
			cleanup()
			reject(error)
		})
	})
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

export interface SecretOptions {
	question: string
	explain?: readonly string[]
}

/**
 * Like {@link text}, but masked and with no default or validation — a
 * credential either is or isn't, there's nothing to re-prompt on. Falls
 * back to the plain, visible `ask` when the context has no `askSecret`
 * (most of them, including every test's fake context) — the answer just
 * isn't masked there, same value either way.
 */
export async function secret(context: PromptContext, options: SecretOptions): Promise<string> {
	printExplain(context.out, options.explain)
	const ask = context.askSecret ?? context.ask
	return (await ask(`  ${options.question}: `)).trim()
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
