// =============================================================================
// vscode-logs-mirror — the host's VS Code logs, copied into the project tree
// =============================================================================
//
// A window crash, an extension host that dies, a Rebuild that ends on "Retry" :
// the trace is in VS Code's own logs on the HOST —
//   ~/Library/Application Support/Code/logs/<session>/   (macOS)
//   ~/.config/Code/logs/<session>/                       (Linux)
//   %APPDATA%\Code\logs\<session>\                       (Windows)
// — main.log, window<N>/renderer.log, and window<N>/exthost/ms-vscode-remote.
// remote-containers/ for the Dev Containers extension. Nothing in the container
// can reach that directory. This module runs inside the daemon (the one host
// process alive for the whole container lifetime) and mirrors it into
// <project>/.devcontainer/tmp/vscode-logs/host/<session>/, which the container
// sees through the workspace bind mount.
//
// Opt-in : VSCODE_LOGS_MIRROR=1 in .devcontainer/.env (the daemon inherits the
// merged .env through its spawn). Off, start() logs one line and returns.
//
// What is mirrored : the 2 newest session directories of each root — the
// current session, and the previous one, which is where a crash that preceded
// THIS launch of VS Code left its trace. A file is copied when the destination
// is missing or differs in size or whole-second mtime (the mount may not keep
// nanoseconds, and the comparison has to be stable across it) ; the copy keeps
// the source mtime. Files over `maxFileBytes` are skipped and named once.
// Every 30 s ; the destination keeps the 5 newest sessions.
//
// daemon.log gets one line at start, one per session the first time it is
// seen, and the errors — never a line per tick.
// =============================================================================

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const log  = require('./log')

const SESSION_RE     = /^\d{8}T\d{6}$/
const APPS           = ['Code', 'Code - Insiders']
const NEWEST         = 2
const KEEP           = 5
const MAX_FILE_BYTES = 100 * 1024 * 1024
const INTERVAL_MS    = 30_000

/**
 * The VS Code log roots that exist on this host, stable and Insiders.
 *
 * @param {object} opts
 * @param {'macos'|'windows'|'linux'|'unknown'} opts.kind   lib/host.getHostKind()
 * @param {object} [opts.env]    defaults to process.env (APPDATA, XDG_CONFIG_HOME)
 * @param {string} [opts.home]   defaults to os.homedir()
 * @returns {string[]}           absolute `…/logs` directories that exist
 */
function hostLogRoots({ kind, env = process.env, home = os.homedir() }) {
	let base
	if (kind === 'macos')        base = path.join(home, 'Library', 'Application Support')
	else if (kind === 'linux')   base = env.XDG_CONFIG_HOME || path.join(home, '.config')
	else if (kind === 'windows') base = env.APPDATA || null   // unset under WSL : unsupported
	else                         base = null
	if (!base) return []
	const roots = []
	for (const app of APPS) {
		const root = path.join(base, app, 'logs')
		if (isDir(root)) roots.push(root)
	}
	return roots
}

/**
 * One pass : mirror the newest sessions of every root, then prune the
 * destination. Synchronous, never throws on a single file — the error is
 * returned in `errors` so the caller can log it.
 *
 * @param {object} opts
 * @param {string[]} opts.roots          from hostLogRoots()
 * @param {string}   opts.destDir        …/tmp/vscode-logs/host
 * @param {number}   [opts.newest=2]     sessions per root
 * @param {number}   [opts.keep=5]       sessions kept in destDir
 * @param {number}   [opts.maxFileBytes] files above are skipped
 * @param {object}   [opts.skipped]      registry of skipped paths, kept across passes
 * @returns {{ sessions: string[], copied: number, bytes: number, skipped: string[], errors: string[] }}
 *          `skipped` holds only the paths skipped for the first time
 */
function syncOnce({ roots, destDir, newest = NEWEST, keep = KEEP, maxFileBytes = MAX_FILE_BYTES, skipped = {} }) {
	const result = { sessions: [], copied: 0, bytes: 0, skipped: [], errors: [] }
	const ctx = { maxFileBytes, skipped, result }
	for (const root of roots) {
		const sessions = listSessions(root).slice(-newest)
		for (const name of sessions) {
			result.sessions.push(name)
			mirrorDir(path.join(root, name), path.join(destDir, name), ctx)
		}
	}
	prune(destDir, keep, result)
	return result
}

/**
 * Start the mirror inside the daemon. Reads VSCODE_LOGS_MIRROR from `env`.
 *
 * @param {object} opts
 * @param {string} opts.projectDir     the workspace root (…/.devcontainer's parent)
 * @param {object} [opts.env]          defaults to process.env
 * @param {number} [opts.intervalMs]   defaults to 30 s
 * @param {string} [opts.kind]         host kind, defaults to lib/host.getHostKind()
 * @param {string} [opts.home]         defaults to os.homedir()
 * @returns {{ destDir: string, stop: () => void } | null}   null when off or no root
 */
