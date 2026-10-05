#!/usr/bin/env node
// smart-text.test.js — the permission banner must be DECIDABLE.
//
// Every case below is built on a real record from
// .devcontainer/tmp/logs/claude-code-vscode-ext-pending-perms*.jsonl (3 400
// permission requests). The bar is not "is the line short" but "seeing only
// this line, with an Allow button next to it, does the human understand what
// they authorise".
//
// Three groups carry the weight :
//
//   TRUE POSITIVES  — a mutation of a tracked file must always surface, with
//                     its target. These are the cases the first iteration
//                     missed entirely (cat >>, sed -i, perl -i, --write,
//                     writeFileSync) because it keyed on command NAMES.
//   TRUE NEGATIVES  — a read must never raise ⚠. `grep -i` is not an in-place
//                     edit ; `git tag -l` lists ; `curl -o /dev/null` probes.
//                     These alone were a third of the residual noise.
//   NON-DESTRUCTIVE GATE — the validity gate may downgrade a LABEL, never
//                     cancel a warning. Rejecting glob targets and loop
//                     variables silently re-hid 13 rewrites of tracked
//                     sources ; that regression is locked here.
//
// Run: node .devcontainer/notify/tests/smart-text.test.js
// Exits 0 on success ; throws + non-zero on failure.

const assert = require('assert')

const { permissionLine, smartText, _test } = require('../lib/smart-text')
const { SMART_TEXT_LIMITS } = require('../lib/constants')

const { effectClause, effectsOf, intentOf, validPath, repoPath, clip, dedupeVerb, policyPrefix } = _test
const CAP = SMART_TEXT_LIMITS.line_cap

let passed = 0
const failures = []

/**
 * Run one named assertion, collecting failures so a single run reports every
 * broken case instead of stopping at the first.
 *
 * @param {string} name   what is being asserted
 * @param {Function} fn   throws on failure
 * @returns {void}
 */
function check(name, fn) {
	try { fn(); passed++ } catch (e) { failures.push(`${name}\n    ${e.message}`) }
}

/** Build a queue line for a Bash permission request. @param {string} command @param {string} [description] @returns {object} */
const bash = (command, description) => ({
	tool_name: 'Bash',
	tool_input: description ? { command, description } : { command }
})
/** Render and return the banner for a Bash command. @param {string} c @param {string} [d] @returns {string} */
const runLine = (c, d) => permissionLine(bash(c, d))

// -----------------------------------------------------------------------------
// TRUE POSITIVES — a tracked-file mutation always surfaces, with its target
// -----------------------------------------------------------------------------

check('cat >> appends to a tracked file', () => {
	const line = runLine("cd /workspace; cat >> plans/process-hardening/LOG.md <<'LOGEOF'\n## 3\nLOGEOF", 'Append session 3 to LOG.md')
	assert.ok(line.includes('⚠'), `no warning: ${line}`)
	assert.ok(line.includes('LOG.md'), `target missing: ${line}`)
})

check('sed -i names the file, not its sed program', () => {
	const line = runLine(`sed -i 's/"version": "0.1.0-a.12"/"version": "0.1.0-a.13"/' plugins/respawn-radar/manifest.json`)
	assert.ok(line.includes('⚠'), `no warning: ${line}`)
	assert.ok(line.includes('manifest.json'), `target missing: ${line}`)
	assert.ok(!line.includes('s/"version"'), `sed program leaked: ${line}`)
})

check('perl -i is an in-place rewrite', () => {
	const line = runLine(`perl -i -ne 'print unless /fontFamily/' src/DB/DBManager.js`)
	assert.ok(line.includes('⚠') && line.includes('DBManager.js'), line)
})

check('prettier --write invoked by path resolves to the binary name', () => {
	const line = runLine('node_modules/.bin/prettier --write src/Loaders/GR2Loader.js >/dev/null 2>&1')
	assert.ok(line.includes('⚠') && line.includes('GR2Loader.js'), line)
})

