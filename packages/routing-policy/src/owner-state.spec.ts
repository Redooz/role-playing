import { describe, expect, it } from 'vitest'
import { routingOwnerSchema } from './owner-state.js'

const factOwner = {
  topic: 'the action list',
  keywords: ['action'],
  personaIds: ['peer'],
  source: 'fact' as const,
  sourceFactIndex: 1,
}

const objectiveOwner = {
  topic: 'Agree the rollout date with the manager.',
  keywords: ['rollout'],
  personaIds: ['manager'],
  source: 'objective' as const,
  objectiveId: 'agree-rollout',
}

function issuesOf(value: unknown) {
  const parsed = routingOwnerSchema.safeParse(value)
  if (parsed.success) throw new Error('expected the owner to be rejected')
  return parsed.error.issues
}

describe('routingOwnerSchema', () => {
  it('accepts a fact claim and an objective claim', () => {
    expect(routingOwnerSchema.parse(factOwner)).toEqual(factOwner)
    expect(routingOwnerSchema.parse(objectiveOwner)).toEqual(objectiveOwner)
  })

  it('rejects an empty topic, keyword or persona id', () => {
    expect(() => routingOwnerSchema.parse({ ...factOwner, topic: '' })).toThrow()
    expect(() => routingOwnerSchema.parse({ ...factOwner, keywords: [] })).toThrow()
    expect(() => routingOwnerSchema.parse({ ...factOwner, keywords: [''] })).toThrow()
    expect(() => routingOwnerSchema.parse({ ...factOwner, personaIds: [] })).toThrow()
    expect(() => routingOwnerSchema.parse({ ...factOwner, personaIds: [''] })).toThrow()
  })

  it('requires a source fact index on a fact claim', () => {
    const { sourceFactIndex: _omitted, ...withoutIndex } = factOwner
    expect(issuesOf(withoutIndex)).toContainEqual(
      expect.objectContaining({
        code: 'custom',
        path: ['sourceFactIndex'],
        message: 'a fact owner needs a source fact index',
      }),
    )
  })

  it('rejects an objective id on a fact claim', () => {
    expect(issuesOf({ ...factOwner, objectiveId: 'agree-rollout' })).toContainEqual(
      expect.objectContaining({
        code: 'custom',
        path: ['objectiveId'],
        message: 'a fact owner cannot name an objective',
      }),
    )
  })

  it('requires an objective id on an objective claim', () => {
    const { objectiveId: _omitted, ...withoutId } = objectiveOwner
    expect(issuesOf(withoutId)).toContainEqual(
      expect.objectContaining({
        code: 'custom',
        path: ['objectiveId'],
        message: 'an objective owner needs an objective id',
      }),
    )
  })

  it('rejects a fact index on an objective claim', () => {
    expect(issuesOf({ ...objectiveOwner, sourceFactIndex: 0 })).toContainEqual(
      expect.objectContaining({
        code: 'custom',
        path: ['sourceFactIndex'],
        message: 'an objective owner cannot name a fact index',
      }),
    )
  })

  it('rejects an unknown source and a non-integer or negative fact index', () => {
    expect(() => routingOwnerSchema.parse({ ...factOwner, source: 'rumour' })).toThrow()
    expect(() => routingOwnerSchema.parse({ ...factOwner, sourceFactIndex: -1 })).toThrow()
    expect(() => routingOwnerSchema.parse({ ...factOwner, sourceFactIndex: 1.5 })).toThrow()
  })
})
