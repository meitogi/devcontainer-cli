// =============================================================================
// smart-text — one readable, decidable line for a permission_request
// =============================================================================
//
// Renders `<Verb> · <what is about to happen>` for the OS notification body.
// Consumed by lib/consumers/notifier.js (and, through its render(), by
// notify-app.js) plus discord-webhook.js for its head label.
//
// WHY THIS EXISTS
//
//   notify-app puts an "Allow" button in the banner, so the user answers
//   without going back to VS Code. The bar is therefore NOT "is it short" but
//   "seeing only this line, does the human understand what they authorise".
//   The previous renderer dumped tool_input verbatim over 150 chars ; on the
//   real corpus, Bash commands run 337 chars median and 58 % are multi-line,
//   so the visible part was almost never the useful part.
//
// THE ONE STRUCTURAL LESSON
//
//   Detecting COMMAND NAMES does not work. A first iteration keyed on a
//   name allowlist warned about `git status` and stayed silent on
//   `cat >> LOG.md`, `sed -i`, `perl -i`, `prettier --write` and
//   `writeFileSync` — 123 real mutations invisible, 65 % of the warnings
//   worthless. This module keys on WRITE EFFECTS instead : a `>` redirect, a
//   `sed -i` and an `rm` are the same event under a target-based rule.
//
// LAYERING
//
//   1. Human text first — 91 % of Bash calls carry a `description`, already
//      notification-shaped. Same for AskUserQuestion's `header`, the plan H1
//      and Artifact's `title`.
//   2. Effects — what the command writes / deletes / installs outside the
//      temp scratchpad, surfaced as a ` — ⚠ …` clause (or as the whole text
//      when there is no description).
//   3. Honest fallback — `script shell, N étapes (lecture seule)` when
//      nothing better can be extracted. Reviewers preferred this to a guessed
//      token : admitting the summary failed beats rendering `Run · done`.
//
// KNOWN BLIND SPOTS (measured, not hidden)
//
//   - Indirect writes : `node build-x.mjs` regenerating a tracked file is out
//     of reach of static analysis of the command line.
//   - `sed -i` inside a `for` loop over an unresolvable variable can be missed.
//   - Write create-vs-overwrite is undecidable here : the daemon runs on the
//     host and the paths are container paths, so no existence check is
//     trustworthy. The full repo-relative path is shown instead, which already
//     disambiguates same-basename siblings.
// =============================================================================

const {
	TOOL_VERBS,
	SMART_TEXT_LIMITS,
	POLICY_PATHS,
	GIT_WRITE_SUBCOMMANDS,
	KNOWN_PATH_EXT
} = require('./constants')

const LINE_CAP = SMART_TEXT_LIMITS.line_cap

// Shell keywords and builtins : never a program, never a banner headline.
const SHELL_KEYWORDS = {
	for: 1, while: 1, until: 1, do: 1, done: 1, if: 1, then: 1, else: 1,
	elif: 1, fi: 1, case: 1, esac: 1, function: 1, in: 1, continue: 1,
	break: 1, return: 1, exit: 1, local: 1, export: 1, set: 1, shift: 1,
	read: 1, echo: 1, printf: 1, cd: 1, true: 1, false: 1, test: 1, time: 1,
	command: 1, source: 1, '.': 1, '[': 1, '[[': 1
}
// Wrappers that delegate to the real program : `sudo X`, `timeout 90 X`.
const WRAPPERS = { sudo: 1, env: 1, nohup: 1, xargs: 1, timeout: 1, stdbuf: 1, nice: 1, ionice: 1 }
// Control words that merely OPEN a block — the real command follows them.
// Skipping the segment instead of the word hid every `for …; do sed -i …; done`.
const BLOCK_OPENERS = { do: 1, then: 1, else: 1, elif: 1 }
// Interpreters : the interesting name is the SCRIPT they run, not themselves.
const RUNNERS = { node: 1, bash: 1, sh: 1, zsh: 1, python: 1, python3: 1, deno: 1, ruby: 1, perl: 1, npx: 1 }
// Tools carrying a meaningful subcommand — `npm run perf` beats `npm`.
const SUBCOMMAND_2 = { npm: 1, pnpm: 1, yarn: 1, docker: 1, gh: 1, wtf: 1 }
const SUBCOMMAND_1 = { git: 1, npx: 1, composer: 1 }
// Commands whose target must always be surfaced : `rm` alone is undecidable.
const TARGETED = { rm: 1, mv: 1, cp: 1, chmod: 1, chown: 1, truncate: 1, ln: 1, dd: 1, mkdir: 1 }
const INSTALLERS = /^(npm|pnpm|yarn|apt|apt-get|pip|pip3|gem|cargo|brew)$/
const FETCHERS = { curl: 1, wget: 1, 'yt-dlp': 1, 'youtube-dl': 1, aria2c: 1 }

/**
 * Semantic labels for the project's `wtf` entry points. `wtf claude-live *`
 * drives the human's browser (see CLAUDE-project.md) — it no longer raises the
 * window, but it navigates their tab, so it is worth naming explicitly in a
 * banner rather than showing an opaque subcommand.
 */
