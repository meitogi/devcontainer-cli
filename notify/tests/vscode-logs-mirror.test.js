#!/usr/bin/env node
// vscode-logs-mirror.test.js — the host's VS Code logs reach the project tree,
// only the sessions that matter, byte for byte, and the destination stays
// bounded.
//
// Real directories under a tmp root, no doubles : syncOnce() is driven against
// a fake VS Code `logs/` root laid out like the real one (session dirs named
// YYYYMMDDTHHMMSS, main.log, window1/renderer.log). The defect this module can
// cause is a stale or truncated copy, so every assertion reads the destination
// bytes back.
//
// Run : node notify/tests/vscode-logs-mirror.test.js
// Exits 0 on success ; throws + non-zero on failure.

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const log = require('../lib/log')
const mirror = require('../lib/vscode-logs-mirror')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-logs-mirror-'))
log.init(path.join(tmp, 'daemon.log'))   // keep the test's stderr clean
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body) }
const read  = (p) => fs.readFileSync(p, 'utf8')
const session = (root, name, body) => {
	write(path.join(root, name, 'main.log'), `${body} main\n`)
	write(path.join(root, name, 'window1', 'renderer.log'), `${body} renderer\n`)
}

let n = 0
const step = (label) => { n++; console.log(`  ✔ ${label}`) }

// --- syncOnce : the 2 newest sessions, byte for byte -------------------------

const root = path.join(tmp, 'Code', 'logs')
const dest = path.join(tmp, 'dest')
session(root, '20260101T000000', 'one')
session(root, '20260102T000000', 'two')
session(root, '20260103T000000', 'three')
write(path.join(root, 'not-a-session', 'main.log'), 'ignored\n')
write(path.join(root, 'stray.log'), 'ignored\n')

let r = mirror.syncOnce({ roots: [root], destDir: dest })
assert.deepStrictEqual(r.sessions, ['20260102T000000', '20260103T000000'], 'the 2 newest sessions by name')
assert.strictEqual(r.copied, 4, '4 files copied on the first pass')
assert.strictEqual(r.errors.length, 0, `no error: ${r.errors.join('; ')}`)
assert.strictEqual(read(path.join(dest, '20260103T000000', 'main.log')), 'three main\n')
assert.strictEqual(read(path.join(dest, '20260103T000000', 'window1', 'renderer.log')), 'three renderer\n')
assert.strictEqual(read(path.join(dest, '20260102T000000', 'main.log')), 'two main\n')
assert.ok(!fs.existsSync(path.join(dest, '20260101T000000')), 'the third-newest session is not mirrored')
assert.ok(!fs.existsSync(path.join(dest, 'not-a-session')), 'a non-session directory is not mirrored')
assert.ok(!fs.existsSync(path.join(dest, 'stray.log')), 'a flat file at the root is not mirrored')
step('first pass mirrors the 2 newest sessions, content identical')

// Source mtime is kept, so the next pass sees nothing to do.
const srcStat = fs.statSync(path.join(root, '20260103T000000', 'main.log'))
const dstStat = fs.statSync(path.join(dest, '20260103T000000', 'main.log'))
assert.strictEqual(Math.floor(dstStat.mtimeMs / 1000), Math.floor(srcStat.mtimeMs / 1000), 'mtime preserved to the second')
r = mirror.syncOnce({ roots: [root], destDir: dest })
assert.strictEqual(r.copied, 0, 'an unchanged tree copies nothing')
step('second pass copies nothing')

// --- a log that grew is recopied ; the others are left alone ------------------

const grown = path.join(root, '20260103T000000', 'main.log')
fs.appendFileSync(grown, 'three main again\n')
// Same second as the first write is possible : force a distinct mtime so the
// size rule and the mtime rule are both exercised on real stat values.
const later = new Date(Date.now() + 5000)
fs.utimesSync(grown, later, later)
r = mirror.syncOnce({ roots: [root], destDir: dest })
assert.strictEqual(r.copied, 1, 'only the grown file is recopied')
assert.strictEqual(read(path.join(dest, '20260103T000000', 'main.log')), 'three main\nthree main again\n')
step('a grown log is recopied, the rest untouched')

// --- a new session appears : mirrored, the oldest copy is pruned -------------

session(root, '20260104T000000', 'four')
r = mirror.syncOnce({ roots: [root], destDir: dest, keep: 2 })
assert.deepStrictEqual(r.sessions, ['20260103T000000', '20260104T000000'])
assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['20260103T000000', '20260104T000000'], 'keep=2 prunes the oldest copy')
assert.strictEqual(read(path.join(dest, '20260104T000000', 'main.log')), 'four main\n')
step('a new session is mirrored and keep prunes the destination')

