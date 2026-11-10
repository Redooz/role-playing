import { hashValue } from '@rp/shared'
import type { TurnRequest } from '@rp/session-core'
import { lastPersonaTurnIndexes } from './features.js'
import type { RoutingContext } from './schemas.js'

/**
 * Deterministic post-turn comparator from Architecture Plan v5 §3.3.
 *
 * M3a has no interjection, so the `valid interject` key is absent. The final
 * seeded tie-break is a hash of run seed, turn and persona, not a sequence of
 * random draws: it is stable when the input order changes.
 */
export function compareTurnRequests(
  context: RoutingContext,
  left: TurnRequest,
  right: TurnRequest,
  seed: number,
): number {
  if (left.addressedByUser !== right.addressedByUser) return left.addressedByUser ? -1 : 1

  if (left.objectiveRelevance !== right.objectiveRelevance) {
    return right.objectiveRelevance - left.objectiveRelevance
  }

  if (left.urgency !== right.urgency) return right.urgency - left.urgency

  const lastSpoke = lastPersonaTurnIndexes(context)
  const leftLast = lastSpoke.get(left.personaId) ?? -1
  const rightLast = lastSpoke.get(right.personaId) ?? -1
  if (leftLast !== rightLast) return leftLast - rightLast

  const leftTie = hashValue({ seed, turnId: context.turnId, personaId: left.personaId })
  const rightTie = hashValue({ seed, turnId: context.turnId, personaId: right.personaId })
  if (leftTie === rightTie) return 0
  return leftTie < rightTie ? -1 : 1
}

/** Stable sort using the documented comparator; input order is not mutated. */
export function rankTurnRequests(
  context: RoutingContext,
  requests: readonly TurnRequest[],
  seed: number,
): readonly TurnRequest[] {
  return [...requests].sort((left, right) => compareTurnRequests(context, left, right, seed))
}
