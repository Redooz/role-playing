import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { taskEntrySchema, type TaskEntry } from '../tasks/schema.js'
import type { CompletionChunk, CompletionProvider } from './canned-provider.js'
import { replayTask } from './replay.js'
import { executeRun } from './runner.js'
import { createTrialEnvironment, snapshotEnvironment } from './trial.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')
const taskPath = join(
  repoRoot,
  'evals/tasks/synthetic-workplace/v1/en/en-b1-report-deadline-001.json',
)

function loadManifestRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown as Record<string, unknown>
}

const task: TaskEntry = taskEntrySchema.parse(JSON.parse(readFileSync(taskPath, 'utf8')) as unknown)

const fixedWallClock = (): number => 1_700_000_000_000

interface ProviderState {
  requests: number
  disposeCalls: number
  disposed: boolean
}

interface TrackedProvider {
  readonly provider: CompletionProvider
  readonly state: ProviderState
}

/** A provider that holds a real timer, so teardown is observable. */
function trackedProvider(id: number, onComplete?: () => void): TrackedProvider {
  const state: ProviderState = { requests: 0, disposeCalls: 0, disposed: false }
  const timer = setInterval(() => undefined, 1_000)

  return {
    state,
    provider: {
      kind: 'canned',
      label: `tracked-${id}`,
      async *complete() {
        state.requests += 1
        onComplete?.()
        yield { text: 'ok', done: true }
      },
      async dispose() {
        state.disposeCalls += 1
        state.disposed = true
        clearInterval(timer)
      },
    },
  }
}

/** A provider whose stream never yields, so only the trial timeout can end it. */
function hangingProvider(id: number): TrackedProvider {
  const state: ProviderState = { requests: 0, disposeCalls: 0, disposed: false }
  const timer = setInterval(() => undefined, 1_000)
  let release: (() => void) | undefined

  return {
    state,
    provider: {
      kind: 'canned',
      label: `hanging-${id}`,
      complete() {
        state.requests += 1
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<CompletionChunk>> {
                return new Promise((resolve) => {
                  release = () => resolve({ done: true, value: undefined })
                })
              },
              return(): Promise<IteratorResult<CompletionChunk>> {
                release?.()
                return Promise.resolve({ done: true, value: undefined })
              },
            }
          },
        }
      },
      async dispose() {
        state.disposeCalls += 1
        state.disposed = true
        clearInterval(timer)
        release?.()
      },
    },
  }
}

function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length
}

