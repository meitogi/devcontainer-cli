// The repos an ext-patches token can read, so the wizard asks for the token
// and derives the repo instead of the other way round: a fine-grained PAT is
// cut for one repo (or a few), and GitHub already knows which.
//
// GET /user/repos with the token itself — for a fine-grained PAT it answers
// with the repos the token was granted; for a classic one, with everything
// the account sees, which is why the wizard caps what it lists.
import type { FetchLike } from './registry.js'

export type RepoListing = { repos: string[] } | { error: string }

const API = 'https://api.github.com'
const PATCHERS_HINT = 'ext-patch'

/**
 * `owner/name` of every repo `token` can read, first page (100) only. Never
 * throws: offline, a slow API (`timeoutMs`), a refused token or a malformed
 * answer all resolve to `{ error }` with the reason, for the wizard to say.
 */
export async function listTokenRepos(
	token: string,
	options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<RepoListing> {
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
	if (fetchImpl === undefined) return { error: 'no fetch in this Node' }
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000)
	try {
		const res = await fetchImpl(`${API}/user/repos?per_page=100&sort=full_name`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'devc',
			},
			signal: controller.signal,
		})
		if (res.status === 401) return { error: 'GitHub refused this token (401)' }
		if (!res.ok) return { error: `api.github.com answered ${res.status}` }
		const body = await res.json()
		if (!Array.isArray(body)) return { error: 'api.github.com answered without a repo list' }
		const repos: string[] = []
		for (const repo of body as Array<{ full_name?: unknown }>) {
			if (typeof repo?.full_name === 'string') repos.push(repo.full_name)
		}
		return { repos }
	} catch (error) {
		const message = error instanceof Error ? (error.name === 'AbortError' ? 'api.github.com did not answer in time' : error.message) : String(error)
		return { error: message }
	} finally {
		clearTimeout(timer)
	}
}

/** Index of the first repo whose name says it holds patchers, else 0. */
export function pickDefaultRepo(repos: readonly string[]): number {
	const count = repos.length
	for (let i = 0; i < count; i++) {
		if ((repos[i] as string).toLowerCase().includes(PATCHERS_HINT)) return i
	}
	return 0
}
