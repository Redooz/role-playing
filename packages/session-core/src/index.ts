/**
 * `@rp/session-core` — the versioned event, grant, and trace model (M0 D2).
 *
 * Types and runtime validation only: no engine behavior lives here yet. Both
 * the future engine and `tools/eval-runner` import this package so a trace
 * cannot be valid for one and invalid for the other.
 */

export * from './events.js'
export * from './guards.js'
export * from './trace.js'
export * from './version.js'
