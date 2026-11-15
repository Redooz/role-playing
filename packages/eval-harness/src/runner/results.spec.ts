import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRANSCRIPT_SCHEMA_VERSION } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import {
  manifestHash,
  runManifestSchema,
  type InvariantResult,
  type RunManifest,
} from './manifest.js'
import {
  RUN_RESULT_SCHEMA_VERSION,
  buildVersions,
  metricReadingsSchema,
  parseRunResult,
  passMetricsSchema,
  runResultSchema,
  runSummarySchema,
  taskPassMetricSchema,
  transcriptArtifactSchema,
  transcriptRelativePath,
  trialOutcomeSchema,
  versionsSchema,
  type RunResult,
  type RunSummary,
  type TranscriptArtifact,
  type TrialOutcome,
} from './results.js'
import { computeVerdict } from './verdict.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const baselinePath = join(repoRoot, 'evals/baselines/m0-canned-replay.json')

function loadCommittedBaseline(): unknown {
  return JSON.parse(readFileSync(baselinePath, 'utf8')) as unknown
}

interface ParseIssue {
  readonly code: string
  readonly path: readonly PropertyKey[]
  readonly message: string
}

interface Parseable {
  safeParse(
    input: unknown,
  ):
    | { readonly success: true }
    | { readonly success: false; readonly error: { readonly issues: readonly ParseIssue[] } }
}

function issuesOf(schema: Parseable, input: unknown): readonly ParseIssue[] {
  const parsed = schema.safeParse(input)
  if (parsed.success) throw new Error('expected the value to be rejected')
  return parsed.error.issues
}

function rejects(schema: Parseable, input: unknown): boolean {
  return schema.safeParse(input).success === false
}

function issueAt(schema: Parseable, input: unknown, path: readonly PropertyKey[]): ParseIssue {
  const issue = issuesOf(schema, input).find(
    (candidate) =>
      candidate.path.length === path.length &&
      candidate.path.every((segment, index) => segment === path[index]),
  )
  if (issue === undefined) {
    throw new Error(`expected a validation issue at path ${path.map(String).join('.')}`)
  }
  return issue
}

function expectCustomIssue(
  schema: Parseable,
  input: unknown,
  path: readonly PropertyKey[],
  message: string,
): void {
  const issue = issueAt(schema, input, path)
  expect(issue.code).toBe('custom')
  expect(issue.message).toBe(message)
}

const MANIFEST_INPUT = {
  schemaVersion: '3.0.0',
  run: { runId: 'suite-a', suite: 'suite-a', purpose: 'capability' },
  tasks: { dataset: 'fixture-set', version: 'v1', languages: ['en'] },
  seeds: { master: 7, algorithm: 'mulberry32' },
  grader: { id: 'deterministic-invariants', kind: 'code', version: '1.0.0' },
  rubric: { version: 'rubric-v1' },
  limits: { rounds: 2, maxFailureRate: 0.5 },
  target: { metric: 'turn.taking_rate', direction: 'increase', minimumDetectableEffect: 0.1 },
  guardrails: [{ metric: 'transcript.guard_violations', direction: 'decrease', tolerance: 0 }],
  invariants: ['transcript.schema_valid', 'transcript.guard_clean'],
  provider: { mode: 'canned', label: 'canned replay', allowLive: false },
  baseline: {
    runId: 'suite-a',
    metrics: { 'turn.taking_rate': 0.5, 'transcript.guard_violations': 0 },
  },
}

function validManifest(): RunManifest {
  return runManifestSchema.parse(MANIFEST_INPUT)
}

const VALID_METRICS = { 'turn.taking_rate': 0.8, 'transcript.guard_violations': 0 }
const VALID_INVARIANTS: InvariantResult[] = [
  { id: 'transcript.schema_valid', ok: true },
  { id: 'transcript.guard_clean', ok: true },
]
const VALID_SUMMARY: RunSummary = {
  requestedRounds: 2,
  attempts: 2,
  completed: 2,
  failed: 0,
  failureRate: 0,
  trials: 2,
  failedTrials: 0,
}
const VALID_VERSIONS = {
  codeSha: 'abc1234',
  transcriptSchemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  taskDataset: 'fixture-set',
  taskVersion: 'v1',
  graderId: 'deterministic-invariants',
  graderKind: 'code' as const,
  graderVersion: '1.0.0',
  rubricVersion: 'rubric-v1',
  seed: 7,
}

