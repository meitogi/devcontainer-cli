// Terminal rendering of a memory snapshot. Pure: snapshot in, text out — the
// command owns the screen, the timer and the history.

import type { MemSnapshot } from './mem-collect.js'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

export function formatBytes(bytes: number): string {
	if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GiB`
	return `${Math.round(bytes / MIB)} MiB`
}

/** Signed MiB, or blank under 1 MiB so the column only lights up on movement. */
function formatDelta(bytes: number | undefined): string {
	if (bytes === undefined) return 'new'
	const mib = Math.round(bytes / MIB)
	if (mib === 0) return ''
	return mib > 0 ? `+${mib}` : `${mib}`
}

export interface RenderOptions {
	/** Terminal columns. */
	width: number
	/** Terminal rows; the group table is cut to fit. Absent = no limit. */
	height?: number | undefined
	/** List each process under its group. */
	procs: boolean
	/** Where the numbers come from, for the title line. */
	source: string
	/** Sampling period, for the title line; absent for a one-shot. */
	intervalMs?: number | undefined
}

/**
 * `baseline` is an older snapshot (about a minute back) the Δ column is
 * computed against; absent on the first frame.
 */
export function render(snapshot: MemSnapshot, baseline: MemSnapshot | undefined, options: RenderOptions): string {
	const { totals, groups } = snapshot
	const width = Math.max(60, options.width)
	const lines: string[] = []
	const time = new Date(snapshot.t).toTimeString().slice(0, 8)
	const every = options.intervalMs === undefined ? '' : `   every ${options.intervalMs / 1000}s, Ctrl-C to quit`
	lines.push(`devc mem — ${options.source}   ${time}${every}`)
	lines.push('')

	const limitNote = totals.limited ? 'cgroup limit' : 'no cgroup limit, VM total'
	lines.push(`Container  ${formatBytes(totals.docker)}  (what Docker shows)   of ${formatBytes(totals.limit)} (${limitNote})`)

	// One cell per slice of the limit: processes, active cache, inactive cache, kernel.
	const barWidth = width - 4
	const cells = (bytes: number): number => Math.round((bytes / totals.limit) * barWidth)
	const anon = cells(totals.anon)
	const active = cells(totals.fileActive)
	const inactive = cells(totals.fileInactive)
	const kernel = cells(totals.kernel)
	const used = Math.min(barWidth, anon + active + inactive + kernel)
	lines.push(`  ${'█'.repeat(anon)}${'▓'.repeat(active)}${'░'.repeat(inactive)}${'▒'.repeat(kernel)}${'·'.repeat(barWidth - used)}`)
	lines.push(
		`  █ processes ${formatBytes(totals.anon)}   ▓ file cache ${formatBytes(totals.fileActive)}` +
			`   ░ reclaimable cache ${formatBytes(totals.fileInactive)}   ▒ kernel ${formatBytes(totals.kernel)}`,
	)
	const swap = totals.swap > 0 ? `   container swap ${formatBytes(totals.swap)}` : ''
	lines.push(
		`  VM: ${formatBytes(totals.vmAvailable)} available of ${formatBytes(totals.vmTotal)}` +
			`   swap ${formatBytes(totals.vmSwapUsed)} / ${formatBytes(totals.vmSwapTotal)}` +
			`   pressure ${totals.pressure.toFixed(2)}%${swap}`,
	)
	lines.push('')

	const baselinePss: Record<string, number> = {}
	if (baseline !== undefined) for (const group of baseline.groups) baselinePss[group.label] = group.pss
	const delta = (label: string, pss: number): number | undefined => {
		if (baseline === undefined) return 0
		const before = baselinePss[label]
		return before === undefined ? undefined : pss - before
	}

	const deltaTitle = baseline === undefined ? 'Δ' : `Δ${Math.round((snapshot.t - baseline.t) / 1000)}s`
	lines.push(`${'PSS'.padStart(10)}${'RSS'.padStart(11)}${deltaTitle.padStart(7)}${'#'.padStart(4)}  WHAT`)
	const top = groups[0]?.pss ?? 1
	const labelWidth = 34
	const groupBar = Math.max(0, width - 34 - labelWidth - 2)
	const room = options.height === undefined ? Infinity : options.height - lines.length - 2
	let shown = 0
	let hiddenPss = 0
	let hiddenCount = 0
	for (const group of groups) {
		const rows = options.procs ? 1 + group.procs.length : 1
		if (shown + rows > room) {
			hiddenPss += group.pss
			hiddenCount++
			continue
		}
		shown += rows
		const label = group.label.length > labelWidth ? `${group.label.slice(0, labelWidth - 1)}…` : group.label
		lines.push(
			`${formatBytes(group.pss).padStart(10)}${formatBytes(group.rss).padStart(11)}` +
				`${formatDelta(delta(group.label, group.pss)).padStart(7)}${String(group.procs.length).padStart(4)}  ` +
				`${label.padEnd(labelWidth)}  ${'█'.repeat(Math.round((group.pss / top) * groupBar))}`,
		)
		if (!options.procs) continue
		for (const proc of group.procs) {
			const cmd = `${proc.pid} ${proc.cmd}`
			lines.push(`${formatBytes(proc.pss).padStart(10)}${formatBytes(proc.rss).padStart(11)}${''.padStart(11)}    ${cmd.slice(0, width - 36)}`)
		}
	}
	if (hiddenCount > 0) lines.push(`${formatBytes(hiddenPss).padStart(10)}  … ${hiddenCount} more groups (enlarge the terminal)`)

	let pssTotal = 0
	for (const group of groups) pssTotal += group.pss
	lines.push('')
	lines.push(`${formatBytes(pssTotal).padStart(10)}  total PSS of all processes — PSS splits shared pages between their users, so it adds up`)
	return `${lines.join('\n')}\n`
}
