import type { TurnRequest } from '@rp/session-core'
import type {
  RoutingContext,
  RoutingDeclineReason,
  RoutingJudgments,
  RoutingPersona,
} from './schemas.js'
import {
  deterministicJudgments,
  lastUserUtterance,
  objectiveRelevanceFor,
  urgencyFor,
} from './features.js'

export const NOUL_YES = 0.7
export const NOUL_NO = 0.3

export type PersonaDecisionKind = 'request' | 'decline' | 'unsettled'

export type PersonaDecision =
  | { readonly personaId: string; readonly kind: 'request' }
  | { readonly personaId: string; readonly kind: 'decline'; readonly reason: RoutingDeclineReason }
  | { readonly personaId: string; readonly kind: 'unsettled' }

function isYes(probability: number): boolean {
  return probability >= NOUL_YES
}

function isUnsettled(probability: number): boolean {
  return probability > NOUL_NO && probability < NOUL_YES
}

/**
 * The single truth table shared by deterministic and Jev arms.
 *
 * Direct address wins. A clear pause request declines. Relevant, additive
 * contribution requests. Everything between the pre-registered bounds is
 * unsettled, so the caller must use its declared fallback rather than guess.
 */
export function derivePersonaDecision(judgments: RoutingJudgments): PersonaDecision {
  if (isYes(judgments.pauseWouldBenefitUser) && !isYes(judgments.directlyAddressed)) {
    return {
      personaId: '',
      kind: 'decline',
      reason: 'pause_would_benefit_user',
    }
  }

  if (isYes(judgments.directlyAddressed)) {
    return { personaId: '', kind: 'request' }
  }

  if (
    isYes(judgments.hasRelevantContribution) &&
    (isYes(judgments.addsUncoveredInformation) || isYes(judgments.hasUnmetRelevantObjective))
  ) {
    return { personaId: '', kind: 'request' }
  }

  const uncertain =
    isUnsettled(judgments.directlyAddressed) ||
    isUnsettled(judgments.pauseWouldBenefitUser) ||
    isUnsettled(judgments.hasRelevantContribution) ||
    (isYes(judgments.hasRelevantContribution) &&
      (isUnsettled(judgments.addsUncoveredInformation) ||
        isUnsettled(judgments.hasUnmetRelevantObjective)))

  if (uncertain) return { personaId: '', kind: 'unsettled' }

  return { personaId: '', kind: 'decline', reason: 'no_contribution' }
}

function confidenceFor(judgments: RoutingJudgments): number {
  return Math.max(
    judgments.directlyAddressed,
    judgments.hasRelevantContribution,
    judgments.addsUncoveredInformation,
    judgments.hasUnmetRelevantObjective,
  )
}

/** Derive one offline speak request from a persona's judgments. */
export function deriveTurnRequest(
  context: RoutingContext,
  persona: RoutingPersona,
  judgments: RoutingJudgments,
  utterance = lastUserUtterance(context),
): TurnRequest {
  return {
    turnId: context.turnId,
    personaId: persona.id,
    action: 'speak',
    urgency: urgencyFor(context, persona, utterance),
    confidence: confidenceFor(judgments),
    addressedByUser: isYes(judgments.directlyAddressed),
    objectiveRelevance: objectiveRelevanceFor(context, persona, utterance),
  }
}

export interface JudgedPersona {
  readonly persona: RoutingPersona
  readonly judgments: RoutingJudgments
  readonly decision: PersonaDecision
}

/**
 * Evaluate every eligible persona and derive the common request/decline set.
 *
 * `judgmentsByPersona` is supplied by the judgment arm. Deterministic M3a uses
 * public features; M3a D2 supplies Jev answers through the same seam.
 */
export function deriveRequests(
  context: RoutingContext,
  judgmentsByPersona: ReadonlyMap<string, RoutingJudgments>,
): {
  readonly judged: readonly JudgedPersona[]
  readonly requests: readonly TurnRequest[]
  readonly declines: readonly { personaId: string; reason: RoutingDeclineReason }[]
  readonly unsettled: readonly string[]
} {
  const judged: JudgedPersona[] = []
  const requests: TurnRequest[] = []
  const declines: { personaId: string; reason: RoutingDeclineReason }[] = []
  const unsettled: string[] = []
  const utterance = lastUserUtterance(context)

  for (const persona of context.personas) {
    const judgments = judgmentsByPersona.get(persona.id)
    if (judgments === undefined) {
      throw new Error(`missing judgments for eligible persona "${persona.id}"`)
    }

    const rawDecision = derivePersonaDecision(judgments)
    const decision: PersonaDecision = { ...rawDecision, personaId: persona.id }
    judged.push({ persona, judgments, decision })

    switch (decision.kind) {
      case 'request':
        requests.push(deriveTurnRequest(context, persona, judgments, utterance))
        break
      case 'decline':
        declines.push({
          personaId: persona.id,
          reason: decision.reason,
        })
        break
      case 'unsettled':
        unsettled.push(persona.id)
        break
    }
  }

  return { judged, requests, declines, unsettled }
}

/** Convenience for deterministic arms: compute judgments from public features. */
export function deterministicJudgmentsByPersona(
  context: RoutingContext,
): ReadonlyMap<string, RoutingJudgments> {
  return new Map(
    context.personas.map((persona) => [
      persona.id,
      deterministicJudgments(context, persona, lastUserUtterance(context)),
    ]),
  )
}
