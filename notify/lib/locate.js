// =============================================================================
// locate — resolve the tmp/notify directory from the launch context
// =============================================================================
//
// The daemon is meant to be launched from one of three contexts :
//   - a project root (cwd contains `.devcontainer/`)            → most common, via initialize.sh
//   - inside `.devcontainer/`                                   → manual debug from the host shell
//   - with an explicit path passed as argv[2]                   → ad-hoc test runs
//
// Anywhere else, we throw with a clear message instead of guessing —
// silently picking a wrong queue dir would split events across two
// daemons watching different files. Loud failure is the right tradeoff.
// =============================================================================

const fs   = require('fs')
const path = require('path')

/**
 * Resolve the queue dir from the launch context. See file header for the
 * three supported rules (explicit argv override, cwd inside .devcontainer,
 * cwd at a project root containing .devcontainer/). Anywhere else, throws
 * with an actionable message rather than guessing — picking a wrong queue
 * dir would split events across two daemons watching different files.
 *
 * @param {string} [argvQueue]   optional explicit override (typically process.argv[2])
 * @param {string} [cwd]         directory to inspect, defaults to process.cwd()
 * @returns {string}             absolute path to the resolved queue dir
 * @throws {Error}               when none of the three rules match the cwd
 */
function locateQueueDir(argvQueue, cwd = process.cwd()) {
	if (argvQueue) return path.resolve(argvQueue)

	if (path.basename(cwd) === '.devcontainer') {
		return path.join(cwd, 'tmp', 'notify')
	}

	try {
		if (fs.statSync(path.join(cwd, '.devcontainer')).isDirectory()) {
			return path.join(cwd, '.devcontainer', 'tmp', 'notify')
		}
	} catch (_) { /* not a project root */ }

	throw new Error(
		`cannot auto-locate tmp/notify from cwd=${cwd}. ` +
		`Run from a project root (containing .devcontainer/) or from inside .devcontainer/, ` +
		`or pass the queue dir explicitly: node index.js <queueDir>`
	)
}

/**
 * Read the canonical project name from .devcontainer/devcontainer.json's
 * `name` field. Returns everything before the first em/en/hyphen dash,
 * trimmed. devcontainer.json is JSONC (allows // comments), so we regex-
 * match the field directly rather than JSON.parse — avoids pulling in a
 * JSONC dependency for one field. Falls back to the projectDir basename
 * if the file is missing, malformed, or the field is absent.
 *
 * @param {string} projectDir   absolute path to the project root
 * @returns {string}            project display name (dash-suffix-stripped, trimmed)
 */
function readProjectName(projectDir) {
	try {
		const txt = fs.readFileSync(path.join(projectDir, '.devcontainer', 'devcontainer.json'), 'utf8')
		const m = txt.match(/"name"\s*:\s*"([^"]+)"/)
		if (m && m[1]) return m[1].split(/\s*[—–-]\s*/)[0].trim()
	} catch (_) {}
	return path.basename(projectDir)
}

module.exports = { locateQueueDir, readProjectName }
