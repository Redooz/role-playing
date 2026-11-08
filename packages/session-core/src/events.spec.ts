import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import {
  eventPayloadSchemas,
  isSessionEventName,
  parseSessionEvent,
  sessionEventNames,
  sessionEventSchema,
  type SessionEvent,
  type SessionEventName,
} from './events.js'

const GRANT_ID = 'grant-1'
const TURN_ID = 'turn-1'
const PERSONA_ID = 'persona-1'
const EXPIRES_AT = '2026-01-01T00:00:00.000Z'

/**
 * One good and one bad payload per §2.1 event. `satisfies` makes the test fail
 * to compile if an event is added without coverage.
 */
const payloadCases = {
  'session.started': {
    good: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en', taskId: 'task-1' },
    bad: { sessionId: '', clockMode: 'simulated', lang: 'en' },
  },
  'user.started_speaking': {
    good: {},
    bad: { source: 'keyboard' },
  },
  'user.utterance.committed': {
    good: { text: 'I would like to practise a negotiation.' },
    bad: {},
  },
  'user.barge_in': {
    good: { targetGrantId: GRANT_ID },
    bad: { targetGrantId: 42 },
  },
  'persona.utterance.partial': {
    good: { grantId: GRANT_ID, text: 'So the', sequence: 0 },
    bad: { grantId: GRANT_ID, text: 'So the', sequence: -1 },
  },
  'turn.opened': {
    good: { turnId: TURN_ID },
    bad: { turnId: '' },
  },
  'persona.requested_turn': {
    good: {
      request: {
        turnId: TURN_ID,
        personaId: PERSONA_ID,
        action: 'interject',
        urgency: 0.8,
        confidence: 0.7,
        addressedByUser: false,
        objectiveRelevance: 0.6,
        targetGrantId: GRANT_ID,
      },
    },
    bad: {
      // interject without targetGrantId violates §3.4/§3.2.
      request: {
        turnId: TURN_ID,
        personaId: PERSONA_ID,
        action: 'interject',
        urgency: 0.8,
        confidence: 0.7,
        addressedByUser: false,
        objectiveRelevance: 0.6,
      },
    },
  },
  'persona.declined': {
    good: { turnId: TURN_ID, personaId: PERSONA_ID },
    bad: { turnId: TURN_ID },
  },
  'turn.granted': {
    good: {
      grant: {
        turnId: TURN_ID,
        grantId: GRANT_ID,
        personaId: PERSONA_ID,
        expiresAt: EXPIRES_AT,
      },
    },
    bad: {
      grant: { turnId: TURN_ID, grantId: GRANT_ID, personaId: PERSONA_ID },
    },
  },
  'turn.revoked': {
    good: { grantId: GRANT_ID, reason: 'timeout' },
    bad: { grantId: GRANT_ID, reason: 'because' },
  },
  'turn.user_yielded': {
    good: { reason: 'all_declined' },
    bad: { reason: 'nobody_wanted_it' },
  },
  'persona.response.started': {
    good: { grantId: GRANT_ID },
    bad: {},
  },
  'persona.response.chunk': {
    good: { grantId: GRANT_ID, text: 'Hello', sequence: 1 },
    bad: { grantId: GRANT_ID, text: 'Hello' },
  },
  'persona.response.committed': {
    good: { grantId: GRANT_ID, text: 'Hello there.' },
    bad: { grantId: '', text: 'Hello there.' },
  },
  'persona.response.cancelled': {
    good: { grantId: GRANT_ID, reason: 'interrupted', partialText: 'Hel' },
    bad: { grantId: GRANT_ID, reason: 'user_was_bored' },
  },
  'session.completed': {
    good: {},
    bad: { reason: 'user_ended' },
  },
} satisfies Record<SessionEventName, { good: unknown; bad: unknown }>

function payloadSchema(name: SessionEventName): ZodType {
  return eventPayloadSchemas[name] as ZodType
}

