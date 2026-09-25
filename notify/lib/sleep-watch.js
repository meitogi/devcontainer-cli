// =============================================================================
// sleep-watch — wake detection via wall-clock drift heuristic
// =============================================================================
//
// macOS / Linux / Windows tous gèlent les process Node pendant le sleep système
// (libuv timers en pause). Au wake, le prochain tick d'un setInterval fire
// immédiatement et Date.now() montre un saut bien plus grand que la période
// nominale. Ce module exploite ce comportement : un setInterval(_, 1000) qui
// compare le delta réel au delta attendu — si la dérive dépasse thresholdMs,
// c'est un wake.
//
// Émet 'system:wake' sur le bus partagé avec `{ gapMs }`. Consommé par
// lib/docker-watch.js, qui suspend container:gone pendant 30 s pour laisser
// Docker Desktop reprendre ses esprits sans déclencher un faux exit.
//
// PAS de pre-sleep detection — le process est gelé avant qu'on puisse réagir.
// Ça nécessiterait un binding natif (node-mac-power-monitor / IOKit) qu'on
// évite ici pour rester zéro-dep.
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
