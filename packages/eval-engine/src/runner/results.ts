import { TRACE_SCHEMA_VERSION } from '@rp/session-core'
import { z } from 'zod'
import { langSchema } from '../fixtures/schema.js'
import {
  invariantResultSchema,
  manifestHash,
  metricNameSchema,
  runManifestSchema,
  type RunManifest,
} from './manifest.js'
import { runVerdictSchema } from './verdict.js'

/**
 * Persisted run artifact (M0 D3/D6, Architecture Plan v5 §4.1.8).
 *
 * One `result.json` per run plus the pre-registered manifest copy. The artifact
 * carries every version stamp needed to reproduce the decision (code SHA when
 * available, fixture dataset/version, scorer id/version and judge model, rubric
 * version, seed, trace schema version) and per-axis metrics only — there is no
 * composite score field anywhere, by design (§4.1.7).
 *
 * A committed baseline under `evals/baselines/<suite>.json` is the same shape
 * with `verdict.status === "accepted"`, so `compare` can read either one.
 */

export const RUN_RESULT_SCHEMA_VERSION = '1.0.0'

const hex64Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 hex digest')

export const metricReadingsSchema = z
  .record(metricNameSchema, z.number().finite())
  .superRefine((readings, ctx) => {
    if (Object.keys(readings).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'at least one per-axis metric is required',
      })
    }
  })

export type MetricReadings = z.infer<typeof metricReadingsSchema>

export const versionsSchema = z.strictObject({
  /** Git commit of the code under test, when the caller could resolve one. */
  codeSha: z.string().min(1).optional(),
  traceSchemaVersion: z.string().min(1),
  fixtureDataset: z.string().min(1),
  fixtureVersion: z.string().min(1),
  scorerId: z.string().min(1),
  scorerVersion: z.string().min(1),
  judgeModel: z.string().min(1).optional(),
  rubricVersion: z.string().min(1),
  seed: z.int().nonnegative(),
})

export type RunVersions = z.infer<typeof versionsSchema>

export const repetitionOutcomeSchema = z.strictObject({
  repetition: z.int().nonnegative(),
  fixtureId: z.string().min(1),
  lang: langSchema,
  ok: z.boolean(),
  /** Number of trace records the repetition produced. */
  records: z.int().nonnegative(),
  /** SHA-256 of the normalized JSONL trace, when the repetition produced one. */
  traceSha256: hex64Schema.optional(),
  /** Path relative to the run directory. */
  tracePath: z.string().min(1).optional(),
  /** Last simulated timestamp in the trace, in milliseconds. */
  simDurationMs: z.number().finite().nonnegative().optional(),
  /** Set only for failed repetitions; never turned into a score of zero. */
  error: z.string().min(1).optional(),
  /** True when the failure came from the provider/API surface. */
  providerOutage: z.boolean(),
})

export type RepetitionOutcome = z.infer<typeof repetitionOutcomeSchema>

export const traceArtifactSchema = z.strictObject({
  fixtureId: z.string().min(1),
  lang: langSchema,
  repetition: z.int().nonnegative(),
  /** Path relative to the run directory. */
  path: z.string().min(1),
  sha256: hex64Schema,
})

export type TraceArtifact = z.infer<typeof traceArtifactSchema>

export const runSummarySchema = z.strictObject({
  /** Repetition passes pre-registered in the manifest. */
  requestedRepetitions: z.int().nonnegative(),
  /** Repetition passes attempted. A pass covers every selected fixture. */
  attempts: z.int().nonnegative(),
  /** Passes where every fixture execution succeeded. */
  completed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  failureRate: z.number().finite().min(0).max(1),
  /** Fixture executions across all passes (fixtures × repetitions). */
  executions: z.int().nonnegative(),
  failedExecutions: z.int().nonnegative(),
})

export type RunSummary = z.infer<typeof runSummarySchema>

export const runResultSchema = z
  .strictObject({
    schemaVersion: z.literal(RUN_RESULT_SCHEMA_VERSION),
    runId: z.string().min(1),
    suite: z.string().min(1),
    manifestHash: hex64Schema,
    manifest: runManifestSchema,
    verdict: runVerdictSchema,
    /** Per-axis measurements. No composite score exists on purpose. */
    metrics: metricReadingsSchema,
    invariants: z.array(invariantResultSchema),
    repetitions: z.array(repetitionOutcomeSchema),
    traces: z.array(traceArtifactSchema),
    summary: runSummarySchema,
    versions: versionsSchema,
    startedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((result, ctx) => {
    if (result.runId !== result.manifest.run.runId) {
      ctx.addIssue({
        code: 'custom',
        path: ['runId'],
        message: `runId "${result.runId}" does not match the embedded manifest run id "${result.manifest.run.runId}"`,
      })
    }

    if (result.manifestHash !== manifestHash(result.manifest)) {
      ctx.addIssue({
        code: 'custom',
        path: ['manifestHash'],
        message: 'manifestHash does not match the embedded manifest; the registration was altered',
      })
    }

    if (result.summary.executions !== result.repetitions.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary', 'executions'],
        message: `executions ${result.summary.executions} does not match ${result.repetitions.length} repetition outcomes`,
      })
    }

    const failedExecutions = result.repetitions.filter((outcome) => !outcome.ok).length
    if (result.summary.failedExecutions !== failedExecutions) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary', 'failedExecutions'],
        message: `failedExecutions ${result.summary.failedExecutions} does not match ${failedExecutions} failed repetition outcomes`,
      })
    }

    if (result.summary.completed !== result.summary.attempts - result.summary.failed) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary', 'completed'],
        message: 'completed count does not match attempts minus failed passes',
      })
    }
  })

export type RunResult = z.infer<typeof runResultSchema>

/** Parse a stored run/baseline artifact, throwing a ZodError on invalid input. */
export function parseRunResult(input: unknown): RunResult {
  return runResultSchema.parse(input)
}

/** Relative layout for one normalized trace file inside a run directory. */
export function traceRelativePath(repetition: number, lang: string, fixtureId: string): string {
  const safeId = fixtureId.replace(/[^A-Za-z0-9._-]/g, '_')
  return `traces/rep-${repetition}/${lang}/${safeId}.jsonl`
}

/** Version stamps for a completed run. Wall-clock time is only run metadata. */
export function buildVersions(input: {
  readonly manifest: RunManifest
  readonly codeSha?: string | undefined
}): RunVersions {
  const { manifest } = input
  return {
    ...(input.codeSha === undefined ? {} : { codeSha: input.codeSha }),
    traceSchemaVersion: TRACE_SCHEMA_VERSION,
    fixtureDataset: manifest.fixtures.dataset,
    fixtureVersion: manifest.fixtures.version,
    scorerId: manifest.scorer.id,
    scorerVersion: manifest.scorer.version,
    ...(manifest.scorer.judgeModel === undefined ? {} : { judgeModel: manifest.scorer.judgeModel }),
    rubricVersion: manifest.rubric.version,
    seed: manifest.seeds.master,
  }
}