function validTrials(): TrialOutcome[] {
  return [
    {
      round: 0,
      taskId: 'en-1',
      lang: 'en',
      ok: true,
      records: 3,
      transcriptSha256: 'a'.repeat(64),
      transcriptPath: 'transcripts/round-0/en/en-1.jsonl',
      simDurationMs: 900,
      providerOutage: false,
    },
    {
      round: 1,
      taskId: 'en-1',
      lang: 'en',
      ok: true,
      records: 3,
      transcriptSha256: 'b'.repeat(64),
      transcriptPath: 'transcripts/round-1/en/en-1.jsonl',
      simDurationMs: 950,
      providerOutage: false,
    },
  ]
}

function validTranscripts(): TranscriptArtifact[] {
  return [
    {
      taskId: 'en-1',
      lang: 'en',
      round: 0,
      path: 'transcripts/round-0/en/en-1.jsonl',
      sha256: 'a'.repeat(64),
    },
    {
      taskId: 'en-1',
      lang: 'en',
      round: 1,
      path: 'transcripts/round-1/en/en-1.jsonl',
      sha256: 'b'.repeat(64),
    },
  ]
}

function validArtifact(): RunResult {
  const manifest = validManifest()
  const metrics = { ...VALID_METRICS }
  const invariants = VALID_INVARIANTS.map((invariant) => ({ ...invariant }))
  const trials = validTrials()
  const verdict = computeVerdict({
    manifest,
    metrics,
    rounds: {
      requested: VALID_SUMMARY.requestedRounds,
      attempts: VALID_SUMMARY.attempts,
      completed: VALID_SUMMARY.completed,
    },
    invariants,
    providerOutages: trials.filter((trial) => trial.providerOutage).length,
  })

  return {
    schemaVersion: RUN_RESULT_SCHEMA_VERSION,
    runId: 'suite-a',
    suite: 'suite-a',
    manifestHash: manifestHash(manifest),
    manifest,
    verdict,
    metrics,
    invariants,
    trials,
    transcripts: validTranscripts(),
    summary: { ...VALID_SUMMARY },
    versions: { ...VALID_VERSIONS },
    startedAt: '2026-01-02T05:04:05.000+02:00',
    finishedAt: '2026-01-02T05:05:06.000+02:00',
  }
}

function cloneArtifact(): RunResult {
  return structuredClone(validArtifact())
}

describe('run result artifact', () => {
  it('accepts the committed baseline artifact read-only', () => {
    const result = parseRunResult(loadCommittedBaseline())

    expect(result.runId).toBe('m0-canned-replay')
    expect(result.verdict.status).toBe('accepted')
    expect(result.manifestHash).toBe(manifestHash(result.manifest))
    expect(result.transcripts).toHaveLength(12)
    expect(result.versions.seed).toBe(result.manifest.seeds.master)
    expect(result).not.toHaveProperty('score')
  })

  it('rejects an artifact whose embedded manifest was altered', () => {
    const raw = loadCommittedBaseline() as Record<string, unknown>
    raw['manifestHash'] = '0'.repeat(64)

    expect(() => parseRunResult(raw)).toThrow(/manifestHash/)
  })

  it('rejects an artifact whose verdict no longer matches its metrics', () => {
    const raw = loadCommittedBaseline() as Record<string, unknown>
    const metrics = raw['metrics'] as Record<string, number>
    metrics['replay.deterministic_rate'] = 0.5

    expect(() => parseRunResult(raw)).toThrow(/verdict/)
  })

  it('rejects an artifact whose provider-outage count does not match its trials', () => {
    const raw = loadCommittedBaseline() as Record<string, unknown>
    const verdict = raw['verdict'] as Record<string, unknown>
    verdict['providerOutages'] = 1

    expect(() => parseRunResult(raw)).toThrow(/providerOutages|provider outage/)
  })

  it('requires at least one per-axis metric', () => {
    expect(metricReadingsSchema.safeParse({}).success).toBe(false)
    expect(metricReadingsSchema.safeParse({ 'transcript.guard_violations': 0 }).success).toBe(true)
  })

  it('keeps transcript paths inside the run directory', () => {
    expect(transcriptRelativePath(0, 'en', 'en-b1-report-deadline-001')).toBe(
      'transcripts/round-0/en/en-b1-report-deadline-001.jsonl',
    )
    expect(transcriptRelativePath(1, 'fr', '../escape/id')).toBe(
      'transcripts/round-1/fr/.._escape_id.jsonl',
    )
  })
})

