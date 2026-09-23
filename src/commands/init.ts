// `devc init` — the host wizard that scaffolds a thin v3 .devcontainer/.
//
// Replaces install.sh, and is not a port of it: that script copied 364 files
// out of a template tree, this one writes ~25 and lets the project inherit
// the rest from the published base image at runtime. What did carry over is
// the slice around the copy — the questions, the .env generation, the root
// .gitignore append, the symlinks, the "never clobber" guards — and each one
// names its bash ancestor below.
//
// Three states, decided before anything is written:
//   absent    — scaffold;
//   same      — a tree this CLI recognises: report, add what is missing, exit 0;
//   different — anything else (v1/v2 trees, another tool's): refuse, exit 1.

import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { detectStack, isStackId, STACKS, stackInfo, type StackId } from '../lib/detect-stack.js'
import { readDevcontainerJson } from '../lib/devcontainer-json.js'
import {
	BASE_IMAGE_REPOSITORY,
	DEFAULT_BASE_VERSION,
	DEFAULT_CLAUDE_CODE_VERSION,
	discoverCredsVolumes,
	PUBLISHED_CLAUDE_CODE_VERSIONS,
	type CredsVolume,
} from '../lib/docker.js'
import { readEnvFile, uncommentEnvVar, unsetEnvVar } from '../lib/env-file.js'
import { readExtPatchesConfig, writeExtPatchesConfig } from '../lib/machine-config.js'
import {
	CLI_PACKAGE_NAME,
	detectPackageManager,
	installCommand,
	planPackageJson,
	readPackageJson,
} from '../lib/package-json.js'
import { defaultProjectId, isValidProjectId, titlecase } from '../lib/paths.js'
import { isBareWin32, readHostProbe, type HostProbe } from '../lib/platform.js'
import { run } from '../lib/proc.js'
import { choose, confirm, PromptAbandoned, readlineAsk, secret, text, type Ask, type PromptContext } from '../lib/prompts.js'
import { applyPlan, buildPlan, classifyTarget, diffPlan, type ScaffoldAnswers } from '../lib/scaffold.js'
import { CLI_NAME, CLI_VERSION } from '../lib/version.js'

export interface InitOptions {
	cwd: string
	/** Project root to scaffold into; defaults to cwd. */
	targetDir?: string | undefined
	/** Take every default, ask nothing. Required when stdin is not a terminal. */
	yes: boolean
	dryRun: boolean
	projectId?: string | undefined
	displayName?: string | undefined
	/** A volume name, or `none` for a private per-project volume. */
	credsVolume?: string | undefined
	stack?: string | undefined
	claudeCodeVersion?: string | undefined
	/** Non-interactive ext-patches opt-in; token comes from EXT_PATCHES_TOKEN, never a flag. */
	extPatchesRepo?: string | undefined
	extPatchesRef?: string | undefined
	/** Run the package manager after writing package.json (default true; `--no-install`). */
	install?: boolean | undefined
	/** Stream whose TTY-ness decides whether prompting is possible. */
	input?: NodeJS.ReadableStream & { isTTY?: boolean }
	/** The question seam — same shape as `devc initialize`. */
	ask?: Ask
	/** Masked-input seam for the ext-patches token; same fallback as `PromptContext.askSecret`. */
	askSecret?: Ask
	out?: NodeJS.WritableStream
	err?: NodeJS.WritableStream
	probe?: HostProbe
	/** Credentials-volume discovery; replaced in tests that do not stub docker. */
	discover?: () => CredsVolume[] | null
	/** The install step; replaced in tests so nothing reaches the registry. */
	installer?: (projectDir: string, argv: readonly string[]) => Promise<number>
}

