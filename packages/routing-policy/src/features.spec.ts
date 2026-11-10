import { describe, expect, it } from 'vitest'
import { makeContext } from './fixtures.js'
import type { RoutingContext } from './schemas.js'
import {
  containsRoutingTerm,
  deterministicJudgments,
  isPersonaAddressed,
  lastPersonaTurnIndexes,
  lastUserUtterance,
  normalizeRoutingText,
  objectiveRelevanceFor,
  uncoveredMatchedObjectives,
  urgencyFor,
} from './features.js'

const manager = makeContext().personas[0]!
const peer = makeContext().personas[1]!

describe('normalizeRoutingText', () => {
  it('normalises Unicode and lowercases using the routing language', () => {
    expect(normalizeRoutingText('  DÉLAI  ', 'fr')).toBe('  délai  ')
  })
})

describe('containsRoutingTerm', () => {
  it('matches a whole word', () => {
    expect(containsRoutingTerm('Ask Sam, please.', 'Sam', 'en')).toBe(true)
  })

  it('does not match a substring inside another word', () => {
    expect(containsRoutingTerm('It is the same file.', 'Sam', 'en')).toBe(false)
  })

  it('matches accented French terms', () => {
    expect(containsRoutingTerm('Le délai est court.', 'délai', 'fr')).toBe(true)
  })

  it('normalises compatibility forms', () => {
    expect(containsRoutingTerm('the ﬁle is ready', 'file', 'en')).toBe(true)
    expect(containsRoutingTerm('the ﬁle is ready', 'ﬁle', 'en')).toBe(true)
  })

  it('escapes regular-expression metacharacters in the term', () => {
    expect(containsRoutingTerm('Use a+b here.', 'a+b', 'en')).toBe(true)
    expect(containsRoutingTerm('Use aaab here.', 'a+b', 'en')).toBe(false)
  })

  it('trims surrounding whitespace from the term', () => {
    expect(containsRoutingTerm('Ask Sam, please.', '  Sam  ', 'en')).toBe(true)
  })

  it('does not treat a whitespace-only term as a match', () => {
    expect(containsRoutingTerm('a b', ' ', 'en')).toBe(false)
    expect(containsRoutingTerm('a  b', ' ', 'en')).toBe(false)
    expect(containsRoutingTerm('a  b', '   ', 'en')).toBe(false)
  })

  it('treats punctuation as a boundary', () => {
    expect(containsRoutingTerm('(Sam)', 'Sam', 'en')).toBe(true)
  })

  it('rejects an empty term', () => {
    expect(containsRoutingTerm('anything', '   ', 'en')).toBe(false)
  })
})

describe('lastUserUtterance', () => {
  it('returns the latest committed user turn', () => {
    const context = makeContext({
      transcript: [
        { speaker: { kind: 'user' }, text: 'First.' },
        { speaker: { kind: 'persona', personaId: 'peer' }, text: 'Reply.' },
        { speaker: { kind: 'user' }, text: 'Second.' },
      ],
    })
    expect(lastUserUtterance(context)).toBe('Second.')
  })

  it('rejects a raw context without a final user turn', () => {
    const context = {
      transcript: [{ speaker: { kind: 'persona', personaId: 'peer' }, text: 'Reply.' }],
    } as unknown as RoutingContext
    expect(() => lastUserUtterance(context)).toThrow(/no committed user utterance/i)

    const empty = { transcript: [] } as unknown as RoutingContext
    expect(() => lastUserUtterance(empty)).toThrow(/no committed user utterance/i)
  })
})

describe('isPersonaAddressed', () => {
  it('matches the display name', () => {
    expect(isPersonaAddressed(makeContext({ lastUser: 'Katherine?' }), manager)).toBe(true)
  })

  it('matches an alias', () => {
    expect(isPersonaAddressed(makeContext({ lastUser: 'Kate, a word?' }), manager)).toBe(true)
  })

  it('does not match a different persona', () => {
    expect(isPersonaAddressed(makeContext({ lastUser: 'Julian?' }), manager)).toBe(false)
  })
})

describe('uncoveredMatchedObjectives', () => {
  it('returns objectives whose keywords appear and which are not covered', () => {
    const context = makeContext({
      lastUser: 'Can you confirm the handoff or find cover?',
      coveredObjectiveIds: [],
    })
    expect(uncoveredMatchedObjectives(context, peer).map((objective) => objective.id)).toEqual([
      'handoff',
      'coverage',
    ])
  })

  it('excludes a covered objective', () => {
    const context = makeContext({
      lastUser: 'Can you confirm the handoff or find cover?',
      coveredObjectiveIds: ['handoff'],
    })
    expect(uncoveredMatchedObjectives(context, peer).map((objective) => objective.id)).toEqual([
      'coverage',
    ])
  })

  it('matches multi-word keywords', () => {
    const context = makeContext({ lastUser: 'What delivery date works?' })
    expect(uncoveredMatchedObjectives(context, manager)).toHaveLength(1)
  })

  it('returns nothing when no keyword appears', () => {
    expect(uncoveredMatchedObjectives(makeContext({ lastUser: 'Hello there.' }), peer)).toEqual([])
  })
})