// --- an oversized file is skipped, and named once ----------------------------

write(path.join(root, '20260104T000000', 'huge.log'), 'x'.repeat(64))
const skipped = {}
r = mirror.syncOnce({ roots: [root], destDir: dest, maxFileBytes: 32, skipped })
assert.deepStrictEqual(r.skipped, [path.join(root, '20260104T000000', 'huge.log')], 'the oversized file is reported')
assert.ok(!fs.existsSync(path.join(dest, '20260104T000000', 'huge.log')), 'and not copied')
r = mirror.syncOnce({ roots: [root], destDir: dest, maxFileBytes: 32, skipped })
assert.deepStrictEqual(r.skipped, [], 'reported once only across passes')
step('oversized files are skipped and named once')

// --- two roots (stable + Insiders) land in one destination -------------------

const insiders = path.join(tmp, 'Code - Insiders', 'logs')
session(insiders, '20260105T000000', 'ins')
r = mirror.syncOnce({ roots: [root, insiders], destDir: dest })
assert.ok(r.sessions.includes('20260105T000000'))
assert.strictEqual(read(path.join(dest, '20260105T000000', 'main.log')), 'ins main\n')
step('a second root is mirrored into the same destination')

// --- hostLogRoots : per host kind, existing roots only -----------------------

const home = tmp   // tmp/Code/logs exists ; use it as a fake XDG / APPDATA base too
assert.deepStrictEqual(
	mirror.hostLogRoots({ kind: 'macos', home: path.join(tmp, 'nohome'), env: {} }),
	[], 'macos : nothing under an empty home')
fs.mkdirSync(path.join(home, 'Library', 'Application Support'), { recursive: true })
fs.symlinkSync(path.join(tmp, 'Code'), path.join(home, 'Library', 'Application Support', 'Code'))
assert.deepStrictEqual(
	mirror.hostLogRoots({ kind: 'macos', home, env: {} }),
	[path.join(home, 'Library', 'Application Support', 'Code', 'logs')], 'macos : ~/Library/Application Support/Code/logs')
assert.deepStrictEqual(
	mirror.hostLogRoots({ kind: 'linux', home: path.join(tmp, 'nohome'), env: { XDG_CONFIG_HOME: tmp } }),
	[root, insiders], 'linux : $XDG_CONFIG_HOME/<app>/logs, stable and Insiders')
assert.deepStrictEqual(
	mirror.hostLogRoots({ kind: 'windows', home, env: { APPDATA: tmp } }),
	[root, insiders], 'windows : %APPDATA%/<app>/logs')
assert.deepStrictEqual(mirror.hostLogRoots({ kind: 'windows', home, env: {} }), [], 'windows without APPDATA (WSL) : unsupported, none')
assert.deepStrictEqual(mirror.hostLogRoots({ kind: 'unknown', home, env: {} }), [], 'unknown host : none')
step('hostLogRoots resolves per host kind and returns existing roots only')

// --- start() : off without the key, on with it -------------------------------

const project = path.join(tmp, 'project')
fs.mkdirSync(project, { recursive: true })
const projectDest = path.join(project, '.devcontainer', 'tmp', 'vscode-logs', 'host')
assert.strictEqual(mirror.start({ projectDir: project, env: {}, kind: 'linux', home }), null, 'off : returns null')
assert.ok(!fs.existsSync(projectDest), 'off : writes nothing')
const handle = mirror.start({ projectDir: project, env: { VSCODE_LOGS_MIRROR: '1', XDG_CONFIG_HOME: tmp }, kind: 'linux', home, intervalMs: 60_000 })
assert.ok(handle, 'on : returns a handle')
assert.strictEqual(handle.destDir, projectDest)
assert.strictEqual(read(path.join(projectDest, '20260104T000000', 'main.log')), 'four main\n', 'on : the first pass ran synchronously')
handle.stop()
const daemonLog = read(path.join(tmp, 'daemon.log'))
assert.match(daemonLog, /\[vscode-logs\] mirror off \(VSCODE_LOGS_MIRROR unset/)
assert.match(daemonLog, /\[vscode-logs\] mirror on — .* → \.devcontainer\/tmp\/vscode-logs\/host/)
assert.match(daemonLog, /\[vscode-logs\] session 20260104T000000 mirrored/)
assert.strictEqual(mirror.start({ projectDir: project, env: { VSCODE_LOGS_MIRROR: '1' }, kind: 'windows', home }), null, 'on but no root : null')
assert.match(read(path.join(tmp, 'daemon.log')), /no VS Code logs directory found \(no APPDATA — WSL is unsupported\)/)
step('start() is a no-op without the key and mirrors at once with it')

console.log(`vscode-logs-mirror: ${n}/${n} steps pass`)