export const INIT_HELP = `devc init — scaffold a .devcontainer/ into a project

Writes the thin project layer that builds on the published base image
${BASE_IMAGE_REPOSITORY}:${DEFAULT_BASE_VERSION}-cc<claude-code>:
devcontainer.json, Dockerfile, docker-compose.yml, .env, the firewall
allowlist and the hook/skill overlay directories — plus a root package.json
that pins this CLI (installed right away unless --no-install), a root
.gitignore fragment and the LESSONS / rules links.

Usage:
  devc init [dir] [options]

Arguments:
  dir                        Project root (default: the current directory)

Options:
  --yes                      Take every default without asking (required when
                             stdin is not a terminal)
  --project-id <slug>        DC_PROJECT: compose project name and volume prefix
                             (lowercase letters, digits, hyphens)
  --display-name <name>      The devcontainer's name in VS Code
  --creds-volume <name|none> Claude credentials volume to share, or "none" for a
                             private per-project one
  --stack <id>               ${STACKS.map((stack) => stack.id).join(' | ')}
  --cc <x.y.z>               Claude Code line to pin (published: ${PUBLISHED_CLAUDE_CODE_VERSIONS.join(', ')})
  --ext-patches-repo <owner/name>  Extension patchers repo (non-interactive opt-in)
  --ext-patches-ref <ref>    Ref for the above (default: empty = auto)
  --no-install               Write package.json but do not run the package manager
  --dry-run                  Show what would be written, write nothing
  -h, --help                 Show this help

Environment:
  EXT_PATCHES_TOKEN          Token for --ext-patches-repo (never a flag — it
                             would land in shell history)

An existing .devcontainer/ is never overwritten: a tree this CLI made gets a
per-file report and only missing files added; any other tree is refused.
`

