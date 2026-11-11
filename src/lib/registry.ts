// The base image's registry, read once at scaffold time so a new project pins
// the newest image published on its Claude Code line — instead of whatever
// DEFAULT_BASE_VERSION this CLI was built with. That constant stays as the
// offline fallback, not as the thing a release of the image has to chase.
//
// GHCR answers anonymously for a public image: a pull-scoped token from
// /token, then /v2/<repo>/tags/list. No docker needed, Node's own fetch.
import { BASE_IMAGE_REPOSITORY, DEFAULT_BASE_VERSION } from './docker.js'

export interface BaseResolution {
	version: string
	/** `ghcr`: newest published tag; `default`: the template's pin, with the reason; `flag`: --base. */
	source: 'ghcr' | 'default' | 'flag'
	reason?: string
}

/** The slice of fetch this module uses — injectable so tests never touch the network. */
export type FetchLike = (
	url: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const REGISTRY = 'https://ghcr.io'
const REPO_PATH = BASE_IMAGE_REPOSITORY.replace(/^ghcr\.io\//, '')

/** The highest `<x.y.z>-cc<cc>` among `tags`, or null. Pure: the selector the tests pin. */
export function newestBase(tags: readonly string[], claudeCodeVersion: string): string | null {
	const suffix = `-cc${claudeCodeVersion}`
	let best: { key: number[]; version: string } | null = null
	for (const tag of tags) {
		if (!tag.endsWith(suffix)) continue
		const version = tag.slice(0, -suffix.length)
		const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
		if (m === null) continue
		const key = [Number(m[1]), Number(m[2]), Number(m[3])]
		if (best === null || compare(key, best.key) > 0) best = { key, version }
	}
	return best?.version ?? null
}

function compare(a: number[], b: number[]): number {
	for (let i = 0; i < 3; i++) {
		const d = (a[i] as number) - (b[i] as number)
		if (d !== 0) return d
	}
	return 0
}

/**
 * Every tag GHCR publishes for the base image, or why it could not say.
 * Never throws: offline, a slow registry (`timeoutMs`), a refused token or a
 * malformed answer all come back as `{ reason }`.
 */
export async function publishedTags(
	options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<{ tags: string[] } | { reason: string }> {
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
	if (fetchImpl === undefined) return { reason: 'no fetch in this Node' }
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000)
	try {
		const tokenRes = await fetchImpl(`${REGISTRY}/token?scope=repository:${REPO_PATH}:pull`, { signal: controller.signal })
		if (!tokenRes.ok) return { reason: `ghcr.io/token answered ${tokenRes.status}` }
		const token = (await tokenRes.json()) as { token?: unknown }
		if (typeof token.token !== 'string') return { reason: 'ghcr.io/token answered without a token' }
		// n=1000: GHCR pages the list past that, and the repo is nowhere near it.
		const listRes = await fetchImpl(`${REGISTRY}/v2/${REPO_PATH}/tags/list?n=1000`, {
			headers: { Authorization: `Bearer ${token.token}` },
			signal: controller.signal,
		})
		if (!listRes.ok) return { reason: `tags/list answered ${listRes.status}` }
		const list = (await listRes.json()) as { tags?: unknown }
		if (!Array.isArray(list.tags)) return { reason: 'tags/list answered without tags' }
		return { tags: list.tags.filter((t): t is string => typeof t === 'string') }
	} catch (error) {
		return {
			reason: error instanceof Error ? (error.name === 'AbortError' ? 'ghcr.io did not answer in time' : error.message) : String(error),
		}
	} finally {
		clearTimeout(timer)
	}
}

/**
 * The Claude Code lines the newest base is published on, oldest first — the
 * choice a new project has today. Empty when no tag has the scheme. Pure.
 */
export function publishedLines(tags: readonly string[]): string[] {
	let newest: number[] | null = null
	const lines: Record<string, number[][]> = {}
	for (const tag of tags) {
		const m = /^(\d+)\.(\d+)\.(\d+)-cc(\d+)\.(\d+)\.(\d+)$/.exec(tag)
		if (m === null) continue
		const base = [Number(m[1]), Number(m[2]), Number(m[3])]
		const cc = [Number(m[4]), Number(m[5]), Number(m[6])]
		if (newest === null || compare(base, newest) > 0) newest = base
		const key = base.join('.')
		;(lines[key] ??= []).push(cc)
	}
	if (newest === null) return []
	return (lines[newest.join('.')] ?? []).sort(compare).map((cc) => cc.join('.'))
}

/**
 * Newest published base on `claudeCodeVersion`'s line, from what
 * `publishedTags` answered. Whatever it could not answer resolves to the
 * template's default, with the reason for the summary line.
 */
export function baseFor(published: { tags: string[] } | { reason: string }, claudeCodeVersion: string): BaseResolution {
	if ('reason' in published) return fallback(published.reason)
	const version = newestBase(published.tags, claudeCodeVersion)
	if (version === null) return fallback(`no published image on the cc${claudeCodeVersion} line`)
	return { version, source: 'ghcr' }
}

function fallback(reason: string): BaseResolution {
	return { version: DEFAULT_BASE_VERSION, source: 'default', reason }
}
