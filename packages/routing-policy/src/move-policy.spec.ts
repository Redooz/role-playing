import { describe, expect, it } from 'vitest'
import { makeContext } from './fixtures.js'
import { deriveMoveDecision, type MoveDerivationInput } from './move-policy.js'
import type { RoutingContext, RoutingMoveJudgments, RoutingOwner } from './schemas.js'

const actionList: RoutingOwner = {
  topic: 'the action list',
  keywords: ['action', 'list'],
  personaIds: ['peer'],
  source: 'fact',
  sourceFactIndex: 0,
}

const rollout: RoutingOwner = {
  topic: 'Agree the rollout date with the manager.',
  keywords: ['rollout'],
  personaIds: ['manager'],
  source: 'objective',
  objectiveId: 'agree-rollout',
}

const declaredPair: RoutingOwner = {
  topic: 'the handover',
  keywords: ['handover'],
  personaIds: ['manager', 'peer'],
  source: 'fact',
  sourceFactIndex: 1,
}

const quiet: RoutingMoveJudgments = {
  closingMove: 0.1,
  selfAnswer: 0.1,
  thinkingAloud: 0.1,
  sideComment: 0.1,
}

function moves(overrides: Partial<RoutingMoveJudgments> = {}): RoutingMoveJudgments {
  return { ...quiet, ...overrides }
}

function input(
  lastUser: string,
  owners: readonly RoutingOwner[],
  overrides: Partial<MoveDerivationInput> = {},
): MoveDerivationInput {
  return {
    context: makeContext({ lastUser, owners: [...owners] }),
    moves: quiet,
    topology: 'central_selection',
    seed: 7,
    ...overrides,
  }
}

