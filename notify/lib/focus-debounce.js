// =============================================================================
// focus-debounce — per-sid setTimeout for focus-aware banner delay
// =============================================================================
//
// Session 4 : when a queue event carries `line.focused === true` (host VS Code
// window is focused per the extension patch's `vscode.window.state` snapshot,
// see `.devcontainer/skills/notify-queue/hook.js::readLatestFocus`), the
// notify-app consumer arms a per-sid setTimeout instead of spawning `notif
// send` immediately. Two exit paths :
//
//   1. Timer expires without cancel → `onFire()` is invoked → banner fires
//      after the debounce delay. Matches the "delay N s, then remind" policy
//      confirmed during Phase 3.
//   2. `cancelDebounce(sid)` is called before the timer fires (via
//      `cancelled:notification` from the bus — user replied, tool finished,
//      Allow click) → `onFire` is never invoked, no banner fires.
//
// State is a module-level `Map<sid, timeout>`. A new arm on an existing sid
// clears the previous timer so identical events collapse to the latest arm
// (matches the "1 banner per sid" invariant enforced by the daemon).
//
// `NOTIFY_FOCUS_DEBOUNCE_MS` overrides the default 5000 ms delay. Setting it
// to 0 or negative disables the gate entirely (send() short-circuits and
// dispatches immediately), useful for tests and users who don't want the
// delay.
// =============================================================================

const DEFAULT_DEBOUNCE_MS = 5000
const MAX_DEBOUNCE_MS = 60 * 1000

const timers = new Map()

/**
 * Read `NOTIFY_FOCUS_DEBOUNCE_MS` from env with sane defaults + clamping.
 * A value of 0 (or any non-positive integer) disables the debounce entirely.
 *
 * @param {NodeJS.ProcessEnv} env    typically process.env
 * @returns {number}                 delay in ms, or 0 when the gate is off
 */
function getDebounceMs(env) {
	const raw = env && env.NOTIFY_FOCUS_DEBOUNCE_MS
	if (raw === undefined || raw === null || raw === '') return DEFAULT_DEBOUNCE_MS
	const n = Number(raw)
	if (!Number.isFinite(n)) return DEFAULT_DEBOUNCE_MS
	if (n <= 0) return 0
	if (n > MAX_DEBOUNCE_MS) return MAX_DEBOUNCE_MS
	return Math.floor(n)
}

/**
 * Arm a per-sid debounce timer. If a timer is already armed for this sid, it
 * is cleared and replaced ("latest wins") — the caller is expected to have
 * dropped or superseded the earlier event.
 *
 * @param {string} sid           session id
 * @param {number} ms            delay in ms
 * @param {() => void} onFire    invoked once when the timer expires
 * @returns {void}
 */
function armDebounce(sid, ms, onFire) {
	if (!sid || typeof onFire !== 'function') return
	cancelDebounce(sid)
	const timeout = setTimeout(() => {
		timers.delete(sid)
		try { onFire() } catch (_) { /* consumer logs its own errors */ }
	}, ms)
	timeout.unref?.()
	timers.set(sid, timeout)
}

/**
 * Cancel any pending debounce timer for a sid. Idempotent — no-op when no
 * timer is armed.
 *
 * @param {string} sid
 * @returns {boolean}   true when a timer was actually cleared, false otherwise
 */
function cancelDebounce(sid) {
	const timeout = timers.get(sid)
	if (!timeout) return false
	clearTimeout(timeout)
	timers.delete(sid)
	return true
}

module.exports = {
	getDebounceMs,
	armDebounce,
	cancelDebounce,
	DEFAULT_DEBOUNCE_MS,
	MAX_DEBOUNCE_MS,
	_test: { timers },
}
