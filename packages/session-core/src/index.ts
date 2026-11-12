/**
 * `@rp/session-core` — the versioned event, grant and transcript model (M0 D2),
 * the single-agent text session driver (M1 D1) and the multi-persona driver
 * (M3b D3).
 *
 * The model is shared by the driver, the eval harness and the future API so a
 * transcript cannot be valid for one and invalid for another. The driver is a
 * library port: consumers supply the clock and the model adapter.
 */

export * from './arbiter-port.js'
export * from './driver.js'
export * from './event-queue.js'
export * from './events.js'
export * from './guards.js'
export * from './model-port.js'
export * from './session-log.js'
export * from './transcript.js'
export * from './version.js'
