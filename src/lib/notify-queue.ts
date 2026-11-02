// The notify queue as this CLI sees it now that the Notify VS Code extension
// consumes it: the manual `send` line (`devc notify send`), and the decision
// `devc initialize` makes about the host daemon.
//
// The `send` line is the queue contract's (vscode-notify
// schemas/queue.v1.schema.json). Two other writers build the same one — the
// container's `notify send` (devcontainer-sandbox bin/notify) and the
// extension's `notify.send` command — keep the three identical.

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The cap the hook puts on every excerpt (`hook.js` `MAX_EXCERPT`). */
export const MAX_SEND_MESSAGE = 200
export const MAX_SEND_TITLE = 64
/** A sid is also the queue file name: no path separator, no leading dot. */
export const SID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Where the hook and the extension meet: `<devcontainerDir>/tmp/notify`. */
export function queueDirOf(devcontainerDir: string): string {
	return join(devcontainerDir, 'tmp', 'notify')
}

/** At most `max` code points; a longer text ends with `…`, never splitting a pair. */
export function capText(s: string, max: number): string {
	const cps = Array.from(s)
	return cps.length <= max ? s : `${cps.slice(0, max - 1).join('')}…`
}

export interface SendLine {
	v: 1
	ts: string
	sid: string
	event: 'send'
	producer: 'devc'
	message: string
	title?: string
}

/** Keys in contract order: `v, ts, sid, event, producer, message, title?`. */
export function buildSendLine(fields: { message: string; title?: string; sid: string }, ts: string): SendLine {
	const line: SendLine = { v: 1, ts, sid: fields.sid, event: 'send', producer: 'devc', message: capText(fields.message.trim(), MAX_SEND_MESSAGE) }
	const title = fields.title?.trim()
	if (title) line.title = capText(title, MAX_SEND_TITLE)
	return line
}

/** Append one line to `<queueDir>/<sid>.jsonl`, creating the directory; returns the file. */
export function appendSendLine(queueDir: string, line: SendLine): string {
	const file = join(queueDir, `${line.sid}.jsonl`)
	mkdirSync(queueDir, { recursive: true })
	appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
	return file
}

// === The host daemon: spawn it or not ======================================

/** The extension rewrites it hourly while it serves the project (vscode-notify src/lock.ts). */
export const EXTENSION_MARKER = '.extension.json'
/** A marker older than this no longer counts: the extension is gone, or the project was left. */
export const MARKER_FRESH_MS = 7 * 24 * 3_600_000
/** The daemon touches `.daemon.pid` every 10 s; the extension calls it alive within 30 s. */
export const DAEMON_PID_FRESH_MS = 30_000

export type NotifyDaemonMode = 'auto' | 'on' | 'off'

/** `NOTIFY_DAEMON` from the merged .env / environment; unset or empty = auto. */
export function parseDaemonMode(raw: string | undefined): NotifyDaemonMode | { invalid: string } {
	const v = (raw ?? '').trim().toLowerCase()
	if (v === '' || v === 'auto') return 'auto'
	if (v === 'on' || v === 'off') return v
	return { invalid: raw as string }
}

/** What the queue directory says about its consumers, read without writing. */
export interface QueueSignals {
	/** The marker's `ts` (else its mtime), null when absent or unreadable. */
	markerTs: number | null
	markerVersion: string | null
	/** `.daemon.pid` when touched within {@link DAEMON_PID_FRESH_MS}, else null. */
	livePid: number | null
}

export function readQueueSignals(queueDir: string, now: number): QueueSignals {
	let markerTs: number | null = null
	let markerVersion: string | null = null
	try {
		const file = join(queueDir, EXTENSION_MARKER)
		const mtime = statSync(file).mtimeMs
		markerTs = mtime
		try {
			const rec = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; ts?: unknown }
			if (typeof rec.ts === 'number' && Number.isFinite(rec.ts)) markerTs = rec.ts
			if (typeof rec.version === 'string') markerVersion = rec.version
		} catch {
			// malformed: the mtime still says when the extension last wrote it
		}
	} catch {
		// no marker
	}
	let livePid: number | null = null
	try {
		const file = join(queueDir, '.daemon.pid')
		if (now - statSync(file).mtimeMs <= DAEMON_PID_FRESH_MS) {
			const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
			livePid = Number.isInteger(pid) && pid > 0 ? pid : 0
		}
	} catch {
		// no daemon
	}
	return { markerTs, markerVersion, livePid }
}

/** The panel's notify row (same shape as notify-daemon.ts's report). */
export interface NotifyRow {
	value: string
	state: 'ok' | 'warn'
	why: string | null
}

/**
 * Spawn the host daemon, or say who serves the queue instead.
 *
 * `auto` (the default) spawns only when no fresh extension marker is there: a
 * project whose windows run the Notify extension gets no daemon, and one that
 * never saw it keeps today's. `on` / `off` force it; any other value reads as
 * `auto` and says so. When nothing is spawned and a daemon from an earlier boot
 * (an older devc) still runs, the row warns: the extension stands by while it
 * lives.
 */
export function decideNotify(raw: NotifyDaemonMode | { invalid: string }, signals: QueueSignals, now: number): { spawn: true; note: string | null } | { spawn: false; row: NotifyRow } {
	const mode = typeof raw === 'string' ? raw : 'auto'
	const note = typeof raw === 'string' ? null : `NOTIFY_DAEMON=${raw.invalid} is not auto, on or off — read as auto`
	const markerFresh = signals.markerTs !== null && now - signals.markerTs <= MARKER_FRESH_MS
	if (mode === 'on' || (mode === 'auto' && !markerFresh)) return { spawn: true, note }
	const value = mode === 'off' ? 'off (NOTIFY_DAEMON=off)' : `VS Code extension${signals.markerVersion ? ` ${signals.markerVersion}` : ''}`
	const why: string[] = []
	const pid = signals.livePid
	if (pid !== null) {
		why.push(
			`a notify daemon from an earlier boot is still running (${pid > 0 ? `pid ${pid}` : 'unreadable pid'}) — the extension stands by until it stops`,
			`stop it: ${pid > 0 ? `kill -TERM ${pid}` : 'kill the process named in .devcontainer/tmp/notify/.daemon.pid'}`,
		)
	}
	if (note !== null) why.push(note)
	return { spawn: false, row: why.length === 0 ? { value, state: 'ok', why: null } : { value, state: 'warn', why: why.join('; ') } }
}
