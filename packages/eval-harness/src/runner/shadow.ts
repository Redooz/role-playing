import type { JevBatchSuccess } from '../jev/types.js'
import type { JevRoutingJudge } from '../jev/routing.js'
import {
  DETERMINISTIC_POLICY_VERSION,
  routingDecisionSchema,
  routingYieldReasonSchema,
  type RoutingContext,
  type RoutingDecision,
} from '@rp/routing-policy'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  runDeterministicRoutingReplay,
  runJevRoutingReplay,
  JEV_CENTRAL_POLICY_VERSION,
  JEV_PERSONA_POLICY_VERSION,
  type RoutingExactObservation,
  type RoutingReplayResult,
} from './routing.js'

/**
 * Shadow routing arms (M3b D4).
 *
 * The live control arm (`det-persona`) already made the session decision. The
 * three non-live arms run afterwards on the same public context and record what
 * they would have decided. They cannot emit events, grant a turn, revoke a turn
 * or change the transcript: this module has no session dependency and only
 * returns records.
 */

export const SHADOW_SCHEMA_VERSION = '1.0.0'
export const SHADOW_DEADLINE_MS = 2_500
export const SHADOW_ARM_IDS = ['jev-persona', 'det-central', 'jev-central'] as const
export type ShadowArmId = (typeof SHADOW_ARM_IDS)[number]

const shadowArmIdSchema = z.enum(SHADOW_ARM_IDS)

export const shadowOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('speak'), personaId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('user_yield'), reason: routingYieldReasonSchema }),
  z.strictObject({ kind: z.literal('infrastructure_incomplete') }),
])

export type ShadowOutcome = z.infer<typeof shadowOutcomeSchema>

export const shadowUsageSchema = z.strictObject({
  inputTokens: z.int().nonnegative().nullable(),
  outputTokens: z.int().nonnegative().nullable(),
  costUsd: z.number().finite().nonnegative().nullable(),
})

export type ShadowUsage = z.infer<typeof shadowUsageSchema>

export const shadowRecordSchema = z.strictObject({
  schemaVersion: z.literal(SHADOW_SCHEMA_VERSION),
  kind: z.literal('routing.shadow'),
  contentClass: z.literal('restricted'),
  taskId: z.string().min(1),
  lang: z.enum(['en', 'fr']),
  arm: shadowArmIdSchema,
  policyVersion: z.string().min(1),
  decision: routingDecisionSchema.nullable(),
  outcome: shadowOutcomeSchema,
  fallbackCause: z.enum(['timeout', 'unsettled']).nullable(),
  unsettled: z.boolean(),
  latencyMs: z.number().finite().nonnegative(),
  usage: shadowUsageSchema.nullable(),
  agreement: z.boolean().nullable(),
  observation: z.unknown(),
  error: z.string().min(1).optional(),
})

export type ShadowRecord = z.infer<typeof shadowRecordSchema>

export const shadowArmSummarySchema = z.strictObject({
  arm: shadowArmIdSchema,
  records: z.int().nonnegative(),
  completed: z.int().nonnegative(),
  incomplete: z.int().nonnegative(),
  speak: z.int().nonnegative(),
  yield: z.int().nonnegative(),
  agreements: z.int().nonnegative(),
  disagreements: z.int().nonnegative(),
  agreementRate: z.number().min(0).max(1).nullable(),
  timeoutFallbacks: z.int().nonnegative(),
  unsettledFallbacks: z.int().nonnegative(),
  latencyMs: z
    .strictObject({
      p50: z.number().finite().nonnegative(),
      p95: z.number().finite().nonnegative(),
    })
    .nullable(),
  usage: shadowUsageSchema.nullable(),
})

export const shadowSummarySchema = z
  .strictObject({
    schemaVersion: z.literal(SHADOW_SCHEMA_VERSION),
    kind: z.literal('routing.shadow.summary'),
    contentClass: z.literal('restricted'),
    taskId: z.string().min(1),
    lang: z.enum(['en', 'fr']),
    records: z.int().nonnegative(),
    arms: z.array(shadowArmSummarySchema),
  })
  .superRefine((summary, ctx) => {
    const total = summary.arms.reduce((count, arm) => count + arm.records, 0)
    if (total !== summary.records) {
      ctx.addIssue({
        code: 'custom',
        path: ['records'],
        message: `summary records ${summary.records} do not match arm total ${total}`,
      })
    }
  })

export type ShadowSummary = z.infer<typeof shadowSummarySchema>