check('writeFileSync inside a python heredoc names the file it overwrites', () => {
	const cmd = "cd /workspace\npython3 - <<'EOF'\nfr_path = 'docs/how-i-work-with-claude/fr/patient-create.md'\nopen(fr_path, 'w').write(fr)\nEOF"
	const line = permissionLine({ tool_name: 'Bash', tool_input: { command: cmd } })
	assert.ok(line.includes('⚠'), `no warning: ${line}`)
	assert.ok(line.includes('patient-create.md'), `target missing: ${line}`)
})

check('git commit surfaces its subject, even through $(cat <<EOF)', () => {
	const cmd = 'git add a.md && git commit -m "$(cat <<\'EOF\'\nfix(ai): lower the correction-promotion threshold\n\nbody line\nEOF\n)"'
	const line = permissionLine({ tool_name: 'Bash', tool_input: { command: cmd } })
	assert.ok(line.includes('git commit'), `no commit: ${line}`)
	assert.ok(line.includes('fix(ai)'), `subject missing: ${line}`)
})

check('git commit --amend is not an ordinary commit', () => {
	const line = runLine('git add x.js && git commit --amend --no-edit', 'Amend commit')
	assert.ok(line.includes('--amend'), line)
})

check('git stash push mutates the worktree', () => {
	const line = runLine('git stash push -u -m "parked" -- src/Renderer/Effects/EsmaHit.js', 'Stash Esma work')
	assert.ok(line.includes('⚠') && line.includes('git stash'), line)
})

check('chmod keeps its target', () => {
	const line = runLine('chmod +x .devcontainer/tests/unit/test-session-signals.sh', 'Make test file executable')
	assert.ok(line.includes('⚠'), `no warning: ${line}`)
	assert.ok(line.includes('test-session-signals.sh'), `target missing: ${line}`)
	assert.ok(!line.includes('+x'), `flag rendered as a file: ${line}`)
})

check('rm surfaces what it deletes', () => {
	const fx = effectsOf('rm -rf neg && mkdir -p neg')
	const del = fx.find(e => e.kind === 'delete')
	assert.ok(del && del.target.includes('neg'), JSON.stringify(fx))
})

// -----------------------------------------------------------------------------
// NON-DESTRUCTIVE GATE — an unusable token degrades the label, never the alarm
// -----------------------------------------------------------------------------

check('glob target keeps the warning (regression: it used to vanish)', () => {
	const line = runLine('npx prettier --write "src/Renderer/GR2/*.js"', 'Prettier format new files')
	assert.ok(line.includes('⚠'), `glob target silenced the warning: ${line}`)
})

check('loop variable target keeps the warning', () => {
	const fx = effectsOf('for f in a.md b.md; do sed -i "s/x/y/" "$f"; done')
	assert.ok(fx.some(e => e.kind === 'inplace'), JSON.stringify(fx))
})

check('a redirect whose target is not a path raises nothing (strict side)', () => {
	// `^>` inside a sed address must not be read as a redirection.
	const line = runLine(`sed -n '/crosslink/,/^##\\|^>/p' notes.md | head -12`, 'Inspect a block')
	assert.ok(!line.includes('⚠'), `phantom warning: ${line}`)
})

// -----------------------------------------------------------------------------
// TRUE NEGATIVES — reads must stay silent
// -----------------------------------------------------------------------------

const silent = [
	['grep -i is case-insensitivity, not an in-place edit',
		'node scripts/docs/doc-links.mjs --verbose 2>/dev/null | grep -i excalidraw', 'Confirm the four new links'],
	['git tag -l lists', 'git tag -l | tail -10', 'Understand version history'],
	['git stash list reads', 'git -C /workspace stash list 2>&1', 'Git state of both clones'],
	['git apply --check applies nothing', 'git apply --check "$P" 2>&1 | head', 'Check recipe 15'],
	['cherry-pick --abort restores', 'git cherry-pick --abort', 'Abort cherry-pick'],
	['curl -o /dev/null is a probe', 'curl -s -o /dev/null -w "%{http_code}" https://example.com', 'Probe endpoint'],
	['yt-dlp --flat-playlist is a metadata query', 'yt-dlp --flat-playlist --no-warnings -j "ytsearch12:foo"', 'Search query 1'],
	['git -C <path> does not become the subcommand',
		'git -C /workspace ls-files -- docs/x.md; echo "---"', 'Inspect existing plan dir'],
	['npm run check is read-only', 'npm run check 2>&1 | tail -30', 'full check suite'],
	['node -e reading files writes nothing',
		`node -e "const fs=require('node:fs'); const a=JSON.parse(fs.readFileSync('x.excalidraw')); console.log(a.elements.length)"`, 'Count elements']
]
for (const [name, cmd, desc] of silent) {
	check(`silent: ${name}`, () => {
		const line = runLine(cmd, desc)
		assert.ok(!line.includes('⚠'), `false alarm: ${line}`)
	})
}

