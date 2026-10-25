import type { SessionEvent, TurnGrant } from './events.js'

/**
 * Runtime guards for the §3.2 hard rules.
 *
 * Guards never throw for an expected violation: they return structured
 * {@link Violation}s so the eval runner can record every problem in one pass and
 * the engine can decide what to do. Callers that want fail-fast behaviour pass
 * `{ strict: true }` to {@link guardTurnEvents} / {@link enforceGuardResult},
 * which is the only path that throws.
 *
 * The ledger is a pure fold over a *complete* event stream starting at session
 * start. Feeding it a partial stream (for example a trace that begins mid-turn)
 * will report the first grant-less response as stale.
 */

/** Stable machine-readable guard codes. New codes are additive. */
export type GuardCode =
  | 'grant_conflict'
  | 'grant_reissued'
  | 'response_missing_grant_id'
  | 'response_unknown_grant'
  | 'response_stale_grant'
  | 'revocation_unknown_grant'
  | 'stale_sequence'
  | 'seq_not_monotonic'

export interface Violation {
  readonly code: GuardCode
  readonly message: string
}

export interface GuardResult {
  readonly ok: boolean
  readonly violations: readonly Violation[]
}

export interface GuardOptions {
  /** When true, {@link enforceGuardResult} throws instead of returning. */
  readonly strict?: boolean
}

/**
 * Grant state derived from the events seen so far.
 *
 * `lastSequenceByStream` is keyed by `${grantId}:${eventType}` so the partial
 * utterance stream and the response chunk stream are monotonic independently —
 * both are sequence-numbered in §3.2/§3.4 but they are not the same stream.
 */
export interface GrantLedger {
  readonly currentGrant: TurnGrant | undefined
  readonly grantedGrantIds: readonly string[]
  readonly revokedGrantIds: readonly string[]
  readonly lastSequenceByStream: Readonly<Record<string, number>>
}

export interface TurnGuardReport extends GuardResult {
  readonly ledger: GrantLedger
}

/** A fresh ledger: no grants issued, none revoked, no sequences observed. */
export function createGrantLedger(): GrantLedger {
  return {
    currentGrant: undefined,
    grantedGrantIds: [],
    revokedGrantIds: [],
    lastSequenceByStream: {},
  }
}

/** Thrown only when a caller explicitly requests strict guard mode. */
export class GuardViolationError extends Error {
  readonly violations: readonly Violation[]

  constructor(violations: readonly Violation[]) {
    super(`session guard violated: ${violations.map((v) => `${v.code} (${v.message})`).join('; ')}`)
    this.name = 'GuardViolationError'
    this.violations = violations
  }
}

/**
 * Return `result` unchanged, or throw {@link GuardViolationError} when the
 * caller asked for strict mode and the result is not ok.
 */
export function enforceGuardResult<T extends GuardResult>(
  result: T,
  options: GuardOptions = {},
): T {
  if (options.strict === true && !result.ok) {
    throw new GuardViolationError(result.violations)
  }
  return result
}

/**
 * Feed one event through the §3.2 hard rules.
 *
 * Detects:
 * - `grant_conflict` / `grant_reissued` — at most one current grant, ids are not reused.
 * - `response_missing_grant_id` / `response_unknown_grant` / `response_stale_grant`
 *   — response output is only accepted under the current, unrevoked grant.
 * - `revocation_unknown_grant` — revoking a grant that was never issued. A
 *   repeated revocation of a known grant is an idempotent no-op (§3.2 rule 3).
 * - `stale_sequence` — partial/chunk sequence numbers must strictly increase per grant.
 *
 * Closing events (`persona.response.committed`, `persona.response.cancelled`,
 * `turn.revoked`, `turn.user_yielded`, `session.completed`) release the current
 * grant, so the next `turn.granted` is not a conflict.
 */