describe('run result schema version', () => {
  it('pins the persisted artifact version', () => {
    expect(RUN_RESULT_SCHEMA_VERSION).toBe('3.0.0')
  })

  it('accepts only the pinned version literal', () => {
    expect(runResultSchema.safeParse(validArtifact()).success).toBe(true)

    const raw = cloneArtifact() as { schemaVersion: string }
    raw.schemaVersion = '3.0.1'
    expect(rejects(runResultSchema, raw)).toBe(true)
  })
})

describe('metricReadingsSchema', () => {
  it('rejects an empty record with the exact custom issue and no path', () => {
    const issues = issuesOf(metricReadingsSchema, {})
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      code: 'custom',
      path: [],
      message: 'at least one per-axis metric is required',
    })
  })

  it('accepts and preserves one or more per-axis readings', () => {
    expect(metricReadingsSchema.parse({ 'turn.taking_rate': 0.5 })).toStrictEqual({
      'turn.taking_rate': 0.5,
    })
    expect(
      metricReadingsSchema.parse({
        'turn.taking_rate': 0.5,
        'transcript.guard_violations': 0,
      }),
    ).toStrictEqual({ 'turn.taking_rate': 0.5, 'transcript.guard_violations': 0 })
  })

  it('rejects a metric key that does not follow the axis naming rule', () => {
    expect(rejects(metricReadingsSchema, { 'Turn.Taking': 1 })).toBe(true)
    expect(rejects(metricReadingsSchema, { '1turn': 1 })).toBe(true)
  })

  it('rejects non-finite and non-numeric readings', () => {
    expect(rejects(metricReadingsSchema, { 'turn.taking_rate': Number.POSITIVE_INFINITY })).toBe(
      true,
    )
    expect(rejects(metricReadingsSchema, { 'turn.taking_rate': Number.NaN })).toBe(true)
    expect(rejects(metricReadingsSchema, { 'turn.taking_rate': '0.5' })).toBe(true)
  })
})

describe('versionsSchema', () => {
  const required = {
    transcriptSchemaVersion: '1.4.0',
    taskDataset: 'fixture-set',
    taskVersion: 'v1',
    graderId: 'deterministic-invariants',
    graderKind: 'code',
    graderVersion: '1.0.0',
    rubricVersion: 'rubric-v1',
    seed: 7,
  }

  it('accepts the required stamps and omits the optional ones', () => {
    const parsed = versionsSchema.parse(required)

    expect(parsed).toStrictEqual(required)
    expect(parsed).not.toHaveProperty('codeSha')
    expect(parsed).not.toHaveProperty('graderModel')
  })

  it('accepts codeSha and graderModel when present', () => {
    const parsed = versionsSchema.parse({
      ...required,
      codeSha: 'abc1234',
      graderModel: 'typesafe/jev-1.14',
    })

    expect(parsed).toStrictEqual({
      ...required,
      codeSha: 'abc1234',
      graderModel: 'typesafe/jev-1.14',
    })
  })

  it('rejects an empty string stamp for every required field', () => {
    for (const field of [
      'transcriptSchemaVersion',
      'taskDataset',
      'taskVersion',
      'graderId',
      'graderVersion',
      'rubricVersion',
    ] as const) {
      expect(rejects(versionsSchema, { ...required, [field]: '' })).toBe(true)
    }
  })

  it('rejects an empty optional stamp rather than treating it as absent', () => {
    expect(rejects(versionsSchema, { ...required, codeSha: '' })).toBe(true)
    expect(rejects(versionsSchema, { ...required, graderModel: '' })).toBe(true)
  })

  it('accepts seed 0 and rejects negative or fractional seeds', () => {
    expect(versionsSchema.parse({ ...required, seed: 0 }).seed).toBe(0)
    expect(rejects(versionsSchema, { ...required, seed: -1 })).toBe(true)
    expect(rejects(versionsSchema, { ...required, seed: 1.5 })).toBe(true)
  })

  it('rejects a missing required stamp, an unknown key and an unknown grader kind', () => {
    const { taskVersion: _taskVersion, ...missingTaskVersion } = required
    expect(rejects(versionsSchema, missingTaskVersion)).toBe(true)
    expect(rejects(versionsSchema, { ...required, extra: true })).toBe(true)
    expect(rejects(versionsSchema, { ...required, graderKind: 'vibes' })).toBe(true)
  })
})

