import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { computeVerdict, manifestHash, type RunResult } from '@rp/eval-harness'
import { CliUsageError } from './cli-errors.js'
import type { CliIo } from './cli-contract.js'
import { compareCommand } from './compare-command.js'

/**
 * `compare` is the M0 regression gate at the terminal: it prints every axis
 * separately, refuses a baseline that was never accepted, and turns a
 * non-accepted candidate into exit 1 without pretending to compare it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const baselinePath = resolve(here, '..', '..', '..', 'evals/baselines/m0-canned-replay.json')

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

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eval-cli-compare-'))
  tempDirs.push(dir)
  return dir
}

async function acceptedResult(): Promise<RunResult> {
  return JSON.parse(await readFile(baselinePath, 'utf8')) as RunResult
}

/**
 * Recompute the verdict and manifest hash after a fixture edit. The artifact
 * schema re-derives both, so an edited run is only loadable when the embedded
 * verdict still follows from the embedded manifest and metrics.
 */
function restate(result: RunResult): RunResult {
  result.verdict = computeVerdict({
    manifest: result.manifest,
    metrics: result.metrics,
    rounds: {
      requested: result.summary.requestedRounds,
      attempts: result.summary.attempts,
      completed: result.summary.completed,
    },
    invariants: result.invariants,
    providerOutages: result.trials.filter((trial) => trial.providerOutage).length,
  })
  result.manifestHash = manifestHash(result.manifest)
  return result
}

/** Write a result artifact as `<dir>/result.json` and return the directory. */
async function writeRunDir(root: string, name: string, result: RunResult): Promise<string> {
  const runDir = join(root, name)
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return runDir
}

