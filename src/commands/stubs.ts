// Registered-but-unimplemented commands.
//
// They exist so the dispatcher, `--help` and the exit codes are exercised from
// day one, and so someone reaching for a documented command gets told it is not
// built rather than "unknown command". Every other command in the design's
// table is genuinely absent rather than stubbed.
//
// `devc knowledge *` and `devc lessons *` are not here and will not be: dropped
// as YAGNI for v1, since those files are edited directly.

export interface StubCommand {
	name: string
	summary: string
}

export const STUB_COMMANDS: readonly StubCommand[] = [
	{ name: 'update', summary: 'Bump base + Claude Code versions' },
	{ name: 'doctor', summary: 'Diagnose versions, config and warnings' },
]

/**
 * Non-zero: the command was recognised, but it did not do anything.
 *
 * The message deliberately names no schedule. An earlier version pointed at
 * internal rollout sessions, which means nothing to someone who installed this
 * from npm — and went stale the moment those sessions were reordered.
 */
export function runStub(stub: StubCommand): number {
	process.stderr.write(`devc ${stub.name}: not implemented in this version.\n`)
	return 1
}