describe('trialOutcomeSchema', () => {
  const minimal = {
    round: 0,
    taskId: 'en-1',
    lang: 'en',
    ok: true,
    records: 0,
    providerOutage: false,
  }

  it('accepts a minimal trial outcome exactly', () => {
    expect(trialOutcomeSchema.parse(minimal)).toStrictEqual(minimal)
  })

  it('accepts every optional field and preserves it', () => {
    const full = {
      round: 2,
      taskId: 'fr-2',
      lang: 'fr',
      ok: false,
      records: 4,
      transcriptSha256: 'a'.repeat(64),
      transcriptPath: 'transcripts/round-2/fr/fr-2.jsonl',
      simDurationMs: 1234.5,
      error: 'provider timed out',
      providerOutage: true,
    }

    expect(trialOutcomeSchema.parse(full)).toStrictEqual(full)
  })

  it('rejects negative and fractional rounds and record counts', () => {
    expect(rejects(trialOutcomeSchema, { ...minimal, round: -1 })).toBe(true)
    expect(rejects(trialOutcomeSchema, { ...minimal, round: 1.5 })).toBe(true)
    expect(rejects(trialOutcomeSchema, { ...minimal, records: -1 })).toBe(true)
    expect(rejects(trialOutcomeSchema, { ...minimal, records: 1.5 })).toBe(true)
  })

  it('rejects an empty required string and an unknown language', () => {
    expect(rejects(trialOutcomeSchema, { ...minimal, taskId: '' })).toBe(true)
    expect(rejects(trialOutcomeSchema, { ...minimal, lang: 'de' })).toBe(true)
    expect(trialOutcomeSchema.parse({ ...minimal, lang: 'fr' }).lang).toBe('fr')
  })

  it('rejects an empty optional path or error', () => {
    expect(rejects(trialOutcomeSchema, { ...minimal, transcriptPath: '' })).toBe(true)
    expect(rejects(trialOutcomeSchema, { ...minimal, error: '' })).toBe(true)
  })

  it('rejects a malformed transcript digest with the exact rule message', () => {
    expect(
      issuesOf(trialOutcomeSchema, { ...minimal, transcriptSha256: 'A'.repeat(64) })[0],
    ).toMatchObject({ message: 'must be a lowercase SHA-256 hex digest' })
    expect(rejects(trialOutcomeSchema, { ...minimal, transcriptSha256: 'a'.repeat(63) })).toBe(true)
    expect(rejects(trialOutcomeSchema, { ...minimal, transcriptSha256: 'a'.repeat(65) })).toBe(true)
    expect(
      rejects(trialOutcomeSchema, { ...minimal, transcriptSha256: `${'a'.repeat(64)}b` }),
    ).toBe(true)
    expect(
      rejects(trialOutcomeSchema, { ...minimal, transcriptSha256: `b${'a'.repeat(64)}` }),
    ).toBe(true)
  })

  it('rejects a negative or non-finite simulated duration', () => {
    expect(trialOutcomeSchema.parse({ ...minimal, simDurationMs: 0 }).simDurationMs).toBe(0)
    expect(trialOutcomeSchema.parse({ ...minimal, simDurationMs: 0.5 }).simDurationMs).toBe(0.5)
    expect(rejects(trialOutcomeSchema, { ...minimal, simDurationMs: -1 })).toBe(true)
    expect(
      rejects(trialOutcomeSchema, { ...minimal, simDurationMs: Number.POSITIVE_INFINITY }),
    ).toBe(true)
  })

  it('rejects a missing required field and an unknown key', () => {
    const { providerOutage: _providerOutage, ...missingProviderOutage } = minimal
    expect(rejects(trialOutcomeSchema, missingProviderOutage)).toBe(true)
    expect(rejects(trialOutcomeSchema, { ...minimal, extra: 1 })).toBe(true)
  })
})

