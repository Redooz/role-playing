import type {
  RoutingContext,
  RoutingDecision,
  RoutingJudgments,
  RoutingTopology,
} from './schemas.js'
import {
  DETERMINISTIC_POLICY_VERSION,
  ROUTING_DECISION_SCHEMA_VERSION,
  routingDecisionSchema,
} from './schemas.js'
import { deriveRequests, deterministicJudgmentsByPersona, type JudgedPersona } from './derive.js'
import { rankTurnRequests } from './rank.js'

export interface DeterministicPolicyOptions {
  readonly seed: number
}

export interface DeterministicPolicyRun {
  readonly decision: RoutingDecision
  readonly judged: readonly JudgedPersona[]
}

/** Build a deterministic decision from an arbitrary judgment map. */
export function buildDeterministicDecision(
  context: RoutingContext,
  topology: RoutingTopology,
  judgments: ReadonlyMap<string, RoutingJudgments>,
  seed: number,
): DeterministicPolicyRun {
  const { judged, requests, declines, unsettled } = deriveRequests(context, judgments)

  const base = {
    schemaVersion: ROUTING_DECISION_SCHEMA_VERSION,
    decisionId: context.decisionId,
    turnId: context.turnId,
    lang: context.lang,
    topology,
    judgmentSource: 'deterministic' as const,
    policyVersion: DETERMINISTIC_POLICY_VERSION,
    eligiblePersonaIds: context.personas.map((persona) => persona.id),
  }

  if (unsettled.length > 0) {
    return {
      judged,
      decision: routingDecisionSchema.parse({
        ...base,
        outcome: { kind: 'user_yield', reason: 'unsettled' },
        requests,
        declines,
        unsettledPersonas: unsettled,
        judgments: Object.fromEntries(judgments),
        fallback: { kind: 'deterministic', cause: 'unsettled' },
      }),
    }
  }

  if (requests.length === 0) {
    return {
      judged,
      decision: routingDecisionSchema.parse({
        ...base,
        outcome: { kind: 'user_yield', reason: 'all_declined' },
        requests: [],
        declines,
        unsettledPersonas: [],
        judgments: Object.fromEntries(judgments),
        fallback: { kind: 'none' },
      }),
    }
  }

  const ranked = rankTurnRequests(context, requests, seed)
  const winner = ranked[0]!

  return {
    judged,
    decision: routingDecisionSchema.parse({
      ...base,
      outcome: { kind: 'speak', personaId: winner.personaId, request: winner },
      requests: ranked,
      declines,
      unsettledPersonas: [],
      judgments: Object.fromEntries(judgments),
      fallback: { kind: 'none' },
    }),
  }
}

function buildDecision(
  context: RoutingContext,
  topology: RoutingTopology,
  seed: number,
): DeterministicPolicyRun {
  return buildDeterministicDecision(
    context,
    topology,
    deterministicJudgmentsByPersona(context),
    seed,
  )
}

/** Central deterministic arm: public features compute a speaker from all eligible personas. */
export function decideDeterministicCentral(
  context: RoutingContext,
  options: DeterministicPolicyOptions,
): DeterministicPolicyRun {
  return buildDecision(context, 'central_selection', options.seed)
}

/** Per-persona deterministic arm: rules produce judgments, code derives requests, then ranks. */
export function decideDeterministicPersonaRequests(
  context: RoutingContext,
  options: DeterministicPolicyOptions,
): DeterministicPolicyRun {
  return buildDecision(context, 'persona_requests', options.seed)
}
