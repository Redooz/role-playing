import type { TurnRequest } from '@rp/session-core'
import { isNoulUnsettled, isNoulYes } from './derive.js'
import {
  isPersonaAddressed,
  lastUserUtterance,
  objectiveRelevanceFor,
  urgencyFor,
} from './features.js'
import { selectOwner, type OwnerSelection } from './owner.js'
import { rankTurnRequests } from './rank.js'
import type {
  RoutingContext,
  RoutingDecline,
  RoutingDeclineReason,
  RoutingMoveJudgments,
  RoutingPersona,
  RoutingTopology,
} from './schemas.js'

/**
 * Ownership-first move contract (M3d D2).
 *
 * The model answers only the four self-directed move Nouls. Code resolves the
 * owner and applies the contract: a settled self-directed move yields, one
 * owner speaks, a declared pair is resolved by a Choice or by ranking, and
 * anything unresolved yields. An unsettled answer uses the owner rule only.
 */

export const MOVE_JUDGMENT_KEYS = [
  'closingMove',
  'selfAnswer',
  'thinkingAloud',
  'sideComment',
] as const

export type MoveJudgmentKey = (typeof MOVE_JUDGMENT_KEYS)[number]

export type MoveYieldReason = 'self_directed_move' | 'no_owner' | 'unresolved_owner'

export interface MoveDerivationInput {
  readonly context: RoutingContext
  readonly moves: RoutingMoveJudgments
  readonly topology: RoutingTopology
  readonly seed: number
  /** Central Choice winner; only a declared owner can be selected. */
  readonly selectedPersonaId?: string
  /** Persona-arm direct-address answers that cleared the yes threshold. */
  readonly addressedPersonaIds?: readonly string[]
  readonly utterance?: string
}

export interface MoveDerivation {
  readonly kind: 'speak' | 'yield'
  readonly personaId?: string
  readonly yieldReason?: MoveYieldReason
  readonly requests: readonly TurnRequest[]
  readonly declines: readonly RoutingDecline[]
  /** `unsettled` only when the owner rule decided the turn. */
  readonly fallbackCause: 'unsettled' | null
  readonly ownerSelection: OwnerSelection
}

function personaFor(context: RoutingContext, personaId: string): RoutingPersona {
  const persona = context.personas.find((candidate) => candidate.id === personaId)
  if (persona === undefined) {
    throw new Error(`move policy has no eligible persona "${personaId}"`)
  }
  return persona
}

function declineAll(
  context: RoutingContext,
  reason: RoutingDeclineReason,
): readonly RoutingDecline[] {
  return context.personas.map((persona) => ({ personaId: persona.id, reason }))
}

function maxMove(moves: RoutingMoveJudgments): number {
  return Math.max(...MOVE_JUDGMENT_KEYS.map((key) => moves[key]))
}

function requestFor(
  input: MoveDerivationInput,
  personaId: string,
  addressed: ReadonlySet<string>,
  utterance: string,
): TurnRequest {
  const persona = personaFor(input.context, personaId)
  return {
    turnId: input.context.turnId,
    personaId,
    action: 'speak',
    urgency: urgencyFor(input.context, persona, utterance),
    confidence: 1 - maxMove(input.moves),
    addressedByUser: addressed.has(personaId),
    objectiveRelevance: objectiveRelevanceFor(input.context, persona, utterance),
  }
}

function addressedSet(input: MoveDerivationInput, utterance: string): ReadonlySet<string> {
  if (input.addressedPersonaIds !== undefined) {
    return new Set(input.addressedPersonaIds)
  }
  return new Set(
    input.context.personas
      .filter((persona) => isPersonaAddressed(input.context, persona, utterance))
      .map((persona) => persona.id),
  )
}

function yieldDecision(
  input: MoveDerivationInput,
  reason: MoveYieldReason,
  fallbackCause: 'unsettled' | null,
  ownerSelection: OwnerSelection,
): MoveDerivation {
  return {
    kind: 'yield',
    yieldReason: reason,
    requests: [],
    declines: declineAll(input.context, reason),
    fallbackCause,
    ownerSelection,
  }
}

function speakDecision(
  input: MoveDerivationInput,
  personaId: string,
  fallbackCause: 'unsettled' | null,
  ownerSelection: OwnerSelection,
  utterance: string,
  addressed: ReadonlySet<string>,
): MoveDerivation {
  return {
    kind: 'speak',
    personaId,
    requests: [requestFor(input, personaId, addressed, utterance)],
    declines: input.context.personas
      .filter((persona) => persona.id !== personaId)
      .map((persona) => ({ personaId: persona.id, reason: 'not_owner' as const })),
    fallbackCause,
    ownerSelection,
  }
}

function resolvedPairWinner(
  input: MoveDerivationInput,
  personaIds: readonly [string, string],
  utterance: string,
  addressed: ReadonlySet<string>,
): string | undefined {
  if (input.topology === 'central_selection') {
    return input.selectedPersonaId !== undefined && personaIds.includes(input.selectedPersonaId)
      ? input.selectedPersonaId
      : undefined
  }
  const requests = personaIds.map((personaId) => requestFor(input, personaId, addressed, utterance))
  return rankTurnRequests(input.context, requests, input.seed)[0]?.personaId
}

/**
 * Apply the move contract. This function owns no deadline and no provider call.
 *
 * A settled self-directed move always yields. Otherwise an unsettled answer
 * speaks only for one resolved owner; a settled answer may also resolve a
 * declared pair by Choice (central) or ranking (persona). Every other case
 * yields with an explicit reason.
 */
export function deriveMoveDecision(input: MoveDerivationInput): MoveDerivation {
  const utterance = input.utterance ?? lastUserUtterance(input.context)
  const addressed = addressedSet(input, utterance)
  const ownerSelection = selectOwner(input.context, [...addressed], utterance)

  if (MOVE_JUDGMENT_KEYS.some((key) => isNoulYes(input.moves[key]))) {
    return yieldDecision(input, 'self_directed_move', null, ownerSelection)
  }

  const fallbackCause = MOVE_JUDGMENT_KEYS.some((key) => isNoulUnsettled(input.moves[key]))
    ? 'unsettled'
    : null

  if (fallbackCause !== null) {
    if (ownerSelection.kind === 'unique') {
      return speakDecision(
        input,
        ownerSelection.personaId,
        fallbackCause,
        ownerSelection,
        utterance,
        addressed,
      )
    }
    return yieldDecision(
      input,
      ownerSelection.kind === 'none' ? 'no_owner' : 'unresolved_owner',
      fallbackCause,
      ownerSelection,
    )
  }

  switch (ownerSelection.kind) {
    case 'none':
      return yieldDecision(input, 'no_owner', null, ownerSelection)
    case 'unique':
    case 'addressed':
      return speakDecision(
        input,
        ownerSelection.personaId,
        null,
        ownerSelection,
        utterance,
        addressed,
      )
    case 'pair': {
      const winner = resolvedPairWinner(input, ownerSelection.personaIds, utterance, addressed)
      return winner === undefined
        ? yieldDecision(input, 'unresolved_owner', null, ownerSelection)
        : speakDecision(input, winner, null, ownerSelection, utterance, addressed)
    }
    case 'unresolved':
      return yieldDecision(input, 'unresolved_owner', null, ownerSelection)
  }
}
