import { describe, expect, it } from 'vitest'
import type { SessionEvent } from './events.js'
import {
  checkTranscriptSequence,
  createGrantLedger,
  enforceGuardResult,
  GuardViolationError,
  guardTurnEvents,
  observeTurnEvent,
  type GuardResult,
} from './guards.js'

const TURN_ID = 'turn-1'
const PERSONA_ID = 'persona-1'
const EXPIRES_AT = '2026-06-01T12:00:00.000Z'

function granted(grantId: string): SessionEvent {
  return {
    type: 'turn.granted',
    payload: {
      grant: { turnId: TURN_ID, grantId, personaId: PERSONA_ID, expiresAt: EXPIRES_AT },
    },
  }
}

function revoked(grantId: string): SessionEvent {
  return { type: 'turn.revoked', payload: { grantId, reason: 'timeout' } }
}

function started(grantId: string): SessionEvent {
  return { type: 'persona.response.started', payload: { grantId } }
}

function chunk(grantId: string, sequence: number): SessionEvent {
  return { type: 'persona.response.chunk', payload: { grantId, text: 'tok', sequence } }
}

function partial(grantId: string, sequence: number): SessionEvent {
  return { type: 'persona.utterance.partial', payload: { grantId, text: 'par', sequence } }
}

function committed(grantId: string): SessionEvent {
  return { type: 'persona.response.committed', payload: { grantId, text: 'done' } }
}

function cancelled(grantId: string): SessionEvent {
  return { type: 'persona.response.cancelled', payload: { grantId, reason: 'revoked' } }
}

function userYielded(): SessionEvent {
  return { type: 'turn.user_yielded', payload: { reason: 'all_declined' } }
}

function codes(result: { readonly violations: readonly { readonly code: string }[] }): string[] {
  return result.violations.map((violation) => violation.code)
}

describe('single current grant', () => {
  it('passes a valid grant → response → revocation → next grant sequence', () => {
    const report = guardTurnEvents([
      granted('grant-1'),
      started('grant-1'),
      chunk('grant-1', 0),
      partial('grant-1', 0),
      committed('grant-1'),
      revoked('grant-1'),
      granted('grant-2'),
    ])

    expect(report.violations).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.ledger.currentGrant?.grantId).toBe('grant-2')
    expect(report.ledger.revokedGrantIds).toEqual(['grant-1'])
  })

  it('flags a second grant while the first is still current', () => {
    const report = guardTurnEvents([granted('grant-1'), granted('grant-2')])

    expect(report.ok).toBe(false)
    expect(codes(report)).toEqual(['grant_conflict'])
    expect(report.violations[0]?.message).toMatch(/grant-1 is still current/)
    // Invalid grant is not adopted, so downstream stale checks stay meaningful.
    expect(report.ledger.currentGrant?.grantId).toBe('grant-1')
  })

  it('flags reuse of a grant id after revocation', () => {
    const report = guardTurnEvents([granted('grant-1'), revoked('grant-1'), granted('grant-1')])

    expect(codes(report)).toEqual(['grant_reissued'])
    expect(report.ledger.currentGrant).toBeUndefined()
  })

  it('allows a new grant after the current response commits', () => {
    const report = guardTurnEvents([granted('grant-1'), committed('grant-1'), granted('grant-2')])
    expect(report.violations).toEqual([])
  })

  it('allows a new grant after the user takes the turn back', () => {
    const report = guardTurnEvents([granted('grant-1'), userYielded(), granted('grant-2')])
    expect(report.violations).toEqual([])
  })

  it('allows a new grant after the session completes', () => {
    const report = guardTurnEvents([
      granted('grant-1'),
      { type: 'session.completed', payload: {} },
      granted('grant-2'),
    ])
    expect(report.violations).toEqual([])
  })
})

describe('grantId required on response events', () => {
  it('flags a response event without a grantId', () => {
    const malformed = {
      type: 'persona.response.chunk',
      payload: { text: 'no grant', sequence: 0 },
    } as unknown as SessionEvent

    const report = guardTurnEvents([granted('grant-1'), malformed])
    expect(codes(report)).toEqual(['response_missing_grant_id'])
  })

  it('flags a response under a grant that was never issued', () => {
    const report = guardTurnEvents([granted('grant-1'), chunk('grant-404', 0)])
    expect(codes(report)).toEqual(['response_unknown_grant'])
  })

  it('flags late output from a revoked grant', () => {
    const report = guardTurnEvents([granted('grant-1'), revoked('grant-1'), chunk('grant-1', 0)])
    expect(codes(report)).toEqual(['response_stale_grant'])
    expect(report.violations[0]?.message).toMatch(/late output is discarded/)
  })

  it('flags output from a grant that is no longer current', () => {
    const report = guardTurnEvents([granted('grant-1'), committed('grant-1'), chunk('grant-1', 0)])
    expect(codes(report)).toEqual(['response_stale_grant'])
  })

  it('accepts cancellation bookkeeping after revocation', () => {
    const report = guardTurnEvents([granted('grant-1'), revoked('grant-1'), cancelled('grant-1')])
    expect(report.violations).toEqual([])
  })

  it('rejects output after a cancellation closed the grant', () => {
    const report = guardTurnEvents([granted('grant-1'), cancelled('grant-1'), chunk('grant-1', 0)])
    expect(codes(report)).toEqual(['response_stale_grant'])
  })
})

