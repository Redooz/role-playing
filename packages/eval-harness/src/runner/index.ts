/**
 * Simulated-time evaluation harness (M0 D3/D6).
 *
 * Public surface: manifest validation and hashing, the pure verdict function,
 * the provider port with its canned implementation, the deterministic replay
 * path, the result schema, baseline comparison and the run executor.
 *
 * Grading is an injected port (`Grader`) so the Jev client can plug in later
 * without changing the harness, verdict or artifact shape.
 */

export * from './manifest.js'
export * from './verdict.js'
export * from './canned-provider.js'
export * from './text-model.adapter.js'
export * from './replay.js'
export * from './session-runner.js'
export * from './speech.js'
export * from './pass-k.js'
export * from './trial.js'
export * from './grader.js'
export * from './results.js'
export * from './compare.js'
export * from './runner.js'
