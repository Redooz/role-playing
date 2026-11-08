import { FakeClock, createSeededRandom, sha256Hex, type SeededRandom } from '@rp/shared'
import type { Lang, TaskEntry } from '../tasks/schema.js'
import type { CompletionProvider } from './canned-provider.js'

/**
 * Per-trial isolation (M0 D3 follow-up, M1 D7).
 *
 * A trial gets its own simulated clock, RNG stream, provider instance, copy of
 * the task, and (in the runner) a restored `process.env`. That is the isolation
 * this code provides; it is **not** a claim of full isolation. AGENTS.md lists
 * the still-open gaps: no per-trial process/worker/container boundary, no
 * external database reset, no per-trial filesystem workspace, no generic
 * network-mock or module-cache reset, and no live-provider teardown test against
 * a real socket.
 *
 * M1 adds the live half: a per-trial timeout for a hung provider or stalled
 * stream, a bounded grace window for the abandoned work to stop, disposal in the
 * runner's `finally`, and an environment snapshot restored after every trial.
 * The provider's `dispose()` releases sockets, timers and other per-trial
 * resources; the harness proves it is called on success, failure and timeout.
 */

const DEFAULT_TRIAL_TIMEOUT_MS = 30_000
/** How long abandoned work gets to stop before cleanup is declared failed. */
const DEFAULT_STOP_GRACE_MS = 1_000

/**
 * Thrown when one trial exceeds its budget; the provider or stream is stalled.
 * `stopped` is false when the work ignored the abort signal and was still running
 * when the grace window expired, which makes the trial an infrastructure failure
 * rather than a clean timeout.
 */
export class TrialTimeoutError extends Error {
  readonly trialId: string
  readonly timeoutMs: number
  readonly stopped: boolean

  constructor(trialId: string, timeoutMs: number, stopped = true) {
    super(
      stopped
        ? `trial ${trialId} exceeded its ${timeoutMs} ms timeout; the provider or stream is stalled`
        : `trial ${trialId} exceeded its ${timeoutMs} ms timeout and did not stop within the grace window; treating the trial as an infrastructure failure`,
    )
    this.name = 'TrialTimeoutError'
    this.trialId = trialId
    this.timeoutMs = timeoutMs
    this.stopped = stopped
  }
}

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
  /** Wall-clock budget for the trial. */
  readonly timeoutMs: number
  dispose(): Promise<void>
}

export interface CreateTrialEnvironmentOptions {
  /** The manifest's master seed. Each trial derives its own stream from it. */
  readonly masterSeed: number
  /** Zero-based round number. */
  readonly round: number
  readonly task: TaskEntry
  readonly providerFactory: ProviderFactory
  /** Trial budget. Defaults to 30 seconds. */
  readonly timeoutMs?: number
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError(`timeoutMs must be a positive integer: ${timeoutMs}`)
  }

  const seed = deriveTrialSeed(masterSeed, round, task.lang, task.id)
  const trialTask = structuredClone(task)
  const provider = providerFactory()
  let disposed = false

  return {
    trialId: `${round}:${task.lang}:${task.id}`,
    seed,
    clock: new FakeClock(0),
    random: createSeededRandom(seed),
    provider,
    task: trialTask,
    timeoutMs,
    async dispose() {
      if (disposed) return
      disposed = true
      await provider.dispose?.()
    },
  }
}

/**
 * Race one trial's work against its wall-clock budget.
 *
 * On timeout the controller is aborted so the provider and replay loop can stop.
 * Before rejecting, the abandoned work gets a bounded grace window: if it is
 * still running when that expires, the error says so and the runner records an
 * infrastructure failure. Waiting here matters because the runner restores the
 * environment snapshot and disposes the provider immediately afterwards.
 *
 * A late rejection is attached to `workPromise` so it never becomes an unhandled
 * rejection. The caller still disposes the environment in `finally`.
 */
export async function withTrialTimeout<T>(
  trial: Pick<TrialEnvironment, 'trialId' | 'timeoutMs'>,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const workPromise = work(controller.signal)
  // A request that times out may settle after the caller has moved on.
  workPromise.catch(() => undefined)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new TrialTimeoutError(trial.trialId, trial.timeoutMs))
    }, trial.timeoutMs)
  })

  try {
    return await Promise.race([workPromise, timeout])
  } catch (error) {
    if (error instanceof TrialTimeoutError) {
      const graceMs = Math.max(1, Math.min(DEFAULT_STOP_GRACE_MS, trial.timeoutMs))
      // `then` maps both fulfilment and rejection to "settled"; only the grace
      // timer rejects, so the boolean really means "stopped".
      const stopped = await settleWithin(
        workPromise.then(
          () => true as const,
          () => true as const,
        ),
        graceMs,
      ).then(
        () => true,
        () => false,
      )
      throw new TrialTimeoutError(trial.trialId, trial.timeoutMs, stopped)
    }
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Wait for a promise, but never longer than `ms`. Rejects when the limit is
 * reached. Used for cleanup that must not re-introduce a hang.
 */
export async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
  message = `operation did not settle within ${ms} ms`,
): Promise<T> {
  promise.catch(() => undefined)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Snapshot the process environment so a trial cannot leak variables into the
 * next one. Restoring removes keys a trial added and resets changed values.
 */
export interface EnvironmentSnapshot {
  restore(): void
}

export function snapshotEnvironment(source: NodeJS.ProcessEnv = process.env): EnvironmentSnapshot {
  const snapshot = { ...source }

  return {
    restore() {
      for (const key of Object.keys(source)) {
        if (!Object.hasOwn(snapshot, key)) delete source[key]
      }
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) delete source[key]
        else source[key] = value
      }
    },
  }
}
