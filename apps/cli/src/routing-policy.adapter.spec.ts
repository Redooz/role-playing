import type { RoutingContext } from '@rp/routing-policy'
import type { PersonaPolicyInput } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import type { SessionRoutingOptions } from './routing-policy.adapter.js'
import { createSessionRouting } from './routing-policy.adapter.js'

const context = {
  decisionId: 'decision-1',
  turnId: 'turn-1',
  lang: 'en',
  coveredObjectiveIds: [],
  owners: [],
  personas: [
    {
      id: 'manager',
      displayName: 'Katherine Brooks',
      aliases: ['Katherine'],
      role: 'manager',
      objectives: [],
    },
    {
      id: 'peer',
      displayName: 'Sam Carter',
      aliases: ['Sam'],
      role: 'peer colleague',
      objectives: [],
    },
  ],
  transcript: [{ speaker: { kind: 'user' }, text: 'Hello.' }],
} as unknown as RoutingContext

function input(personaId: string): PersonaPolicyInput<RoutingContext> {
  return { personaId, turnId: 'turn-1', action: 'speak', messages: [], lang: 'en', context }
}

const noPersona = async (): Promise<never> => {
  throw new Error('the central arm never asks for a persona judgment')
}

function options(overrides: Partial<SessionRoutingOptions> = {}): SessionRoutingOptions {
  return {
    requested: 'auto',
    provider: 'live',
    lang: 'en',
    personaCount: 2,
    env: { OPENROUTER_API_KEY: 'router-key' },
    createJudge: () => ({
      async judgeCentral() {
        throw new Error('unexpected judge')
      },
      judgePersona: noPersona,
    }),
    onFallback: () => {},
    ...overrides,
  }
}

describe('createSessionRouting', () => {
  it('wraps the deterministic incumbent for English with a key', async () => {
    const failures: unknown[] = []
    const routing = createSessionRouting(
      options({
        createJudge: () => ({
          async judgeCentral() {
            throw new Error('network down')
          },
          judgePersona: noPersona,
        }),
        onFallback: (failure) => failures.push(failure),
      }),
    )

    expect(routing.choice).toBe('jev-central')
    expect(routing.label).toBe('jev-central (English, det-persona fallback)')
    expect(routing.note).toBeUndefined()
    expect(await routing.policy.decide(input('peer'))).toEqual({ kind: 'decline' })
    expect(failures).toEqual([{ turnId: 'turn-1', cause: 'error' }])
  })

  it('passes the trimmed key to the judge factory', () => {
    const keys: string[] = []
    createSessionRouting(
      options({
        env: { OPENROUTER_API_KEY: '  router-key  ' },
        createJudge: (apiKey) => {
          keys.push(apiKey)
          return {
            judgeCentral: async () => ({ ok: true }) as never,
            judgePersona: noPersona,
          }
        },
      }),
    )
    expect(keys).toEqual(['router-key'])
  })

  it('keeps det-persona when the flag asks for it and never builds a judge', async () => {
    let built = 0
    const routing = createSessionRouting(
      options({
        requested: 'det-persona',
        createJudge: () => {
          built += 1
          throw new Error('unexpected judge')
        },
      }),
    )

    expect(routing.choice).toBe('det-persona')
    expect(routing.label).toBe('det-persona')
    expect(await routing.policy.decide(input('peer'))).toEqual({ kind: 'decline' })
    expect(built).toBe(0)
  })

  it('reports a missing key instead of failing the session', () => {
    const routing = createSessionRouting(options({ env: {} }))

    expect(routing.choice).toBe('det-persona')
    expect(routing.label).toBe('det-persona (OPENROUTER_API_KEY missing: Jev routing off)')
    expect(routing.note).toBe('this English session uses det-persona routing')
  })

  it('keeps det-persona for canned mode even with a key', () => {
    expect(createSessionRouting(options({ provider: 'canned' }))).toMatchObject({
      choice: 'det-persona',
      label: 'det-persona',
    })
  })

  it('keeps det-persona for a French session even with a key', () => {
    expect(createSessionRouting(options({ lang: 'fr' }))).toMatchObject({
      choice: 'det-persona',
      label: 'det-persona',
    })
  })

  it('keeps det-persona for a single-persona session even with a key', () => {
    expect(createSessionRouting(options({ personaCount: 1 }))).toMatchObject({
      choice: 'det-persona',
      label: 'det-persona',
    })
  })
})
