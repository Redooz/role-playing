import { FakeClock, createSeededRandom, sha256Hex, type SeededRandom } from '@rp/shared'
import type { Lang, TaskEntry } from '../tasks/schema.js'
import type { CompletionProvider } from './canned-provider.js'

/**
 * Per-trial isolation (M0 D3 follow-up).
 *
 * Every trial gets its own simulated clock, RNG stream, provider instance and
 * copy of the task. Nothing a trial can mutate is shared with another trial.
 *
 * The harness still has no external environment at M0 (no database, workspace
 * or network), so this is the complete boundary the current replay needs. When
 * an agent harness or a live provider arrives, its per-trial resources are
 * created by the provider factory and released by `dispose()`.
 */

/** Builds a new provider for one trial. Must never return a shared instance. */
export type ProviderFactory = () => CompletionProvider

export interface TrialEnvironment {
  /** Stable identity for diagnostics: round, language and task id. */
  readonly trialId: string
  /** Derived from the master seed, so the same trial always uses the same stream. */
  readonly seed: number
  readonly clock: FakeClock
  readonly random: SeededRandom
  readonly provider: CompletionProvider
  /** A private copy; mutating it cannot affect another trial. */
  readonly task: TaskEntry
  dispose(): Promise<void>
}

export interface CreateTrialEnvironmentOptions {
  /** The manifest's master seed. Each trial derives its own stream from it. */
  readonly masterSeed: number
  /** Zero-based round number. */
  readonly round: number
  readonly task: TaskEntry
  readonly providerFactory: ProviderFactory
}

/**
 * Derive a trial seed without depending on trial order or earlier trials.
 *
 * Hashing the master seed with the round, language and task id means a trial
 * replayed alone uses the same stream as the same trial replayed after others.
 */
export function deriveTrialSeed(
  masterSeed: number,
  round: number,
  lang: Lang,
  taskId: string,
): number {
  if (!Number.isInteger(masterSeed) || masterSeed < 0) {
    throw new TypeError(`masterSeed must be a non-negative integer: ${masterSeed}`)
  }
  if (!Number.isInteger(round) || round < 0) {
    throw new TypeError(`round must be a non-negative integer: ${round}`)
  }

  const digest = sha256Hex([masterSeed, round, lang, taskId].join('\u0000'))
  return Number.parseInt(digest.slice(0, 8), 16)
}

/**
 * Create the clean environment for one trial.
 *
 * `task` is deep-copied and the provider factory is called exactly once, so a
 * caller cannot accidentally share mutable state between trials.
 */
export function createTrialEnvironment(options: CreateTrialEnvironmentOptions): TrialEnvironment {
  const { masterSeed, round, task, providerFactory } = options
  const seed = deriveTrialSeed(masterSeed, round, task.lang, task.id)
  const trialTask = structuredClone(task)
  const provider = providerFactory()

  return {
    trialId: `${round}:${task.lang}:${task.id}`,
    seed,
    clock: new FakeClock(0),
    random: createSeededRandom(seed),
    provider,
    task: trialTask,
    async dispose() {
      await provider.dispose?.()
    },
  }
}
