// The package's own version and root, read once from package.json.
//
// One source of truth: the version shows up in `--help`, in the devDependency
// range the scaffold writes, and in the `npx …@<major>.x` initializeCommand.
// A second copy typed into a constant is the kind of thing that drifts on the
// first release.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Absolute path of the package root (the directory holding package.json). */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const manifest = JSON.parse(readFileSync(new URL('package.json', `file://${PACKAGE_ROOT}`), 'utf8')) as {
	name: string
	version: string
}

export const CLI_NAME: string = manifest.name
export const CLI_VERSION: string = manifest.version

/** `0.x` for a 0.y.z package, `1.x` for 1.y.z — the range the scaffold pins npx to. */
export function majorRange(version: string = CLI_VERSION): string {
	return `${version.split('.')[0] ?? '0'}.x`
}
