// =============================================================================
// sleep-watch — wake detection via wall-clock drift heuristic
// =============================================================================
//
// macOS / Linux / Windows all freeze Node processes during system sleep
// (libuv timers paused). On wake, a setInterval's next tick fires
// immediately and Date.now() shows a jump far larger than the nominal
// period. This module exploits that behaviour : a setInterval(_, 1000) that
// compares the real delta to the expected one — if the drift exceeds
// thresholdMs, it is a wake.
//
// Emits 'system:wake' on the shared bus with `{ gapMs }`. Consumed by
// lib/docker-watch.js, which suspends container:gone for 30 s to let
// Docker Desktop come back to its senses without triggering a false exit.
//
// NO pre-sleep detection — the process is frozen before we can react.
// That would require a native binding (node-mac-power-monitor / IOKit) which
// we avoid here to stay zero-dep.
// =============================================================================

const log = require('./log')

// -----------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// -----------------------------------------------------------------------------

/**
 * Start the wall-clock drift watcher. Schedules a low-cost tick (default
 * every 1 s) and emits 'system:wake' on the bus the first time the actual
 * delta between two ticks exceeds `thresholdMs`. The interval handle is
 * unref'd so it doesn't keep the event loop alive after shutdown.
 *
 * @param {object} opts
 * @param {import('events').EventEmitter} opts.bus           emit target for 'system:wake'
 * @param {number} [opts.tickMs=1000]                        nominal tick period
 * @param {number} [opts.thresholdMs=5000]                   drift above which we declare a wake
 * @returns {void}                                           schedules the tick, returns immediately
 */
function start({ bus, tickMs = 1000, thresholdMs = 5000 }) {
	let last = Date.now()
	const tick = () => {
		const now = Date.now()
		const drift = now - last
		last = now
		if (drift >= thresholdMs) {
			log.info(`[sleep-watch] wake detected — drift=${drift}ms`)
			bus.emit('system:wake', { gapMs: drift })
		}
	}
	const handle = setInterval(tick, tickMs)
	handle.unref?.()
	log.info(`[sleep-watch] drift watcher active — tick=${tickMs}ms threshold=${thresholdMs}ms`)
}

module.exports = { start }