const WTF_LABELS = {
	'claude-live shot':      'screenshot (drives the browser)',
	'claude-live probe':     'probe the live DOM (drives the browser)',
	'claude-live sweep':     'reset the viewport (drives the browser)',
	'claude-live e2e':       'browser E2E suite (drives the browser)',
	'claude-live front':     'bring the app tab to the front (drives the browser)',
	'claude-live':           'drives the browser',
	'claude-script ab-shot': 'A/B screenshot compare',
	'claude-script pixel':   'pixel measure',
	'claude-script gate':    'lint + test gate',
	test:                    'test suite',
	lint:                    'lint',
	format:                  'format',
	dev:                     'dev server',
	figma:                   'read Figma'
}

// -----------------------------------------------------------------------------
// TEXT PRIMITIVES
// -----------------------------------------------------------------------------

/**
 * Collapse a value to a single clean line. Control characters become spaces —
 * a native banner does not survive a `\n`, and 20 % of the corpus carries
 * accents, typographic punctuation and emoji that must pass through intact.
 *
 * @param {*} s   any value ; coerced via String()
 * @returns {string}   single-line, whitespace-collapsed, trimmed
 */
function norm(s) {
	return String(s == null ? '' : s).replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Clamp to `n` visible characters, cutting on a word boundary and marking the
 * cut with `…`. Iterates code points, NOT UTF-16 units : the corpus contains
 * 140 emoji and a naive slice splits surrogate pairs into a broken glyph.
 *
 * @param {*} s        value to render
 * @param {number} n   maximum length, ellipsis included
 * @returns {string}   `s` normalised, possibly ellipsis-clipped
 */
function clip(s, n) {
	const str = norm(s)
	const chars = Array.from(str)
	if (chars.length <= n) return str
	let cut = chars.slice(0, n - 1).join('')
	const lastSpace = cut.lastIndexOf(' ')
	if (lastSpace > n * 0.6) cut = cut.slice(0, lastSpace)
	return cut.replace(/[\s([{"'`\-–—,;:]+$/, '') + '…'
}

/**
 * Shorten a path for display : session scratchpad → `~scratch`, workspace →
 * repo-relative, home → `~/`. Deep paths keep their ROOT and their FILE and
 * elide the middle, so `.devcontainer/…/scripts/export.mjs` stays
 * distinguishable from a sibling in another skill.
 *
 * @param {string} p   raw path
 * @returns {string}   display path
 */
function repoPath(p) {
	let s = String(p || '')
		.replace(/\/tmp\/claude-\d+\/[^/]+\/[0-9a-f-]{36}\/scratchpad/g, '~scratch')
		.replace(/^\/workspace\//, '')
		.replace(/^\/home\/node\//, '~/')
	const seg = s.split('/').filter(Boolean)
	if (seg.length > 3) s = `${seg[0]}/…/${seg.slice(-2).join('/')}`
	return s
}

/**
 * True when a path lives in throwaway territory — the session scratchpad, a
 * mktemp dir, or any `tmp/` / `.tmp/` inside the tree. Writes there never
 * raise a warning : on the corpus this suppression was verified exact.
 *
 * @param {string} p   path, ideally after variable expansion
 * @returns {boolean}
 */
function isScratch(p) {
	const s = String(p || '')
	return /^(\/tmp\/|~scratch|\/var\/folders\/|\$TMP|\$\{TMP)/.test(s) ||
		/mktemp/.test(s) || /(^|\/)\.?tmp\//.test(s) || /(^|\/)scratchpad(\/|$)/.test(s)
}

/**
 * The validity gate : is this token really a filesystem path ?
 *
 * Without it the effect scanner renders JS fragments as written files —
 * `écrit s.map`, `écrit console.log`, `écrit chmod +x`. With it, 39 % of
 * warnings carrying an unreadable token dropped to nearly zero.
 *
 * Callers must respect the strict/lenient split documented on `effectsOf` :
 * this predicate says "displayable as a path", never "harmless".
 *
 * @param {string} t   candidate token
 * @returns {boolean}
 */
function validPath(t) {
	const s = String(t || '')
	if (s.length < 2) return false
	if (/[()=<>\\`$*|"'{}]/.test(s)) return false   // JS / regex / substitution fragment
	if (/^[-+]/.test(s)) return false               // an option (-x, +x, --write)
	if (/^\d+$/.test(s)) return false               // a flag value (-m 30)
	if (s.includes('/')) {
		// `/p`, `/g` are sed addresses, not paths — a real absolute path has ≥ 2 segments.
		const seg = s.split('/').filter(Boolean)
		return seg.length >= 2 || KNOWN_PATH_EXT.test(s)
	}
	return KNOWN_PATH_EXT.test(s)
}

/**
 * Weaker sibling of `validPath`, used only for targets coming from a verb that
 * always mutates. A bare directory name (`neg`, `frames_01`) is a legitimate
 * `rm` / `mkdir` operand and must survive, but the `name.ext` shape with an
 * unknown extension must not — that is the signature of a scraped JS property
 * (`console.log`, `s.map`).
 *
 * @param {string} t   candidate token
 * @returns {boolean}
 */
function plausibleTarget(t) {
	const s = String(t || '')
	if (validPath(s)) return true
	if (!/^[\w.@+-]+$/.test(s) || s.length < 2) return false
	if (/^[-+]/.test(s) || /^\d+$/.test(s)) return false
	return !s.includes('.') || KNOWN_PATH_EXT.test(s)
}

// -----------------------------------------------------------------------------
// SHELL SPLITTING — heredoc bodies and inline script bodies are NOT shell
// -----------------------------------------------------------------------------

/**
 * Collect heredoc bodies so they can be mined for inline-script writes while
 * being excluded from shell parsing.
 *
 * @param {string} c   raw command
 * @returns {string[]} body texts
 */
function heredocBodies(c) {
	const bodies = []
	const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([\s\S]*?)^\s*\2\s*$/gm
	let m
	while ((m = re.exec(c))) bodies.push(m[3])
	return bodies
}

/** Replace heredoc bodies with a placeholder. @param {string} c @returns {string} */
function stripHeredocs(c) {
	return String(c || '').replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, '<<BODY')
}

/**
 * Mask the quoted payload of `node -e "…"` / `python3 -c '…'`. Scanning inside
 * it produced 202 unreadable tokens and a stream of false alarms — property
 * accesses and template strings look exactly like paths and redirects.
 *
 * @param {string} s   command text
 * @returns {string}   same text with inline payloads replaced
 */
function maskInline(s) {
	return String(s || '').replace(/(^|\s)(-e|-c)\s+(['"])[\s\S]*?\3/g, '$1$2 INLINE')
}

/**
 * Blank out the CONTENT of quoted spans, keeping the quotes. A `>` inside
 * `echo "=== live session — expect silence ==="` is data, not a redirection ;
 * scanning through quotes invented writes to files named `expect`, `1h`, `1x`.
 *
 * Quoted redirect targets are collapsed too and then rejected by the strict
 * gate — deliberate : on the corpus they are all temp paths, and dropping a
 * phantom warning matters more than naming a rare quoted destination.
 *
 * @param {string} s   command text
 * @returns {string}   same length-ish text with quoted content neutralised
 */
function maskQuoted(s) {
	return String(s || '').replace(/(['"])(?:\\.|(?!\1)[\s\S])*\1/g, (m, q) => q + '…' + q)
}

/**
 * Split at top level on `;`, `&&`, `||`, `|` and newlines, honouring quoted
 * spans and dropping comments. A plain `split()` breaks on heredocs and on
 * `git commit -m "a; b"`.
 *
 * @param {string} c   command text (heredocs already stripped)
 * @returns {string[]} trimmed, non-empty segments
 */
function segments(c) {
	const out = []
	let cur = ''
	let quote = null
	const len = c.length
	for (let i = 0; i < len; i++) {
		const ch = c[i]
		if (quote) {
			if (ch === quote) quote = null
			cur += ch
			continue
		}
		if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue }
		if (ch === '#' && (i === 0 || /\s/.test(c[i - 1]))) {
			while (i < len && c[i] !== '\n') i++
			continue
		}
		if (ch === '\n' || ch === ';' || ch === '|') { out.push(cur); cur = ''; continue }
		if ((ch === '&' && c[i + 1] === '&') || (ch === '|' && c[i + 1] === '|')) {
			out.push(cur); cur = ''; i++; continue
		}
		cur += ch
	}
	out.push(cur)
	return out.map(s => s.replace(/\\$/, '').trim()).filter(Boolean)
}

/**
 * Tokenise one segment, stripping quotes and dropping redirection operators
 * with their targets — `cp a b 2>/dev/null` has TWO arguments, and letting
 * `2>/dev/null` through made it the reported copy destination.
 *
 * @param {string} seg   one shell segment
 * @returns {string[]}   argv-like tokens
 */
function tokens(seg) {
	const raw = []
	let cur = ''
	let quote = null
	for (const ch of seg) {
		if (quote) {
			if (ch === quote) quote = null
			else cur += ch
			continue
		}
		if (ch === "'" || ch === '"') { quote = ch; continue }
		if (/\s/.test(ch)) { if (cur) raw.push(cur); cur = ''; continue }
		cur += ch
	}
	if (cur) raw.push(cur)

	const out = []
	const len = raw.length
	for (let i = 0; i < len; i++) {
		const t = raw[i]
		if (/^\d*>>?$/.test(t)) { i++; continue }   // `>` `2>` `>>` plus its target
		if (/^\d*>>?\S/.test(t)) continue           // `2>/dev/null` glued together
		out.push(t)
	}
	return out
}

/**
 * Harvest `VAR=value` assignments so effects report a path instead of `$LOG`.
 *
 * @param {string} cmd
 * @returns {Object<string,string>}   variable name → literal value
 */
function varMap(cmd) {
	const map = {}
	for (const m of String(cmd || '').matchAll(/(?:^|[\s;&|])([A-Za-z_]\w*)=(['"]?)([^\s'"`;&|]+)\2/g)) {
		map[m[1]] = m[3]
	}
	return map
}

/**
 * Substitute known variables, up to 3 passes for chained definitions.
 *
 * @param {string} t
 * @param {Object<string,string>} vars
 * @returns {string}   expanded token ; may still contain `$` when unresolvable
 */
function expand(t, vars) {
	let s = String(t || '')
	for (let pass = 0; pass < 3 && s.includes('$'); pass++) {
		s = s.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name) => (vars[name] === undefined ? whole : vars[name]))
		if (!/\$\{?[A-Za-z_]/.test(s)) break
	}
	return s
}

/**
 * Leading `cd <dir>`, used to resolve relative targets before the temp filter.
 * Without it, `cd <scratchpad> && mkdir frames` looked like a repo write.
 *
 * @param {string} cmd
 * @returns {string}   directory, or '' when the command does not cd
 */
function effectiveCwd(cmd) {
	const m = String(cmd || '').match(/(?:^|[\s;&|])cd\s+(['"]?)([^\s'";&|]+)\1/)
	return m ? m[2] : ''
}

/**
 * git subcommand, skipping global options that take a value. Reading `argv[1]`
 * blindly turned `git -C /workspace ls-files` into the command `git /workspace`.
 *
 * @param {string[]} rest   tokens after `git`
 * @returns {string}        subcommand, or ''
 */
function gitSubcommand(rest) {
	const len = rest.length
	for (let i = 0; i < len; i++) {
		const t = rest[i]
		if (t === '-C' || t === '-c' || t === '--work-tree' || t === '--git-dir') { i++; continue }
		if (t.startsWith('-')) continue
		return t
	}
	return ''
}

/**
 * True when a git invocation only reads. `git tag -l`, `git stash list`,
 * `git apply --check` and `cherry-pick --abort` all mutate nothing ; flagging
 * them was a third of the residual noise.
 *
 * @param {string} sub       resolved subcommand
 * @param {string[]} rest    tokens after `git`
 * @param {string} seg       the whole segment
 * @returns {boolean}
 */
function isGitReadOnly(sub, rest, seg) {
	const flags = ` ${rest.join(' ')}`
	if (sub === 'tag' && /(^|\s)(-l|--list|--format)/.test(flags)) return true
	if (sub === 'stash' && /(^|\s)(list|show)(\s|$)/.test(flags)) return true
	if (sub === 'apply' && /(^|\s)(--check|--stat|--summary)/.test(flags)) return true
	if (sub === 'cherry-pick' && /--abort|--quit/.test(seg)) return true
	// A bare `git tag` / `git stash` with no operand lists rather than creates.
	if ((sub === 'tag' || sub === 'stash') && rest.filter(t => !t.startsWith('-')).length === 1) return true
	return false
}

// -----------------------------------------------------------------------------
// EFFECTS — what the command actually changes
// -----------------------------------------------------------------------------

// Kinds whose target is a path and therefore goes through the validity gate.
const PATH_KINDS = { write: 1, inplace: 1, delete: 1, move: 1, mkdir: 1, chmod: 1 }

/**
 * Static effect analysis of a shell command.
 *
 * THE STRICT / LENIENT SPLIT — this is the subtle part, and getting it wrong
 * once already regressed the feature :
 *
 *   - A target derived from a REDIRECTION goes through the gate strictly. If
 *     it is not a path, the parse was wrong, and inventing a mutation there
 *     manufactures false alarms.
 *   - A target derived from a VERB THAT ALWAYS MUTATES (`rm`, `cp`, `sed -i`,
 *     `prettier --write`…) goes through leniently : an unusable token degrades
 *     the LABEL but must never cancel the warning. Rejecting glob targets
 *     (`src/**\/*.js`) and loop variables (`$f`) silently re-hid 13 rewrites
 *     of tracked sources.
 *
 * @param {string} cmd   the shell command
 * @returns {Array<{kind:string,target:string}>}   effects, in discovery order
 */
function effectsOf(cmd) {
	const fx = []
	const src = String(cmd || '')
	const vars = varMap(src)
	const cwd = effectiveCwd(src)

	const add = (kind, target, strict) => {
		let t = expand(String(target || '').trim(), vars)
		if (!t) return
		// Decide throwaway-ness on the RAW token, before any degradation : once
		// `rm -rf "$TMP"` has collapsed to "un fichier" the mktemp origin is
		// gone and a temp cleanup would warn like a real deletion.
		const rawVar = String(target || '').match(/\$\{?([A-Za-z_]\w*)\}?/)
		const scratch = isScratch(t) || (rawVar && isScratch(vars[rawVar[1]] || ''))
		if (scratch) return
		if (PATH_KINDS[kind]) {
			// Resolve against the effective cwd FIRST, whatever the gate decides :
			// `cd <scratchpad> && mkdir neg` must be recognised as throwaway.
			if (cwd && !t.startsWith('/') && !t.startsWith('~') && !t.includes('$')) {
				t = `${cwd.replace(/\/$/, '')}/${t}`
			}
			if (validPath(t) || (!strict && plausibleTarget(t))) {
				t = repoPath(t)
			} else if (strict) {
				return
			} else {
				const isOperand = /[*?]/.test(t) || t.includes('/') || /\$\{?[A-Za-z_]/.test(t)
				t = isOperand ? clip(t.replace(/\$\{?[A-Za-z_]\w*\}?/g, '…'), 34) : 'un fichier'
			}
		}
		if (!fx.some(e => e.kind === kind && e.target === t)) fx.push({ kind, target: t })
	}

	const shell = maskInline(stripHeredocs(src))

	// 1. Redirections to a file, `cat > f <<EOF` included. Quoted spans are
	//    neutralised first, and the gate is strict here : a non-path is a
	//    parsing accident, not a write.
	for (const m of maskQuoted(shell).matchAll(/(^|[^0-9>&])>>?\s*(['"]?)([^\s'"|;&<>()]+)\2/g)) {
		if (/^\/dev\//.test(m[3])) continue
		add('write', m[3], true)
	}

	// 2. Inline scripts that write. Resolve the literal when possible ; a
	//    generic note is still better than silence when it is built at runtime.
	for (const body of heredocBodies(src).concat([src])) {
		const literal = body.match(/open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa]/) ||
			body.match(/(?:writeFileSync|appendFileSync|createWriteStream)\s*\(\s*['"]([^'"]+)['"]/)
		if (literal) { add('write', literal[1]); continue }
		const viaVar = body.match(/open\s*\(\s*(\w+)\s*,\s*['"][wa]/) ||
			body.match(/(?:writeFileSync|appendFileSync)\s*\(\s*(\w+)\s*,/)
		if (viaVar) {
			const assigned = body.match(new RegExp(`${viaVar[1]}\\s*=\\s*['"]([^'"]+)['"]`))
			if (assigned) add('write', assigned[1])
			else add('note', 'écrit un fichier (script inline)')
			continue
		}
		if (/\.write_text\s*\(/.test(body)) add('note', 'écrit un fichier (script inline)')
		if (/\b(unlink|rmSync|rmdirSync|shutil\.rmtree|os\.remove)\b/.test(body)) add('note', 'supprime un fichier (script inline)')
	}

	// 3. Per-segment verb analysis.
	for (const seg of segments(shell)) {
		const tk = tokens(seg)
		if (!tk.length) continue
		let i = 0
		while (i < tk.length && (WRAPPERS[tk[i]] || BLOCK_OPENERS[tk[i]] || /^[A-Za-z_]\w*=/.test(tk[i]) || /^\d+$/.test(tk[i]))) i++
		let bin = tk[i]
		if (!bin) continue
		if (bin.includes('/')) bin = bin.split('/').pop()   // node_modules/.bin/prettier → prettier
		if (SHELL_KEYWORDS[bin]) continue

		let rest = tk.slice(i + 1)
		if (bin === 'npx') {
			const real = rest.find(t => !t.startsWith('-'))
			if (real) { bin = real; rest = rest.slice(rest.indexOf(real) + 1) }
		}
		const args = rest.filter(t => !t.startsWith('-') && !t.includes('='))

		if (bin === 'git') {
			const sub = gitSubcommand(rest)
			if (sub && GIT_WRITE_SUBCOMMANDS[sub] && !isGitReadOnly(sub, rest, seg)) {
				add('git', gitLabel(sub, rest, args, src, seg))
			}
			continue
		}
		if (INSTALLERS.test(bin) && rest.some(t => /^(i|install|add|ci)$/.test(t))) {
			const pkgs = args.filter(t => !/^(i|install|add|ci|run)$/.test(t))
			add('install', pkgs.length ? `${bin} ${pkgs.slice(0, 2).join(' ')}` : bin)
			continue
		}
		if (FETCHERS[bin]) { addFetchEffect(add, bin, rest, args, seg, vars); continue }
		if (bin === 'rm') { for (const a of args.slice(0, 3)) add('delete', a); continue }
		if (bin === 'mv') { for (const a of args.slice(0, 2)) add('move', a); continue }
		if (bin === 'cp') { add('write', args[args.length - 1] || ''); continue }
		if (bin === 'chmod' || bin === 'chown') { for (const a of args.slice(1, 3)) add('chmod', a); continue }
		if (bin === 'truncate' || bin === 'ln' || bin === 'dd') { for (const a of args.slice(0, 2)) add('write', a); continue }
		if (bin === 'mkdir') { for (const a of args.slice(0, 1)) add('mkdir', a); continue }

		// In-place rewrite. `-i` only means that for sed/perl/ruby — `grep -i`
		// is case-insensitivity, and treating it as an edit produced 54 false
		// alarms, over a third of the residual noise.
		const flagged = ` ${rest.join(' ')} `
		const isInPlace = (/^(sed|perl|ruby)$/.test(bin) && /(^|\s)(-i|-pi|--in-place)/.test(flagged)) ||
			/(^|\s)(--write|--fix|--in-place)(\s|=|$)/.test(flagged)
		if (isInPlace && args.length) {
			// sed/perl/awk take their PROGRAM as the first bare argument.
			const targets = (/^(sed|perl|awk|ruby)$/.test(bin) && !rest.includes('-e') && !rest.includes('-f'))
				? args.slice(1)
				: args
			for (const a of targets.slice(0, 3)) add('inplace', a)
		}
	}
	return fx
}

/**
 * Human label for a mutating git subcommand. The commit subject is the whole
 * decision for a commit, including through `-m "$(cat <<'EOF' … )"`.
 *
 * @param {string} sub      subcommand
 * @param {string[]} rest   tokens after `git`
 * @param {string[]} args   bare operands
 * @param {string} src      full command (for the heredoc message)
 * @param {string} seg      current segment
 * @returns {string}        e.g. `git commit "fix(ai): …"`
 */
function gitLabel(sub, rest, args, src, seg) {
	if (sub !== 'commit') {
		if (sub === 'checkout' && /\s-b\s/.test(seg)) return `git checkout -b ${args[args.indexOf('checkout') + 1] || ''}`.trim()
		if (sub === 'push') return `git push${/--force|-f\b/.test(seg) ? ' --force' : ''}`
		return `git ${sub}`
	}
	if (/--amend/.test(src)) return 'git commit --amend'
	let msg = ''
	const inline = src.match(/-m\s+(['"])([^'"]{4,})\1/)
	if (inline && !inline[2].startsWith('$(')) msg = inline[2]
	if (!msg) {
		const body = heredocBodies(src)[0]
		if (body) msg = (body.split('\n').find(l => l.trim()) || '').trim()
	}
	return msg ? `git commit "${clip(msg, 46)}"` : 'git commit'
}

/**
 * Record a download only when bytes actually land on disk outside the
 * scratchpad. `curl -o /dev/null` is a reachability probe and
 * `yt-dlp --flat-playlist` a metadata query — 57 of 83 download warnings were
 * one of those.
 *
 * @param {Function} add           effect collector
 * @param {string} bin             fetcher name
 * @param {string[]} rest          tokens after the binary
 * @param {string[]} args          bare operands
 * @param {string} seg             current segment
 * @param {Object<string,string>} vars   variable map
 * @returns {void}
 */
function addFetchEffect(add, bin, rest, args, seg, vars) {
	const outIndex = rest.findIndex(t => /^(-o|-O|--output)$/.test(t))
	const dest = outIndex >= 0 ? rest[outIndex + 1] : ''
	if (dest && (/^\/dev\//.test(dest) || isScratch(expand(dest, vars)))) return

	if (/-X\s*(PUT|POST|DELETE|PATCH)/i.test(seg)) {
		const url = args.find(a => /^https?:/.test(a)) || ''
		add('note', `envoie des données à ${clip(url.replace(/^https?:\/\//, ''), 34)}`)
		return
	}
	const metadataOnly = /--flat-playlist|--print|--skip-download|(^|\s)-j(\s|$)|--version|--dump-json/.test(seg)
	const redirectsOut = /(^|[^0-9>&])>>?\s*[^\s|;&]+/.test(seg)
	if (metadataOnly || (outIndex < 0 && !redirectsOut && bin !== 'wget')) return

	const url = args.find(a => /^https?:/.test(a)) || ''
	const host = url && !url.includes('$') ? clip(url.replace(/^https?:\/\//, ''), 34) : ''
	add('fetch', host || '(URL non résolue)')
}

/**
 * Render the effects that land outside throwaway territory. Returns '' when
 * nothing durable changes — the absence of a clause is itself the signal.
 *
 * @param {Array<{kind:string,target:string}>} fx
 * @returns {string}   e.g. `écrit docs/…/x.md, supprime build/`
 */
function effectClause(fx) {
	let out = fx.filter(e => !isScratch(e.target) && !e.target.includes('~scratch'))
	// `git add` alone is reversible staging : it only earns a slot when nothing
	// heavier is happening in the same command.
	if (out.length > 1) out = out.filter(e => e.target !== 'git add')
	if (!out.length) return ''

	const label = (e) => {
		const t = e.target
		switch (e.kind) {
			case 'delete':  return `supprime ${t}`
			case 'move':    return `déplace ${t}`
			case 'install': return `installe ${t}`
			case 'fetch':   return `télécharge ${t}`
			case 'inplace': return `réécrit ${t}`
			case 'mkdir':   return `crée ${t}/`
			case 'chmod':   return `change les droits de ${t}`
			case 'git':
			case 'note':    return t
			default:        return `écrit ${t}`
		}
	}
	const shown = out.slice(0, 2).map(label).join(', ')
	return out.length > 2 ? `${shown} +${out.length - 2}` : shown
}

// -----------------------------------------------------------------------------
// INTENT — used only when nothing is written and no description exists
// -----------------------------------------------------------------------------

/**
 * Best-effort "what does this run", naming the SCRIPT rather than the
 * interpreter : a bare `node` or `npm` says nothing, `doc-counts.mjs --check`
 * and `npm run perf` say everything.
 *
 * @param {string} cmd
 * @returns {string}   short intent, or '' when nothing trustworthy is found
 */
function intentOf(cmd) {
	const vars = varMap(cmd)
	for (const seg of segments(maskInline(stripHeredocs(cmd)))) {
		// A redirection to a file IS the intent of its segment.
		const red = seg.match(/(^|[^0-9>&])>>?\s*(['"]?)([^\s'"|;&<>()]+)\2/)
		if (red && !/^\/dev\//.test(red[3]) && validPath(red[3])) {
			const target = expand(red[3], vars)
			return /\$\{?[A-Za-z_]/.test(target) ? 'écrit un fichier temporaire' : `écrit ${repoPath(target)}`
		}

		const tk = tokens(seg)
		if (!tk.length) continue
		let i = 0
		while (i < tk.length && (WRAPPERS[tk[i]] || BLOCK_OPENERS[tk[i]] || /^[A-Za-z_]\w*=/.test(tk[i]) || /^\d+$/.test(tk[i]))) i++
		let bin = tk[i]
		if (!bin) continue
		if (bin.includes('/')) bin = bin.split('/').pop()
		if (SHELL_KEYWORDS[bin] || !/^[a-z_][\w.+-]*$/i.test(bin)) continue

		let rest = tk.slice(i + 1)
		if (bin === 'npx') {
			const real = rest.find(t => !t.startsWith('-'))
			if (real) { bin = real; rest = rest.slice(rest.indexOf(real) + 1) }
		}
		const args = rest.filter(t => !t.startsWith('-') && !t.includes('$'))

		if (bin === 'wtf') {
			const pair = args.slice(0, 2).join(' ')
			const single = args[0] || ''
			if (WTF_LABELS[pair]) return `wtf ${pair} — ${WTF_LABELS[pair]}`
			if (WTF_LABELS[single]) return `wtf ${single} — ${WTF_LABELS[single]}`
			return args.length ? `wtf ${pair}` : 'wtf'
		}
		if (RUNNERS[bin]) {
			if (!args.length) return rest.includes('-e') || rest.includes('-c') ? `${bin} -e` : bin
			const script = repoPath(args[0]).split('/').pop()
			const second = args[1] && !args[1].includes('*') ? ` ${repoPath(args[1]).split('/').pop()}` : ''
			return script + second
		}
		if (bin === 'git') return `git ${gitSubcommand(rest)}`.trim()
		if (SUBCOMMAND_2[bin]) return args.length ? `${bin} ${args.slice(0, 2).join(' ')}` : bin
		if (SUBCOMMAND_1[bin]) return args.length ? `${bin} ${args[0]}` : bin
		if (TARGETED[bin] && args.length) return `${bin} ${repoPath(args[0])}`
		if (args.length && /[./]/.test(args[0])) return `${bin} ${repoPath(args[0])}`
		return bin + (args[0] ? ` ${clip(args[0], 24)}` : '')
	}
	return ''
}

// -----------------------------------------------------------------------------
// PER-TOOL RENDERING
// -----------------------------------------------------------------------------

/**
 * Bash / Monitor. Description wins when present ; otherwise the effect leads,
 * because with no description the mutation IS the information.
 *
 * @param {object} input   tool_input
 * @returns {string}
 */
function bashText(input) {
	const cmd = input.command || ''
	const clause = effectClause(effectsOf(cmd))
	const desc = input.description ? norm(input.description) : ''
	if (desc) return clause ? `${desc} — ⚠ ${clause}` : desc
	if (clause) return `⚠ ${clause}`
	const intent = intentOf(cmd)
	if (intent) return intent
	return `script shell, ${segments(stripHeredocs(cmd)).length} étapes (lecture seule)`
}

/**
 * Edit. The payload is never rendered : a fragment of the replaced text is
 * frequently `---`, `},` or a boilerplate import, which authorises a blind
 * edit. Magnitude plus the enclosing named scope is what a reader can act on.
 *
 * @param {object} i   tool_input
 * @returns {string}
 */
function editText(i) {
	const oldStr = i.old_string || ''
	const newStr = i.new_string || ''
	const oldLines = oldStr.split('\n').length
	const newLines = newStr.split('\n').length
	const anchor = oldStr.split('\n')
		.map(s => s.trim())
		.find(s => /^#{1,6}\s|^(function|const|let|class|def|export|async)\b/.test(s)) || ''
	const where = anchor ? ` près de "${clip(anchor.replace(/^#+\s*/, ''), SMART_TEXT_LIMITS.anchor_cap)}"` : ''
	const delta = oldLines === newLines ? `${newLines} lignes` : `${oldLines}→${newLines} lignes`
	return `${repoPath(i.file_path)} — ${delta}${where}`
}

/**
 * AskUserQuestion. The question field routinely opens with 2-3 sentences of
 * context and puts the interrogative last, so taking the head of the string
 * reliably cut away the actual ask. The option count is reserved out of the
 * budget so it can never be truncated.
 *
 * @param {object} i   tool_input
 * @returns {string}
 */
function askText(i) {
	const qs = i.questions || []
	const first = qs[0] || {}
	const text = norm(first.question || '')
	// Split on real sentence ends, not only on `?` : the corpus questions open
	// with 2-3 sentences of context and put the ask LAST, so a `?`-only split
	// left the whole paragraph as one "sentence" and the preamble won the budget.
	const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean)
	const interrogative = sentences.reverse().find(s => /[?？]\s*$/.test(s)) || text

	const headers = qs.map(q => q && q.header).filter(Boolean)
	const head = headers.length > 1 ? headers.join(', ') : (first.header || '')
	const optionCount = (first.options || []).length
	const suffix = qs.length > 1
		? ` · ${qs.length} questions`
		: (optionCount ? ` · ${optionCount} options` : '')

	const headPart = head ? `${head} — ` : ''
	const budget = LINE_CAP - 'Ask · '.length - headPart.length - suffix.length
	let body = clip(interrogative, Math.max(SMART_TEXT_LIMITS.question_min, budget))
	if (head && body.toLowerCase().startsWith(head.toLowerCase())) {
		body = body.slice(head.length).replace(/^\s*[—:-]\s*/, '')
	}
	return headPart + body + suffix
}

// Operations in a plan body that cannot be undone once approved.
const IRREVERSIBLE = /\b(rm -rf|force-push|--force|prune|npm publish|gh pr (comment|create|merge)|git push|git rebase|--no-cache|apt-get install)\b/

/**
 * ExitPlanMode. Approving a plan authorises an editing session, so the title
 * alone (often an internal codename) is not enough — the count of cited files
 * and any irreversible operation ride along.
 *
 * @param {object} i   tool_input
 * @returns {string}
 */
function planText(i) {
	const plan = i.plan || ''
	const h1 = plan.match(/^#\s+(.+)$/m)
	const title = h1 ? norm(h1[1].replace(/`/g, '')) : (clip(plan.split('\n')[0], 70) || '(plan)')

	const files = {}
	for (const m of plan.matchAll(/\(([^)\s]+\.(?:js|mjs|cjs|ts|vue|json|md|sh|py|yml|yaml))[^)]*\)/g)) files[m[1]] = 1
	for (const m of plan.matchAll(/`([^`\s]+\.(?:js|mjs|cjs|ts|vue|json|md|sh|py|yml|yaml))`/g)) files[m[1]] = 1
	let count = 0
	for (const _ in files) count++

	const irreversible = plan.match(IRREVERSIBLE)
	const bits = []
	if (count) bits.push(`cite ${count} fichiers`)
	if (irreversible) bits.push(`⚠ ${irreversible[0]}`)
	return bits.length ? `${title} — ${bits.join(', ')}` : title
}

/**
 * Category prefix for a path that changes a capability rather than content.
 *
 * @param {string} p   file path
 * @returns {string}   category, or '' for an ordinary file
 */
function policyPrefix(p) {
	const s = String(p || '')
	for (const [re, label] of POLICY_PATHS) {
		if (re.test(s)) return label
	}
	return ''
}

/**
 * Render the input of any tool to a short, decidable phrase.
 *
 * @param {string} tool    tool_name
 * @param {string|object} input   tool_input ; a string is the legacy pre-truncated hook format
 * @returns {string}
 */
function smartText(tool, input) {
	if (input === undefined || input === null) return '(aucune entrée)'
	if (typeof input === 'string') return clip(input, LINE_CAP) || '(aucune entrée)'
	if (tool === 'Bash' || tool === 'Monitor') return bashText(input)
	if (tool === 'Edit') return editText(input)
	if (tool === 'Write') return `${repoPath(input.file_path)} (${Math.round((input.content || '').length / 100) / 10}k)`
	if (tool === 'AskUserQuestion') return askText(input)
	if (tool === 'ExitPlanMode') return planText(input)
	if (tool === 'Skill') return input.skill + (input.args ? ` — ${clip(input.args, 60)}` : '')
	if (tool === 'Artifact') return norm(input.title || input.description || repoPath(input.file_path))
	let json = ''
	try { json = JSON.stringify(input) } catch { json = String(input) }
	return clip(json, 70) || '(aucune entrée)'
}

/**
 * Drop a verb repeated at the head of the text — `Plan · Plan — X` reads as a
 * stutter. Only fires on a separator or a space, and never when the remainder
 * would collapse, so `Plan · Plan` and `Plan · Planification…` stay intact.
 *
 * @param {string} verb
 * @param {string} text
 * @returns {string}
 */
function dedupeVerb(verb, text) {
	const stripped = text.replace(new RegExp(`^${verb}\\s*(?:[—:\\-–]\\s*|\\s)`, 'i'), '').trim()
	return stripped.length >= 3 ? stripped : text
}

/**
 * The permission_request body : `<Verb> · <what happens>`, clamped to the line
 * budget. Exported for the consumers and asserted directly by the tests.
 *
 * @param {object} line                    queue JSONL event line
 * @param {string} [line.tool_name]        tool identifier
 * @param {string|object} line.tool_input  raw or structured tool input
 * @returns {string}                       ready for the notification body
 */
function permissionLine(line) {
	const tool = (line && line.tool_name) || ''
	const input = line ? line.tool_input : null
	let verb = TOOL_VERBS[tool] || tool || 'Permission'
	if ((tool === 'Edit' || tool === 'Write') && input && typeof input === 'object' && input.file_path) {
		const policy = policyPrefix(input.file_path)
		if (policy) verb = policy
	}
	return clip(`${verb} · ${dedupeVerb(verb, smartText(tool, input))}`, LINE_CAP)
}

module.exports = {
	permissionLine,
	smartText,
	_test: { effectsOf, effectClause, intentOf, validPath, repoPath, isScratch, clip, dedupeVerb, policyPrefix, segments, tokens }
}