check('git -C ls-files renders a real subcommand', () => {
	const line = runLine('git -C /workspace ls-files -- docs/x.md')
	assert.ok(!line.includes('/workspace'), `path used as subcommand: ${line}`)
})

// -----------------------------------------------------------------------------
// POLICY PATHS — capability changes get their own category
// -----------------------------------------------------------------------------

const policies = [
	['/workspace/.claude/settings.local.json', 'Permissions'],
	['/workspace/.devcontainer/firewall/domains.local.txt', 'Firewall'],
	['/workspace/.devcontainer/skills/session-signals/hooks.json', 'Hook'],
	['/workspace/.devcontainer/pending/catbox-respawndb.sh', 'Host-script'],
	['/workspace/.gitignore', 'Gitignore']
]
for (const [path, label] of policies) {
	check(`policy prefix: ${label}`, () => {
		assert.strictEqual(policyPrefix(path), label)
		const line = permissionLine({ tool_name: 'Write', tool_input: { file_path: path, content: 'x' } })
		assert.ok(line.startsWith(`${label} · `), line)
	})
}

check('an ordinary file keeps the plain verb', () => {
	const line = permissionLine({ tool_name: 'Write', tool_input: { file_path: '/workspace/docs/tests.md', content: 'x' } })
	assert.ok(line.startsWith('Write · '), line)
})

// -----------------------------------------------------------------------------
// PER-TOOL RENDERING
// -----------------------------------------------------------------------------

check('Edit renders magnitude and scope, never the payload', () => {
	const line = permissionLine({
		tool_name: 'Edit',
		tool_input: {
			file_path: '/workspace/.devcontainer/skills/diagram/scripts/export.mjs',
			old_string: 'const fontFaces = []\nlet ox = 0;\n},',
			new_string: 'const fontFaces = []\n},'
		}
	})
	assert.ok(line.includes('export.mjs'), line)
	assert.ok(/\d+→?\d*\s*lignes/.test(line), `no magnitude: ${line}`)
	assert.ok(!line.includes('},'), `payload fragment leaked: ${line}`)
})

check('Ask keeps the interrogative and never truncates the option count', () => {
	const question = 'Static RE is exhausted — every stage of the ver12 flag pipeline is byte-identical to the reference implementation and the sandbox agrees. Quel standard de clôture veux-tu avant que je committe ?'
	const line = permissionLine({
		tool_name: 'AskUserQuestion',
		tool_input: { questions: [{ header: 'Closure', question, options: [{ label: 'a' }, { label: 'b' }] }] }
	})
	assert.ok(line.includes('clôture') || line.includes('committe'), `preamble kept instead of the ask: ${line}`)
	assert.ok(line.includes('2 options'), `option count truncated away: ${line}`)
})

check('Ask lists every header when several questions are bundled', () => {
	const line = permissionLine({
		tool_name: 'AskUserQuestion',
		tool_input: {
			questions: [
				{ header: 'Threshold', question: 'How many days ?', options: [] },
				{ header: 'Gap gate', question: 'Suppress short sessions ?', options: [] }
			]
		}
	})
	assert.ok(line.includes('Threshold') && line.includes('Gap gate'), line)
	assert.ok(line.includes('2 questions'), line)
})

check('Plan carries blast radius and flags an irreversible operation', () => {
	const plan = '# Session 2 — hooks\n\nTouche `a.js`, `b.mjs` et `c.md`.\nPuis `git push` vers origin.\n'
	const line = permissionLine({ tool_name: 'ExitPlanMode', tool_input: { plan } })
	assert.ok(line.includes('Session 2'), line)
	assert.ok(line.includes('cite 3 fichiers'), `file count wrong or unlabelled: ${line}`)
	assert.ok(line.includes('git push'), `irreversible op not flagged: ${line}`)
})