describe('deriveMoveDecision', () => {
  it.each([['closingMove'], ['selfAnswer'], ['thinkingAloud'], ['sideComment']] as const)(
    'yields when %s is settled yes',
    (key) => {
      const result = deriveMoveDecision(
        input('Sam, what is on the action list?', [actionList], { moves: moves({ [key]: 0.8 }) }),
      )
      expect(result).toMatchObject({
        kind: 'yield',
        yieldReason: 'self_directed_move',
        fallbackCause: null,
      })
      expect(result.declines.map((decline) => decline.reason)).toEqual([
        'self_directed_move',
        'self_directed_move',
        'self_directed_move',
      ])
    },
  )

  it('speaks for one settled owner and declines the others', () => {
    const result = deriveMoveDecision(input('What is on the action list?', [actionList]))
    expect(result).toMatchObject({ kind: 'speak', personaId: 'peer', fallbackCause: null })
    expect(result.requests).toHaveLength(1)
    expect(result.requests[0]).toMatchObject({
      personaId: 'peer',
      action: 'speak',
      addressedByUser: false,
      confidence: 0.9,
    })
    expect(result.declines.map((decline) => decline.personaId)).toEqual(['manager', 'client'])
    expect(result.declines.every((decline) => decline.reason === 'not_owner')).toBe(true)
  })

  it('yields when no claim matches the utterance', () => {
    const result = deriveMoveDecision(input('How is the contract going?', [actionList]))
    expect(result).toMatchObject({ kind: 'yield', yieldReason: 'no_owner' })
    expect(result.requests).toEqual([])
  })

  it('uses the owner rule when a move answer is unsettled', () => {
    const result = deriveMoveDecision(
      input('What is on the action list?', [actionList], {
        moves: moves({ sideComment: 0.5 }),
      }),
    )
    expect(result).toMatchObject({
      kind: 'speak',
      personaId: 'peer',
      fallbackCause: 'unsettled',
    })
  })

  it('yields a declared pair under the unsettled owner rule', () => {
    const result = deriveMoveDecision(
      input('Who owns the handover?', [declaredPair], {
        moves: moves({ closingMove: 0.5 }),
      }),
    )
    expect(result).toMatchObject({
      kind: 'yield',
      yieldReason: 'unresolved_owner',
      fallbackCause: 'unsettled',
    })
  })

  it('speaks for the directly addressed owner under the unsettled rule', () => {
    const result = deriveMoveDecision(
      input('Katherine, what about the action list and the rollout?', [actionList, rollout], {
        moves: moves({ sideComment: 0.5 }),
      }),
    )
    expect(result).toMatchObject({
      kind: 'speak',
      personaId: 'manager',
      fallbackCause: 'unsettled',
    })
    expect(result.ownerSelection).toEqual({ kind: 'addressed', personaId: 'manager' })
    expect(result.requests[0]?.addressedByUser).toBe(true)
    // Confidence is the complement of the strongest self-directed signal.
    expect(result.requests[0]?.confidence).toBe(0.5)
  })

  it('yields with no owner when a move answer is unsettled', () => {
    const result = deriveMoveDecision(
      input('How is the contract going?', [actionList], {
        moves: moves({ selfAnswer: 0.5 }),
      }),
    )
    expect(result).toMatchObject({
      kind: 'yield',
      yieldReason: 'no_owner',
      fallbackCause: 'unsettled',
    })
  })

  it('yields when several owners are unresolved under the unsettled rule', () => {
    const result = deriveMoveDecision(
      input('What about the action list and the rollout?', [actionList, rollout], {
        moves: moves({ thinkingAloud: 0.5 }),
      }),
    )
    expect(result).toMatchObject({
      kind: 'yield',
      yieldReason: 'unresolved_owner',
      fallbackCause: 'unsettled',
    })
  })

  it('lets a central Choice pick between declared owners', () => {
    expect(
      deriveMoveDecision(
        input('Who owns the handover?', [declaredPair], { selectedPersonaId: 'manager' }),
      ),
    ).toMatchObject({ kind: 'speak', personaId: 'manager' })
  })

  it('yields a declared pair when the central Choice is absent', () => {
    expect(deriveMoveDecision(input('Who owns the handover?', [declaredPair]))).toMatchObject({
      kind: 'yield',
      yieldReason: 'unresolved_owner',
    })
  })

  it('rejects a central Choice outside the declared owners', () => {
    expect(
      deriveMoveDecision(
        input('Who owns the handover?', [declaredPair], { selectedPersonaId: 'client' }),
      ),
    ).toMatchObject({ kind: 'yield', yieldReason: 'unresolved_owner' })
  })

  it('ranks declared owners in the persona arm', () => {
    const result = deriveMoveDecision(
      input('Sam, who owns the handover?', [declaredPair], {
        topology: 'persona_requests',
        addressedPersonaIds: ['peer'],
      }),
    )
    expect(result).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.requests[0]?.addressedByUser).toBe(true)
  })

  it('ranks a declared pair with no address in the persona arm', () => {
    const result = deriveMoveDecision(
      input('Who owns the handover?', [declaredPair], { topology: 'persona_requests' }),
    )
    expect(result).toMatchObject({ kind: 'speak' })
    expect(['manager', 'peer']).toContain(result.personaId)
    expect(result.ownerSelection.kind).toBe('pair')
  })

  it('honours the explicit addressed list over the transcript', () => {
    const result = deriveMoveDecision(
      input('What about the action list and the rollout?', [actionList, rollout], {
        addressedPersonaIds: ['peer'],
      }),
    )
    expect(result).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.requests[0]?.addressedByUser).toBe(true)
  })

  it('does not treat two separate owners as a pair', () => {
    expect(
      deriveMoveDecision(
        input('What about the action list and the rollout?', [actionList, rollout]),
      ),
    ).toMatchObject({ kind: 'yield', yieldReason: 'unresolved_owner' })
  })

  it('separates two separate owners by direct address', () => {
    expect(
      deriveMoveDecision(
        input('Katherine, what about the action list and the rollout?', [actionList, rollout]),
      ),
    ).toMatchObject({ kind: 'speak', personaId: 'manager' })
  })
})

describe('deriveMoveDecision request shape', () => {
  it('accepts a full context and declares the owner selection', () => {
    const context: RoutingContext = makeContext({
      lastUser: 'What is on the action list?',
      owners: [actionList],
    })
    const result = deriveMoveDecision({
      context,
      moves: quiet,
      topology: 'central_selection',
      seed: 7,
    })
    expect(result.ownerSelection).toEqual({ kind: 'unique', personaId: 'peer' })
    expect(result.requests[0]?.turnId).toBe(context.turnId)
  })
})