export interface ShadowRunInput {
  readonly taskId: string
  readonly context: RoutingContext
  readonly liveDecision: RoutingDecision
  readonly seed: number
  /** Defaults to the M3a shadow deadline; it is never a live turn deadline. */
  readonly deadlineMs?: number
}

export interface ShadowRunResult {
  readonly records: readonly ShadowRecord[]
  readonly summary: ShadowSummary
}

function outcomeOf(decision: RoutingDecision): ShadowOutcome {
  return decision.outcome.kind === 'speak'
    ? { kind: 'speak', personaId: decision.outcome.personaId }
    : { kind: 'user_yield', reason: decision.outcome.reason }
}

function sameOutcome(left: ShadowOutcome, right: ShadowOutcome): boolean | null {
  if (left.kind === 'infrastructure_incomplete' || right.kind === 'infrastructure_incomplete') {
    return null
  }
  if (left.kind !== right.kind) return false
  if (left.kind === 'speak' && right.kind === 'speak') {
    return left.personaId === right.personaId
  }
  if (left.kind === 'user_yield' && right.kind === 'user_yield') {
    return left.reason === right.reason
  }
  return false
}

function usageFromObservation(observation: RoutingExactObservation): ShadowUsage | null {
  const batches: JevBatchSuccess[] = []
  if (observation.central !== undefined) batches.push(observation.central.exact)
  for (const persona of Object.values(observation.personas ?? {})) batches.push(persona.exact)
  if (batches.length === 0) return null

  const inputKnown = batches.every(
    (batch) => Number.isFinite(batch.usage.input_tokens) && batch.usage.input_tokens >= 0,
  )
  const outputKnown = batches.every(
    (batch) => Number.isFinite(batch.usage.output_tokens) && batch.usage.output_tokens >= 0,
  )
  const costKnown = batches.every(
    (batch) => batch.usage.cost !== undefined && Number.isFinite(batch.usage.cost),
  )

  return {
    inputTokens: inputKnown
      ? batches.reduce((total, batch) => total + batch.usage.input_tokens, 0)
      : null,
    outputTokens: outputKnown
      ? batches.reduce((total, batch) => total + batch.usage.output_tokens, 0)
      : null,
    costUsd: costKnown
      ? batches.reduce((total, batch) => total + (batch.usage.cost ?? 0), 0)
      : null,
  }
}

function fallbackCauseOf(decision: RoutingDecision): 'timeout' | 'unsettled' | null {
  if (decision.fallback.kind !== 'deterministic') return null
  return decision.fallback.cause
}

function policyVersionFor(arm: ShadowArmId): string {
  if (arm === 'det-central') return DETERMINISTIC_POLICY_VERSION
  return arm === 'jev-persona' ? JEV_PERSONA_POLICY_VERSION : JEV_CENTRAL_POLICY_VERSION
}

function recordFor(
  arm: ShadowArmId,
  input: ShadowRunInput,
  result: RoutingReplayResult,
): ShadowRecord {
  if (!result.ok) {
    return shadowRecordSchema.parse({
      schemaVersion: SHADOW_SCHEMA_VERSION,
      kind: 'routing.shadow',
      contentClass: 'restricted',
      taskId: input.taskId,
      lang: input.context.lang,
      arm,
      policyVersion: policyVersionFor(arm),
      decision: null,
      outcome: { kind: 'infrastructure_incomplete' },
      fallbackCause: null,
      unsettled: false,
      latencyMs: result.policyLatencyMs,
      usage: null,
      agreement: null,
      observation: { kind: 'none' },
      error: result.error.trim() === '' ? 'shadow policy failed without a message' : result.error,
    })
  }

  const decision = result.decision
  const outcome = outcomeOf(decision)
  return shadowRecordSchema.parse({
    schemaVersion: SHADOW_SCHEMA_VERSION,
    kind: 'routing.shadow',
    contentClass: 'restricted',
    taskId: input.taskId,
    lang: input.context.lang,
    arm,
    policyVersion: decision.policyVersion,
    decision,
    outcome,
    fallbackCause: fallbackCauseOf(decision),
    unsettled: decision.unsettledPersonas.length > 0 || fallbackCauseOf(decision) === 'unsettled',
    latencyMs: result.policyLatencyMs,
    usage: usageFromObservation(result.observation),
    agreement: sameOutcome(outcomeOf(input.liveDecision), outcome),
    observation: result.observation,
    ...(result.observation.kind === 'timeout'
      ? { error: 'shadow policy timed out; deterministic fallback recorded for audit only' }
      : {}),
  })
}

function percentile(values: readonly number[], point: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const rank = (sorted.length - 1) * point
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  const low = sorted[lower]!
  const high = sorted[upper]!
  return low + (high - low) * (rank - lower)
}

