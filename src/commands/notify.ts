// `devc notify send` — a notification from the host, through the Notify VS Code
// extension.
//
// It only appends one `send` line to the project's queue
// (`<devcontainerDir>/tmp/notify/<sid>.jsonl`); the extension shows it on the
// machine holding the VS Code window. Under Remote-SSH that is another Mac: the
// line is written here, on the machine holding the files, and the extension
// reads it through the remote. Nothing is displayed from this process.

import { randomUUID } from 'node:crypto'
import { appendSendLine, buildSendLine, MAX_SEND_MESSAGE, MAX_SEND_TITLE, queueDirOf, SID_PATTERN } from '../lib/notify-queue.js'
import { resolveProjectPaths } from '../lib/paths.js'

export const NOTIFY_HELP = `devc notify - notifications through the Notify VS Code extension

Usage:
  devc notify send <message> [options]

Appends one notification line to the project's queue
(.devcontainer/tmp/notify/<sid>.jsonl); the Notify extension shows it at once
on the machine holding the VS Code window. The message is capped at
${MAX_SEND_MESSAGE} characters.

Options:
  --title <text>             Shown in place of the session name (<= ${MAX_SEND_TITLE} characters)
  --sid <id>                 Queue file / session id (default: a fresh UUID, so a
                             send never replaces another notification)
  --devcontainer-dir <path>  Target .devcontainer directory
                             (default: ./.devcontainer, or . when already inside)
  -h, --help                 Show this help
`

export interface NotifySendOptions {
	cwd: string
	devcontainerDir?: string | undefined
	message: string
	title?: string | undefined
	sid?: string | undefined
	out?: NodeJS.WritableStream
	err?: NodeJS.WritableStream
}

/** Exit code: 0 written, 1 the append failed, 2 a sid that cannot be a file name. */
export function notifySend(options: NotifySendOptions): number {
	const out = options.out ?? process.stdout
	const err = options.err ?? process.stderr
	if (options.sid !== undefined && !SID_PATTERN.test(options.sid)) {
		err.write(`devc notify send: --sid must match ${SID_PATTERN.source}\n`)
		return 2
	}
	const { devcontainerDir } = resolveProjectPaths(options.cwd, options.devcontainerDir)
	const line = buildSendLine({ message: options.message, title: options.title, sid: options.sid ?? randomUUID() }, new Date().toISOString())
	try {
		out.write(`${appendSendLine(queueDirOf(devcontainerDir), line)}\n`)
		return 0
	} catch (error) {
		err.write(`devc notify send: could not append to ${queueDirOf(devcontainerDir)}: ${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	}
}