describe('revocation idempotency', () => {
  it('treats a repeated revocation as a no-op', () => {
    const report = guardTurnEvents([
      granted('grant-1'),
      revoked('grant-1'),
      revoked('grant-1'),
      revoked('grant-1'),
    ])

    expect(report.violations).toEqual([])
    expect(report.ledger.revokedGrantIds).toEqual(['grant-1'])
    expect(report.ledger.currentGrant).toBeUndefined()
  })

  it('flags revocation of a grant that was never issued', () => {
    const report = guardTurnEvents([granted('grant-1'), revoked('grant-404')])

    expect(codes(report)).toEqual(['revocation_unknown_grant'])
    expect(report.ledger.currentGrant?.grantId).toBe('grant-1')
  })
})

describe('sequence monotonicity', () => {
  it('flags a repeated chunk sequence for the same grant', () => {
    const report = guardTurnEvents([granted('grant-1'), chunk('grant-1', 1), chunk('grant-1', 1)])
    expect(codes(report)).toEqual(['stale_sequence'])
  })

  it('flags a descending partial sequence for the same grant', () => {
    const report = guardTurnEvents([
      granted('grant-1'),
      partial('grant-1', 2),
      partial('grant-1', 1),
    ])
    expect(codes(report)).toEqual(['stale_sequence'])
  })

  it('keeps chunk and partial streams independent', () => {
    const report = guardTurnEvents([
      granted('grant-1'),
      chunk('grant-1', 5),
      partial('grant-1', 0),
      chunk('grant-1', 6),
      partial('grant-1', 1),
    ])
    expect(report.violations).toEqual([])
  })

  it('passes strictly increasing transcript seq', () => {
    const result = checkTranscriptSequence([{ seq: 0 }, { seq: 1 }, { seq: 2 }])
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('rejects duplicated transcript seq', () => {
    const result = checkTranscriptSequence([{ seq: 0 }, { seq: 1 }, { seq: 1 }])
    expect(codes(result)).toEqual(['seq_not_monotonic'])
    expect(result.violations[0]?.message).toMatch(/strictly increase/)
  })

  it('rejects reordered transcript seq', () => {
    expect(codes(checkTranscriptSequence([{ seq: 2 }, { seq: 1 }]))).toEqual(['seq_not_monotonic'])
  })
})

describe('strict mode', () => {
  it('returns violations without throwing by default', () => {
    expect(() => guardTurnEvents([granted('grant-1'), granted('grant-2')])).not.toThrow()
  })

  it('throws only when strict mode is requested', () => {
    expect(() =>
      guardTurnEvents([granted('grant-1'), granted('grant-2')], { strict: true }),
    ).toThrow(GuardViolationError)

    try {
      guardTurnEvents([granted('grant-1'), granted('grant-2')], { strict: true })
    } catch (error) {
      expect(error).toBeInstanceOf(GuardViolationError)
      if (error instanceof GuardViolationError) {
        expect(codes(error)).toEqual(['grant_conflict'])
      }
    }
  })

  it('enforceGuardResult passes a clean result through', () => {
    const clean: GuardResult = { ok: true, violations: [] }
    expect(enforceGuardResult(clean, { strict: true })).toBe(clean)
  })
})

describe('observeTurnEvent', () => {
  it('returns a new ledger without mutating the input', () => {
    const ledger = createGrantLedger()
    const outcome = observeTurnEvent(ledger, granted('grant-1'))

    expect(ledger.grantedGrantIds).toEqual([])
    expect(ledger.currentGrant).toBeUndefined()
    expect(outcome.ledger.currentGrant?.grantId).toBe('grant-1')
    expect(outcome.violations).toEqual([])
  })

  it('leaves the ledger unchanged for events outside the grant state machine', () => {
    const ledger = createGrantLedger()
    const outcome = observeTurnEvent(ledger, {
      type: 'turn.opened',
      payload: { turnId: TURN_ID },
    })
    expect(outcome.ledger).toStrictEqual(ledger)
    expect(outcome.violations).toEqual([])
  })
})

describe('guard diagnostics', () => {
  it('exposes a typed error name and a readable message', () => {
    try {
      guardTurnEvents([granted('grant-1'), granted('grant-2')], { strict: true })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(GuardViolationError)
      expect((error as GuardViolationError).name).toBe('GuardViolationError')
      expect((error as Error).message).toBe(
        'session guard violated: grant_conflict (grant grant-2 issued while grant grant-1 is still current)',
      )
      expect((error as GuardViolationError).violations).toHaveLength(1)
    }
  })

  it('uses an exact message for each violation class', () => {
    const cases: ReadonlyArray<readonly [SessionEvent[], string]> = [
      [
        [granted('grant-1'), revoked('grant-1'), granted('grant-1')],
        'grant grant-1 was already issued; grant ids must not be reused',
      ],
      [
        [granted('grant-1'), revoked('grant-404')],
        'turn.revoked names grant grant-404, which was never granted',
      ],
      [
        [granted('grant-1'), chunk('grant-404', 0)],
        'persona.response.chunk names grant grant-404, which was never granted',
      ],
      [
        [granted('grant-1'), committed('grant-1'), chunk('grant-1', 0)],
        'persona.response.chunk names grant grant-1, which is not the current grant',
      ],
      [
        [granted('grant-1'), chunk('grant-1', 2), chunk('grant-1', 1)],
        'persona.response.chunk sequence 1 for grant grant-1 is not greater than 2',
      ],
    ]
    for (const [events, message] of cases) {
      const report = guardTurnEvents(events)
      expect(report.violations[0]?.message).toBe(message)
    }
  })

  it('treats an empty-string grantId as missing', () => {
    const malformed = {
      type: 'persona.response.chunk',
      payload: { grantId: '', text: 'no grant', sequence: 0 },
    } as unknown as SessionEvent
    const report = guardTurnEvents([granted('grant-1'), malformed])
    expect(codes(report)).toEqual(['response_missing_grant_id'])
    expect(report.violations[0]?.message).toBe('persona.response.chunk requires a grantId')
  })

  it('keeps the current grant when an already-revoked grant is revoked again', () => {
    const report = guardTurnEvents([
      granted('grant-1'),
      revoked('grant-1'),
      granted('grant-2'),
      revoked('grant-1'),
    ])
    expect(report.violations).toEqual([])
    expect(report.ledger.currentGrant?.grantId).toBe('grant-2')
  })

  it('does not apply sequence checks to closing events', () => {
    const committedWithSequence = {
      type: 'persona.response.committed',
      payload: { grantId: 'grant-1', text: 'done', sequence: 1 },
    } as unknown as SessionEvent
    const report = guardTurnEvents([granted('grant-1'), chunk('grant-1', 5), committedWithSequence])
    expect(report.violations).toEqual([])
  })

  it('keeps the highest sequence after a stale chunk so later gaps stay visible', () => {
    const report = guardTurnEvents([
      granted('grant-1'),
      chunk('grant-1', 5),
      chunk('grant-1', 3),
      chunk('grant-1', 4),
    ])
    expect(codes(report)).toEqual(['stale_sequence', 'stale_sequence'])
  })

  it('ignores holes in a sparse transcript sequence list', () => {
    const sparse = [{ seq: 0 }, undefined, { seq: 1 }] as unknown as Array<{ seq: number }>
    expect(checkTranscriptSequence(sparse)).toEqual({ ok: true, violations: [] })
  })

  it('checks a response.started event like every other response event', () => {
    expect(codes(guardTurnEvents([granted('grant-1'), started('grant-404')]))).toEqual([
      'response_unknown_grant',
    ])
    expect(codes(guardTurnEvents([granted('grant-1'), started('')]))).toEqual([
      'response_missing_grant_id',
    ])
  })

  it('does not read a sequence from response events that have none', () => {
    const startedWithSequence = (sequence: unknown): SessionEvent =>
      ({
        type: 'persona.response.started',
        payload: { grantId: 'grant-1', sequence },
      }) as unknown as SessionEvent

    const report = guardTurnEvents([
      granted('grant-1'),
      startedWithSequence(5),
      startedWithSequence(1),
    ])
    expect(report.violations).toEqual([])
  })

  it('ignores a non-numeric sequence instead of treating it as monotonic', () => {
    const first = {
      type: 'persona.response.chunk',
      payload: { grantId: 'grant-1', text: 'tok', sequence: '5' },
    } as unknown as SessionEvent
    const second = {
      type: 'persona.response.chunk',
      payload: { grantId: 'grant-1', text: 'tok', sequence: 1 },
    } as unknown as SessionEvent
    const report = guardTurnEvents([granted('grant-1'), first, second])
    expect(report.violations).toEqual([])
  })

  it('joins multiple violations in one strict error message', () => {
    try {
      guardTurnEvents([granted('grant-1'), granted('grant-2'), chunk('grant-404', 0)], {
        strict: true,
      })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(GuardViolationError)
      expect((error as Error).message).toContain('; ')
    }
  })
})