describe('event payload schemas', () => {
  it('covers every §2.1 event exactly once', () => {
    expect(sessionEventNames).toHaveLength(Object.keys(payloadCases).length)
    expect(new Set(sessionEventNames).size).toBe(sessionEventNames.length)
  })

  for (const name of sessionEventNames) {
    const testCase = payloadCases[name]

    it(`accepts a valid ${name} payload`, () => {
      expect(payloadSchema(name).safeParse(testCase.good).success).toBe(true)
    })

    it(`rejects an invalid ${name} payload`, () => {
      expect(payloadSchema(name).safeParse(testCase.bad).success).toBe(false)
    })
  }

  it('rejects unknown fields instead of silently dropping them', () => {
    expect(
      payloadSchema('persona.response.chunk').safeParse({
        grantId: GRANT_ID,
        text: 'Hi',
        sequence: 0,
        audio: true,
      }).success,
    ).toBe(false)
  })

  it('accepts a short provider-failure detail and rejects empty or oversized ones', () => {
    const cancelled = payloadSchema('persona.response.cancelled')
    const base = { grantId: GRANT_ID, reason: 'provider_failure' }

    expect(cancelled.safeParse({ ...base, detail: 'ok' }).success).toBe(true)
    expect(cancelled.safeParse({ ...base, detail: '' }).success).toBe(false)
    expect(cancelled.safeParse({ ...base, detail: 'x'.repeat(241) }).success).toBe(false)
  })

  it('requires targetGrantId only for interject requests', () => {
    const speak = {
      turnId: TURN_ID,
      personaId: PERSONA_ID,
      action: 'speak',
      urgency: 0.2,
      confidence: 0.5,
      addressedByUser: false,
      objectiveRelevance: 0.1,
    }
    expect(
      eventPayloadSchemas['persona.requested_turn'].safeParse({ request: speak }).success,
    ).toBe(true)
  })

  it('rejects judgement scores outside [0, 1]', () => {
    const tooUrgent = {
      turnId: TURN_ID,
      personaId: PERSONA_ID,
      action: 'speak',
      urgency: 1.2,
      confidence: 0.5,
      addressedByUser: false,
      objectiveRelevance: 0.1,
    }
    expect(
      eventPayloadSchemas['persona.requested_turn'].safeParse({ request: tooUrgent }).success,
    ).toBe(false)
  })

  it('accepts session.started without a task id and rejects an unknown clock mode', () => {
    const started = { sessionId: 'session-1', clockMode: 'wall', lang: 'fr' }
    expect(eventPayloadSchemas['session.started'].safeParse(started).success).toBe(true)
    expect(
      eventPayloadSchemas['session.started'].safeParse({ ...started, clockMode: 'fake' }).success,
    ).toBe(false)
    expect(
      eventPayloadSchemas['session.started'].safeParse({ ...started, lang: 'de' }).success,
    ).toBe(false)
  })

  it('accepts optional usage on a committed response and rejects negative tokens', () => {
    const committed = {
      grantId: GRANT_ID,
      text: 'Hello there.',
      usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.00002 },
    }
    expect(eventPayloadSchemas['persona.response.committed'].safeParse(committed).success).toBe(
      true,
    )
    expect(
      eventPayloadSchemas['persona.response.committed'].safeParse({
        ...committed,
        usage: { inputTokens: -1 },
      }).success,
    ).toBe(false)
  })
})

describe('sessionEventSchema', () => {
  it('accepts a well-formed event and narrows its payload', () => {
    const parsed = sessionEventSchema.safeParse({
      type: 'turn.granted',
      payload: {
        grant: {
          turnId: TURN_ID,
          grantId: GRANT_ID,
          personaId: PERSONA_ID,
          expiresAt: EXPIRES_AT,
        },
      },
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.type).toBe('turn.granted')
      if (parsed.data.type === 'turn.granted') {
        expect(parsed.data.payload.grant.grantId).toBe(GRANT_ID)
      }
    }
  })

  it('rejects an unknown event name', () => {
    expect(sessionEventSchema.safeParse({ type: 'turn.closed', payload: {} }).success).toBe(false)
  })

  it('rejects a payload that belongs to another event', () => {
    expect(
      sessionEventSchema.safeParse({
        type: 'persona.response.chunk',
        payload: { grantId: GRANT_ID, text: 'Hi' },
      }).success,
    ).toBe(false)
  })

  it('rejects a date-shaped expiresAt that is not an ISO UTC string', () => {
    expect(
      sessionEventSchema.safeParse({
        type: 'turn.granted',
        payload: {
          grant: {
            turnId: TURN_ID,
            grantId: GRANT_ID,
            personaId: PERSONA_ID,
            expiresAt: new Date(EXPIRES_AT),
          },
        },
      }).success,
    ).toBe(false)
  })

  it('round-trips through parseSessionEvent', () => {
    const event: SessionEvent = {
      type: 'turn.user_yielded',
      payload: { reason: 'streak_cap' },
    }
    expect(parseSessionEvent(event)).toEqual(event)
  })
})

describe('isSessionEventName', () => {
  it('accepts only §2.1 names', () => {
    expect(isSessionEventName('persona.response.chunk')).toBe(true)
    expect(isSessionEventName('turn.closed')).toBe(false)
    expect(isSessionEventName('toString')).toBe(false)
  })
})
