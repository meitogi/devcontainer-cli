// Locating the .devcontainer directory.
//
// initialize.sh could take a shortcut here: `DEVCONTAINER_DIR="$(cd "$(dirname
// "$0")" && pwd)"`. The script lived inside the directory it operated on, so
// its own location was the answer.
//
// That shortcut dies with the port. Under `npx @meitogi/devcontainer-cli`, the
// entry point sits in an npm cache directory that has nothing to do with the
// project, so location has to be resolved from the working directory instead —
// or stated outright, which is also what makes the differential test possible.

import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface ProjectPaths {
	/** Absolute path of `.devcontainer/`. */
	devcontainerDir: string
	/** Absolute path of its parent, the workspace root. */
	projectDir: string
	/** `<devcontainerDir>/.env`. */
	envFile: string
}

export class PathResolutionError extends Error {}

/**
 * Resolve the pair of directories every command works against.
 *
 * The path given — whether through `--devcontainer-dir` or as the working
 * directory — may be either the `.devcontainer` itself or the project root
 * holding it. Anything not already named `.devcontainer` gets `.devcontainer`
 * appended, so `../some-project` and `../some-project/.devcontainer` resolve to
 * the same place. Pointing at a project root is the more natural way to say it,
 * and getting an error for it would be pedantry.
 *
 * Walking *up* the tree looking for a `.devcontainer` ancestor is deliberately
 * not implemented: this command mutates `.env`, seeds firewall files and can
 * start an image build, so silently picking a different project than the one
 * named would be worse than an error.
 */
export function resolveProjectPaths(cwd: string, explicitDir?: string): ProjectPaths {
	const devcontainerDir = devcontainerDirFor(resolve(explicitDir ?? cwd))
	const projectDir = dirname(devcontainerDir)
	return { devcontainerDir, projectDir, envFile: join(devcontainerDir, '.env') }
}

/** `<path>` when it is already a `.devcontainer`, else `<path>/.devcontainer`. */
export function devcontainerDirFor(path: string): string {
	return basename(path) === '.devcontainer' ? path : join(path, '.devcontainer')
}

export type DevcontainerState =
	/** No `.devcontainer` directory at all. */
	| { kind: 'absent' }
	/** A directory exists, but nothing identifies it as a devcontainer. */
	| { kind: 'unrecognised' }
	/** A `devcontainer.json` is present — safe to operate on. */
	| { kind: 'present' }

/**
 * Classify the target before anything writes to it.
 *
 * The bash script never needed this: `DEVCONTAINER_DIR` came from
 * `dirname $0`, so the directory provably contained the script and everything
 * shipped beside it. Accepting a path from the caller removes that guarantee,
 * and without a check the command will happily seed firewall files, write a
 * `.vscode` stub and create a Docker volume inside a directory that is not a
 * devcontainer at all — then fail on the first thing that actually needs one.
 */
export function classifyDevcontainer(devcontainerDir: string): DevcontainerState {
	if (!existsSync(devcontainerDir) || !statSync(devcontainerDir).isDirectory()) return { kind: 'absent' }
	if (!existsSync(join(devcontainerDir, 'devcontainer.json'))) return { kind: 'unrecognised' }
	return { kind: 'present' }
}

/**
 * The one shape a project id may take: `install.sh`'s wizard regex.
 *
 * Narrower than what Docker accepts in a volume name (`_` and `.` are legal
 * there) because the id also becomes the compose project name, where `.` is
 * not — and because `devc init` validates what the user types against this
 * while `devc initialize` derives a fallback from the directory: one charset
 * keeps the two agreeing about the same directory.
 */
export const PROJECT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export function isValidProjectId(value: string): boolean {
	return PROJECT_ID_PATTERN.test(value)
}

/**
 * Default `DC_PROJECT` when `.env` does not set one.
 *
 * @remarks
 * The bash script hardcoded `symptems` here (and `{{PROJECT_ID}}` in the
 * template copies) — one project's name baked into what is about to become a
 * public npm package, feeding both the Docker credentials volume name and the
 * base image tag. The directory name is the obvious non-leaky default, and it
 * is what `install.sh` prompted the user for anyway.
 *
 * Sanitised to {@link PROJECT_ID_PATTERN}: lowercase alphanumerics and `-`,
 * never leading or trailing with a separator.
 */
export function defaultProjectId(projectDir: string): string {
	const sanitised = basename(projectDir)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return sanitised.length > 0 ? sanitised : 'devcontainer'
}

/** `my-app` → `My App` — install.sh's `titlecase`, the display-name default. */
export function titlecase(projectId: string): string {
	return projectId
		.split('-')
		.filter((word) => word.length > 0)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ')
}

/** Render `path` relative to `base` for log lines, mirroring `${p#$DIR/}`. */
export function relativeTo(base: string, path: string): string {
	const prefix = base.endsWith('/') ? base : `${base}/`
	return path.startsWith(prefix) ? path.slice(prefix.length) : path
}
