/**
 * Simulated-time eval runner (M0 D3/D6).
 *
 * Public surface: manifest validation and hashing, the pure verdict function,
 * the provider port with its canned implementation, the deterministic replay
 * harness, the result schema, baseline comparison and the run executor.
 *
 * Scoring is an injected port (`RunScorer`) so the Jev client can plug in later
 * without changing the runner, verdict or artifact shape.
 */

export * from './manifest.js'
export * from './verdict.js'
export * from './canned-provider.js'
export * from './replay.js'
export * from './scorer.js'
export * from './results.js'
export * from './compare.js'
export * from './runner.js'