describe('transcriptArtifactSchema', () => {
  const valid = {
    taskId: 'en-1',
    lang: 'en',
    round: 0,
    path: 'transcripts/round-0/en/en-1.jsonl',
    sha256: 'a'.repeat(64),
  }

  it('accepts and preserves a transcript artifact', () => {
    expect(transcriptArtifactSchema.parse(valid)).toStrictEqual(valid)
  })

  it('rejects negative and fractional rounds', () => {
    expect(rejects(transcriptArtifactSchema, { ...valid, round: -1 })).toBe(true)
    expect(rejects(transcriptArtifactSchema, { ...valid, round: 1.5 })).toBe(true)
    expect(transcriptArtifactSchema.parse({ ...valid, round: 3 }).round).toBe(3)
  })

  it('rejects an unknown language and empty required strings', () => {
    expect(rejects(transcriptArtifactSchema, { ...valid, lang: 'de' })).toBe(true)
    expect(rejects(transcriptArtifactSchema, { ...valid, taskId: '' })).toBe(true)
    expect(rejects(transcriptArtifactSchema, { ...valid, path: '' })).toBe(true)
  })

  it('rejects a malformed digest', () => {
    expect(rejects(transcriptArtifactSchema, { ...valid, sha256: 'A'.repeat(64) })).toBe(true)
    expect(rejects(transcriptArtifactSchema, { ...valid, sha256: 'a'.repeat(63) })).toBe(true)
    expect(rejects(transcriptArtifactSchema, { ...valid, sha256: 'a'.repeat(65) })).toBe(true)
  })

  it('rejects a missing field and an unknown key', () => {
    const { path: _path, ...missingPath } = valid
    expect(rejects(transcriptArtifactSchema, missingPath)).toBe(true)
    expect(rejects(transcriptArtifactSchema, { ...valid, extra: true })).toBe(true)
  })
})

describe('runSummarySchema', () => {
  const valid = {
    requestedRounds: 2,
    attempts: 2,
    completed: 2,
    failed: 0,
    failureRate: 0,
    trials: 2,
    failedTrials: 0,
  }

  it('accepts zero counts and a zero failure rate exactly', () => {
    const zero = {
      requestedRounds: 0,
      attempts: 0,
      completed: 0,
      failed: 0,
      failureRate: 0,
      trials: 0,
      failedTrials: 0,
    }

    expect(runSummarySchema.parse(zero)).toStrictEqual(zero)
  })

  it('accepts a failure rate of 1', () => {
    expect(
      runSummarySchema.parse({ ...valid, failed: 2, completed: 0, failureRate: 1 }).failureRate,
    ).toBe(1)
  })

  it('rejects a failure rate outside [0, 1] or non-finite', () => {
    expect(rejects(runSummarySchema, { ...valid, failureRate: -0.01 })).toBe(true)
    expect(rejects(runSummarySchema, { ...valid, failureRate: 1.01 })).toBe(true)
    expect(rejects(runSummarySchema, { ...valid, failureRate: Number.POSITIVE_INFINITY })).toBe(
      true,
    )
    expect(rejects(runSummarySchema, { ...valid, failureRate: Number.NaN })).toBe(true)
  })

  it('rejects negative or fractional counts for every count field', () => {
    for (const field of [
      'requestedRounds',
      'attempts',
      'completed',
      'failed',
      'trials',
      'failedTrials',
    ] as const) {
      expect(rejects(runSummarySchema, { ...valid, [field]: -1 })).toBe(true)
      expect(rejects(runSummarySchema, { ...valid, [field]: 1.5 })).toBe(true)
    }
  })

  it('rejects a missing count and an unknown key', () => {
    const { failedTrials: _failedTrials, ...missingFailedTrials } = valid
    expect(rejects(runSummarySchema, missingFailedTrials)).toBe(true)
    expect(rejects(runSummarySchema, { ...valid, extra: true })).toBe(true)
  })
})

describe('taskPassMetricSchema', () => {
  const valid = { lang: 'en', taskId: 'en-1', trials: 2, successes: 1, pass1: 0.5 }

  it('accepts and preserves a per-task pass metric', () => {
    expect(taskPassMetricSchema.parse(valid)).toStrictEqual(valid)
  })

  it('accepts an optional passK', () => {
    const withPassK = { ...valid, passK: 0.5 }
    expect(taskPassMetricSchema.parse(withPassK)).toStrictEqual(withPassK)
  })

  it('accepts pass1 boundaries 0 and 1 and rejects out-of-range values', () => {
    expect(taskPassMetricSchema.parse({ ...valid, pass1: 0 }).pass1).toBe(0)
    expect(taskPassMetricSchema.parse({ ...valid, pass1: 1 }).pass1).toBe(1)
    expect(rejects(taskPassMetricSchema, { ...valid, pass1: -0.01 })).toBe(true)
    expect(rejects(taskPassMetricSchema, { ...valid, pass1: 1.01 })).toBe(true)
  })

  it('accepts passK boundaries 0 and 1 and rejects out-of-range values', () => {
    expect(taskPassMetricSchema.parse({ ...valid, passK: 0 }).passK).toBe(0)
    expect(taskPassMetricSchema.parse({ ...valid, passK: 1 }).passK).toBe(1)
    expect(rejects(taskPassMetricSchema, { ...valid, passK: -0.01 })).toBe(true)
    expect(rejects(taskPassMetricSchema, { ...valid, passK: 1.01 })).toBe(true)
  })

  it('rejects negative or fractional counts and empty identifiers', () => {
    expect(rejects(taskPassMetricSchema, { ...valid, trials: -1 })).toBe(true)
    expect(rejects(taskPassMetricSchema, { ...valid, trials: 1.5 })).toBe(true)
    expect(rejects(taskPassMetricSchema, { ...valid, successes: -1 })).toBe(true)
    expect(rejects(taskPassMetricSchema, { ...valid, successes: 1.5 })).toBe(true)
    expect(rejects(taskPassMetricSchema, { ...valid, lang: '' })).toBe(true)
    expect(rejects(taskPassMetricSchema, { ...valid, taskId: '' })).toBe(true)
  })

  it('rejects a missing pass1 and an unknown key', () => {
    const { pass1: _pass1, ...missingPass1 } = valid
    expect(rejects(taskPassMetricSchema, missingPass1)).toBe(true)
    expect(rejects(taskPassMetricSchema, { ...valid, extra: true })).toBe(true)
  })
})