describe('deterministicJudgments', () => {
  it('marks a directly addressed persona relevant and not paused', () => {
    expect(deterministicJudgments(makeContext(), peer)).toEqual({
      directlyAddressed: 1,
      hasRelevantContribution: 1,
      addsUncoveredInformation: 1,
      hasUnmetRelevantObjective: 0,
      pauseWouldBenefitUser: 0,
    })
  })

  it('marks a non-addressed persona with no matched objective as paused', () => {
    expect(deterministicJudgments(makeContext(), manager)).toEqual({
      directlyAddressed: 0,
      hasRelevantContribution: 0,
      addsUncoveredInformation: 0,
      hasUnmetRelevantObjective: 0,
      pauseWouldBenefitUser: 1,
    })
  })

  it('keeps an objective-addressed persona relevant without direct address', () => {
    const context = makeContext({ lastUser: 'What is the deadline?' })
    expect(deterministicJudgments(context, manager)).toMatchObject({
      directlyAddressed: 0,
      hasRelevantContribution: 1,
      addsUncoveredInformation: 1,
      pauseWouldBenefitUser: 0,
    })
  })

  it('does not add information when every matched objective is covered', () => {
    const context = makeContext({
      lastUser: 'What is the deadline?',
      coveredObjectiveIds: ['deadline'],
    })
    expect(deterministicJudgments(context, manager)).toMatchObject({
      hasRelevantContribution: 0,
      addsUncoveredInformation: 0,
      pauseWouldBenefitUser: 1,
    })
  })

  it('uses direct address even when the persona has no matched objective', () => {
    const context = makeContext({ lastUser: 'Katherine?' })
    expect(deterministicJudgments(context, manager)).toMatchObject({
      directlyAddressed: 1,
      hasRelevantContribution: 1,
      addsUncoveredInformation: 0,
      pauseWouldBenefitUser: 0,
    })
  })

  it('marks an unmet objective when only some objectives are matched', () => {
    const context = makeContext({ lastUser: 'Can you confirm the handoff?' })
    expect(deterministicJudgments(context, peer)).toMatchObject({
      hasRelevantContribution: 1,
      addsUncoveredInformation: 1,
      hasUnmetRelevantObjective: 1,
    })
  })
})

describe('objectiveRelevanceFor', () => {
  it('returns one for direct address even without a keyword match', () => {
    expect(objectiveRelevanceFor(makeContext({ lastUser: 'Katherine?' }), manager)).toBe(1)
  })

  it('returns one for direct address when all objectives also match', () => {
    expect(objectiveRelevanceFor(makeContext(), peer)).toBe(1)
  })

  it('returns the uncovered match fraction', () => {
    const context = makeContext({
      lastUser: 'Can you confirm the handoff?',
      coveredObjectiveIds: [],
    })
    expect(objectiveRelevanceFor(context, peer)).toBe(0.5)
  })

  it('returns zero without a match', () => {
    expect(objectiveRelevanceFor(makeContext({ lastUser: 'Hello.' }), peer)).toBe(0)
  })
})

describe('urgencyFor', () => {
  it('returns one for direct address', () => {
    expect(urgencyFor(makeContext(), peer)).toBe(1)
  })

  it('returns 0.6 for an objective match', () => {
    expect(urgencyFor(makeContext({ lastUser: 'What is the deadline?' }), manager)).toBe(0.6)
  })

  it('returns zero otherwise', () => {
    expect(urgencyFor(makeContext({ lastUser: 'Hello.' }), manager)).toBe(0)
  })
})

describe('lastPersonaTurnIndexes', () => {
  it('keeps the latest index for each persona', () => {
    const context = makeContext({
      transcript: [
        { speaker: { kind: 'persona', personaId: 'peer' }, text: 'One.' },
        { speaker: { kind: 'persona', personaId: 'manager' }, text: 'Two.' },
        { speaker: { kind: 'persona', personaId: 'peer' }, text: 'Three.' },
        { speaker: { kind: 'user' }, text: 'Question.' },
      ],
    })
    const indexes = lastPersonaTurnIndexes(context)
    expect(indexes.size).toBe(2)
    expect(indexes.get('peer')).toBe(2)
    expect(indexes.get('manager')).toBe(1)
    expect(indexes.has('client')).toBe(false)
  })
})
