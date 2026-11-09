import { canonicalJson } from '@rp/shared'
import { TRANSCRIPT_SCHEMA_VERSION } from '@rp/session-core'
import { z } from 'zod'
import { langSchema } from '../tasks/schema.js'
import {
  graderKindSchema,
  invariantResultSchema,
  manifestHash,
  metricNameSchema,
  runManifestSchema,
  type RunManifest,
} from './manifest.js'
import { computeVerdict, runVerdictSchema } from './verdict.js'

/**
 * Persisted run artifact (M0 D3/D6, Architecture Plan v5 §4.1.8).
 *
 * One `result.json` per run plus the pre-registered manifest copy. The artifact
 * carries every version stamp needed to reproduce the decision (code SHA when
 * available, task dataset/version, grader id/version and judge model, rubric
 * version, seed, transcript schema version) and per-axis metrics only — there is no
 * composite score field anywhere, by design (§4.1.7).
 *
 * A committed baseline under `evals/baselines/<suite>.json` is the same shape
 * with `verdict.status === "accepted"`, so `compare` can read either one.
 */

export const RUN_RESULT_SCHEMA_VERSION = '3.0.0'

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
  transcriptSchemaVersion: z.string().min(1),
  taskDataset: z.string().min(1),
  taskVersion: z.string().min(1),
  graderId: z.string().min(1),
  graderKind: graderKindSchema,
  graderVersion: z.string().min(1),
  graderModel: z.string().min(1).optional(),
  rubricVersion: z.string().min(1),
  seed: z.int().nonnegative(),
})

export type RunVersions = z.infer<typeof versionsSchema>

export const trialOutcomeSchema = z.strictObject({
  /** The round this trial belongs to. */
  round: z.int().nonnegative(),
  taskId: z.string().min(1),
  lang: langSchema,
  ok: z.boolean(),
  /** Number of transcript records the trial produced. */
  records: z.int().nonnegative(),
  /** SHA-256 of the normalized JSONL transcript, when the trial produced one. */
  transcriptSha256: hex64Schema.optional(),
  /** Path relative to the run directory. */
  transcriptPath: z.string().min(1).optional(),
  /** Last simulated timestamp in the transcript, in milliseconds. */
  simDurationMs: z.number().finite().nonnegative().optional(),
  /** Set only for failed trials; never turned into a score of zero. */
  error: z.string().min(1).optional(),
  /** True when the failure came from the provider/API surface. */
  providerOutage: z.boolean(),
})

export type TrialOutcome = z.infer<typeof trialOutcomeSchema>

export const transcriptArtifactSchema = z.strictObject({
  taskId: z.string().min(1),
  lang: langSchema,
  round: z.int().nonnegative(),
  /** Path relative to the run directory. */
  path: z.string().min(1),
  sha256: hex64Schema,
})

export type TranscriptArtifact = z.infer<typeof transcriptArtifactSchema>

export const runSummarySchema = z.strictObject({
  /** Rounds pre-registered in the manifest. */
  requestedRounds: z.int().nonnegative(),
  /** Rounds attempted. A round covers every selected task. */
  attempts: z.int().nonnegative(),
  /** Rounds where every trial succeeded. */
  completed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  failureRate: z.number().finite().min(0).max(1),
  /** Trials across all rounds (tasks × rounds). */
  trials: z.int().nonnegative(),
  failedTrials: z.int().nonnegative(),
})

export type RunSummary = z.infer<typeof runSummarySchema>

export const taskPassMetricSchema = z.strictObject({
  lang: z.string().min(1),
  taskId: z.string().min(1),
  trials: z.int().nonnegative(),
  successes: z.int().nonnegative(),
  pass1: z.number().finite().min(0).max(1),
  passK: z.number().finite().min(0).max(1).optional(),
})

