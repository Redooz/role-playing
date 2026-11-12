import type { PersonaPolicyInput, PersonaTurnPolicy } from '@rp/session-core'
import type { RoutingContext, RoutingPersona } from './schemas.js'
import { derivePersonaDecision, deriveTurnRequest } from './derive.js'
import { deterministicJudgments, isPersonaAddressed, lastUserUtterance } from './features.js'

/**
 * `det-persona` — the M3b live control arm.
 *
 * It is the existing M3a per-persona deterministic policy adapted to the live
 * policy port. It is a control arm, not an adopted routing policy: no model is
 * called, nothing is ranked twice, and the policy owns no grant lifecycle.
 *
 * Interjection is deliberately conservative. A persona asks to interject only
 * when the committed learner utterance directly addresses it while another
 * persona holds the grant. Any wider rule would need the active partial text or
 * a model judgment; neither belongs to this deterministic arm.
 */
export const DET_PERSONA_LIVE_POLICY_ID = 'det-persona'
export const DET_PERSONA_LIVE_POLICY_VERSION = 'm3b-det-persona-live-policy-v1'

function personaFor(context: RoutingContext, personaId: string): RoutingPersona {
  const persona = context.personas.find((candidate) => candidate.id === personaId)
  if (persona === undefined) {
    throw new Error(`det-persona has no eligible persona "${personaId}"`)
  }
  return persona
}

/** Create one deterministic policy instance for a session or a trial. */
export function createDetPersonaLivePolicy(): PersonaTurnPolicy<RoutingContext> {
  return {
    decide(input: PersonaPolicyInput<RoutingContext>) {
      const context = input.context
      if (input.turnId !== context.turnId) {
        throw new Error(
          `det-persona received turn "${input.turnId}" for context turn "${context.turnId}"`,
        )
      }

      const persona = personaFor(context, input.personaId)
      const utterance = lastUserUtterance(context)
      const judgments = deterministicJudgments(context, persona, utterance)
      const decision = derivePersonaDecision(judgments)

      if (input.action === 'speak') {
        // Deterministic judgments are 0/1, so `derivePersonaDecision` can only
        // return request or decline here; an unsettled result is impossible.
        if (decision.kind !== 'request') return { kind: 'decline' }
        return {
          kind: 'request',
          request: deriveTurnRequest(context, persona, judgments, utterance),
        }
      }

      if (input.targetGrantId === undefined) {
        throw new Error('det-persona needs a target grant id to evaluate an interjection')
      }
      if (!isPersonaAddressed(context, persona, utterance)) return { kind: 'decline' }

      const request = deriveTurnRequest(context, persona, judgments, utterance)
      return {
        kind: 'request',
        request: {
          ...request,
          action: 'interject',
          targetGrantId: input.targetGrantId,
        },
      }
    },
  }
}
