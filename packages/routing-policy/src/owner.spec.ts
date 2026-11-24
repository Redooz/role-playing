import { describe, expect, it } from 'vitest'
import { makeContext } from './fixtures.js'
import { matchedOwners, ownerPersonaIds, selectOwner } from './owner.js'
import type { RoutingOwner } from './schemas.js'

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

function context(lastUser: string, owners: readonly RoutingOwner[]) {
  return makeContext({ lastUser, owners: [...owners] })
}

describe('matchedOwners', () => {
  it('matches fact and objective claims by topic keyword', () => {
    const owners = matchedOwners(context('Sam, what is on the action list?', [actionList, rollout]))
    expect(owners).toEqual([actionList])
  })

  it('matches on any one declared keyword', () => {
    expect(matchedOwners(context('What is on the list?', [actionList]))).toEqual([actionList])
  })

  it('ignores a claim whose topic is not mentioned', () => {
    expect(matchedOwners(context('How is the contract going?', [actionList, rollout]))).toEqual([])
  })
})

describe('ownerPersonaIds', () => {
  it('returns distinct personas in context order', () => {
    expect(
      ownerPersonaIds(
        context('Sam, is the action list ready for the rollout?', [actionList, rollout]),
      ),
    ).toEqual(['manager', 'peer'])
  })

  it('deduplicates several claims by the same persona', () => {
    const notes: RoutingOwner = {
      topic: 'the follow-up notes',
      keywords: ['notes'],
      personaIds: ['peer'],
      source: 'fact',
      sourceFactIndex: 2,
    }
    expect(
      ownerPersonaIds(context('Sam, are the notes on the action list?', [actionList, notes])),
    ).toEqual(['peer'])
  })
})

describe('selectOwner', () => {
  it('returns none when no claim matches', () => {
    expect(selectOwner(context('How is the contract going?', [actionList]), [])).toEqual({
      kind: 'none',
    })
  })

  it('keeps a single owner even when the learner names someone else', () => {
    expect(
      selectOwner(context('Katherine, what is on the action list?', [actionList]), ['manager']),
    ).toEqual({ kind: 'unique', personaId: 'peer' })
  })

  it('uses a direct address to separate several owners', () => {
    expect(
      selectOwner(
        context('Sam, what is on the action list and the rollout?', [actionList, rollout]),
        ['peer'],
      ),
    ).toEqual({ kind: 'addressed', personaId: 'peer' })
  })

  it('resolves a declared pair when nobody is addressed', () => {
    expect(selectOwner(context('Who owns the handover?', [declaredPair]), [])).toEqual({
      kind: 'pair',
      personaIds: ['manager', 'peer'],
    })
  })

  it('prefers a two-owner claim to a one-owner claim for the same topic', () => {
    const notes: RoutingOwner = {
      topic: 'the notes',
      keywords: ['notes'],
      personaIds: ['manager'],
      source: 'fact',
      sourceFactIndex: 2,
    }
    expect(selectOwner(context('Who owns the handover notes?', [notes, declaredPair]), [])).toEqual(
      { kind: 'pair', personaIds: ['manager', 'peer'] },
    )
  })

  it('does not treat three matched owners as a pair', () => {
    const triple: RoutingOwner = {
      topic: 'the release plan',
      keywords: ['plan'],
      personaIds: ['manager', 'peer', 'client'],
      source: 'fact',
      sourceFactIndex: 3,
    }
    expect(selectOwner(context('Who owns the plan?', [triple]), [])).toEqual({
      kind: 'unresolved',
      personaIds: ['manager', 'peer', 'client'],
    })
  })

  it('does not treat a subset claim as the pair when three owners are matched', () => {
    const triple: RoutingOwner = {
      topic: 'the release plan',
      keywords: ['plan'],
      personaIds: ['manager', 'peer', 'client'],
      source: 'fact',
      sourceFactIndex: 3,
    }
    const subset: RoutingOwner = {
      topic: 'the handover',
      keywords: ['plan'],
      personaIds: ['manager', 'peer'],
      source: 'fact',
      sourceFactIndex: 4,
    }
    expect(selectOwner(context('Who owns the plan?', [triple, subset]), [])).toEqual({
      kind: 'unresolved',
      personaIds: ['manager', 'peer', 'client'],
    })
  })

  it('ignores an addressed persona who owns nothing', () => {
    expect(
      selectOwner(context('What about the action list and the rollout?', [actionList, rollout]), [
        'peer',
        'client',
      ]),
    ).toEqual({ kind: 'addressed', personaId: 'peer' })
  })

  it('does not treat two separate owners as a declared pair', () => {
    expect(
      selectOwner(
        context('What about the action list and the rollout?', [actionList, rollout]),
        [],
      ),
    ).toEqual({ kind: 'unresolved', personaIds: ['manager', 'peer'] })
  })

  it('leaves several addressed owners unresolved', () => {
    expect(
      selectOwner(
        context('Katherine, Sam, what about the action list and the rollout?', [
          actionList,
          rollout,
        ]),
        ['manager', 'peer'],
      ),
    ).toEqual({ kind: 'unresolved', personaIds: ['manager', 'peer'] })
  })
})