check('Skill and Artifact use their human field', () => {
	assert.ok(permissionLine({ tool_name: 'Skill', tool_input: { skill: 'claude-api', args: 'model choice' } }).includes('claude-api'))
	assert.ok(permissionLine({ tool_name: 'Artifact', tool_input: { title: 'Test collage → Canva', file_path: '/tmp/x.html' } }).includes('Canva'))
})

check('Monitor is treated like Bash', () => {
	const line = permissionLine({ tool_name: 'Monitor', tool_input: { command: 'until [ -f x ]; do sleep 2; done', description: 'wait for glyph subagent' } })
	assert.ok(line.startsWith('Watch · ') && line.includes('glyph'), line)
})

// -----------------------------------------------------------------------------
// FALLBACK — admitting the summary failed beats a guessed token
// -----------------------------------------------------------------------------

check('an unsummarisable read-only script degrades honestly', () => {
	const line = runLine('for f in *.md; do\n  echo "== $f"\ndone')
	assert.ok(!line.includes('⚠'), line)
	assert.ok(/lecture seule|\.md/.test(line), `not an honest fallback: ${line}`)
	assert.ok(!/·\s*(done|for|fi)\s*$/.test(line), `shell keyword as the banner: ${line}`)
})

// -----------------------------------------------------------------------------
// TEXT PRIMITIVES
// -----------------------------------------------------------------------------

check('clip never splits a surrogate pair', () => {
	const emoji = 'statut 📋🚧✅ et suite du texte pour dépasser la limite fixée'
	for (let n = 4; n <= 40; n++) {
		const out = clip(emoji, n)
		assert.ok(!/[\uD800-\uDFFF]/.test(out.slice(-1)), `lone surrogate at n=${n}: ${JSON.stringify(out)}`)
		assert.ok(Array.from(out).length <= n, `over budget at n=${n}`)
	}
})

check('clip cuts on a word boundary and keeps accents', () => {
	const out = clip('Régénère, revérifie, puis validation jq de la skill sur les 7 fichiers', 30)
	assert.ok(out.endsWith('…'), out)
	assert.ok(out.includes('Régénère'), out)
	assert.ok(!/\s…$/.test(out), `dangling space before ellipsis: ${out}`)
})

check('validPath rejects fragments and accepts real paths', () => {
	for (const bad of ['s.map', 'console.log', '+x', '-m', '30', '/p', 'n+', '$(yt-dlp', 'x=1']) {
		assert.ok(!validPath(bad), `accepted a fragment: ${bad}`)
	}
	for (const good of ['src/main.js', 'docs/a/b.md', 'manifest.json', '~scratch/x.mjs']) {
		assert.ok(validPath(good), `rejected a path: ${good}`)
	}
})

check('repoPath keeps root and file, elides the middle', () => {
	assert.strictEqual(repoPath('/workspace/.devcontainer/skills/diagram/scripts/export.mjs'), '.devcontainer/…/scripts/export.mjs')
	assert.strictEqual(repoPath('/workspace/docs/tests.md'), 'docs/tests.md')
	assert.ok(repoPath('/tmp/claude-1000/-workspace/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/scratchpad/x.mjs').startsWith('~scratch'))
})

check('dedupeVerb removes the stutter but spares real words', () => {
	assert.strictEqual(dedupeVerb('Plan', 'Plan — Conformité des diagrammes'), 'Conformité des diagrammes')
	assert.strictEqual(dedupeVerb('Plan', 'Plan'), 'Plan')
	assert.strictEqual(dedupeVerb('Plan', 'Planification du sprint'), 'Planification du sprint')
	assert.strictEqual(dedupeVerb('Run', 'run inline JS'), 'inline JS')
})

check('effectClause stays empty when everything lands in the scratchpad', () => {
	const cmd = 'cd /tmp/claude-1000/-workspace/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/scratchpad && mkdir -p neg && cp a.mjs neg/'
	assert.strictEqual(effectClause(effectsOf(cmd)), '')
})

