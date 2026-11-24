import { hashValue } from '@rp/shared'
import type { RoutingCentralObservation, RoutingPersonaObservation } from '../jev/routing.js'
import type { JevRoutingJudge } from '../jev/routing.js'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  assembleRoutingDecision,
  decideDeterministicCentral,
  decideDeterministicPersonaRequests,
  deriveMoveDecision,
  NOUL_YES,
  type RoutingContext,
  type RoutingDecision,
  type RoutingMoveJudgments,
  type RoutingPersonaMoveJudgments,
  type RoutingTopology,
} from '@rp/routing-policy'
import { z } from 'zod'

/** Policy identifiers written into every routing artifact. */
export const DETERMINISTIC_POLICY_VERSION = 'm3a-routing-policy-v1'
export const JEV_CENTRAL_POLICY_VERSION = 'm3d-jev-central-v2'
export const JEV_PERSONA_POLICY_VERSION = 'm3d-jev-persona-v2'
export const ROUTING_ARTIFACT_SCHEMA_VERSION = '1.0.0'

export interface RoutingArm {
  readonly topology: RoutingTopology
  readonly judgmentSource: 'deterministic' | 'jev'
}

export interface RoutingExactObservation {
  readonly kind: 'deterministic' | 'jev' | 'timeout'
  readonly central?: RoutingCentralObservation
  readonly personas?: Readonly<Record<string, RoutingPersonaObservation>>
}

export interface RoutingReplaySuccess {
  readonly ok: true
  readonly decision: RoutingDecision
  readonly policyLatencyMs: number
  readonly observation: RoutingExactObservation
}

export interface RoutingReplayFailure {
  readonly ok: false
  readonly kind: 'infrastructure_incomplete'
  readonly error: string
  readonly questionIds: readonly string[]
  readonly policyLatencyMs: number
}

export type RoutingReplayResult = RoutingReplaySuccess | RoutingReplayFailure

export interface RoutingReplayOptions {
  readonly seed: number
  readonly deadlineMs: number
}

function nowMs(): number {
  return performance.now()
}

function featureJudgmentsOf(decision: RoutingDecision): NonNullable<RoutingDecision['judgments']> {
  if (decision.judgments === undefined) {
    throw new Error('a deterministic decision must carry feature judgments')
  }
  return decision.judgments
}

function deadlineFailure(error: unknown): RoutingReplayFailure['error'] {
  return error instanceof Error ? error.message : String(error)
}

/** Deterministic arm; no provider and no fallback. */
export function runDeterministicRoutingReplay(
  context: RoutingContext,
  topology: RoutingTopology,
  seed: number,
): RoutingReplaySuccess {
  const start = nowMs()
  const run =
    topology === 'central_selection'
      ? decideDeterministicCentral(context, { seed })
      : decideDeterministicPersonaRequests(context, { seed })
  return {
    ok: true,
    decision: assembleRoutingDecision({
      context,
      topology,
      judgmentSource: 'deterministic',
      policyVersion: DETERMINISTIC_POLICY_VERSION,
      judgments: featureJudgmentsOf(run.decision),
      requests: run.decision.requests,
      declines: run.decision.declines,
      unsettledPersonas: run.decision.unsettledPersonas,
      ...(run.decision.outcome.kind === 'speak'
        ? { selectedPersonaId: run.decision.outcome.personaId }
        : {}),
      fallback: { kind: 'none' },
    }),
    policyLatencyMs: nowMs() - start,
    observation: { kind: 'deterministic' },
  }
}

