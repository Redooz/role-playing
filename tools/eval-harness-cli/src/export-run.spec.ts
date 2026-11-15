import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  LANGFUSE_ARTIFACT_SCHEMA_VERSION,
  buildGrades,
  executeRun,
  type EvaluationObserver,
  type EvaluationRun,
  type GradesArtifact,
  type ObservationPlan,
  type ObserverConfig,
  type ObserverFactory,
} from '@rp/eval-harness'
import { main, type CliIo } from './cli-main.js'
import { exportRun } from './export-run.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

const baseEnv: NodeJS.ProcessEnv = {
  LANGFUSE_ENABLED: 'true',
  LANGFUSE_BASE_URL: 'http://127.0.0.1:3000',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_PROJECT_ID: 'project-test',
}

const ENV_ENABLED = baseEnv
const ENV_DISABLED: NodeJS.ProcessEnv = { ...baseEnv, LANGFUSE_ENABLED: 'false' }

interface Capture {
  readonly io: CliIo
  readonly out: string[]
  readonly err: string[]
}

function captureIo(): Capture {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err }
}

function fakeObserver(received: ObservationPlan[] = []): ObserverFactory {
  return async (_config: ObserverConfig): Promise<EvaluationObserver> => ({
    async observe(plan) {
      received.push(plan)
      return {
        experimentId: plan.executionId,
        experimentUrl: `http://127.0.0.1:3000/project/project-test/experiments/${plan.executionId}`,
        traceIds: Object.fromEntries(
          plan.items.map((item) => [item.itemId, `trace-${item.itemId}`]),
        ),
      }
    },
    async shutdown() {},
  })
}

const roots: string[] = []

async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  observerFactory?: ObserverFactory,
): Promise<{ code: number; io: Capture; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rp-langfuse-'))
  roots.push(root)
  const io = captureIo()
  const code = await main(
    ['run', '--manifest', manifestPath, '--results-root', root, ...args],
    io.io,
    {
      repoRoot,
      wallClock: () => 1_700_000_000_000,
      env,
      ...(observerFactory === undefined ? {} : { observerFactory }),
    },
  )
  return { code, io, root }
}