/** Docker's own rule for a volume name. */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const SEMVER = /^\d+\.\d+\.\d+$/
/** Quotes, backslashes and control characters — the name lands inside a JSON string. */
const DISPLAY_NAME_FORBIDDEN = /["\\\u0000-\u001f\u007f]/
const NEW_VOLUME_DEFAULT = 'claude-creds-shared'
const STACK_DOC_BASE = `https://github.com/meitogi/devcontainer-sandbox/blob/v${DEFAULT_BASE_VERSION}/`

export async function init(options: InitOptions): Promise<number> {
	const out = options.out ?? process.stdout
	const err = options.err ?? process.stderr
	const say = (line = ''): void => {
		out.write(`${line}\n`)
	}

	const projectDir = resolve(options.cwd, options.targetDir ?? '.')
	if (!isDirectory(projectDir)) {
		err.write(`devc init: target directory does not exist: ${projectDir}\n`)
		return 2
	}

	// === Flags are validated before any prompt, so a typo fails fast =========
	const flagError = validateFlags(options)
	if (flagError !== null) {
		err.write(`devc init: ${flagError}\n`)
		return 2
	}

	const probe = options.probe ?? readHostProbe()
	if (isBareWin32(probe)) {
		// init writes text files only, so it can carry on; the symlinks are the
		// one step that may fail here, and applyPlan reports each with the
		// command to run by hand.
		err.write('⚠ Running on native Windows outside WSL — WSL2 is the supported route.\n')
	}

	say(`devc init — ${CLI_NAME} v${CLI_VERSION}`)
	say(`  target: ${projectDir}`)
	if (options.dryRun) say('  mode:   dry-run (nothing is written)')

	// === The three states (install.sh's detect_existing_devcontainer) ========
	const state = classifyTarget(projectDir)
	if (state.kind === 'different') {
		err.write(`devc init: refusing — ${join(projectDir, '.devcontainer')} holds ${state.found}\n`)
		for (const line of state.detail) err.write(`  ${line}\n`)
		err.write('  Manual route: back up .devcontainer/.env, move .devcontainer aside, re-run devc init.\n')
		return 1
	}

	const input = options.input ?? process.stdin
	const interactive = !options.yes && input.isTTY === true
	if (!options.yes && !interactive) {
		err.write(
			'devc init: stdin is not a terminal and --yes was not given.\n' +
				'  Pass --yes to take the defaults, with --project-id / --display-name /\n' +
				'  --creds-volume / --stack / --cc to override any of them.\n',
		)
		return 2
	}

	const readline = interactive && options.ask === undefined ? readlineAsk(input, out) : null
	const context: PromptContext = {
		ask: options.ask ?? readline?.ask ?? (async () => ''),
		askSecret: options.askSecret ?? readline?.askSecret,
		out,
	}
	const wizard: WizardContext = { projectDir, options, context, interactive, say, err }

	try {
		// `return await`, not `return`: the finally below closes the readline
		// interface, and a bare return runs it while a question is still
		// pending — the promise never settles and the process exits 13.
		if (state.kind === 'same') return await reportExisting(wizard)

		const collected = await collectAnswers(wizard)
		if (collected === null) {
			say('Aborted — nothing written.')
			return 0
		}
		return await scaffold(wizard, collected.answers, collected.extPatches)
	} catch (error) {
		if (error instanceof PromptAbandoned) {
			err.write(`devc init: ${error.message}\n`)
			return 2
		}
		throw error
	} finally {
		readline?.close()
	}
}

function validateFlags(options: InitOptions): string | null {
	if (options.projectId !== undefined && !isValidProjectId(options.projectId)) {
		return `--project-id "${options.projectId}" is not a valid slug (lowercase letters, digits, hyphens; cannot start or end with "-")`
	}
	if (options.displayName !== undefined) {
		const problem = displayNameProblem(options.displayName)
		if (problem !== null) return `--display-name ${problem}`
	}
	if (options.credsVolume !== undefined && options.credsVolume !== 'none' && !VOLUME_NAME.test(options.credsVolume)) {
		return `--creds-volume "${options.credsVolume}" is not a valid Docker volume name`
	}
	if (options.stack !== undefined && !isStackId(options.stack)) {
		return `--stack "${options.stack}" is not one of ${STACKS.map((stack) => stack.id).join(', ')}`
	}
	if (options.claudeCodeVersion !== undefined && !SEMVER.test(options.claudeCodeVersion)) {
		return `--cc "${options.claudeCodeVersion}" is not a version (expected x.y.z)`
	}
	return null
}

function displayNameProblem(value: string): string | null {
	if (value.trim().length === 0) return 'cannot be empty'
	if (DISPLAY_NAME_FORBIDDEN.test(value)) return 'cannot contain quotes, backslashes or control characters'
	return null
}

interface WizardContext {
	projectDir: string
	options: InitOptions
	context: PromptContext
	interactive: boolean
	say: (line?: string) => void
	err: NodeJS.WritableStream
}

interface ExtPatchesAnswer {
	repo: string
	ref: string
	token: string
}

interface CollectedAnswers {
	answers: ScaffoldAnswers
	extPatches: ExtPatchesAnswer | null
}

/** The questions, in install.sh's order with the stack detection in front. Null = aborted at the summary. */
async function collectAnswers(wizard: WizardContext): Promise<CollectedAnswers | null> {
	const { projectDir, options, context, interactive, say } = wizard

	// --- 1. What is this project? --------------------------------------------
	const detection = detectStack(projectDir)
	let stack: StackId = isStackId(options.stack ?? '') ? (options.stack as StackId) : detection.stack
	if (options.stack === undefined) {
		say()
		say(
			detection.evidence.length > 0
				? `  Detected: ${stackInfo(detection.stack).label} (${detection.evidence.join(', ')})`
				: '  Detected: nothing recognisable at the project root',
		)
		if (interactive) {
			const index = await choose(context, {
				question: 'Stack',
				explain: [
					'The base image is Node 24 and self-sufficient. Any other stack is a documented',
					'block you add to .devcontainer/Dockerfile; the answer picks which doc to point',
					'you at and fills the stack line of claude/CLAUDE-project.md.',
				],
				options: STACKS.map((info) => ({
					label: info.label,
					hint: info.id === 'node' ? '(base image, nothing to add)' : info.doc === null ? '' : `→ ${info.doc}`,
				})),
				defaultIndex: Math.max(
					0,
					STACKS.findIndex((info) => info.id === detection.stack),
				),
			})
			stack = (STACKS[index] as { id: StackId }).id
		}
	}

	// --- 2. Project id (wizard_project_id) -------------------------------------
	let projectId = options.projectId ?? defaultProjectId(projectDir)
	if (options.projectId === undefined && interactive) {
		projectId = await text(context, {
			question: 'Project id',
			explain: [
				'DC_PROJECT in .env: the Docker Compose project name and the prefix of this',
				"project's volumes (claude-code-config-<id>, claude-code-bashhistory-<id>,",
				'mitmproxy-<id>). Lowercase letters, digits and hyphens.',
			],
			defaultValue: projectId,
			validate: (value) =>
				isValidProjectId(value) ? null : 'lowercase letters, digits, hyphens; cannot start or end with "-"',
		})
	}
	if (!isValidProjectId(projectId)) {
		// Only reachable under --yes with a directory name that sanitises to nothing usable.
		throw new PromptAbandoned(`derived project id "${projectId}" is not a valid slug — pass --project-id`)
	}

	// --- 3. Display name (wizard_display_name) ---------------------------------
	let displayName = options.displayName ?? titlecase(projectId)
	if (options.displayName === undefined && interactive) {
		displayName = await text(context, {
			question: 'Display name',
			explain: ["The devcontainer's name in VS Code: the window title and the", '"Dev Container: …" badge in the status bar.'],
			defaultValue: displayName,
			validate: displayNameProblem,
		})
	}

	// --- 4. Credentials volume (wizard_creds_volume) ---------------------------
	const credsVolume = await chooseCredsVolume(wizard, projectId)

	// --- 5. Claude Code line ---------------------------------------------------
	let claudeCodeVersion = options.claudeCodeVersion ?? DEFAULT_CLAUDE_CODE_VERSION
	if (options.claudeCodeVersion === undefined && interactive) {
		const index = await choose(context, {
			question: 'Claude Code line',
			explain: [
				`The base image is published once per Claude Code version (${DEFAULT_BASE_VERSION}-cc<version>).`,
				'Change this only to stay on an older Claude Code; BASE_IMAGE in .env is the knob.',
			],
			options: PUBLISHED_CLAUDE_CODE_VERSIONS.map((version) => ({
				label: version,
				hint: version === DEFAULT_CLAUDE_CODE_VERSION ? '(current)' : '',
			})),
			defaultIndex: Math.max(0, PUBLISHED_CLAUDE_CODE_VERSIONS.indexOf(DEFAULT_CLAUDE_CODE_VERSION)),
		})
		claudeCodeVersion = PUBLISHED_CLAUDE_CODE_VERSIONS[index] as string
	}
	if (!PUBLISHED_CLAUDE_CODE_VERSIONS.includes(claudeCodeVersion)) {
		say(
			`  ⚠ ${claudeCodeVersion} is not a published line (${PUBLISHED_CLAUDE_CODE_VERSIONS.join(', ')}) — the image pull may fail.`,
		)
	}

	const answers: ScaffoldAnswers = { projectId, displayName, stack, credsVolume, claudeCodeVersion }

	// --- 6. Extension patchers (machine-level reuse) ---------------------------
	const extPatches = await collectExtPatches(wizard, claudeCodeVersion)

	// --- Summary + confirm (summary_and_confirm) -------------------------------
	say()
	say('  Summary')
	say(`    Target        : ${projectDir}`)
	say(`    Stack         : ${stackInfo(stack).label}`)
	say(`    Project id    : ${projectId}`)
	say(`    Display name  : ${displayName}`)
	say(`    Creds volume  : ${credsVolume ?? `(private — claude-creds-${projectId}, created at first start)`}`)
	say(`    Base image    : ${buildPlan(answers).imageRef}`)
	if (extPatches !== null) say(`    Ext-patches   : ${extPatches.repo} @ ${extPatches.ref === '' ? 'auto' : extPatches.ref}`)
	say()
	if (interactive && !(await confirm(context, { question: 'Proceed?', defaultYes: true }))) return null
	return { answers, extPatches }
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/

/**
 * Repo/ref/token for the wizard's extension-patcher prompts, with
 * machine-level reuse: the first project on a machine asks all three and
 * offers to remember them at `~/.config/devc/ext-patches.env`; later
 * projects get one reuse confirmation, with `ref` always recomputed for
 * this project rather than trusted from the stored value. Non-interactive
 * only via explicit flags — never prompted, never touches the machine
 * config.
 */
async function collectExtPatches(wizard: WizardContext, claudeCodeVersion: string): Promise<ExtPatchesAnswer | null> {
	const { options, context, interactive, say } = wizard
	// Empty = auto: the hook resolves the newest tag cut for the Claude Code
	// version the container runs (cc<version>-r<n>). A pin is the exception.
	const defaultRef = ''
	void claudeCodeVersion

	if (!interactive) {
		if (options.extPatchesRepo === undefined) return null
		return {
			repo: options.extPatchesRepo,
			ref: options.extPatchesRef ?? defaultRef,
			token: process.env['EXT_PATCHES_TOKEN'] ?? '',
		}
	}

	const machine = readExtPatchesConfig()
	if (machine !== null) {
		const reuse = await confirm(context, { question: `Reuse ext-patches config from ${machine.repo}?`, defaultYes: true })
		if (reuse) return { repo: machine.repo, ref: defaultRef, token: machine.token }
	}

	say()
	const repo = await text(context, {
		question: 'Extension patchers repository (owner/name, empty to skip)',
		explain: [
			'A git repo of VS Code extension patches applied at container start.',
			'Leave empty to skip — nothing else is asked or written for this.',
		],
		defaultValue: '',
		validate: (value) => (value.length === 0 || REPO_PATTERN.test(value) ? null : 'expected owner/name'),
	})
	if (repo.length === 0) return null

	const ref = await text(context, {
		question: 'Ref (empty = auto)',
		explain: ['Empty: the newest tag cut for this Claude Code version, cc<version>-r<n>, resolved at boot.', 'A tag or a commit SHA freezes a set instead.'],
		defaultValue: defaultRef,
	})

	const token = await secret(context, {
		question: 'Access token (empty for none, ctrl-R reveals)',
		explain: ["Lands in this project's .env either way — masking only guards the terminal echo."],
	})

	if (await confirm(context, { question: 'Remember these for your next project?', defaultYes: true })) {
		writeExtPatchesConfig({ repo, ref, token })
	}

	return { repo, ref, token }
}

/**
 * Discovery first: every claude-creds-* volume on the host, ranked by how many
 * compose projects mount it, so the most shared one is the default. install.sh
 * offered the first `grep` hit; a host with three volumes deserves the list.
 */
async function chooseCredsVolume(wizard: WizardContext, projectId: string): Promise<string | null> {
	const { options, context, interactive, say } = wizard
	if (options.credsVolume !== undefined) return options.credsVolume === 'none' ? null : options.credsVolume

	const discovered = (options.discover ?? discoverCredsVolumes)()
	const found = discovered ?? []
	const mostShared = found[0]
	if (!interactive) return mostShared?.name ?? NEW_VOLUME_DEFAULT

	const describe = (volume: CredsVolume): string => {
		const count = volume.projects.length
		if (count === 0) return 'not mounted by any container'
		const who = `(${volume.projects.join(', ')})`
		return count === 1 ? `used by 1 project ${who}` : `shared by ${count} projects ${who}`
	}
	if (discovered === null) say('  ⚠ docker did not answer — existing credentials volumes could not be listed.')
	const choices = [
		...found.map((volume) => ({ label: volume.name, hint: describe(volume) })),
		{ label: 'New shared volume…', hint: `(name asked next, default ${NEW_VOLUME_DEFAULT})` },
		{ label: 'None', hint: `private volume claude-creds-${projectId}, created at first start` },
	]
	const index = await choose(context, {
		question: 'Claude credentials volume',
		explain: [
			'Claude Code keeps its login in a Docker volume. Sharing one volume between',
			'projects means one login per machine instead of one per project.',
		],
		options: choices,
		defaultIndex: 0,
	})
	if (index < found.length) return (found[index] as CredsVolume).name
	if (index === found.length) {
		return text(context, {
			question: 'Volume name',
			explain: [
				'CLAUDE_CREDS_VOLUME in .env; created by devc initialize at first start. Use the',
				'same name in your other projects to share the login with them.',
			],
			defaultValue: NEW_VOLUME_DEFAULT,
			validate: (value) => (VOLUME_NAME.test(value) ? null : 'letters, digits, "_", "." and "-" only'),
		})
	}
	return null
}

/** State "absent": write the plan, the manifest, install, and say what comes next. */
async function scaffold(wizard: WizardContext, answers: ScaffoldAnswers, extPatches: ExtPatchesAnswer | null): Promise<number> {
	const { projectDir, options, context, interactive, say, err } = wizard
	const dryRun = options.dryRun
	const plan = buildPlan(answers)
	const result = applyPlan({ projectDir, plan, dryRun })

	say()
	say(dryRun ? '  Would write:' : '  Written:')
	for (const path of result.written) say(`    + ${path}`)
	for (const path of result.kept) say(`    = ${path} (already there, kept)`)
	say(`    ${result.gitignore === 'appended' ? '+' : '='} .gitignore (${result.gitignore})`)
	for (const problem of result.symlinkProblems) err.write(`  ⚠ ${problem}\n`)

	if (extPatches !== null) {
		const envFile = join(projectDir, '.devcontainer', '.env')
		if (!dryRun) {
			uncommentEnvVar(envFile, 'EXT_PATCHES_REPO', extPatches.repo)
			// Auto stays the documented, commented line: an empty live value would
			// read as a pin to nothing.
			if (extPatches.ref !== '') uncommentEnvVar(envFile, 'EXT_PATCHES_REF', extPatches.ref)
			uncommentEnvVar(envFile, 'EXT_PATCHES_TOKEN', extPatches.token)
		}
		say(`    ~ .env (EXT_PATCHES_REPO/REF/TOKEN)`)
	} else if (!dryRun) {
		// The template ships EXT_PATCHES_REPO and the <change-me> token LIVE, so a
		// clone knows what to fill in. A project that declined patchers gets
		// neither line in its .env: the hook would otherwise say "placeholder"
		// at every boot about a feature nobody asked for.
		const envFile = join(projectDir, '.devcontainer', '.env')
		unsetEnvVar(envFile, 'EXT_PATCHES_REPO')
		unsetEnvVar(envFile, 'EXT_PATCHES_TOKEN')
	}

	// The bootstrap manifest, so `npm install` pins this CLI for the
	// initializeCommand to run locally from then on.
	const manifest = planPackageJson(readPackageJson(projectDir), CLI_PACKAGE_NAME, `^${CLI_VERSION}`)
	const manualLine = `"${CLI_PACKAGE_NAME}": "^${CLI_VERSION}"`
	if (manifest.kind === 'create' || manifest.kind === 'insert') {
		if (!dryRun) writeFileSync(join(projectDir, 'package.json'), manifest.content, 'utf8')
		say(`    ${manifest.kind === 'create' ? '+' : '~'} package.json (devDependency ${manualLine})`)
	} else if (manifest.kind === 'present') {
		say(`    = package.json (${CLI_PACKAGE_NAME} already a devDependency)`)
	} else {
		err.write(`  ⚠ package.json left alone: ${manifest.reason}. Add to devDependencies by hand:\n      ${manualLine}\n`)
	}

	// Install right away, so one command leaves the project ready: the
	// initializeCommand then resolves this local, lockfile-pinned copy at every
	// container start with no registry round-trip.
	const manager = detectPackageManager(projectDir)
	const installable = manifest.kind === 'create' || manifest.kind === 'insert' || manifest.kind === 'present'
	let installed = false
	if (installable && options.install !== false && !dryRun) {
		const go =
			!interactive ||
			(await confirm(context, { question: `Install ${CLI_PACKAGE_NAME} locally now (${installCommand(manager)})?`, defaultYes: true }))
		if (go) {
			const argv = installArgv(manager)
			say()
			say(`  $ ${argv.join(' ')}`)
			const runner = options.installer ?? runInstaller
			const code = await runner(projectDir, argv)
			if (code === 0) installed = true
			else err.write(`  ⚠ ${argv[0]} exited with ${code} — run it again by hand: ${installCommand(manager)}\n`)
		}
	}

	const info = stackInfo(answers.stack)
	let step = 1
	say()
	say('  Next steps')
	if (!installed) {
		say(`    ${step++}. ${installCommand(manager)}`)
		say("       — installs the CLI locally; the container's initializeCommand runs that copy.")
	}
	say(`    ${step++}. code "${projectDir}"  →  Dev Containers: Reopen in Container`)
	say(`       — first boot pulls ${plan.imageRef} (~2-3 GB), bakes your firewall/ allowlist, runs the lifecycle.`)
	if (info.doc !== null) {
		say(`    ${step++}. Add the ${info.label} blocks to .devcontainer/Dockerfile:`)
		say(`       ${STACK_DOC_BASE}${info.doc}`)
	} else if (answers.stack !== 'node') {
		say(`    ${step++}. Add your toolchain to the final stage of .devcontainer/Dockerfile (RUN apt-get install …).`)
	}
	say('    Your hosts go in .devcontainer/firewall/domains.txt; firewall-blocks in the container lists what was denied.')
	return 0
}

/** `npm install` and its equivalents, as an argv — no shell involved. */
export function installArgv(manager: ReturnType<typeof detectPackageManager>): string[] {
	return [manager, 'install']
}

/** Stream the package manager's output through; a non-zero exit is reported, not thrown. */
async function runInstaller(projectDir: string, argv: readonly string[]): Promise<number> {
	try {
		const result = await run({ argv, cwd: projectDir, check: false, onLine: (line) => process.stdout.write(`    ${line}\n`) })
		return result.code
	} catch (error) {
		process.stderr.write(`  ⚠ could not start ${argv[0]}: ${(error as Error).message}\n`)
		return 1
	}
}

/** State "same": nothing to re-scaffold; report, offer to add what is missing. */
async function reportExisting(wizard: WizardContext): Promise<number> {
	const { projectDir, options, context, interactive, say } = wizard
	// The answers this tree was made with, as far as the managed files need
	// them: the id from .env, the display name from devcontainer.json.
	const env = readEnvFile(join(projectDir, '.devcontainer', '.env'))
	const projectId = env['DC_PROJECT'] ?? defaultProjectId(projectDir)
	const name = readDevcontainerJson(join(projectDir, '.devcontainer', 'devcontainer.json'))?.['name']
	const displayName = typeof name === 'string' ? name.replace(/ — Claude Code Sandbox$/, '') : titlecase(projectId)
	const plan = buildPlan({
		projectId,
		displayName,
		stack: 'other',
		credsVolume: null,
		claudeCodeVersion: DEFAULT_CLAUDE_CODE_VERSION,
	})

	const report = diffPlan(projectDir, plan)
	const missing = report.filter((file) => file.status === 'missing')
	const differs = report.filter((file) => file.status === 'differs')

	say()
	say('  This .devcontainer/ was scaffolded by this CLI — nothing to re-scaffold.')
	for (const file of report) {
		const label = file.status === 'identical' ? '=' : file.status === 'differs' ? '~' : file.status === 'yours' ? '·' : '?'
		const note = file.status === 'yours' ? `yours (${file.ownership})` : file.status
		say(`    ${label} ${file.path}  ${note}`)
	}
	if (differs.length > 0) {
		say(`  ${differs.length} managed file(s) differ from this version's template; they are not overwritten.`)
	}
	if (missing.length === 0) {
		say('  Nothing to do.')
		return 0
	}

	say(`  ${missing.length} file(s) missing.`)
	const add = !interactive || (await confirm(context, { question: 'Add the missing files?', defaultYes: true }))
	if (!add) {
		say('  Left as is.')
		return 0
	}
	const result = applyPlan({ projectDir, plan, dryRun: options.dryRun })
	for (const path of result.written) say(`    + ${path}`)
	for (const problem of result.symlinkProblems) say(`  ⚠ ${problem}`)
	return 0
}

function isDirectory(path: string): boolean {
	return existsSync(path) && statSync(path).isDirectory()
}
