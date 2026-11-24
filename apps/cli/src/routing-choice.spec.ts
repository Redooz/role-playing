import { describe, expect, it } from 'vitest'
import { routingChoiceFor, routingRequestFrom, type RoutingChoiceInput } from './routing-choice.js'

function input(overrides: Partial<RoutingChoiceInput> = {}): RoutingChoiceInput {
  return {
    requested: 'auto',
    provider: 'live',
    lang: 'en',
    personaCount: 2,
    hasRouterKey: true,
    ...overrides,
  }
}

describe('routingRequestFrom', () => {
  it('defaults to auto', () => {
    expect(routingRequestFrom(undefined)).toBe('auto')
  })

  it('accepts the two documented values', () => {
    expect(routingRequestFrom('auto')).toBe('auto')
    expect(routingRequestFrom('det-persona')).toBe('det-persona')
  })

  it('rejects any other value', () => {
    expect(() => routingRequestFrom('jev-central')).toThrow(/--routing must be/u)
    expect(() => routingRequestFrom('')).toThrow(/--routing must be/u)
  })
})

describe('routingChoiceFor', () => {
  it('uses jev-central for an English live two-persona session with a key', () => {
    expect(routingChoiceFor(input())).toEqual({ choice: 'jev-central' })
  })

  it('keeps det-persona when the flag asks for it', () => {
    expect(routingChoiceFor(input({ requested: 'det-persona' }))).toEqual({
      choice: 'det-persona',
    })
  })

  it('keeps det-persona in canned mode', () => {
    expect(routingChoiceFor(input({ provider: 'canned' }))).toEqual({ choice: 'det-persona' })
  })

  it('keeps det-persona for French', () => {
    expect(routingChoiceFor(input({ lang: 'fr' }))).toEqual({ choice: 'det-persona' })
  })

  it('keeps det-persona for a single-persona session', () => {
    expect(routingChoiceFor(input({ personaCount: 1 }))).toEqual({ choice: 'det-persona' })
  })

  it('reports the missing key instead of failing the session', () => {
    expect(routingChoiceFor(input({ hasRouterKey: false }))).toEqual({
      choice: 'det-persona',
      warning: 'missing-openrouter-key',
    })
  })
})
