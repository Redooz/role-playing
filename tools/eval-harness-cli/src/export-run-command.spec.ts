import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  EvaluationObserver,
  ObservationPlan,
  ObserverConfig,
  ObserverFactory,
  TrialGrade,
} from '@rp/eval-harness'
import { HarnessConfigError } from '@rp/eval-harness'
import { CliUsageError } from './cli-errors.js'
import type { CliIo } from './cli-contract.js'
import { exportRunCommand } from './export-run-command.js'
import { main } from './cli-main.js'

/**
 * `export-run` rebuilds the in-memory run from the artifacts a finished run
 * wrote and reuses the `run` export path. These tests feed it a real run
 * directory produced once, then vary one artifact at a time.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

const ENABLED_ENV: NodeJS.ProcessEnv = {
  LANGFUSE_ENABLED: 'true',
  LANGFUSE_BASE_URL: 'http://127.0.0.1:3000',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_PROJECT_ID: 'project-test',
}

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

const tempDirs: string[] = []
let sourceRun = ''
let sourceRoot = ''

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eval-cli-export-run-'))
  tempDirs.push(dir)
  return dir
}

/** A fresh copy of the recorded run directory, so each test edits its own. */
async function runDirCopy(): Promise<string> {
  const root = await tempDir()
  const target = join(root, 'm0-canned-replay')
  await cp(sourceRun, target, { recursive: true })
  return target
}