function activeServers(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === 'TCPServerWrap' || resource === 'TCPSocketWrap').length
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('M1 trial isolation', () => {
  it('gives interleaved trials separate providers and tears each one down', async () => {
    const baselineTimeouts = activeTimeouts()
    const instances: TrackedProvider[] = []
    const environments = [0, 1, 2].map(() =>
      createTrialEnvironment({
        masterSeed: 42,
        round: 0,
        task,
        providerFactory: () => {
          const tracked = trackedProvider(instances.length)
          instances.push(tracked)
          return tracked.provider
        },
      }),
    )

    try {
      const results = await Promise.all(
        environments.map((environment) =>
          replayTask({
            runId: 'isolation',
            executionId: 'isolation-execution',
            task: environment.task,
            clock: environment.clock,
            provider: environment.provider,
            wallNow: fixedWallClock,
          }),
        ),
      )

      expect(results).toHaveLength(3)
      expect(new Set(environments.map((environment) => environment.provider)).size).toBe(3)
      expect(new Set(environments.map((environment) => environment.clock)).size).toBe(3)
      expect(instances.every((instance) => instance.state.requests > 0)).toBe(true)
      expect(instances.every((instance) => instance.state.disposeCalls === 0)).toBe(true)
    } finally {
      await Promise.all(environments.map((environment) => environment.dispose()))
    }

    expect(instances.every((instance) => instance.state.disposed)).toBe(true)
    expect(instances.every((instance) => instance.state.disposeCalls === 1)).toBe(true)
    await tick()
    expect(activeTimeouts()).toBeLessThanOrEqual(baselineTimeouts)
  })

  it('disposes every provider in a run and restores the environment after each trial', async () => {
    const key = 'RP_M1_TRIAL_SCRATCH'
    delete process.env[key]
    const instances: TrackedProvider[] = []

    const run = await executeRun({
      repoRoot,
      manifest: loadManifestRaw(),
      wallClock: fixedWallClock,
      trialTimeoutMs: 1_000,
      providerFactory: () => {
        const tracked = trackedProvider(instances.length, () => {
          process.env[key] = 'inside'
        })
        instances.push(tracked)
        return tracked.provider
      },
    })

    // The committed manifest runs 2 rounds over 6 tasks.
    expect(instances).toHaveLength(12)
    expect(instances.every((instance) => instance.state.disposed)).toBe(true)
    expect(instances.every((instance) => instance.state.disposeCalls === 1)).toBe(true)
    expect(process.env[key]).toBeUndefined()
    expect(run.result.trials.every((trial) => trial.ok)).toBe(true)
  })

  it('times out a stalled provider, disposes it, and records an infrastructure outage', async () => {
    const instances: TrackedProvider[] = []

    const run = await executeRun({
      repoRoot,
      manifest: loadManifestRaw(),
      wallClock: fixedWallClock,
      trialTimeoutMs: 20,
      providerFactory: () => {
        const tracked = hangingProvider(instances.length)
        instances.push(tracked)
        return tracked.provider
      },
    })

    expect(instances).toHaveLength(12)
    expect(instances.every((instance) => instance.state.disposed)).toBe(true)
    expect(run.result.trials).toHaveLength(12)
    expect(run.result.trials.every((trial) => !trial.ok)).toBe(true)
    expect(run.result.trials.every((trial) => trial.providerOutage)).toBe(true)
    expect(run.result.verdict.status).toBe('infrastructure_inconclusive')
  })

  it('does not leak an unhandled rejection from a timed-out trial', async () => {
    const rejections: unknown[] = []
    const listener = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', listener)

    try {
      await executeRun({
        repoRoot,
        manifest: loadManifestRaw(),
        wallClock: fixedWallClock,
        trialTimeoutMs: 10,
        providerFactory: () => hangingProvider(0).provider,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(rejections).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('releases a socket held by a trial provider', async () => {
    const baselineServers = activeServers()
    const servers: Server[] = []
    const environments = [0, 1].map(() =>
      createTrialEnvironment({
        masterSeed: 42,
        round: 0,
        task,
        providerFactory: () => {
          const server = createServer()
          servers.push(server)
          server.listen(0, '127.0.0.1')

          return {
            kind: 'canned',
            label: `socket-${servers.length}`,
            async *complete() {
              yield { text: 'ok', done: true }
            },
            dispose() {
              return new Promise<void>((resolve, reject) => {
                server.close((error) => {
                  if (error === undefined) resolve()
                  else reject(error)
                })
              })
            },
          }
        },
      }),
    )

    try {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolveListening) => {
              if (server.listening) resolveListening()
              else server.once('listening', () => resolveListening())
            }),
        ),
      )
      await Promise.all(
        environments.map((environment) =>
          replayTask({
            runId: 'socket-isolation',
            executionId: 'socket-isolation-execution',
            task: environment.task,
            clock: environment.clock,
            provider: environment.provider,
            wallNow: fixedWallClock,
          }),
        ),
      )
    } finally {
      await Promise.all(environments.map((environment) => environment.dispose()))
    }

    expect(servers.every((server) => !server.listening)).toBe(true)
    await tick()
    expect(activeServers()).toBeLessThanOrEqual(baselineServers)
  })

  it('restores added and changed environment variables', () => {
    const key = 'RP_M1_SNAPSHOT_TEST'
    const added = 'RP_M1_SNAPSHOT_ADDED'
    const original = process.env[key]
    process.env[key] = 'before'
    delete process.env[added]

    const snapshot = snapshotEnvironment()
    process.env[key] = 'after'
    process.env[added] = 'leaked'
    snapshot.restore()

    expect(process.env[key]).toBe('before')
    expect(process.env[added]).toBeUndefined()

    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  })
})
