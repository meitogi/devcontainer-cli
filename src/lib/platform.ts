// Host-OS identity and POSIX <-> native path translation.
//
// Ports initialize.sh:14-55 and 67-77. This is the one piece of the stack that
// genuinely can only run on the host: from inside the container the kernel
// only reveals the hypervisor (`…-linuxkit` = Docker Desktop VM,
// `…-microsoft` = WSL2), never the OS driving it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runCapture } from './proc.js'

/**
 * `mac` and `linux` are the historical targets. `wsl` and `gitbash` are the
 * two Windows shims. `cygwin` and `unknown` are unsupported and abort early
 * with one actionable line, rather than failing later with a cryptic
 * command-not-found.
 */
export type HostKind = 'mac' | 'linux' | 'wsl' | 'gitbash' | 'cygwin' | 'unknown'

export const SUPPORTED_HOST_KINDS: readonly HostKind[] = ['mac', 'linux', 'wsl', 'gitbash']

/** Everything {@link detectHostKind} reads, injected so it is testable. */
export interface HostProbe {
	/** `uname -s` equivalent. Node reports `darwin` / `linux` / `win32`. */
	platform: NodeJS.Platform
	env: NodeJS.ProcessEnv
	/** Contents of `/proc/version`, or `null` when unreadable. */
	procVersion: string | null
}

export function readHostProbe(): HostProbe {
	let procVersion: string | null = null
	try {
		procVersion = readFileSync('/proc/version', 'utf8')
	} catch {
		procVersion = null
	}
	return { platform: process.platform, env: process.env, procVersion }
}

/**
 * Classify the host.
 *
 * @remarks
 * Bash switched on `uname -s`, which distinguishes `MINGW*` / `MSYS*` (Git
 * Bash) from `CYGWIN*` for free. Node reports `win32` for all three, so the
 * MSYSTEM environment variable — set by every MSYS2-derived shell — carries
 * that distinction instead. A native `cmd.exe` / PowerShell host sets none of
 * them and lands on `unknown`, which is correct: initialize needs a POSIX
 * shell environment for `wslpath`/`cygpath` and for the firewall tooling.
 */
export function detectHostKind(probe: HostProbe): HostKind {
	if (probe.platform === 'darwin') return 'mac'
	if (probe.platform === 'linux') {
		const inWsl =
			Boolean(probe.env['WSL_DISTRO_NAME']) ||
			Boolean(probe.env['WSL_INTEROP']) ||
			(probe.procVersion !== null && /microsoft/i.test(probe.procVersion))
		return inWsl ? 'wsl' : 'linux'
	}
	if (probe.platform === 'win32') {
		const msystem = probe.env['MSYSTEM'] ?? ''
		if (/^MINGW|^MSYS/i.test(msystem)) return 'gitbash'
		// Best-effort only: MSYSTEM is an MSYS2 variable, and real Cygwin sets
		// neither it nor a bare CYGWIN in every configuration. A Cygwin host may
		// therefore land on `unknown` instead — which costs nothing beyond the
		// name in the refusal message, since isSupported() rejects both.
		if (/^CYGWIN/i.test(msystem) || Boolean(probe.env['CYGWIN'])) return 'cygwin'
		return 'unknown'
	}
	return 'unknown'
}

export function isSupported(kind: HostKind): boolean {
	return SUPPORTED_HOST_KINDS.includes(kind)
}

/**
 * Whether the CLI is running on native Windows outside any POSIX shim.
 *
 * Design §7 "Cross-platform Windows" asks for a warning in exactly this case;
 * WSL2 is the supported route, mirroring VS Code Remote-WSL.
 */
export function isBareWin32(probe: HostProbe): boolean {
	return probe.platform === 'win32' && detectHostKind(probe) === 'unknown'
}

/**
 * POSIX path -> host-native path.
 *
 * Docker Desktop on Windows labels containers with Windows-format paths
 * (`C:\foo\bar`) while bash holds them POSIX-style (`/mnt/c/foo/bar` under
 * WSL, `/c/foo/bar` under Git Bash). Without this translation the
 * `docker ps --filter label=…` probe never matches what the daemon wrote and
 * the CLI over-rebuilds on every reopen.
 *
 * Identity on mac and native Linux, so this is a no-op on the historical
 * paths. Falls back to the input when the translator is missing or fails —
 * a wrong-but-POSIX path degrades to the pre-existing behaviour, whereas
 * throwing would break initialize on a host where docker itself works fine.
 */
export function toHostPath(kind: HostKind, posixPath: string): string {
	const translator = kind === 'wsl' ? 'wslpath' : kind === 'gitbash' ? 'cygpath' : null
	if (translator === null) return posixPath
	const result = runCapture([translator, '-w', posixPath])
	if (result === null || result.trim().length === 0) return posixPath
	return result.trim()
}

/**
 * Record the host OS for the container to read back (initialize.sh:69-77).
 *
 * @remarks
 * The bash comment credits `scripts/install-cross-arch-natives.mjs` as the
 * reader. That file does not exist anywhere in this repo — the comment has
 * gone stale. The side effect has NOT: `claude/scripts/cdp.mjs` resolves
 * `../../logs/host-os` and reads it. Kept verbatim.
 *
 * `tmp/logs/` is gitignored, so this stays machine-local.
 */
export function writeHostOs(devcontainerDir: string, kind: HostKind): string {
	const target = join(devcontainerDir, 'tmp', 'logs', 'host-os')
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, `${kind}\n`, 'utf8')
	return target
}

/** True when `path` already exists — small helper so callers avoid importing fs. */
export function exists(path: string): boolean {
	return existsSync(path)
}
