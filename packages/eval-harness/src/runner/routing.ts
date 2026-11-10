import { hashValue } from '@rp/shared'
import type { RoutingCentralObservation, RoutingPersonaObservation } from '../jev/routing.js'
import type { JevRoutingJudge } from '../jev/routing.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  assembleRoutingDecision,
  decideDeterministicCentral,
  decideDeterministicPersonaRequests,
  deriveRequests,
  deriveTurnRequest,
  deterministicJudgmentsByPersona,
  rankTurnRequests,
  type RoutingContext,
  type RoutingDecision,
  type RoutingJudgments,
  type RoutingTopology,
} from '@rp/routing-policy'
import { z } from 'zod'

/** Policy identifiers written into every routing artifact. */
export const DETERMINISTIC_POLICY_VERSION = 'm3a-routing-policy-v1'
export const JEV_CENTRAL_POLICY_VERSION = 'm3a-jev-central-v1'
export const JEV_PERSONA_POLICY_VERSION = 'm3a-jev-persona-v1'
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

function fallbackDecision(
  context: RoutingContext,
  topology: RoutingTopology,
  seed: number,
  cause: 'timeout' | 'unsettled',
): RoutingDecision {
  const deterministic =
    topology === 'central_selection'
      ? decideDeterministicCentral(context, { seed })
      : decideDeterministicPersonaRequests(context, { seed })
  const decision = deterministic.decision
  return assembleRoutingDecision({
    context,
    topology,
    judgmentSource: 'deterministic',
    policyVersion: DETERMINISTIC_POLICY_VERSION,
    judgments: decision.judgments,
    requests: decision.requests,
    declines: decision.declines,
    unsettledPersonas: decision.unsettledPersonas,
    ...(decision.outcome.kind === 'speak' ? { selectedPersonaId: decision.outcome.personaId } : {}),
    fallback: { kind: 'deterministic', cause },
  })
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
      judgments: run.decision.judgments,
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

function allJudgments(
  observations: Readonly<Record<string, RoutingPersonaObservation>>,
): Record<string, RoutingJudgments> {
  return Object.fromEntries(
    Object.entries(observations).map(([personaId, observation]) => [
      personaId,
      observation.judgments,
    ]),
  )
}

function rankWinner(
  context: RoutingContext,
  requests: readonly ReturnType<typeof deriveTurnRequest>[],
  seed: number,
): string | undefined {
  return rankTurnRequests(context, requests, seed)[0]?.personaId
}

/**
 * Jev arm with the declared fallback. A deadline or unsettled result reruns the
 * same topology with deterministic rules. Any transport/schema failure is
 * infrastructure-incomplete and never a routing outcome.
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
      ok: true,
      decision: fallbackDecision(context, topology, options.seed, 'timeout'),
      policyLatencyMs: nowMs() - start,
      observation: { kind: 'timeout' },
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
    if (central.judgment.anyoneWarranted > 0.3 && central.judgment.anyoneWarranted < 0.7) {
      return {
        ok: true,
        decision: fallbackDecision(context, topology, options.seed, 'unsettled'),
        policyLatencyMs: nowMs() - start,
        observation: { kind: 'jev', central },
      }
    }

    const deterministic = deterministicJudgmentsByPersona(context)
    const judgments = Object.fromEntries(deterministic)
    const derived = deriveRequests(context, deterministic)
    let selectedPersonaId: string | undefined
    let requests = derived.requests
    let declines: typeof derived.declines

    if (central.judgment.anyoneWarranted >= 0.7) {
      selectedPersonaId = central.judgment.selectedPersonaId
      const selected = context.personas.find((persona) => persona.id === selectedPersonaId)
      if (selected === undefined) {
        return {
          ok: false,
          kind: 'infrastructure_incomplete',
          error: 'Jev selected a persona that is not eligible.',
          questionIds: central.exact.questionIds,
          policyLatencyMs: nowMs() - start,
        }
      }
      const request =
        requests.find((entry) => entry.personaId === selectedPersonaId) ??
        deriveTurnRequest(context, selected, deterministic.get(selectedPersonaId)!)
      requests = [request]
      declines = context.personas
        .filter((persona) => persona.id !== selectedPersonaId)
        .map((persona) => ({ personaId: persona.id, reason: 'no_contribution' as const }))
    } else {
      requests = []
      declines = context.personas.map((persona) => ({
        personaId: persona.id,
        reason: 'no_contribution' as const,
      }))
    }

    return {
      ok: true,
      decision: assembleRoutingDecision({
        context,
        topology,
        judgmentSource: 'jev',
        policyVersion: JEV_CENTRAL_POLICY_VERSION,
        judgments,
        requests,
        declines,
        unsettledPersonas: [],
        ...(selectedPersonaId === undefined ? {} : { selectedPersonaId }),
        fallback: { kind: 'none' },
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

  const judgments = allJudgments(observations)
  const derived = deriveRequests(context, new Map(Object.entries(judgments)))
  if (derived.unsettled.length > 0) {
    return {
      ok: true,
      decision: fallbackDecision(context, topology, options.seed, 'unsettled'),
      policyLatencyMs: nowMs() - start,
      observation: { kind: 'jev', personas: observations },
    }
  }

  const winner = rankWinner(context, derived.requests, options.seed)
  return {
    ok: true,
    decision: assembleRoutingDecision({
      context,
      topology,
      judgmentSource: 'jev',
      policyVersion: JEV_PERSONA_POLICY_VERSION,
      judgments,
      requests: derived.requests,
      declines: derived.declines,
      unsettledPersonas: [],
      ...(winner === undefined ? {} : { selectedPersonaId: winner }),
      fallback: { kind: 'none' },
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
    return routingDecisionArtifactSchema.parse({
      ...common,
      decision: result.decision,
      outcome: 'completed',
      observation: result.observation,
    })
  }

  return routingDecisionArtifactSchema.parse({
    ...common,
    outcome: 'infrastructure_incomplete',
    observation: { kind: 'none' },
    error: result.error,
  })
}

/** Persist exact records as restricted JSONL. Callers choose the run directory. */
export async function writeRoutingArtifacts(
  path: string,
  records: readonly RoutingDecisionArtifact[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const lines = records.map((record) => JSON.stringify(routingDecisionArtifactSchema.parse(record)))
  await writeFile(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
}
