// Pure text helpers. No I/O, no globals — everything here is unit-testable
// without a TTY, a filesystem or a child process, which is why it lives in its
// own module rather than inside logger.ts.

import { StringDecoder } from 'node:string_decoder'

/**
 * Splits an arbitrarily-chunked byte stream into whole lines.
 *
 * @remarks
 * Bash got this for free: `while IFS= read -r line` on a pipe. In Node a
 * `spawn` pipe emits chunks that split wherever the kernel felt like it, so
 * both the line boundaries and the UTF-8 sequence boundaries have to be
 * reassembled by hand.
 *
 * `StringDecoder` holds back an incomplete multi-byte sequence until the next
 * chunk completes it — without it, an accented character straddling a chunk
 * boundary decodes to U+FFFD.
 *
 * Trailing `\r` is stripped so a `\r\n` producer (a Windows docker daemon, or
 * any progress bar redrawing its line) does not corrupt the rolling window.
 */
export class LineSplitter {
	private readonly decoder = new StringDecoder('utf8')
	private remainder = ''

	constructor(private readonly onLine: (line: string) => void) {}

	push(chunk: Buffer | string): void {
		const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
		if (text.length === 0) return
		const parts = (this.remainder + text).split('\n')
		// The last element is either an incomplete line or '' when the chunk
		// ended exactly on a newline. Either way it is not ready to emit.
		this.remainder = parts.pop() ?? ''
		for (const part of parts) this.onLine(stripTrailingCR(part))
	}

	/**
	 * Emit whatever is left at EOF. Bash's `read -r` silently drops an
	 * unterminated final line; keeping it is strictly better when the producer
	 * is a build that died mid-sentence.
	 */
	flush(): void {
		const tail = this.remainder + this.decoder.end()
		this.remainder = ''
		if (tail.length > 0) this.onLine(stripTrailingCR(tail))
	}
}

function stripTrailingCR(line: string): string {
	return line.endsWith('\r') ? line.slice(0, -1) : line
}

// CSI sequences (colour, cursor moves) and OSC sequences (window title) — the
// two families a build tool actually emits. Not a full ECMA-48 parser. Built
// from a string rather than a regex literal so the ESC and BEL bytes stay
// readable as escapes instead of raw control characters in the source.
const ANSI_RE = new RegExp(
	[
		'[\\u001B\\u009B]',
		'[[\\]()#;?]*',
		'(?:',
		/**/ '(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)',
		/**/ '|',
		/**/ '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])',
		')',
	].join(''),
	'g',
)

/**
 * Strip ANSI escapes from a line before it is drawn inside the rolling window.
 *
 * @remarks
 * An addition, not a port. Bash passed the child's bytes through raw, so a
 * colour code emitted by the build leaked past our own reset and stained every
 * subsequent row of the frame.
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, '')
}

/**
 * Truncate to `max` **code points**.
 *
 * @remarks
 * Bash used `printf '%.*s'`, which cuts bytes and can leave half a UTF-8
 * sequence at the end of the row. Array spread iterates code points, so an
 * accented character or an emoji is kept or dropped whole.
 */
export function truncate(text: string, max: number): string {
	if (max <= 0) return ''
	const points = [...text]
	return points.length <= max ? text : points.slice(0, max).join('')
}