async function readArtifact(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(root, 'm0-canned-replay', 'langfuse.json'), 'utf8'),
  ) as Record<string, unknown>
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Langfuse export in the eval CLI', () => {
  it('writes grades.jsonl and a disabled langfuse.json when export is off', async () => {
    const { code, io, root } = await runCli([], ENV_DISABLED)
    expect(code).toBe(0)

    const gradesPath = join(root, 'm0-canned-replay', 'grades.jsonl')
    const grades = (await readFile(gradesPath, 'utf8')).trimEnd().split('\n')
    expect(grades).toHaveLength(12)

    const artifact = await readArtifact(root)
    expect(artifact['status']).toBe('disabled')
    expect(artifact['traceIds']).toEqual({})
    expect(io.out.join('\n')).toContain('langfuse: export disabled')

    // Export being off must not change the strict result artifact.
    const result = JSON.parse(
      await readFile(join(root, 'm0-canned-replay', 'result.json'), 'utf8'),
    ) as { verdict: { status: string } }
    expect(result.verdict.status).toBe('accepted')
  })

  it('--no-export wins over LANGFUSE_ENABLED=true', async () => {
    const { code, root } = await runCli(['--no-export'], ENV_ENABLED, fakeObserver())
    expect(code).toBe(0)
    expect((await readArtifact(root))['status']).toBe('disabled')
  })

  it('exports 12 item traces and records every trace id', async () => {
    const plans: ObservationPlan[] = []
    const { code, io, root } = await runCli([], ENV_ENABLED, fakeObserver(plans))

    expect(code).toBe(0)
    expect(plans).toHaveLength(1)
    const plan = plans[0]
    expect(plan?.items).toHaveLength(12)
    expect(plan?.experiment.id).toBe(plan?.executionId)
    expect(plan?.executionId).not.toBe('m0-canned-replay')

    const artifact = await readArtifact(root)
    expect(artifact['status']).toBe('exported')
    expect(artifact['experimentId']).toBe(plan?.executionId)
    expect(Object.keys(artifact['traceIds'] as Record<string, string>)).toHaveLength(12)
    expect(io.out.join('\n')).toContain('exported 12 item trace(s)')
  })

  it('re-exports an existing run without executing the provider', async () => {
    const base = await runCli([], ENV_DISABLED)
    const plans: ObservationPlan[] = []
    const io = captureIo()

    const code = await main(['export-run', '--run', join(base.root, 'm0-canned-replay')], io.io, {
      repoRoot,
      env: ENV_ENABLED,
      observerFactory: fakeObserver(plans),
    })

    expect(code).toBe(0)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.items).toHaveLength(12)
    expect(io.out.join('\n')).toContain('exported 12 item trace(s)')

    const artifact = await readArtifact(base.root)
    expect(artifact['status']).toBe('exported')
    expect(Object.keys(artifact['traceIds'] as Record<string, string>)).toHaveLength(12)
  })

  it('can omit automated scores for blind labelling', async () => {
    const base = await runCli([], ENV_DISABLED)
    const plans: ObservationPlan[] = []
    const io = captureIo()

    const code = await main(
      ['export-run', '--run', join(base.root, 'm0-canned-replay'), '--no-scores'],
      io.io,
      {
        repoRoot,
        env: ENV_ENABLED,
        observerFactory: fakeObserver(plans),
      },
    )

    expect(code).toBe(0)
    expect(plans[0]?.items).toHaveLength(12)
    expect(plans[0]?.items.every((item) => item.scores.length === 0)).toBe(true)
  })

  it('keeps the verdict when the export fails', async () => {
    const failing: ObserverFactory = async () => {
      throw new Error('langfuse is unreachable')
    }
    const { code, io, root } = await runCli([], ENV_ENABLED, failing)

    expect(code).toBe(0)
    expect(io.err.join('\n')).toContain('langfuse: export failed')
    expect((await readArtifact(root))['status']).toBe('failed')

    const result = JSON.parse(
      await readFile(join(root, 'm0-canned-replay', 'result.json'), 'utf8'),
    ) as { verdict: { status: string } }
    expect(result.verdict.status).toBe('accepted')
  })

  it('exits 3 with --require-export after writing every artifact', async () => {
    const failing: ObserverFactory = async () => {
      throw new Error('langfuse is unreachable')
    }
    const { code, root } = await runCli(['--require-export'], ENV_ENABLED, failing)

    expect(code).toBe(3)
    expect((await readArtifact(root))['status']).toBe('failed')

    for (const file of ['result.json', 'grades.jsonl', 'manifest.json']) {
      const path = join(root, 'm0-canned-replay', file)
      await expect(stat(path)).resolves.toBeDefined()
    }
  })

  it('refuses Langfuse Cloud and writes a failed artifact', async () => {
    const { code, io, root } = await runCli(
      [],
      { ...ENV_ENABLED, LANGFUSE_BASE_URL: 'https://cloud.langfuse.com' },
      fakeObserver(),
    )

    expect(code).toBe(0)
    expect(io.err.join('\n')).toContain('self-hosted only')
    expect((await readArtifact(root))['status']).toBe('failed')
  })

  it('rejects --no-export combined with --require-export', async () => {
    const { code, io } = await runCli(
      ['--no-export', '--require-export'],
      ENV_ENABLED,
      fakeObserver(),
    )
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('cannot be combined')
  })
})

/**
 * Direct `exportRun` tests: an injected `EvaluationRun` and grades artifact let
 * each branch of the export step be exercised without a second model run, with
 * the observer always replaced by an injected factory (no socket is opened).
 */

const OBSERVER_ENV: NodeJS.ProcessEnv = {
  LANGFUSE_ENABLED: 'true',
  LANGFUSE_BASE_URL: 'http://127.0.0.1:3000',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
}

let fixtureRun: EvaluationRun
let fixtureGrades: GradesArtifact

beforeAll(async () => {
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  fixtureRun = await executeRun({
    repoRoot,
    manifest: raw,
    wallClock: () => 1_700_000_000_000,
  })
  fixtureGrades = buildGrades({ execution: fixtureRun })
})

interface ObserverCall {
  readonly config: ObserverConfig
  readonly plan: ObservationPlan
}