function start({ projectDir, env = process.env, intervalMs = INTERVAL_MS, kind, home }) {
	if (env.VSCODE_LOGS_MIRROR !== '1') {
		log.info('[vscode-logs] mirror off (VSCODE_LOGS_MIRROR unset in .devcontainer/.env)')
		return null
	}
	const hostKind = kind || require('./host').getHostKind()
	const roots = hostLogRoots({ kind: hostKind, env, home })
	if (roots.length === 0) {
		const why = hostKind === 'windows' && !env.APPDATA ? 'no APPDATA — WSL is unsupported' : `host=${hostKind}`
		log.warn(`[vscode-logs] mirror on, but no VS Code logs directory found (${why})`)
		return null
	}
	const destDir = path.join(projectDir, '.devcontainer', 'tmp', 'vscode-logs', 'host')
	log.info(`[vscode-logs] mirror on — ${roots.join(', ')} → .devcontainer/tmp/vscode-logs/host (${NEWEST} newest sessions, keep ${KEEP}, every ${intervalMs / 1000} s)`)

	const seen = {}
	const skipped = {}
	const tick = () => {
		let r
		try {
			r = syncOnce({ roots, destDir, skipped })
		} catch (e) {
			log.warn(`[vscode-logs] pass failed: ${e.message}`)
			return
		}
		for (const s of r.sessions) {
			if (seen[s]) continue
			seen[s] = 1
			log.info(`[vscode-logs] session ${s} mirrored`)
		}
		for (const p of r.skipped) log.warn(`[vscode-logs] skipped ${p} (over ${MAX_FILE_BYTES / 1024 / 1024} MB)`)
		for (const e of r.errors)  log.warn(`[vscode-logs] ${e}`)
	}
	tick()
	const timer = setInterval(tick, intervalMs)
	timer.unref()
	return { destDir, stop: () => clearInterval(timer) }
}

// -----------------------------------------------------------------------------

function isDir(p) {
	try { return fs.statSync(p).isDirectory() } catch (_) { return false }
}

/** Session directories under `root`, sorted : the name is a timestamp, so by name is by time. */
function listSessions(root) {
	let names
	try { names = fs.readdirSync(root) } catch (_) { return [] }
	const out = []
	for (const n of names) {
		if (SESSION_RE.test(n) && isDir(path.join(root, n))) out.push(n)
	}
	return out.sort()
}

function mirrorDir(src, dst, ctx) {
	let entries
	try {
		entries = fs.readdirSync(src, { withFileTypes: true })
	} catch (e) {
		ctx.result.errors.push(`cannot read ${src}: ${e.message}`)
		return
	}
	for (const ent of entries) {
		const s = path.join(src, ent.name)
		const d = path.join(dst, ent.name)
		if (ent.isDirectory()) { mirrorDir(s, d, ctx); continue }
		if (!ent.isFile()) continue   // sockets, symlinks : not logs
		mirrorFile(s, d, ctx)
	}
}

function mirrorFile(s, d, ctx) {
	const { result, skipped, maxFileBytes } = ctx
	let st
	try { st = fs.statSync(s) } catch (e) { result.errors.push(`cannot stat ${s}: ${e.message}`); return }
	if (st.size > maxFileBytes) {
		if (!skipped[s]) { skipped[s] = 1; result.skipped.push(s) }
		return
	}
	let have = null
	try { have = fs.statSync(d) } catch (_) { /* missing */ }
	if (have && have.size === st.size && Math.floor(have.mtimeMs / 1000) === Math.floor(st.mtimeMs / 1000)) return
	try {
		fs.mkdirSync(path.dirname(d), { recursive: true })
		fs.copyFileSync(s, d)
		fs.utimesSync(d, st.atime, st.mtime)
		result.copied++
		result.bytes += st.size
	} catch (e) {
		result.errors.push(`cannot copy ${s}: ${e.message}`)
	}
}

/** Keep the `keep` newest session directories under `destDir`. */
function prune(destDir, keep, result) {
	const sessions = listSessions(destDir)
	const stale = sessions.slice(0, Math.max(0, sessions.length - keep))
	for (const name of stale) {
		try { fs.rmSync(path.join(destDir, name), { recursive: true, force: true }) }
		catch (e) { result.errors.push(`cannot prune ${name}: ${e.message}`) }
	}
}

module.exports = { start, syncOnce, hostLogRoots, SESSION_RE }