function recordingObserver(plans: ObservationPlan[]): ObserverFactory {
  return async (_config: ObserverConfig): Promise<EvaluationObserver> => ({
    async observe(plan) {
      plans.push(plan)
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

async function readArtifact(runDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(runDir, 'langfuse.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

async function gradesRecords(runDir: string): Promise<TrialGrade[]> {
  const jsonl = await readFile(join(runDir, 'grades.jsonl'), 'utf8')
  return jsonl
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as TrialGrade)
}

async function usageError(run: () => Promise<unknown>): Promise<CliUsageError> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error
    return error
  }
  throw new Error('expected a CliUsageError')
}

beforeAll(async () => {
  sourceRoot = await tempDir()
  const code = await main(
    ['run', '--manifest', manifestPath, '--results-root', sourceRoot],
    captureIo().io,
    { repoRoot, env: { LANGFUSE_ENABLED: 'false' } },
  )
  expect(code).toBe(0)
  sourceRun = join(sourceRoot, 'm0-canned-replay')
})

afterAll(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('exportRunCommand', () => {
  it('re-exports the finished run without executing the provider', async () => {
    const runDir = await runDirCopy()
    const plans: ObservationPlan[] = []
    const capture = captureIo()

    const code = await exportRunCommand(new Map([['run', runDir]]), repoRoot, capture.io, {
      repoRoot,
      env: ENABLED_ENV,
      observerFactory: recordingObserver(plans),
    })

    expect(code).toBe(0)
    expect(capture.out).toContain(
      'langfuse: exported 12 item trace(s) to experiment ' + plans[0]?.executionId,
    )
    expect(plans).toHaveLength(1)
    const plan = plans[0]
    expect(plan?.items).toHaveLength(12)
    expect(plan?.items.every((item) => item.output.transcript !== undefined)).toBe(true)

    const artifact = await readArtifact(runDir)
    expect(artifact['status']).toBe('exported')
    expect(artifact['experimentUrl']).toBe(
      `http://127.0.0.1:3000/project/project-test/experiments/${plan?.executionId}`,
    )
    expect(Object.keys(artifact['traceIds'] as Record<string, string>)).toHaveLength(12)
  })

  it('takes the execution id recorded in the grades sidecar', async () => {
    const runDir = await runDirCopy()
    const records = await gradesRecords(runDir)
    const recordedId = records[0]?.executionId ?? 'missing'
    expect(recordedId).not.toBe('')
    const plans: ObservationPlan[] = []

    await exportRunCommand(new Map([['run', runDir]]), repoRoot, captureIo().io, {
      repoRoot,
      env: ENABLED_ENV,
      observerFactory: recordingObserver(plans),
    })

    expect((await readArtifact(runDir))['executionId']).toBe(recordedId)
    expect(plans[0]?.executionId).toBe(recordedId)
  })

  it('keeps a recorded execution id that differs from the derived one', async () => {
    const runDir = await runDirCopy()
    const records = await gradesRecords(runDir)
    const recordedId = 'recorded-execution-id'
    await writeFile(
      join(runDir, 'grades.jsonl'),
      `${records.map((record) => JSON.stringify({ ...record, executionId: recordedId })).join('\n')}\n`,
      'utf8',
    )
    const plans: ObservationPlan[] = []

    const code = await exportRunCommand(new Map([['run', runDir]]), repoRoot, captureIo().io, {
      repoRoot,
      env: ENABLED_ENV,
      observerFactory: recordingObserver(plans),
    })

    expect(code).toBe(0)
    expect((await readArtifact(runDir))['executionId']).toBe(recordedId)
    expect(plans[0]?.executionId).toBe(recordedId)
    expect(plans[0]?.items).toHaveLength(12)
  })

  it('exports even when LANGFUSE_ENABLED is off, because export-run is explicit', async () => {
    const runDir = await runDirCopy()
    const plans: ObservationPlan[] = []

    const code = await exportRunCommand(new Map([['run', runDir]]), repoRoot, captureIo().io, {
      repoRoot,
      env: { ...ENABLED_ENV, LANGFUSE_ENABLED: 'false' },
      observerFactory: recordingObserver(plans),
    })

    expect(code).toBe(0)
    expect(plans).toHaveLength(1)
    expect((await readArtifact(runDir))['status']).toBe('exported')
  })

  it('omits automated scores for a blind labelling export', async () => {
    const runDir = await runDirCopy()
    const plans: ObservationPlan[] = []

    const code = await exportRunCommand(
      new Map([
        ['run', runDir],
        ['no-scores', 'true'],
      ]),
      repoRoot,
      captureIo().io,
      { repoRoot, env: ENABLED_ENV, observerFactory: recordingObserver(plans) },
    )

    expect(code).toBe(0)
    expect(plans[0]?.items).toHaveLength(12)
    expect(plans[0]?.items.every((item) => item.scores.length === 0)).toBe(true)
  })

  it('includes automated scores by default', async () => {
    const runDir = await runDirCopy()
    const plans: ObservationPlan[] = []

    await exportRunCommand(new Map([['run', runDir]]), repoRoot, captureIo().io, {
      repoRoot,
      env: ENABLED_ENV,
      observerFactory: recordingObserver(plans),
    })

    expect(plans[0]?.items.some((item) => item.scores.length > 0)).toBe(true)
  })

  it('accepts --repo-root as the shared location flag', async () => {
    const runDir = await runDirCopy()

    const code = await exportRunCommand(
      new Map([
        ['run', runDir],
        ['repo-root', repoRoot],
      ]),
      repoRoot,
      captureIo().io,
      { repoRoot, env: ENABLED_ENV, observerFactory: recordingObserver([]) },
    )

    expect(code).toBe(0)
  })

  it('rebuilds an empty transcript from a whitespace-only file', async () => {
    const runDir = await runDirCopy()
    const result = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')) as {
      transcripts: { path: string }[]
    }
    const blanked = result.transcripts[0]?.path ?? 'missing.jsonl'
    await writeFile(join(runDir, blanked), '  \n \t\n', 'utf8')
    const plans: ObservationPlan[] = []

    const code = await exportRunCommand(new Map([['run', runDir]]), repoRoot, captureIo().io, {
      repoRoot,
      env: ENABLED_ENV,
      observerFactory: recordingObserver(plans),
    })

    expect(code).toBe(0)
    expect(plans[0]?.items).toHaveLength(12)
    expect(plans[0]?.items.filter((item) => item.output.conversation === undefined)).toHaveLength(1)
  })

  it('tolerates blank lines around the transcript records', async () => {
    const runDir = await runDirCopy()
    const result = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')) as {
      transcripts: { path: string }[]
    }
    const path = result.transcripts[0]?.path ?? 'missing.jsonl'
    const original = await readFile(join(runDir, path), 'utf8')
    await writeFile(join(runDir, path), `\n${original}\n\n`, 'utf8')
    const plans: ObservationPlan[] = []

    const code = await exportRunCommand(new Map([['run', runDir]]), repoRoot, captureIo().io, {
      repoRoot,
      env: ENABLED_ENV,
      observerFactory: recordingObserver(plans),
    })

    expect(code).toBe(0)
    expect(plans[0]?.items).toHaveLength(12)
  })

  it('tolerates a blank line around the grade records', async () => {
    const runDir = await runDirCopy()
    const original = await readFile(join(runDir, 'grades.jsonl'), 'utf8')
    await writeFile(join(runDir, 'grades.jsonl'), `\n${original}\n`, 'utf8')
    const plans: ObservationPlan[] = []

    const code = await exportRunCommand(new Map([['run', runDir]]), repoRoot, captureIo().io, {
      repoRoot,
      env: ENABLED_ENV,
      observerFactory: recordingObserver(plans),
    })

    expect(code).toBe(0)
    expect(plans[0]?.items).toHaveLength(12)
  })

  it('exits 3 when the export itself fails', async () => {
    const runDir = await runDirCopy()
    const failing: ObserverFactory = async () => {
      throw new Error('langfuse is unreachable')
    }
    const capture = captureIo()

    const code = await exportRunCommand(new Map([['run', runDir]]), repoRoot, capture.io, {
      repoRoot,
      env: ENABLED_ENV,
      observerFactory: failing,
    })

    expect(code).toBe(3)
    expect(capture.err).toStrictEqual(['langfuse: export failed: langfuse is unreachable'])
    expect((await readArtifact(runDir))['status']).toBe('failed')
  })

  it('refuses an empty grades sidecar instead of exporting an ungraded run', async () => {
    const runDir = await runDirCopy()
    await writeFile(join(runDir, 'grades.jsonl'), '\n', 'utf8')

    const error = await exportRunCommand(new Map([['run', runDir]]), repoRoot, captureIo().io, {
      repoRoot,
      env: ENABLED_ENV,
      observerFactory: recordingObserver([]),
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(HarnessConfigError)
    expect((error as Error).message).toBe(
      `grades.jsonl in ${runDir} is empty; refusing to export a run without grades`,
    )
  })

  it('requires --run', async () => {
    const error = await usageError(() =>
      exportRunCommand(new Map(), repoRoot, captureIo().io, { repoRoot }),
    )

    expect(error.message).toBe('export-run requires --run <dir>')
  })

  it('reports a missing run directory as a usage error that names it', async () => {
    const root = await tempDir()
    const missing = join(root, 'absent')

    const error = await usageError(() =>
      exportRunCommand(new Map([['run', missing]]), repoRoot, captureIo().io, { repoRoot }),
    )

    expect(error.message).toBe(`run directory not found: ${missing}`)
  })

  it('rejects an unknown flag', async () => {
    const error = await usageError(() =>
      exportRunCommand(
        new Map([
          ['run', sourceRun],
          ['scores', 'all'],
        ]),
        repoRoot,
        captureIo().io,
        { repoRoot },
      ),
    )

    expect(error.message).toBe('unknown flag --scores')
  })

  it('maps a missing grades file to a usage error through main', async () => {
    const runDir = await runDirCopy()
    await rm(join(runDir, 'grades.jsonl'))
    const capture = captureIo()

    const code = await main(['export-run', '--run', runDir], capture.io, {
      repoRoot,
      env: ENABLED_ENV,
      observerFactory: recordingObserver([]),
    })

    expect(code).toBe(2)
    expect(capture.err).toStrictEqual([
      `error: ENOENT: no such file or directory, open '${join(runDir, 'grades.jsonl')}'`,
    ])
  })
})