async function writeResultFile(root: string, name: string, result: RunResult): Promise<string> {
  const file = join(root, name)
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return file
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

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('compareCommand', () => {
  it('prints every axis separately and exits 0 when the candidate matches the baseline', async () => {
    const root = await tempDir()
    const result = await acceptedResult()
    const candidateDir = await writeRunDir(root, 'candidate', result)
    const capture = captureIo()

    const code = await compareCommand(
      new Map([
        ['baseline', baselinePath],
        ['run', candidateDir],
      ]),
      capture.io,
    )

    expect(code).toBe(0)
    expect(capture.err).toStrictEqual([])
    expect(capture.out).toStrictEqual([
      'comparison: PASS',
      '',
      'target replay.deterministic_rate (increase) baseline=1 value=1 delta=0 improvement=0 minimum detectable effect=0 -> PASS - regression axis "replay.deterministic_rate" held',
      'guardrail transcript.schema_valid_rate (increase) baseline=1 value=1 delta=0 improvement=0 tolerance=0 -> PASS - guardrail "transcript.schema_valid_rate" held',
      'guardrail transcript.content_class_rate (increase) baseline=1 value=1 delta=0 improvement=0 tolerance=0 -> PASS - guardrail "transcript.content_class_rate" held',
      'guardrail transcript.guard_violations (decrease) baseline=0 value=0 delta=0 improvement=0 tolerance=0 -> PASS - guardrail "transcript.guard_violations" held',
      'guardrail run.failure_rate (decrease) baseline=0 value=0 delta=0 improvement=0 tolerance=0 -> PASS - guardrail "run.failure_rate" held',
      '',
      'reasons:',
      '  - no regressions and no definition drift',
    ])
  })

  it('accepts a baseline file and a run directory given as relative paths', async () => {
    const root = await tempDir()
    const result = await acceptedResult()
    const candidateDir = await writeRunDir(root, 'candidate', result)
    const relativeBaseline = relative(process.cwd(), baselinePath)
    const relativeCandidate = relative(process.cwd(), candidateDir)
    const capture = captureIo()

    expect(relativeBaseline).not.toBe(baselinePath)
    expect(relativeCandidate).not.toBe(candidateDir)

    const code = await compareCommand(
      new Map([
        ['baseline', relativeBaseline],
        ['run', relativeCandidate],
      ]),
      capture.io,
    )

    expect(code).toBe(0)
    expect(capture.out[0]).toBe('comparison: PASS')
  })

  it('exits 1 and marks the comparison incompatible when the eval definition drifted', async () => {
    const root = await tempDir()
    const drifted = await acceptedResult()
    drifted.manifest.limits.maxFailureRate = 0.1
    restate(drifted)
    expect(drifted.verdict.status).toBe('accepted')
    const candidateDir = await writeRunDir(root, 'candidate', drifted)
    const capture = captureIo()

    const code = await compareCommand(
      new Map([
        ['baseline', baselinePath],
        ['run', candidateDir],
      ]),
      capture.io,
    )

    expect(code).toBe(1)
    expect(capture.err).toStrictEqual([])
    expect(capture.out[0]).toBe('comparison: FAIL (incompatible eval definition)')
    expect(capture.out).toContain(
      '  - limit registration differs from the baseline; changing the eval definition invalidates the comparison',
    )
  })

  it('exits 1 for a candidate that was never accepted, without comparing axes', async () => {
    const root = await tempDir()
    const rejected = await acceptedResult()
    rejected.metrics['transcript.guard_violations'] = 3
    restate(rejected)
    expect(rejected.verdict.status).toBe('rejected')
    const candidateDir = await writeRunDir(root, 'candidate', rejected)
    const capture = captureIo()

    const code = await compareCommand(
      new Map([
        ['baseline', baselinePath],
        ['run', candidateDir],
      ]),
      capture.io,
    )

    expect(code).toBe(1)
    expect(capture.err).toStrictEqual([])
    expect(capture.out).toStrictEqual([
      'comparison: FAIL (candidate not accepted)',
      '  - candidate m0-canned-replay has verdict "rejected"; only an accepted candidate may be compared',
    ])
  })

  it('refuses a baseline that was never accepted', async () => {
    const root = await tempDir()
    const inconclusive = await acceptedResult()
    delete inconclusive.metrics['replay.deterministic_rate']
    restate(inconclusive)
    expect(inconclusive.verdict.status).toBe('inconclusive')
    const rejectedBaseline = await writeResultFile(root, 'baseline.json', inconclusive)
    const candidateDir = await writeRunDir(root, 'candidate', await acceptedResult())
    const capture = captureIo()

    const error = await usageError(() =>
      compareCommand(
        new Map([
          ['baseline', rejectedBaseline],
          ['run', candidateDir],
        ]),
        capture.io,
      ),
    )

    expect(error.message).toBe(
      'baseline m0-canned-replay has verdict "inconclusive"; only an accepted result may be used as a baseline',
    )
    expect(capture.out).toStrictEqual([])
  })

  it('requires --baseline before touching the filesystem', async () => {
    const error = await usageError(() =>
      compareCommand(new Map([['run', 'whatever']]), captureIo().io),
    )

    expect(error.message).toBe('compare requires --baseline <path>')
  })

  it('requires --run before reading either artifact', async () => {
    const capture = captureIo()

    const error = await usageError(() =>
      compareCommand(new Map([['baseline', baselinePath]]), capture.io),
    )

    expect(error.message).toBe('compare requires --run <dir-or-result.json>')
    expect(capture.out).toStrictEqual([])
  })

  it('rejects an unknown flag', async () => {
    const error = await usageError(() =>
      compareCommand(
        new Map([
          ['baseline', baselinePath],
          ['run', 'whatever'],
          ['scores', 'all'],
        ]),
        captureIo().io,
      ),
    )

    expect(error.message).toBe('unknown flag --scores')
  })

  it('accepts the shared --repo-root flag', async () => {
    const root = await tempDir()
    const candidateDir = await writeRunDir(root, 'candidate', await acceptedResult())

    await expect(
      compareCommand(
        new Map([
          ['baseline', baselinePath],
          ['run', candidateDir],
          ['repo-root', root],
        ]),
        captureIo().io,
      ),
    ).resolves.toBe(0)
  })

  it('labels a missing baseline artifact as a baseline read failure', async () => {
    const root = await tempDir()
    const missing = join(root, 'missing-result.json')

    const error = await usageError(() =>
      compareCommand(
        new Map([
          ['baseline', missing],
          ['run', 'whatever'],
        ]),
        captureIo().io,
      ),
    )

    expect(error.message.startsWith(`cannot read baseline artifact ${missing}: `)).toBe(true)
  })

  it('labels a missing candidate artifact as a run read failure', async () => {
    const root = await tempDir()
    const missing = join(root, 'missing-candidate.json')

    const error = await usageError(() =>
      compareCommand(
        new Map([
          ['baseline', baselinePath],
          ['run', missing],
        ]),
        captureIo().io,
      ),
    )

    expect(error.message.startsWith(`cannot read run artifact ${missing}: `)).toBe(true)
  })

  it('labels a malformed candidate artifact as a run read failure', async () => {
    const root = await tempDir()
    const candidateDir = join(root, 'candidate')
    await mkdir(candidateDir)
    await writeFile(join(candidateDir, 'result.json'), '{"verdict":', 'utf8')

    const error = await usageError(() =>
      compareCommand(
        new Map([
          ['baseline', baselinePath],
          ['run', candidateDir],
        ]),
        captureIo().io,
      ),
    )

    expect(error.message.startsWith(`invalid JSON in ${join(candidateDir, 'result.json')}: `)).toBe(
      true,
    )
  })
})
