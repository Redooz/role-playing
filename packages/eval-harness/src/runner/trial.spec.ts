import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { taskEntrySchema } from '../tasks/schema.js'
import type { CompletionProvider } from './canned-provider.js'
import {
  createTrialEnvironment,
  deriveTrialSeed,
  settleWithin,
  snapshotEnvironment,
  TrialTimeoutError,
  withTrialTimeout,
} from './trial.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const taskPath = join(
  repoRoot,
  'evals/tasks/synthetic-workplace/v1/en/en-b1-report-deadline-001.json',
)
const task = taskEntrySchema.parse(JSON.parse(readFileSync(taskPath, 'utf8')) as unknown)

function testProvider(label = 'test'): CompletionProvider {
  return {
    kind: 'canned',
    label,
    complete() {
      return (async function* () {
        yield { text: 'ok', done: true }
      })()
    },
  }
}

describe('per-trial isolation', () => {
  it('derives a stable seed that depends only on the trial identity', () => {
    const first = deriveTrialSeed(42, 0, 'en', 'task-a')
    const again = deriveTrialSeed(42, 0, 'en', 'task-a')

    expect(first).toBe(again)
    expect(Number.isInteger(first)).toBe(true)
    expect(first).toBeGreaterThanOrEqual(0)

    const seeds = new Set([
      first,
      deriveTrialSeed(42, 1, 'en', 'task-a'),
      deriveTrialSeed(42, 0, 'fr', 'task-a'),
      deriveTrialSeed(42, 0, 'en', 'task-b'),
      deriveTrialSeed(43, 0, 'en', 'task-a'),
    ])
    expect(seeds.size).toBe(5)
  })

  it('gives each trial its own clock, RNG, provider and task copy', () => {
    const first = createTrialEnvironment({
      masterSeed: 42,
      round: 0,
      task,
      providerFactory: () => testProvider(),
    })
    const second = createTrialEnvironment({
      masterSeed: 42,
      round: 0,
      task,
      providerFactory: () => testProvider(),
    })
    const nextRound = createTrialEnvironment({
      masterSeed: 42,
      round: 1,
      task,
      providerFactory: () => testProvider(),
    })

    expect(first.clock).not.toBe(second.clock)
    expect(first.clock.now()).toBe(0)
    expect(second.clock.now()).toBe(0)
    expect(first.random).not.toBe(second.random)
    expect(first.provider).not.toBe(second.provider)
    expect(first.task).not.toBe(task)
    expect(first.task).toEqual(task)
    expect(first.trialId).toBe(`0:${task.lang}:${task.id}`)
    expect(first.seed).toBe(deriveTrialSeed(42, 0, task.lang, task.id))
    expect(second.seed).toBe(first.seed)
    expect(nextRound.seed).not.toBe(first.seed)
  })

  it('calls the provider factory exactly once and disposes that provider', async () => {
    const dispose = vi.fn()
    let calls = 0

    const environment = createTrialEnvironment({
      masterSeed: 42,
      round: 0,
      task,
      providerFactory: () => {
        calls += 1
        return { ...testProvider(), dispose }
      },
    })

    expect(calls).toBe(1)
    await environment.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes a provider at most once', async () => {
    const dispose = vi.fn()

    const environment = createTrialEnvironment({
      masterSeed: 42,
      round: 0,
      task,
      providerFactory: () => ({ ...testProvider(), dispose }),
    })

    await environment.dispose()
    await environment.dispose()

    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('aborts the trial signal when the budget expires', async () => {
    let signal: AbortSignal | undefined

    await expect(
      withTrialTimeout({ trialId: 'trial-1', timeoutMs: 10 }, async (trialSignal) => {
        signal = trialSignal
        await new Promise<void>((resolve) => {
          if (trialSignal.aborted) {
            resolve()
            return
          }
          trialSignal.addEventListener('abort', () => resolve(), { once: true })
        })
      }),
    ).rejects.toBeInstanceOf(TrialTimeoutError)

    expect(signal?.aborted).toBe(true)
  })

  it('waits a bounded grace window for work that ignores the abort signal', async () => {
    const startedAt = Date.now()
    let error: unknown

    try {
      await withTrialTimeout(
        { trialId: 'trial-2', timeoutMs: 20 },
        () => new Promise(() => undefined),
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(TrialTimeoutError)
    expect((error as TrialTimeoutError).stopped).toBe(false)
    expect((error as Error).message).toMatch(/did not stop/)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('reports a stopped timeout when the work settles after the abort', async () => {
    let error: unknown

    try {
      await withTrialTimeout({ trialId: 'trial-3', timeoutMs: 20 }, async (trialSignal) => {
        await new Promise<void>((resolve) => {
          trialSignal.addEventListener('abort', () => resolve(), { once: true })
        })
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(TrialTimeoutError)
    expect((error as TrialTimeoutError).stopped).toBe(true)
  })

  it('gives abandoned work its full remaining grace window', async () => {
    let error: unknown

    try {
      await withTrialTimeout({ trialId: 'trial-grace', timeoutMs: 400 }, async (trialSignal) => {
        await new Promise<void>((resolve) => {
          trialSignal.addEventListener('abort', () => setTimeout(resolve, 50), { once: true })
        })
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(TrialTimeoutError)
    expect((error as TrialTimeoutError).stopped).toBe(true)
    expect((error as TrialTimeoutError).message).toMatch(/is stalled/u)
  })

  it('bounds cleanup that never settles', async () => {
    const startedAt = Date.now()

    await expect(settleWithin(new Promise(() => undefined), 10, 'cleanup hung')).rejects.toThrow(
      'cleanup hung',
    )
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})

describe('trial seed derivation guards', () => {
  it('rejects a master seed that is negative or not an integer', () => {
    expect(() => deriveTrialSeed(-1, 0, 'en', 'task-a')).toThrow(
      new TypeError('masterSeed must be a non-negative integer: -1'),
    )
    expect(() => deriveTrialSeed(1.5, 0, 'en', 'task-a')).toThrow(
      new TypeError('masterSeed must be a non-negative integer: 1.5'),
    )
  })

  it('accepts a master seed of zero', () => {
    expect(Number.isInteger(deriveTrialSeed(0, 0, 'en', 'task-a'))).toBe(true)
  })

  it('rejects a round that is negative or not an integer', () => {
    expect(() => deriveTrialSeed(42, -1, 'en', 'task-a')).toThrow(
      new TypeError('round must be a non-negative integer: -1'),
    )
    expect(() => deriveTrialSeed(42, 2.5, 'en', 'task-a')).toThrow(
      new TypeError('round must be a non-negative integer: 2.5'),
    )
  })

  it('derives a seed from the first 32 bits only', () => {
    const seed = deriveTrialSeed(42, 7, 'fr', 'task-a')

    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThanOrEqual(0)
    expect(seed).toBeLessThan(2 ** 32)
  })

  it('separates seed fields so concatenated identities cannot collide', () => {
    expect(deriveTrialSeed(1, 23, 'en', 'task-a')).not.toBe(deriveTrialSeed(12, 3, 'en', 'task-a'))
  })
})

describe('trial environment validation', () => {
  it('defaults the trial budget to 30 seconds', () => {
    const environment = createTrialEnvironment({
      masterSeed: 42,
      round: 0,
      task,
      providerFactory: () => testProvider(),
    })

    expect(environment.timeoutMs).toBe(30_000)
  })

  it('accepts the smallest positive budget', () => {
    const environment = createTrialEnvironment({
      masterSeed: 42,
      round: 0,
      task,
      providerFactory: () => testProvider(),
      timeoutMs: 1,
    })

    expect(environment.timeoutMs).toBe(1)
  })

  it.each([0, -1, 1.5])('rejects a timeout of %s', (timeoutMs) => {
    expect(() =>
      createTrialEnvironment({
        masterSeed: 42,
        round: 0,
        task,
        providerFactory: () => testProvider(),
        timeoutMs,
      }),
    ).toThrow(new TypeError(`timeoutMs must be a positive integer: ${timeoutMs}`))
  })
})

describe('TrialTimeoutError', () => {
  it('defaults to a clean, stopped timeout and names itself', () => {
    const error = new TrialTimeoutError('1:en:task-a', 250)

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TrialTimeoutError')
    expect(error.trialId).toBe('1:en:task-a')
    expect(error.timeoutMs).toBe(250)
    expect(error.stopped).toBe(true)
    expect(error.message).toBe(
      'trial 1:en:task-a exceeded its 250 ms timeout; the provider or stream is stalled',
    )
  })

  it('reports an abandoned trial that ignored the abort signal', () => {
    const error = new TrialTimeoutError('trial-9', 30_000, false)

    expect(error.stopped).toBe(false)
    expect(error.message).toBe(
      'trial trial-9 exceeded its 30000 ms timeout and did not stop within the grace window; treating the trial as an infrastructure failure',
    )
  })
})

describe('withTrialTimeout and settleWithin edges', () => {
  it('rethrows a work failure unchanged when it is not a timeout', async () => {
    const boom = new RangeError('stream exploded')

    await expect(
      withTrialTimeout({ trialId: 'trial-4', timeoutMs: 5_000 }, () => Promise.reject(boom)),
    ).rejects.toBe(boom)
  })

  it('returns the work value when it settles inside the budget', async () => {
    await expect(
      withTrialTimeout({ trialId: 'trial-5', timeoutMs: 5_000 }, () => Promise.resolve('done')),
    ).resolves.toBe('done')
  })

  it('clears its budget timer after the race settles', async () => {
    vi.useFakeTimers()
    try {
      await withTrialTimeout({ trialId: 'trial-6', timeoutMs: 5_000 }, () =>
        Promise.resolve('done'),
      )
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears its cleanup timer after the promise settles', async () => {
    vi.useFakeTimers()
    try {
      await settleWithin(Promise.resolve('cleaned'), 5_000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the default message when cleanup does not settle', async () => {
    await expect(settleWithin(new Promise(() => undefined), 10)).rejects.toThrow(
      new Error('operation did not settle within 10 ms'),
    )
  })

  it('swallows a rejection that arrives after the timeout already won', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', listener)

    try {
      await expect(
        withTrialTimeout(
          { trialId: 'trial-7', timeoutMs: 20 },
          () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error('late provider boom')), 400)
            }),
        ),
      ).rejects.toBeInstanceOf(TrialTimeoutError)

      await new Promise((resolve) => setTimeout(resolve, 430))
      expect(unhandled).toStrictEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('swallows a cleanup rejection that arrives after the cleanup timeout', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', listener)

    try {
      await expect(
        settleWithin(
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('late cleanup boom')), 400)
          }),
          20,
        ),
      ).rejects.toThrow('operation did not settle within 20 ms')

      await new Promise((resolve) => setTimeout(resolve, 430))
      expect(unhandled).toStrictEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })
})

describe('snapshotEnvironment', () => {
  it('removes added keys and restores changed and removed values', () => {
    const source: NodeJS.ProcessEnv = { KEEP: 'keep', CHANGE: 'before', DROP: 'present' }
    const snapshot = snapshotEnvironment(source)

    source['CHANGE'] = 'after'
    source['ADDED'] = 'leaked'
    delete source['DROP']

    snapshot.restore()

    expect(source).toStrictEqual({ KEEP: 'keep', CHANGE: 'before', DROP: 'present' })
  })

  it('restores a key whose snapshot value is undefined by deleting it', () => {
    const source: NodeJS.ProcessEnv = { EMPTY: undefined, KEPT: 'value' }
    const snapshot = snapshotEnvironment(source)

    source['EMPTY'] = 'filled'
    snapshot.restore()

    expect(Object.hasOwn(source, 'EMPTY')).toBe(false)
    expect(source['KEPT']).toBe('value')
  })
})