export const passMetricsSchema = z.strictObject({
  k: z.int().positive(),
  pass1: z.number().finite().min(0).max(1),
  passK: z.number().finite().min(0).max(1).optional(),
  tasks: z.array(taskPassMetricSchema),
})

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
    /** Reliability view over the same trials; reported with pass^1, never alone. */
    passMetrics: passMetricsSchema.optional(),
    trials: z.array(trialOutcomeSchema),
    transcripts: z.array(transcriptArtifactSchema),
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

    if (result.summary.trials !== result.trials.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary', 'trials'],
        message: `trials ${result.summary.trials} does not match ${result.trials.length} trial outcomes`,
      })
    }

    const failedTrials = result.trials.filter((trial) => !trial.ok).length
    if (result.summary.failedTrials !== failedTrials) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary', 'failedTrials'],
        message: `failedTrials ${result.summary.failedTrials} does not match ${failedTrials} failed trial outcomes`,
      })
    }

    if (result.summary.completed !== result.summary.attempts - result.summary.failed) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary', 'completed'],
        message: 'completed count does not match attempts minus failed rounds',
      })
    }

    if (result.summary.requestedRounds !== result.manifest.limits.rounds) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary', 'requestedRounds'],
        message: `requestedRounds ${result.summary.requestedRounds} does not match the registered round limit ${result.manifest.limits.rounds}`,
      })
    }

    const providerOutages = result.trials.filter((trial) => trial.providerOutage).length
    if (result.verdict.providerOutages !== providerOutages) {
      ctx.addIssue({
        code: 'custom',
        path: ['verdict', 'providerOutages'],
        message: `verdict records ${result.verdict.providerOutages} provider outage(s) but ${providerOutages} trial(s) report one`,
      })
    }

    const expectedFailureRate =
      result.summary.attempts === 0 ? 1 : result.summary.failed / result.summary.attempts
    if (Math.abs(result.summary.failureRate - expectedFailureRate) > 1e-12) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary', 'failureRate'],
        message: `failureRate ${result.summary.failureRate} does not match ${expectedFailureRate}`,
      })
    }

    const recomputedVerdict = computeVerdict({
      manifest: result.manifest,
      metrics: result.metrics,
      rounds: {
        requested: result.summary.requestedRounds,
        attempts: result.summary.attempts,
        completed: result.summary.completed,
      },
      invariants: result.invariants,
      providerOutages,
    })

    if (canonicalJson(recomputedVerdict) !== canonicalJson(result.verdict)) {
      ctx.addIssue({
        code: 'custom',
        path: ['verdict'],
        message:
          'verdict does not match a recomputation from the embedded manifest, metrics, trials and transcript checks',
      })
    }
  })

export type RunResult = z.infer<typeof runResultSchema>

/** Parse a stored run/baseline artifact, throwing a ZodError on invalid input. */
export function parseRunResult(input: unknown): RunResult {
  return runResultSchema.parse(input)
}

/** Relative layout for one normalized transcript file inside a run directory. */
export function transcriptRelativePath(round: number, lang: string, taskId: string): string {
  const safeId = taskId.replace(/[^A-Za-z0-9._-]/g, '_')
  return `transcripts/round-${round}/${lang}/${safeId}.jsonl`
}

/** Version stamps for a completed run. Wall-clock time is only run metadata. */
export function buildVersions(input: {
  readonly manifest: RunManifest
  readonly codeSha?: string | undefined
}): RunVersions {
  const { manifest } = input
  return {
    ...(input.codeSha === undefined ? {} : { codeSha: input.codeSha }),
    transcriptSchemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    taskDataset: manifest.tasks.dataset,
    taskVersion: manifest.tasks.version,
    graderId: manifest.grader.id,
    graderKind: manifest.grader.kind,
    graderVersion: manifest.grader.version,
    ...(manifest.grader.model === undefined ? {} : { graderModel: manifest.grader.model }),
    rubricVersion: manifest.rubric.version,
    seed: manifest.seeds.master,
  }
}
