import { FakeClock } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import type {
  PersonaPolicyDecision,
  PersonaPolicyInput,
  SessionArbiterInput,
} from './arbiter-port.js'
import type { TurnRequest } from './events.js'
import { collectInterjections, type InterjectionHost } from './turn-interjections.js'

interface TestContext {
  readonly turnId: string
}

const clock = new FakeClock(5)

function interjectRequest(personaId: string, grantId: string): TurnRequest {
  return {
    turnId: 'turn-2',
    personaId,
    action: 'interject',
    targetGrantId: grantId,
    urgency: 0,
    confidence: 1,
    addressedByUser: false,
    objectiveRelevance: 0,
  }
}

function setup(
  options: {
    readonly candidates?: readonly string[]
    readonly decide?: (
      input: PersonaPolicyInput<TestContext>,
    ) => PersonaPolicyDecision | Promise<PersonaPolicyDecision>
  } = {},
): {
  readonly host: InterjectionHost<TestContext>
  readonly reduced: SessionArbiterInput<TestContext>[]
  readonly failed: string[]
  readonly inputs: PersonaPolicyInput<TestContext>[]
} {
  const reduced: SessionArbiterInput<TestContext>[] = []
  const failed: string[] = []
  const inputs: PersonaPolicyInput<TestContext>[] = []
  const candidates = (options.candidates ?? ['peer']).map((personaId) => ({ personaId }))

  const host: InterjectionHost<TestContext> = {
    clock,
    policy: {
      decide(input) {
        inputs.push(input)
        return options.decide?.(input) ?? { kind: 'decline' as const }
      },
    },
    requestWindowMs: 5,
    candidates,
    policyInput: (personaId, turnId, action, targetGrantId) => ({
      personaId,
      turnId,
      action,
      targetGrantId,
      messages: [],
      lang: 'en',
      context: { turnId },
    }),
    markFailed: (personaId) => failed.push(personaId),
    reduce: async (input) => {
      reduced.push(input)
    },
  }

  return { host, reduced, failed, inputs }
}

describe('interjection collection', () => {
  it('reduces one accepted interject request for each candidate that asks', async () => {
    const { host, reduced } = setup({
      decide: (input) => ({ kind: 'request', request: interjectRequest(input.personaId, 'g-1') }),
    })

    await collectInterjections({ turnId: 'turn-2', grantId: 'g-1' }, host)

    expect(reduced).toEqual([
      { kind: 'request', request: interjectRequest('peer', 'g-1'), nowMs: 5 },
    ])
  })

  it('reduces nothing for a decline', async () => {
    const { host, reduced, failed } = setup()
    await collectInterjections({ turnId: 'turn-2', grantId: 'g-1' }, host)
    expect(reduced).toEqual([])
    expect(failed).toEqual([])
  })

  it('records a timeout as a failed policy call, never a decline', async () => {
    const { host, reduced, failed } = setup({ decide: () => new Promise(() => undefined) })
    await collectInterjections({ turnId: 'turn-2', grantId: 'g-1' }, host)
    expect(failed).toEqual(['peer'])
    expect(reduced).toEqual([
      {
        kind: 'policy_failed',
        turnId: 'turn-2',
        personaId: 'peer',
        cause: 'timeout',
        nowMs: 5,
      },
    ])
  })

  it('records an error as a failed policy call', async () => {
    const { host, reduced, failed } = setup({
      decide: () => {
        throw new Error('policy failed')
      },
    })
    await collectInterjections({ turnId: 'turn-2', grantId: 'g-1' }, host)
    expect(failed).toEqual(['peer'])
    expect(reduced).toEqual([
      { kind: 'policy_failed', turnId: 'turn-2', personaId: 'peer', cause: 'error', nowMs: 5 },
    ])
  })

  it('records a request for another grant as a failed call, never a fabricated request', async () => {
    const { host, reduced, failed } = setup({
      decide: (input) => ({
        kind: 'request',
        request: interjectRequest(input.personaId, 'other-grant'),
      }),
    })
    await collectInterjections({ turnId: 'turn-2', grantId: 'g-1' }, host)
    expect(failed).toEqual(['peer'])
    expect(reduced.map((input) => input.kind)).toEqual(['policy_failed'])
  })

  it('passes the turn and target grant to the policy input', async () => {
    const { host, inputs } = setup()
    await collectInterjections({ turnId: 'turn-2', grantId: 'g-1' }, host)
    expect(inputs[0]).toMatchObject({
      personaId: 'peer',
      turnId: 'turn-2',
      action: 'interject',
      targetGrantId: 'g-1',
    })
  })

  it('calls no policy when no candidate remains', async () => {
    const { host, reduced, inputs } = setup({ candidates: [] })
    await collectInterjections({ turnId: 'turn-2', grantId: 'g-1' }, host)
    expect(inputs).toEqual([])
    expect(reduced).toEqual([])
  })
})
