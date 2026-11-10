import type { TurnRequest } from '@rp/session-core'
import type {
  RoutingContext,
  RoutingDecline,
  RoutingDecision,
  RoutingFallback,
  RoutingJudgmentSource,
  RoutingJudgments,
  RoutingTopology,
} from './schemas.js'
import { ROUTING_DECISION_SCHEMA_VERSION, routingDecisionSchema } from './schemas.js'

function yieldReason(
  fallback: RoutingFallback,
  unsettled: boolean,
): 'all_declined' | 'policy_timeout' | 'unsettled' {
  if (fallback.kind === 'none') {
    if (unsettled) throw new Error('an unsettled decision requires a deterministic fallback')
    return 'all_declined'
  }
  return fallback.cause === 'timeout' ? 'policy_timeout' : 'unsettled'
}

export interface AssembleRoutingDecisionInput {
  readonly context: RoutingContext
  readonly topology: RoutingTopology
  readonly judgmentSource: RoutingJudgmentSource
  readonly policyVersion: string
  readonly judgments: Readonly<Record<string, RoutingJudgments>>
  readonly requests: readonly TurnRequest[]
  readonly declines: readonly RoutingDecline[]
  readonly unsettledPersonas: readonly string[]
  /** Speaker chosen by the judgment arm; absent for a user yield. */
  readonly selectedPersonaId?: string
  readonly fallback: RoutingFallback
}

/**
 * Assemble the persisted routing decision from a policy's derived outcome.
 *
 * This function contains no deadline logic. It only makes the decision shape
 * consistent: model/fallback provenance, the selected request, declines and
 * unsettled personas. A timeout or unsettled yield keeps its declared fallback
 * cause; a normal all-decline keeps `all_declined`.
 */
export function assembleRoutingDecision(input: AssembleRoutingDecisionInput): RoutingDecision {
  const unsettled = new Set(input.unsettledPersonas)
  const requests = input.requests.filter((request) => !unsettled.has(request.personaId))
  const declines = input.declines.filter((decline) => !unsettled.has(decline.personaId))
  const base = {
    schemaVersion: ROUTING_DECISION_SCHEMA_VERSION,
    decisionId: input.context.decisionId,
    turnId: input.context.turnId,
    lang: input.context.lang,
    topology: input.topology,
    judgmentSource: input.judgmentSource,
    policyVersion: input.policyVersion,
    eligiblePersonaIds: input.context.personas.map((persona) => persona.id),
    requests,
    declines,
    unsettledPersonas: [...input.unsettledPersonas],
    judgments: input.judgments,
    fallback: input.fallback,
  }

  if (input.unsettledPersonas.length > 0) {
    return routingDecisionSchema.parse({
      ...base,
      outcome: { kind: 'user_yield', reason: yieldReason(input.fallback, true) },
    })
  }

  if (input.selectedPersonaId === undefined) {
    if (input.fallback.kind === 'none' && requests.length > 0) {
      throw new Error('cannot yield all_declined while derived requests exist')
    }
    return routingDecisionSchema.parse({
      ...base,
      outcome: { kind: 'user_yield', reason: yieldReason(input.fallback, false) },
    })
  }

  const winner = requests.find((request) => request.personaId === input.selectedPersonaId)
  if (winner === undefined) {
    throw new Error(`selected persona "${input.selectedPersonaId}" has no derived turn request`)
  }

  return routingDecisionSchema.parse({
    ...base,
    outcome: {
      kind: 'speak',
      personaId: winner.personaId,
      request: winner,
    },
  })
}