function sumUsage(records: readonly ShadowRecord[]): ShadowUsage | null {
  const values = records
    .map((record) => record.usage)
    .filter((usage): usage is ShadowUsage => usage !== null)
  if (values.length === 0) return null

  const sumKnown = (key: keyof ShadowUsage): number | null => {
    const parts = values.map((usage) => usage[key])
    if (parts.some((part) => part === null)) return null
    return parts.reduce<number>((total, part) => total + (part ?? 0), 0)
  }

  return {
    inputTokens: sumKnown('inputTokens'),
    outputTokens: sumKnown('outputTokens'),
    costUsd: sumKnown('costUsd'),
  }
}

function summarizeArm(arm: ShadowArmId, records: readonly ShadowRecord[]) {
  const completed = records.filter((record) => record.outcome.kind !== 'infrastructure_incomplete')
  const agreements = records.filter((record) => record.agreement === true).length
  const disagreements = records.filter((record) => record.agreement === false).length
  const judged = records.filter((record) => record.agreement !== null)
  const latencies = completed.map((record) => record.latencyMs)

  return shadowArmSummarySchema.parse({
    arm,
    records: records.length,
    completed: completed.length,
    incomplete: records.length - completed.length,
    speak: completed.filter((record) => record.outcome.kind === 'speak').length,
    yield: completed.filter((record) => record.outcome.kind === 'user_yield').length,
    agreements,
    disagreements,
    agreementRate: judged.length === 0 ? null : agreements / judged.length,
    timeoutFallbacks: records.filter((record) => record.fallbackCause === 'timeout').length,
    unsettledFallbacks: records.filter((record) => record.fallbackCause === 'unsettled').length,
    latencyMs:
      latencies.length === 0
        ? null
        : { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    usage: sumUsage(records),
  })
}

/** Aggregate records without forming a composite score or selecting an arm. */
export function summarizeShadowRecords(
  taskId: string,
  lang: 'en' | 'fr',
  records: readonly ShadowRecord[],
): ShadowSummary {
  const parsed = records.map((record) => shadowRecordSchema.parse(record))
  for (const record of parsed) {
    if (record.taskId !== taskId || record.lang !== lang) {
      throw new Error(
        `shadow record ${record.arm} belongs to ${record.taskId}/${record.lang}, not ${taskId}/${lang}`,
      )
    }
  }
  return shadowSummarySchema.parse({
    schemaVersion: SHADOW_SCHEMA_VERSION,
    kind: 'routing.shadow.summary',
    contentClass: 'restricted',
    taskId,
    lang,
    records: parsed.length,
    arms: SHADOW_ARM_IDS.map((arm) =>
      summarizeArm(
        arm,
        parsed.filter((record) => record.arm === arm),
      ),
    ),
  })
}

/**
 * Run the three non-live arms after the live control decision.
 *
 * The deterministic arm needs no provider. A Jev failure is an incomplete
 * record, never a yield or a decline. The live decision is read-only input.
 */
export async function runShadowArms(
  input: ShadowRunInput,
  judge: JevRoutingJudge,
): Promise<ShadowRunResult> {
  if (input.taskId.trim() === '') throw new Error('a shadow run needs a task id')
  const deadlineMs = input.deadlineMs ?? SHADOW_DEADLINE_MS
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error('shadow deadlineMs must be a positive finite number')
  }

  const options = { seed: input.seed, deadlineMs }
  const detCentral: RoutingReplayResult = runDeterministicRoutingReplay(
    input.context,
    'central_selection',
    input.seed,
  )
  const jevPersona = await runJevRoutingReplay(input.context, 'persona_requests', judge, options)
  const jevCentral = await runJevRoutingReplay(input.context, 'central_selection', judge, options)

  const records = [
    recordFor('jev-persona', input, jevPersona),
    recordFor('det-central', input, detCentral),
    recordFor('jev-central', input, jevCentral),
  ]
  return {
    records,
    summary: summarizeShadowRecords(input.taskId, input.context.lang, records),
  }
}

/** Append exact shadow records to a restricted JSONL sidecar. */
export async function writeShadowRecords(
  path: string,
  records: readonly ShadowRecord[],
): Promise<void> {
  if (records.length === 0) return
  await mkdir(dirname(path), { recursive: true })
  const lines = records.map((record) => JSON.stringify(shadowRecordSchema.parse(record)))
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8')
}

/** Write the JSON summary beside the JSONL records; there is no dashboard. */
export async function writeShadowSummary(path: string, summary: ShadowSummary): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(shadowSummarySchema.parse(summary), null, 2)}\n`, 'utf8')
}
