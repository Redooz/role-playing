import type { TurnRequest } from '@rp/session-core'
import { hashValue } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import { makeContext } from './fixtures.js'
import { compareTurnRequests, rankTurnRequests } from './rank.js'

function request(personaId: string, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: 'turn-1',
    personaId,
    action: 'speak',
    urgency: 0.5,
    confidence: 0.5,
    addressedByUser: false,
    objectiveRelevance: 0.5,
    ...overrides,
  }
}

function ids(requests: readonly TurnRequest[]): string[] {
  return requests.map((entry) => entry.personaId)
}

describe('compareTurnRequests', () => {
  it('sorts a direct address first in both directions', () => {
    const context = makeContext()
    const direct = request('peer', { addressedByUser: true })
    const indirect = request('manager')
    expect(compareTurnRequests(context, direct, indirect, 1)).toBeLessThan(0)
    expect(compareTurnRequests(context, indirect, direct, 1)).toBeGreaterThan(0)
  })

  it('sorts higher objective relevance first in both directions', () => {
    const context = makeContext({ transcript: [{ speaker: { kind: 'user' }, text: 'Question.' }] })
    const high = request('peer', { objectiveRelevance: 0.8, urgency: 0.1 })
    const low = request('manager', { objectiveRelevance: 0.2, urgency: 0.9 })
    expect(compareTurnRequests(context, high, low, 1)).toBeLessThan(0)
    expect(compareTurnRequests(context, low, high, 1)).toBeGreaterThan(0)
  })

  it('sorts higher urgency first in both directions', () => {
    const context = makeContext({
      transcript: [
        { speaker: { kind: 'persona', personaId: 'peer' }, text: 'Earlier.' },
        { speaker: { kind: 'user' }, text: 'Question.' },
      ],
    })
    const high = request('peer', { urgency: 0.8 })
    const low = request('manager', { urgency: 0.2 })
    expect(compareTurnRequests(context, high, low, 1)).toBeLessThan(0)
    expect(compareTurnRequests(context, low, high, 1)).toBeGreaterThan(0)
  })

  it('sorts the persona who waited longest first in both directions', () => {
    const context = makeContext({
      transcript: [
        { speaker: { kind: 'persona', personaId: 'peer' }, text: 'Earlier.' },
        { speaker: { kind: 'persona', personaId: 'manager' }, text: 'Later.' },
        { speaker: { kind: 'user' }, text: 'A question.' },
      ],
    })
    expect(compareTurnRequests(context, request('peer'), request('manager'), 1)).toBeLessThan(0)
    expect(compareTurnRequests(context, request('manager'), request('peer'), 1)).toBeGreaterThan(0)
  })

  it('breaks a complete tie with the seeded hash in both directions', () => {
    const context = makeContext({ transcript: [{ speaker: { kind: 'user' }, text: 'Question.' }] })
    const forward = compareTurnRequests(context, request('manager'), request('peer'), 7)
    const reverse = compareTurnRequests(context, request('peer'), request('manager'), 7)
    expect(Math.sign(forward)).toBe(-Math.sign(reverse))
  })

  it('returns equal for the same request and persona', () => {
    const context = makeContext({ transcript: [{ speaker: { kind: 'user' }, text: 'Question.' }] })
    const same = request('manager')
    expect(compareTurnRequests(context, same, { ...same }, 7)).toBe(0)
  })
})

describe('rankTurnRequests', () => {
  it('ranks direct address before every other feature', () => {
    expect(
      ids(
        rankTurnRequests(
          makeContext(),
          [
            request('manager', { objectiveRelevance: 1, urgency: 1 }),
            request('peer', { addressedByUser: true, objectiveRelevance: 0, urgency: 0 }),
          ],
          1,
        ),
      ),
    ).toEqual(['peer', 'manager'])
  })

  it('ranks objective relevance descending', () => {
    expect(
      ids(
        rankTurnRequests(
          makeContext(),
          [
            request('manager', { objectiveRelevance: 0.2 }),
            request('peer', { objectiveRelevance: 0.8 }),
          ],
          1,
        ),
      ),
    ).toEqual(['peer', 'manager'])
  })

  it('ranks urgency descending after relevance', () => {
    expect(
      ids(
        rankTurnRequests(
          makeContext(),
          [request('manager', { urgency: 0.2 }), request('peer', { urgency: 0.8 })],
          1,
        ),
      ),
    ).toEqual(['peer', 'manager'])
  })

  it('prefers the persona who has waited longer', () => {
    const context = makeContext({
      transcript: [
        { speaker: { kind: 'persona', personaId: 'peer' }, text: 'Earlier.' },
        { speaker: { kind: 'persona', personaId: 'manager' }, text: 'Later.' },
        { speaker: { kind: 'user' }, text: 'A question.' },
      ],
    })
    expect(ids(rankTurnRequests(context, [request('manager'), request('peer')], 1))).toEqual([
      'peer',
      'manager',
    ])
  })

  it('prefers a persona who has never spoken', () => {
    const context = makeContext({
      transcript: [
        { speaker: { kind: 'persona', personaId: 'manager' }, text: 'Earlier.' },
        { speaker: { kind: 'user' }, text: 'A question.' },
      ],
    })
    expect(ids(rankTurnRequests(context, [request('manager'), request('peer')], 1))).toEqual([
      'peer',
      'manager',
    ])
  })

  it('uses a stable seeded hash for a complete tie', () => {
    const context = makeContext({ transcript: [{ speaker: { kind: 'user' }, text: 'Question.' }] })
    const forward = rankTurnRequests(context, [request('manager'), request('peer')], 7)
    const reverse = rankTurnRequests(context, [request('peer'), request('manager')], 7)
    expect(ids(forward)).toEqual(ids(reverse))
  })

  it('selects the persona with the lower canonical hash as the tie-break', () => {
    const context = makeContext({ transcript: [{ speaker: { kind: 'user' }, text: 'Question.' }] })
    const ranked = rankTurnRequests(context, [request('manager'), request('peer')], 7)
    const hashes = ['manager', 'peer'].map((personaId) => ({
      personaId,
      hash: hashValue({ seed: 7, turnId: context.turnId, personaId }),
    }))
    hashes.sort((left, right) => (left.hash < right.hash ? -1 : 1))
    expect(ids(ranked)).toEqual(hashes.map((entry) => entry.personaId))
  })

  it('does not mutate the input array', () => {
    const input = [
      request('manager', { objectiveRelevance: 0.2 }),
      request('peer', { objectiveRelevance: 0.8 }),
    ]
    const snapshot = [...input]
    rankTurnRequests(makeContext(), input, 1)
    expect(input).toEqual(snapshot)
  })

  it('returns an empty list unchanged', () => {
    expect(rankTurnRequests(makeContext(), [], 1)).toEqual([])
  })
})
