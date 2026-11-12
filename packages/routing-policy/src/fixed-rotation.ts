import type { PersonaPolicyInput, PersonaTurnPolicy } from '@rp/session-core'
import { hashValue } from '@rp/shared'
import type { RoutingContext } from './schemas.js'

/**
 * `fixed-rotation` — the M3b baseline arm.
 *
 * One persona speaks every turn, in a seeded rotation over the eligible set.
 * It ignores the learner, the scenario and every objective; that is the point.
 * It is a comparison baseline, never a product policy.
 */
export const FIXED_ROTATION_POLICY_ID = 'fixed-rotation'
export const FIXED_ROTATION_POLICY_VERSION = 'm3b-fixed-rotation-v1'

function rotationIndex(turnId: string, size: number): number {
  return Number.parseInt(hashValue({ turnId }).slice(0, 8), 16) % size
}

/** The persona the fixed rotation selects for one turn. */
export function fixedRotationPersonaForTurn(turnId: string, personaIds: readonly string[]): string {
  return personaIds[rotationIndex(turnId, personaIds.length)]!
}

/** Create one fixed-rotation policy for a baseline run. */
export function createFixedRotationLivePolicy(
  personaIds: readonly string[],
): PersonaTurnPolicy<RoutingContext> {
  if (personaIds.length < 2) {
    throw new Error('a fixed rotation needs at least two personas')
  }
  if (new Set(personaIds).size !== personaIds.length) {
    throw new Error('fixed-rotation persona ids must be unique')
  }

  return {
    decide(input: PersonaPolicyInput<RoutingContext>) {
      if (input.turnId !== input.context.turnId) {
        throw new Error(
          `fixed rotation received turn "${input.turnId}" for context turn "${input.context.turnId}"`,
        )
      }
      if (input.action === 'interject') return { kind: 'decline' }
      const selected = fixedRotationPersonaForTurn(input.turnId, personaIds)
      if (selected !== input.personaId) return { kind: 'decline' }
      return {
        kind: 'request',
        request: {
          turnId: input.turnId,
          personaId: input.personaId,
          action: 'speak',
          urgency: 0.5,
          confidence: 1,
          addressedByUser: false,
          objectiveRelevance: 0,
        },
      }
    },
  }
}
