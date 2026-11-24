import type { RoutingContext } from '@rp/routing-policy'
import type { PersonaPolicyInput } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import type { RoutingChoice } from './routing-choice.js'
import { createSessionRoutingPolicy } from './routing-policy.adapter.js'

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

const noFallback = () => {}

describe('createSessionRoutingPolicy', () => {
  it('returns the deterministic incumbent for det-persona and never builds a judge', async () => {
    let built = 0
    const policy = createSessionRoutingPolicy({
      choice: 'det-persona',
      createJudge: () => {
        built += 1
        throw new Error('unexpected judge')
      },
      onFallback: noFallback,
    })

    const decision = await policy.decide(input('peer'))
    expect(built).toBe(0)
    expect(decision.kind).toBe('decline')
  })

  it('wraps the incumbent when jev-central is chosen', async () => {
    const failures: unknown[] = []
    const policy = createSessionRoutingPolicy({
      choice: 'jev-central' as RoutingChoice,
      createJudge: () => ({
        async judgeCentral() {
          throw new Error('network down')
        },
      }),
      onFallback: (failure) => failures.push(failure),
    })

    const decision = await policy.decide(input('peer'))
    expect(failures).toEqual([{ turnId: 'turn-1', cause: 'error' }])
    expect(decision.kind).toBe('decline')
  })
})