describe('passMetricsSchema', () => {
  const task = { lang: 'en', taskId: 'en-1', trials: 2, successes: 1, pass1: 0.5 }
  const valid = { k: 1, pass1: 0.5, passK: 0.5, tasks: [task] }

  it('accepts and preserves a reliability view, including an empty task list', () => {
    expect(passMetricsSchema.parse(valid)).toStrictEqual(valid)
    expect(passMetricsSchema.parse({ ...valid, tasks: [] })).toStrictEqual({
      ...valid,
      tasks: [],
    })
  })

  it('requires a positive integer k', () => {
    expect(passMetricsSchema.parse({ ...valid, k: 1 }).k).toBe(1)
    expect(rejects(passMetricsSchema, { ...valid, k: 0 })).toBe(true)
    expect(rejects(passMetricsSchema, { ...valid, k: -1 })).toBe(true)
    expect(rejects(passMetricsSchema, { ...valid, k: 1.5 })).toBe(true)
  })

  it('accepts pass1 and passK boundaries and rejects out-of-range values', () => {
    expect(passMetricsSchema.parse({ ...valid, pass1: 0, passK: 0 }).pass1).toBe(0)
    expect(passMetricsSchema.parse({ ...valid, pass1: 1, passK: 1 }).passK).toBe(1)
    expect(rejects(passMetricsSchema, { ...valid, pass1: -0.01 })).toBe(true)
    expect(rejects(passMetricsSchema, { ...valid, pass1: 1.01 })).toBe(true)
    expect(rejects(passMetricsSchema, { ...valid, passK: -0.01 })).toBe(true)
    expect(rejects(passMetricsSchema, { ...valid, passK: 1.01 })).toBe(true)
  })

  it('rejects a missing k and an unknown key', () => {
    const { k: _k, ...missingK } = valid
    expect(rejects(passMetricsSchema, missingK)).toBe(true)
    expect(rejects(passMetricsSchema, { ...valid, extra: true })).toBe(true)
  })
})

