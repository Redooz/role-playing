import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { taskEntrySchema } from '../tasks/schema.js'
import type { CompletionProvider } from './canned-provider.js'
import { createTrialEnvironment, deriveTrialSeed } from './trial.js'

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
})