export function observeTurnEvent(
  ledger: GrantLedger,
  event: SessionEvent,
): { readonly ledger: GrantLedger; readonly violations: readonly Violation[] } {
  const violations: Violation[] = []
  let currentGrant = ledger.currentGrant
  let grantedGrantIds = ledger.grantedGrantIds
  let revokedGrantIds = ledger.revokedGrantIds
  let lastSequenceByStream = ledger.lastSequenceByStream

  switch (event.type) {
    case 'turn.granted': {
      const { grant } = event.payload

      if (grantedGrantIds.includes(grant.grantId)) {
        violations.push({
          code: 'grant_reissued',
          message: `grant ${grant.grantId} was already issued; grant ids must not be reused`,
        })
        break
      }

      if (currentGrant !== undefined && !revokedGrantIds.includes(currentGrant.grantId)) {
        violations.push({
          code: 'grant_conflict',
          message: `grant ${grant.grantId} issued while grant ${currentGrant.grantId} is still current`,
        })
        break
      }

      grantedGrantIds = [...grantedGrantIds, grant.grantId]
      currentGrant = grant
      break
    }

    case 'turn.revoked': {
      const { grantId } = event.payload

      if (!grantedGrantIds.includes(grantId)) {
        violations.push({
          code: 'revocation_unknown_grant',
          message: `turn.revoked names grant ${grantId}, which was never granted`,
        })
        break
      }

      // §3.2 rule 3: revocation is idempotent. Re-revoking is a no-op, not an error.
      if (revokedGrantIds.includes(grantId)) break

      revokedGrantIds = [...revokedGrantIds, grantId]
      if (currentGrant?.grantId === grantId) currentGrant = undefined
      break
    }

    case 'persona.response.started':
    case 'persona.response.chunk':
    case 'persona.utterance.partial':
    case 'persona.response.committed':
    case 'persona.response.cancelled': {
      // Runtime check on purpose: schemas require grantId, but guards also
      // protect callers that hand-build events or skip validation.
      const payload: { grantId?: unknown; sequence?: unknown } = event.payload
      const grantId =
        typeof payload.grantId === 'string' && payload.grantId.length > 0
          ? payload.grantId
          : undefined

      if (grantId === undefined) {
        violations.push({
          code: 'response_missing_grant_id',
          message: `${event.type} requires a grantId`,
        })
        break
      }

      if (!grantedGrantIds.includes(grantId)) {
        violations.push({
          code: 'response_unknown_grant',
          message: `${event.type} names grant ${grantId}, which was never granted`,
        })
        break
      }

      if (revokedGrantIds.includes(grantId)) {
        // A cancellation that arrives after revocation is the expected
        // bookkeeping for "cancels generation plus playback" (§3.2 rule 3).
        // Every other kind of output from a revoked grant is late output.
        if (event.type !== 'persona.response.cancelled') {
          violations.push({
            code: 'response_stale_grant',
            message: `${event.type} names revoked grant ${grantId}; late output is discarded`,
          })
        }
        break
      }

      if (currentGrant?.grantId !== grantId) {
        violations.push({
          code: 'response_stale_grant',
          message: `${event.type} names grant ${grantId}, which is not the current grant`,
        })
        break
      }

      if (event.type === 'persona.response.chunk' || event.type === 'persona.utterance.partial') {
        const sequence = payload.sequence
        if (typeof sequence === 'number') {
          const streamKey = `${grantId}:${event.type}`
          const last = lastSequenceByStream[streamKey]

          if (last !== undefined && sequence <= last) {
            violations.push({
              code: 'stale_sequence',
              message: `${event.type} sequence ${sequence} for grant ${grantId} is not greater than ${last}`,
            })
          }

          const next = last === undefined ? sequence : Math.max(last, sequence)
          lastSequenceByStream = { ...lastSequenceByStream, [streamKey]: next }
        }
      }

      if (
        event.type === 'persona.response.committed' ||
        event.type === 'persona.response.cancelled'
      ) {
        currentGrant = undefined
      }
      break
    }

    case 'turn.user_yielded':
    case 'session.completed': {
      // Both end the turn; no grant may survive them.
      currentGrant = undefined
      break
    }

    default:
      // Other §2.1 events do not change grant state.
      break
  }

  return {
    ledger: { currentGrant, grantedGrantIds, revokedGrantIds, lastSequenceByStream },
    violations,
  }
}

/**
 * Fold a complete event sequence through {@link observeTurnEvent} and collect
 * every violation (never just the first).
 */
export function guardTurnEvents(
  events: readonly SessionEvent[],
  options: GuardOptions = {},
): TurnGuardReport {
  let ledger = createGrantLedger()
  const violations: Violation[] = []

  for (const event of events) {
    const outcome = observeTurnEvent(ledger, event)
    ledger = outcome.ledger
    violations.push(...outcome.violations)
  }

  return enforceGuardResult({ ok: violations.length === 0, violations, ledger }, options)
}

/**
 * Trace-record sequence guard: `seq` must strictly increase, so replay order is
 * unambiguous and a duplicated or reordered record is visible rather than
 * silently sorted. Accepts any object with a `seq` so it can run before schema
 * parsing in tooling.
 */
export function checkTraceSequence(records: readonly { readonly seq: number }[]): GuardResult {
  const violations: Violation[] = []

  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]
    const current = records[index]
    if (previous === undefined || current === undefined) continue

    if (current.seq <= previous.seq) {
      violations.push({
        code: 'seq_not_monotonic',
        message: `trace seq must strictly increase: record ${index} has seq ${current.seq} after seq ${previous.seq}`,
      })
    }
  }

  return { ok: violations.length === 0, violations }
}