async function withinDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
): Promise<{ kind: 'result'; value: T } | { kind: 'timeout' }> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work.then((value) => ({ kind: 'result' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), deadlineMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function aggregateMoves(
  observations: Readonly<Record<string, RoutingPersonaObservation>>,
): RoutingMoveJudgments {
  const values = Object.values(observations)
  return {
    closingMove: Math.max(...values.map((value) => value.judgments.closingMove)),
    selfAnswer: Math.max(...values.map((value) => value.judgments.selfAnswer)),
    thinkingAloud: Math.max(...values.map((value) => value.judgments.thinkingAloud)),
    sideComment: Math.max(...values.map((value) => value.judgments.sideComment)),
  }
}

function addressedPersonaIds(
  observations: Readonly<Record<string, RoutingPersonaObservation>>,
): readonly string[] {
  return Object.entries(observations)
    .filter(([, observation]) => observation.judgments.directlyAddressed >= NOUL_YES)
    .map(([personaId]) => personaId)
}

function personaMoveRecord(
  observations: Readonly<Record<string, RoutingPersonaObservation>>,
): Readonly<Record<string, RoutingPersonaMoveJudgments>> {
  return Object.fromEntries(
    Object.entries(observations).map(([personaId, observation]) => [
      personaId,
      observation.judgments,
    ]),
  )
}

function fallbackOf(derived: ReturnType<typeof deriveMoveDecision>) {
  return derived.fallbackCause === null
    ? ({ kind: 'none' } as const)
    : ({ kind: 'deterministic', cause: derived.fallbackCause } as const)
}

/**
 * Jev arm under the ownership-first move contract (M3d D2).
 *
 * A timeout, transport error or invalid/missing answer is
 * infrastructure-incomplete, never a yield. An answered but unsettled move uses
 * the owner rule; code selects the speaker, never the model.
 */
export async function runJevRoutingReplay(
  context: RoutingContext,
  topology: RoutingTopology,
  judge: JevRoutingJudge,
  options: RoutingReplayOptions,
): Promise<RoutingReplayResult> {
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new Error('deadlineMs must be a positive finite number')
  }
  const start = nowMs()

  type WorkResult =
    | {
        readonly kind: 'central'
        readonly result: Awaited<ReturnType<JevRoutingJudge['judgeCentral']>>
      }
    | {
        readonly kind: 'personas'
        readonly results: readonly {
          readonly personaId: string
          readonly result: Awaited<ReturnType<JevRoutingJudge['judgePersona']>>
        }[]
      }
    | { readonly kind: 'threw'; readonly error: unknown }

  const work: Promise<WorkResult> =
    topology === 'central_selection'
      ? judge
          .judgeCentral(context)
          .then((result) => ({ kind: 'central' as const, result }))
          .catch((error: unknown) => ({ kind: 'threw' as const, error }))
      : Promise.all(
          context.personas.map(async (persona) => ({
            personaId: persona.id,
            result: await judge.judgePersona(context, persona),
          })),
        )
          .then((results) => ({ kind: 'personas' as const, results }))
          .catch((error: unknown) => ({ kind: 'threw' as const, error }))

  const raced = await withinDeadline<WorkResult>(work, options.deadlineMs)
  if (raced.kind === 'timeout') {
    return {
      ok: false,
      kind: 'infrastructure_incomplete',
      error: `routing policy timed out after ${options.deadlineMs} ms; a failed model call is incomplete`,
      questionIds: [],
      policyLatencyMs: nowMs() - start,
    }
  }

  if (raced.value.kind === 'threw') {
    return {
      ok: false,
      kind: 'infrastructure_incomplete',
      error: deadlineFailure(raced.value.error),
      questionIds: [],
      policyLatencyMs: nowMs() - start,
    }
  }

  if (raced.value.kind === 'central') {
    const result = raced.value.result
    if (!result.ok) {
      return {
        ok: false,
        kind: 'infrastructure_incomplete',
        error: deadlineFailure(result.error),
        questionIds: result.questionIds,
        policyLatencyMs: nowMs() - start,
      }
    }

    const central = result.observation
    const derived = deriveMoveDecision({
      context,
      moves: central.judgment.move,
      topology,
      seed: options.seed,
      ...(central.judgment.selectedPersonaId === undefined
        ? {}
        : { selectedPersonaId: central.judgment.selectedPersonaId }),
    })

    return {
      ok: true,
      decision: assembleRoutingDecision({
        context,
        topology,
        judgmentSource: 'jev',
        policyVersion: JEV_CENTRAL_POLICY_VERSION,
        moveJudgments: { scope: 'central', move: central.judgment.move },
        requests: derived.requests,
        declines: derived.declines,
        unsettledPersonas: [],
        ...(derived.kind === 'speak' && derived.personaId !== undefined
          ? { selectedPersonaId: derived.personaId }
          : {}),
        fallback: fallbackOf(derived),
      }),
      policyLatencyMs: nowMs() - start,
      observation: { kind: 'jev', central },
    }
  }

  const observations: Record<string, RoutingPersonaObservation> = {}
  for (const entry of raced.value.results) {
    if (!entry.result.ok) {
      return {
        ok: false,
        kind: 'infrastructure_incomplete',
        error: deadlineFailure(entry.result.error),
        questionIds: entry.result.questionIds,
        policyLatencyMs: nowMs() - start,
      }
    }
    observations[entry.personaId] = entry.result.observation
  }

  const derived = deriveMoveDecision({
    context,
    moves: aggregateMoves(observations),
    topology,
    seed: options.seed,
    addressedPersonaIds: addressedPersonaIds(observations),
  })

  return {
    ok: true,
    decision: assembleRoutingDecision({
      context,
      topology,
      judgmentSource: 'jev',
      policyVersion: JEV_PERSONA_POLICY_VERSION,
      moveJudgments: { scope: 'persona', byPersona: personaMoveRecord(observations) },
      requests: derived.requests,
      declines: derived.declines,
      unsettledPersonas: [],
      ...(derived.kind === 'speak' && derived.personaId !== undefined
        ? { selectedPersonaId: derived.personaId }
        : {}),
      fallback: fallbackOf(derived),
    }),
    policyLatencyMs: nowMs() - start,
    observation: { kind: 'jev', personas: observations },
  }
}

const exactObservationSchema = z.strictObject({
  kind: z.enum(['deterministic', 'jev', 'timeout', 'none']),
  central: z.unknown().optional(),
  personas: z.record(z.string(), z.unknown()).optional(),
})

export const routingDecisionArtifactSchema = z.strictObject({
  schemaVersion: z.literal(ROUTING_ARTIFACT_SCHEMA_VERSION),
  kind: z.literal('routing.decision'),
  contentClass: z.literal('restricted'),
  trialId: z.string().min(1),
  taskId: z.string().min(1),
  arm: z.strictObject({
    topology: z.enum(['central_selection', 'persona_requests']),
    judgmentSource: z.enum(['deterministic', 'jev']),
  }),
  contextHash: z.string().regex(/^[0-9a-f]{64}$/),
  policyLatencyMs: z.number().finite().nonnegative(),
  decision: z.unknown().optional(),
  outcome: z.enum(['completed', 'infrastructure_incomplete']),
  observation: exactObservationSchema,
  error: z.string().min(1).optional(),
})

export type RoutingDecisionArtifact = z.infer<typeof routingDecisionArtifactSchema>

export interface RoutingArtifactOptions {
  readonly trialId: string
  readonly taskId: string
  readonly arm: RoutingArm
}

/** Convert one replay result to a restricted exact-payload artifact record. */
export function routingArtifact(
  context: RoutingContext,
  result: RoutingReplayResult,
  options: RoutingArtifactOptions,
): RoutingDecisionArtifact {
  const common = {
    schemaVersion: ROUTING_ARTIFACT_SCHEMA_VERSION,
    kind: 'routing.decision' as const,
    contentClass: 'restricted' as const,
    trialId: options.trialId,
    taskId: options.taskId,
    arm: options.arm,
    contextHash: hashValue(context),
    policyLatencyMs: result.policyLatencyMs,
  }

  if (result.ok) {
    const timedOut = result.observation.kind === 'timeout'
    return routingDecisionArtifactSchema.parse({
      ...common,
      decision: result.decision,
      outcome: timedOut ? 'infrastructure_incomplete' : 'completed',
      observation: result.observation,
      ...(timedOut
        ? { error: 'routing policy timed out; deterministic fallback preserved for audit only' }
        : {}),
    })
  }

  return routingDecisionArtifactSchema.parse({
    ...common,
    outcome: 'infrastructure_incomplete',
    observation: { kind: 'none' },
    error: result.error.trim() === '' ? 'routing policy failed without a message' : result.error,
  })
}

/**
 * Append exact records as restricted JSONL.
 *
 * Append rather than overwrite: a runner may write one decision at a time. Run
 * directories are per-run, so append never merges unrelated executions.
 */
export async function writeRoutingArtifacts(
  path: string,
  records: readonly RoutingDecisionArtifact[],
): Promise<void> {
  if (records.length === 0) return
  await mkdir(dirname(path), { recursive: true })
  const lines = records.map((record) => JSON.stringify(routingDecisionArtifactSchema.parse(record)))
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8')
}
