import { containsRoutingTerm, lastUserUtterance } from './features.js'
import type { RoutingContext, RoutingOwner } from './schemas.js'

/**
 * Turn-level ownership resolution (M3d D2).
 *
 * Ownership is public scenario data: a fact such as "Sam owns the action list"
 * or a persona-scoped objective. This module only matches the learner's topic
 * against those declarations; it never reads a golden label or a model answer.
 * A request is never derived from a keyword match alone, so this result is an
 * input to the move contract, not a speaking decision.
 */

/** Owners whose declared topic keywords appear in the learner's utterance. */
export function matchedOwners(
  context: RoutingContext,
  utterance = lastUserUtterance(context),
): readonly RoutingOwner[] {
  return context.owners.filter((owner) =>
    owner.keywords.some((keyword) => containsRoutingTerm(utterance, keyword, context.lang)),
  )
}

/** Distinct matched owner personas, in context order. */
export function ownerPersonaIds(
  context: RoutingContext,
  utterance = lastUserUtterance(context),
): readonly string[] {
  const matched = new Set(matchedOwners(context, utterance).flatMap((owner) => owner.personaIds))
  return context.personas.filter((persona) => matched.has(persona.id)).map((persona) => persona.id)
}

export type OwnerSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'unique'; readonly personaId: string }
  /** One of several owners was addressed; direct address separates them. */
  | { readonly kind: 'addressed'; readonly personaId: string }
  /** One scenario claim declares exactly these two owners. */
  | { readonly kind: 'pair'; readonly personaIds: readonly [string, string] }
  /** Several owners with no address and no declared pair. */
  | { readonly kind: 'unresolved'; readonly personaIds: readonly string[] }

function declaredPair(
  context: RoutingContext,
  personaIds: readonly string[],
  utterance: string,
): OwnerSelection {
  const pair = matchedOwners(context, utterance).find(
    (owner) =>
      owner.personaIds.length === 2 &&
      owner.personaIds.length === personaIds.length &&
      owner.personaIds.every((personaId) => personaIds.includes(personaId)),
  )
  return pair === undefined
    ? { kind: 'unresolved', personaIds }
    : { kind: 'pair', personaIds: [pair.personaIds[0]!, pair.personaIds[1]!] }
}

/**
 * Resolve who owns the learner's topic on this turn.
 *
 * A single owner always wins, even when the learner names someone else: the
 * named non-owner is a distractor. With several owners, only a direct address
 * or one declared pair can resolve them; anything else is unresolved, so the
 * caller yields rather than guessing.
 */
export function selectOwner(
  context: RoutingContext,
  addressedPersonaIds: readonly string[],
  utterance = lastUserUtterance(context),
): OwnerSelection {
  const personaIds = ownerPersonaIds(context, utterance)
  if (personaIds.length === 0) return { kind: 'none' }
  if (personaIds.length === 1) return { kind: 'unique', personaId: personaIds[0]! }

  const addressed = addressedPersonaIds.filter((personaId) => personaIds.includes(personaId))
  if (addressed.length === 1) return { kind: 'addressed', personaId: addressed[0]! }

  return declaredPair(context, personaIds, utterance)
}