describe('runResultSchema whole-artifact refinements', () => {
  it('accepts a fully valid artifact without passMetrics', () => {
    const artifact = validArtifact()

    expect(parseRunResult(artifact)).toStrictEqual(artifact)
    expect(artifact).not.toHaveProperty('passMetrics')
  })

  it('accepts a fully valid artifact with passMetrics', () => {
    const artifact = {
      ...validArtifact(),
      passMetrics: passMetricsSchema.parse({
        k: 2,
        pass1: 0.5,
        passK: 0.5,
        tasks: [{ lang: 'en', taskId: 'en-1', trials: 2, successes: 1, pass1: 0.5, passK: 0.5 }],
      }),
    }

    expect(parseRunResult(artifact)).toStrictEqual(artifact)
  })

  it('rejects a runId that differs from the embedded manifest run id', () => {
    const raw = cloneArtifact()
    raw.runId = 'suite-b'

    expectCustomIssue(
      runResultSchema,
      raw,
      ['runId'],
      'runId "suite-b" does not match the embedded manifest run id "suite-a"',
    )
  })

  it('rejects a manifestHash that does not match the embedded manifest', () => {
    const raw = cloneArtifact()
    raw.manifestHash = '0'.repeat(64)

    expectCustomIssue(
      runResultSchema,
      raw,
      ['manifestHash'],
      'manifestHash does not match the embedded manifest; the registration was altered',
    )
  })

  it('rejects a summary trial count that differs from the trial outcomes', () => {
    const raw = cloneArtifact()
    raw.summary.trials = 3

    expectCustomIssue(
      runResultSchema,
      raw,
      ['summary', 'trials'],
      'trials 3 does not match 2 trial outcomes',
    )
  })

  it('rejects a failedTrials count that differs from the failed outcomes', () => {
    const raw = cloneArtifact()
    raw.summary.failedTrials = 1

    expectCustomIssue(
      runResultSchema,
      raw,
      ['summary', 'failedTrials'],
      'failedTrials 1 does not match 0 failed trial outcomes',
    )
  })

  it('rejects a completed count that is not attempts minus failed rounds', () => {
    const raw = cloneArtifact()
    raw.summary.completed = 1

    expectCustomIssue(
      runResultSchema,
      raw,
      ['summary', 'completed'],
      'completed count does not match attempts minus failed rounds',
    )
  })

  it('rejects requestedRounds that differs from the registered round limit', () => {
    const raw = cloneArtifact()
    raw.summary.requestedRounds = 1

    expectCustomIssue(
      runResultSchema,
      raw,
      ['summary', 'requestedRounds'],
      'requestedRounds 1 does not match the registered round limit 2',
    )
  })

  it('rejects a verdict outage count that differs from the trial outcomes', () => {
    const raw = cloneArtifact()
    raw.verdict.providerOutages = 1

    expectCustomIssue(
      runResultSchema,
      raw,
      ['verdict', 'providerOutages'],
      'verdict records 1 provider outage(s) but 0 trial(s) report one',
    )
  })

  it('rejects a failureRate that does not match failed rounds over attempts', () => {
    const raw = cloneArtifact()
    raw.summary.failureRate = 0.5

    expectCustomIssue(
      runResultSchema,
      raw,
      ['summary', 'failureRate'],
      'failureRate 0.5 does not match 0',
    )
  })

  it('treats a rate within 1e-12 of the computed failure rate as equal', () => {
    const raw = cloneArtifact()
    raw.summary.attempts = 1
    raw.summary.completed = 1
    raw.summary.trials = 1
    raw.trials = [raw.trials[0]!]
    raw.transcripts = [raw.transcripts[0]!]
    raw.summary.failureRate = 1e-12
    raw.verdict = computeVerdict({
      manifest: raw.manifest,
      metrics: raw.metrics,
      rounds: { requested: 2, attempts: 1, completed: 1 },
      invariants: raw.invariants,
      providerOutages: 0,
    })

    expect(runResultSchema.safeParse(raw).success).toBe(true)
  })

  it('rejects a verdict that does not match a recomputation from the artifact', () => {
    const raw = cloneArtifact()
    raw.metrics['turn.taking_rate'] = 0.9

    expectCustomIssue(
      runResultSchema,
      raw,
      ['verdict'],
      'verdict does not match a recomputation from the embedded manifest, metrics, trials and transcript checks',
    )
  })

  it('rejects an artifact whose failed-round counts and verdict agree but whose failure rate does not', () => {
    const raw = cloneArtifact()
    raw.trials[0]!.ok = false
    raw.summary.failedTrials = 1
    raw.summary.failed = 1
    raw.summary.completed = 1
    raw.summary.failureRate = 0.25
    raw.verdict = computeVerdict({
      manifest: raw.manifest,
      metrics: raw.metrics,
      rounds: { requested: 2, attempts: 2, completed: 1 },
      invariants: raw.invariants,
      providerOutages: 0,
    })

    expectCustomIssue(
      runResultSchema,
      raw,
      ['summary', 'failureRate'],
      'failureRate 0.25 does not match 0.5',
    )
  })

  it('treats a zero-attempt run as a failure rate of 1', () => {
    const raw = cloneArtifact()
    raw.trials = []
    raw.transcripts = []
    raw.summary = {
      requestedRounds: 2,
      attempts: 0,
      completed: 0,
      failed: 0,
      failureRate: 1,
      trials: 0,
      failedTrials: 0,
    }
    raw.verdict = computeVerdict({
      manifest: raw.manifest,
      metrics: raw.metrics,
      rounds: { requested: 2, attempts: 0, completed: 0 },
      invariants: raw.invariants,
      providerOutages: 0,
    })

    expect(runResultSchema.safeParse(raw).success).toBe(true)

    raw.summary.failureRate = 0
    expectCustomIssue(
      runResultSchema,
      raw,
      ['summary', 'failureRate'],
      'failureRate 0 does not match 1',
    )
  })

  it('accepts a failed round when counts and the recomputed verdict agree', () => {
    const raw = cloneArtifact()
    raw.trials[0]!.ok = false
    raw.summary.failedTrials = 1
    raw.summary.failed = 1
    raw.summary.completed = 1
    raw.summary.failureRate = 0.5
    raw.verdict = computeVerdict({
      manifest: raw.manifest,
      metrics: raw.metrics,
      rounds: { requested: 2, attempts: 2, completed: 1 },
      invariants: raw.invariants,
      providerOutages: 0,
    })

    expect(parseRunResult(raw)).toStrictEqual(raw)
    expect(raw.verdict.status).toBe('accepted')
  })

  it('accepts an infrastructure-inconclusive run when outage counts agree', () => {
    const raw = cloneArtifact()
    raw.trials[1]!.ok = false
    raw.trials[1]!.providerOutage = true
    raw.trials[1]!.error = 'provider call failed'
    raw.summary.failedTrials = 1
    raw.summary.failed = 1
    raw.summary.completed = 1
    raw.summary.failureRate = 0.5
    raw.verdict = computeVerdict({
      manifest: raw.manifest,
      metrics: raw.metrics,
      rounds: { requested: 2, attempts: 2, completed: 1 },
      invariants: raw.invariants,
      providerOutages: 1,
    })

    expect(parseRunResult(raw)).toStrictEqual(raw)
    expect(raw.verdict.status).toBe('infrastructure_inconclusive')
  })

  it('rejects an unknown top-level key', () => {
    const raw = { ...validArtifact(), extra: true }
    expect(rejects(runResultSchema, raw)).toBe(true)
  })
})