function scriptedObserver(
  calls: ObserverCall[],
  receipt: (plan: ObservationPlan) => {
    experimentId: string
    experimentUrl?: string
    traceIds: Record<string, string>
  },
  shutdown: () => Promise<void> = async () => {},
): ObserverFactory {
  return async (config) => ({
    async observe(plan) {
      calls.push({ config, plan })
      return receipt(plan)
    },
    shutdown,
  })
}

function fullReceipt(plan: ObservationPlan): {
  experimentId: string
  experimentUrl?: string
  traceIds: Record<string, string>
} {
  return {
    experimentId: plan.executionId,
    experimentUrl: `http://127.0.0.1:3000/project/project-test/experiments/${plan.executionId}`,
    traceIds: Object.fromEntries(plan.items.map((item) => [item.itemId, `trace-${item.itemId}`])),
  }
}

async function exportDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rp-langfuse-direct-'))
  roots.push(dir)
  return dir
}

describe('exportRun (direct)', () => {
  it('writes a disabled artifact and loads no adapter when export is off', async () => {
    const runDir = await exportDir()
    const io = captureIo()
    const factory = vi.fn<ObserverFactory>()

    const artifact = await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: io.io,
      env: {},
      observerFactory: factory,
      noExport: true,
      requireExport: false,
    })

    expect(factory).not.toHaveBeenCalled()
    expect(io.err).toStrictEqual([])
    expect(io.out).toStrictEqual([
      'langfuse: export disabled (set LANGFUSE_ENABLED=true to export)',
    ])
    expect(artifact).toStrictEqual({
      schemaVersion: LANGFUSE_ARTIFACT_SCHEMA_VERSION,
      status: 'disabled',
      executionId: fixtureGrades.executionId,
      runId: fixtureRun.result.runId,
      traceIds: {},
    })
    expect(await readFile(join(runDir, 'langfuse.json'), 'utf8')).toBe(
      `${JSON.stringify(artifact, null, 2)}\n`,
    )
  })

  it.each(['true', 'TRUE', ' true ', '1', 'yes', 'Yes'])(
    'treats LANGFUSE_ENABLED=%j as on',
    async (value) => {
      const runDir = await exportDir()
      const calls: ObserverCall[] = []

      const artifact = await exportRun({
        execution: fixtureRun,
        grades: fixtureGrades,
        runDir,
        repoRoot,
        io: captureIo().io,
        env: { ...OBSERVER_ENV, LANGFUSE_ENABLED: value },
        observerFactory: scriptedObserver(calls, fullReceipt),
        noExport: false,
        requireExport: false,
      })

      expect(calls).toHaveLength(1)
      expect(artifact.status).toBe('exported')
    },
  )

  it.each(['false', 'FALSE', '0', 'no', '', '  '])(
    'treats LANGFUSE_ENABLED=%j as off',
    async (value) => {
      const runDir = await exportDir()
      const calls: ObserverCall[] = []

      const artifact = await exportRun({
        execution: fixtureRun,
        grades: fixtureGrades,
        runDir,
        repoRoot,
        io: captureIo().io,
        env: { ...OBSERVER_ENV, LANGFUSE_ENABLED: value },
        observerFactory: scriptedObserver(calls, fullReceipt),
        noExport: false,
        requireExport: false,
      })

      expect(calls).toStrictEqual([])
      expect(artifact.status).toBe('disabled')
    },
  )

  it('honours --require-export even when LANGFUSE_ENABLED is unset', async () => {
    const runDir = await exportDir()
    const calls: ObserverCall[] = []

    const artifact = await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: captureIo().io,
      env: OBSERVER_ENV,
      observerFactory: scriptedObserver(calls, fullReceipt),
      noExport: false,
      requireExport: true,
    })

    expect(calls).toHaveLength(1)
    expect(artifact.status).toBe('exported')
  })

  it('passes a trimmed self-hosted configuration, project id included', async () => {
    const runDir = await exportDir()
    const calls: ObserverCall[] = []

    await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: captureIo().io,
      env: {
        LANGFUSE_ENABLED: 'true',
        LANGFUSE_BASE_URL: '  http://127.0.0.1:3000///  ',
        LANGFUSE_PUBLIC_KEY: '  pk-lf-test  ',
        LANGFUSE_SECRET_KEY: '  sk-lf-test  ',
        LANGFUSE_PROJECT_ID: '  project-test  ',
      },
      observerFactory: scriptedObserver(calls, fullReceipt),
      noExport: false,
      requireExport: false,
    })

    expect(calls[0]?.config).toStrictEqual({
      baseUrl: 'http://127.0.0.1:3000',
      publicKey: 'pk-lf-test',
      secretKey: 'sk-lf-test',
      projectId: 'project-test',
    })
  })

  it('omits the project id when the environment does not set it', async () => {
    const runDir = await exportDir()
    const calls: ObserverCall[] = []

    await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: captureIo().io,
      env: { ...OBSERVER_ENV, LANGFUSE_PROJECT_ID: undefined },
      observerFactory: scriptedObserver(calls, fullReceipt),
      noExport: false,
      requireExport: false,
    })

    expect(calls[0]?.config).toStrictEqual({
      baseUrl: 'http://127.0.0.1:3000',
      publicKey: 'pk-lf-test',
      secretKey: 'sk-lf-test',
    })
  })

  it.each([
    ['LANGFUSE_BASE_URL', 'LANGFUSE_BASE_URL is not set'],
    ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_PUBLIC_KEY is not set'],
    ['LANGFUSE_SECRET_KEY', 'LANGFUSE_SECRET_KEY is not set'],
  ])('fails closed when %s is missing', async (name, message) => {
    const runDir = await exportDir()
    const env: NodeJS.ProcessEnv = { ...OBSERVER_ENV }
    delete env[name]
    const io = captureIo()

    const artifact = await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: io.io,
      env,
      observerFactory: scriptedObserver([], fullReceipt),
      noExport: false,
      requireExport: false,
    })

    expect(artifact.status).toBe('failed')
    expect(artifact.error).toBe(message)
    expect(io.err).toStrictEqual([`langfuse: export failed: ${message}`])
    expect(io.out).toStrictEqual([])
  })

  it('rejects a base URL that is not a URL', async () => {
    const runDir = await exportDir()
    const io = captureIo()

    const artifact = await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: io.io,
      env: { ...OBSERVER_ENV, LANGFUSE_BASE_URL: 'not a url' },
      observerFactory: scriptedObserver([], fullReceipt),
      noExport: false,
      requireExport: false,
    })

    expect(artifact.error).toBe('LANGFUSE_BASE_URL is not a valid URL: not a url')
    expect(io.err).toStrictEqual([
      'langfuse: export failed: LANGFUSE_BASE_URL is not a valid URL: not a url',
    ])
  })

  it('rejects a non-http(s) base URL', async () => {
    const runDir = await exportDir()
    const io = captureIo()

    const artifact = await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: io.io,
      env: { ...OBSERVER_ENV, LANGFUSE_BASE_URL: 'ftp://127.0.0.1:3000' },
      observerFactory: scriptedObserver([], fullReceipt),
      noExport: false,
      requireExport: false,
    })

    expect(artifact.error).toBe('LANGFUSE_BASE_URL must be http(s): ftp://127.0.0.1:3000')
  })

  it.each([
    'https://langfuse.com',
    'https://langfuse.com/project/1',
    'https://cloud.langfuse.com',
    'https://us.cloud.langfuse.com/project/1',
  ])('refuses Langfuse Cloud at %s', async (baseUrl) => {
    const runDir = await exportDir()
    const io = captureIo()

    const artifact = await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: io.io,
      env: { ...OBSERVER_ENV, LANGFUSE_BASE_URL: baseUrl },
      observerFactory: scriptedObserver([], fullReceipt),
      noExport: false,
      requireExport: false,
    })

    expect(artifact.error).toBe('refusing Langfuse Cloud; the review layer is self-hosted only')
  })

  it('records the exported experiment, every trace id and the URL', async () => {
    const runDir = await exportDir()
    const io = captureIo()
    const calls: ObserverCall[] = []

    const artifact = await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: io.io,
      env: OBSERVER_ENV,
      observerFactory: scriptedObserver(calls, fullReceipt),
      noExport: false,
      requireExport: false,
    })

    const plan = calls[0]?.plan
    expect(plan?.items).toHaveLength(12)
    expect(artifact).toStrictEqual({
      schemaVersion: LANGFUSE_ARTIFACT_SCHEMA_VERSION,
      status: 'exported',
      executionId: fixtureGrades.executionId,
      runId: fixtureRun.result.runId,
      baseUrl: 'http://127.0.0.1:3000',
      experimentId: fixtureGrades.executionId,
      experimentUrl: `http://127.0.0.1:3000/project/project-test/experiments/${fixtureGrades.executionId}`,
      traceIds: fullReceipt(plan as ObservationPlan).traceIds,
      exportedAt: expect.any(String),
    })
    expect(io.out).toStrictEqual([
      `langfuse: exported 12 item trace(s) to experiment ${fixtureGrades.executionId}`,
      `langfuse: http://127.0.0.1:3000/project/project-test/experiments/${fixtureGrades.executionId}`,
    ])
    expect(io.err).toStrictEqual([])
    expect(await readFile(join(runDir, 'langfuse.json'), 'utf8')).toBe(
      `${JSON.stringify(artifact, null, 2)}\n`,
    )
  })

  it('omits the URL line and field when the platform returns no experiment URL', async () => {
    const runDir = await exportDir()
    const io = captureIo()

    const artifact = await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: io.io,
      env: OBSERVER_ENV,
      observerFactory: scriptedObserver([], (plan) => ({
        experimentId: plan.executionId,
        traceIds: Object.fromEntries(
          plan.items.map((item) => [item.itemId, `trace-${item.itemId}`]),
        ),
      })),
      noExport: false,
      requireExport: false,
    })

    expect(artifact).not.toHaveProperty('experimentUrl')
    expect(io.out).toStrictEqual([
      `langfuse: exported 12 item trace(s) to experiment ${fixtureGrades.executionId}`,
    ])
  })

  it('fails when the platform returns no trace id for an item', async () => {
    const runDir = await exportDir()
    const io = captureIo()
    let dropped: string[] = []

    const artifact = await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: io.io,
      env: OBSERVER_ENV,
      observerFactory: scriptedObserver([], (plan) => {
        dropped = plan.items.slice(0, 2).map((item) => item.itemId)
        return {
          experimentId: plan.executionId,
          traceIds: Object.fromEntries(
            plan.items
              .filter((item) => !dropped.includes(item.itemId))
              .map((item) => [item.itemId, `trace-${item.itemId}`]),
          ),
        }
      }),
      noExport: false,
      requireExport: false,
    })

    const message = `export returned no trace id for 2 item(s): ${dropped.join(', ')}`
    expect(artifact.status).toBe('failed')
    expect(artifact.error).toBe(message)
    expect(io.err).toStrictEqual([`langfuse: export failed: ${message}`])
  })

  it('records a shutdown failure without losing the failed artifact', async () => {
    const runDir = await exportDir()
    const io = captureIo()

    const artifact = await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: io.io,
      env: OBSERVER_ENV,
      observerFactory: scriptedObserver([], fullReceipt, async () => {
        throw new Error('flush failed')
      }),
      noExport: false,
      requireExport: false,
    })

    expect(artifact.status).toBe('failed')
    expect(artifact.error).toBe('langfuse shutdown failed: flush failed')
    expect(io.err).toStrictEqual(['langfuse: shutdown failed: flush failed'])
  })

  it('shuts the observer down after a successful export', async () => {
    const runDir = await exportDir()
    const shutdown = vi.fn(async () => {})

    const artifact = await exportRun({
      execution: fixtureRun,
      grades: fixtureGrades,
      runDir,
      repoRoot,
      io: captureIo().io,
      env: OBSERVER_ENV,
      observerFactory: scriptedObserver([], fullReceipt, shutdown),
      noExport: false,
      requireExport: false,
    })

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(artifact.status).toBe('exported')
  })

  it.each([true, false])(
    'maps includeScores=%s onto the observation plan',
    async (includeScores) => {
      const runDir = await exportDir()
      const calls: ObserverCall[] = []

      await exportRun({
        execution: fixtureRun,
        grades: fixtureGrades,
        runDir,
        repoRoot,
        io: captureIo().io,
        env: OBSERVER_ENV,
        observerFactory: scriptedObserver(calls, fullReceipt),
        noExport: false,
        requireExport: false,
        includeScores,
      })

      const items = calls[0]?.plan.items ?? []
      expect(items).toHaveLength(12)
      expect(items.every((item) => item.scores.length === 0)).toBe(!includeScores)
    },
  )
})