check('intentOf names the script, not the interpreter', () => {
	assert.ok(intentOf('node scripts/docs/doc-counts.mjs --check patient-create.md').includes('doc-counts.mjs'))
	assert.ok(intentOf('npm run perf').includes('run perf'))
	assert.ok(intentOf('wtf claude-live shot').includes('screenshot'))
})

// -----------------------------------------------------------------------------
// DEGRADED INPUTS — the producer contract must never crash the banner
// -----------------------------------------------------------------------------

const degraded = [
	['null input', { tool_name: 'Bash', tool_input: null }],
	['undefined input', { tool_name: 'Bash' }],
	['legacy pre-truncated string', { tool_name: 'Bash', tool_input: 'php vendor/bin/phinx migrate' }],
	['unknown tool', { tool_name: 'BrandNewTool', tool_input: { whatever: 1 } }],
	['no tool name', { tool_input: { command: 'ls' } }],
	['empty line object', {}]
]
for (const [name, line] of degraded) {
	check(`degraded: ${name}`, () => {
		const out = permissionLine(line)
		assert.ok(typeof out === 'string' && out.trim().length > 0, `empty banner for ${name}`)
		assert.ok(!out.includes('\n'), `newline in banner for ${name}`)
		assert.ok(Array.from(out).length <= CAP, `over cap for ${name}`)
	})
}

check('an unknown tool falls back to its own name', () => {
	assert.ok(permissionLine({ tool_name: 'BrandNewTool', tool_input: { a: 1 } }).startsWith('BrandNewTool · '))
})

// -----------------------------------------------------------------------------
// GLOBAL INVARIANTS — asserted over every case exercised above
// -----------------------------------------------------------------------------

const corpusShapes = [
	bash('cd /workspace && git status --short docs/', 'Shows git status'),
	bash("cat >> plans/LOG.md <<'EOF'\nx\nEOF", 'Append'),
	bash('npx prettier --write "src/**/*.js"'),
	bash('rm -rf neg && mkdir -p neg && cp /workspace/docs/a.excalidraw neg/'),
	{ tool_name: 'Edit', tool_input: { file_path: '/workspace/CLAUDE.md', old_string: '## 3. Simplicity\nx', new_string: 'y' } },
	{ tool_name: 'Write', tool_input: { file_path: '/workspace/.devcontainer/skills/x/hooks.json', content: '{}' } },
	{ tool_name: 'AskUserQuestion', tool_input: { questions: [{ header: 'Fond', question: '« Fond noir » = laquelle des trois ?', options: [{ label: 'a' }] }] } },
	{ tool_name: 'ExitPlanMode', tool_input: { plan: '# Spike — `.excalidraw` → SVG 📋\n\nTouche `a.mjs`.' } },
	bash('wtf test --json 2>&1 | tail -150', 'Run the suite')
]
check('invariants hold on every shape: single line, within cap, never empty', () => {
	for (const line of corpusShapes) {
		const out = permissionLine(line)
		assert.ok(out.trim().length > 0, `empty: ${JSON.stringify(line).slice(0, 80)}`)
		assert.ok(!/[\n\r\t]/.test(out), `control char: ${JSON.stringify(out)}`)
		assert.ok(Array.from(out).length <= CAP, `over ${CAP}: ${Array.from(out).length} — ${out}`)
		assert.ok(!/[\uD800-\uDFFF]/.test(out.slice(-1)), `lone surrogate: ${out}`)
		assert.ok(out.includes(' · '), `missing verb separator: ${out}`)
	}
})

check('smartText is reachable directly for consumers that need the bare text', () => {
	assert.ok(smartText('Bash', { command: 'ls', description: 'List' }) === 'List')
})

// -----------------------------------------------------------------------------

if (failures.length) {
	process.stderr.write(`\n${failures.length} FAILED / ${passed + failures.length}\n\n`)
	for (const f of failures) process.stderr.write(`  ✗ ${f}\n\n`)
	process.exit(1)
}
process.stdout.write(`smart-text: ${passed}/${passed} checks passed\n`)