describe('parseRunResult', () => {
  it('parses a valid artifact to the same structure', () => {
    const artifact = validArtifact()
    expect(parseRunResult(artifact)).toStrictEqual(artifact)
  })

  it('throws a ZodError on invalid input', () => {
    const raw = cloneArtifact()
    raw.runId = 'suite-b'

    expect(() => parseRunResult(raw)).toThrow(ZodError)
  })
})

describe('transcriptRelativePath', () => {
  it('writes round 0 under the language directory', () => {
    expect(transcriptRelativePath(0, 'en', 'en-1')).toBe('transcripts/round-0/en/en-1.jsonl')
  })

  it('preserves safe identifier characters', () => {
    expect(transcriptRelativePath(2, 'fr', 'fr-b1_report.deadline-001')).toBe(
      'transcripts/round-2/fr/fr-b1_report.deadline-001.jsonl',
    )
  })

  it('replaces every unsafe character with an underscore', () => {
    expect(transcriptRelativePath(1, 'en', 'a b/c:d*e?f')).toBe(
      'transcripts/round-1/en/a_b_c_d_e_f.jsonl',
    )
    expect(transcriptRelativePath(1, 'en', '..\\escape|id"<>')).toBe(
      'transcripts/round-1/en/.._escape_id___.jsonl',
    )
  })
})

describe('buildVersions', () => {
  it('maps every manifest stamp and omits the absent optionals', () => {
    const versions = buildVersions({ manifest: validManifest() })

    expect(versions).toStrictEqual({
      transcriptSchemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      taskDataset: 'fixture-set',
      taskVersion: 'v1',
      graderId: 'deterministic-invariants',
      graderKind: 'code',
      graderVersion: '1.0.0',
      rubricVersion: 'rubric-v1',
      seed: 7,
    })
    expect(versions).not.toHaveProperty('codeSha')
    expect(versions).not.toHaveProperty('graderModel')
  })

  it('includes codeSha and the grader model when the caller and manifest supply them', () => {
    const manifest = runManifestSchema.parse({
      ...MANIFEST_INPUT,
      grader: {
        id: 'jev',
        kind: 'system-one-model',
        version: 'typesafe/jev-1.14',
        model: 'typesafe/jev-1.14',
      },
    })
    const versions = buildVersions({ manifest, codeSha: 'abc1234' })

    expect(versions).toStrictEqual({
      codeSha: 'abc1234',
      transcriptSchemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      taskDataset: 'fixture-set',
      taskVersion: 'v1',
      graderId: 'jev',
      graderKind: 'system-one-model',
      graderVersion: 'typesafe/jev-1.14',
      graderModel: 'typesafe/jev-1.14',
      rubricVersion: 'rubric-v1',
      seed: 7,
    })
  })
})
