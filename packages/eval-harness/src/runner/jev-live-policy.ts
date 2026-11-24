import type { RoutingContext } from '@rp/routing-policy'
import type {
  PersonaPolicyDecision,
  PersonaPolicyInput,
  PersonaTurnPolicy,
  TurnRequest,
} from '@rp/session-core'
import type { JevRoutingJudge } from '../jev/routing.js'
import { JEV_CENTRAL_POLICY_VERSION, runJevRoutingReplay } from './routing.js'

/**
 * Live `jev-central` routing policy (M3d D6).
 *
 * The multi-persona driver asks the policy once per persona per turn. This
 * policy runs one central Jev batch for the turn, shares it between those calls,
 * and maps the ownership-first decision to one request and the other declines.
 *
 * The decision itself is the evaluated central arm, unchanged: the same judge,
 * move contract and assembly as `runJevRoutingReplay`. Only the live wrapper is
 * new — the memo across persona calls, the deadline and the failure rule.
 *
 * A timeout, transport error or invalid answer is never a decline and never a
 * fabricated speaker: the policy reports the cause once per turn and rejects, so
 * the driver records a failed policy call and the turn stays incomplete. The
 * deterministic fallback answers interjections, which the move contract does not
 * model, and never a failed call. The driver's own request window stays the
 * outer bound; this deadline is the inner one.
 */

export const JEV_CENTRAL_LIVE_POLICY_ID = 'jev-central'
/** The evaluated arm's version, stamped on every assembled decision. */
export const JEV_CENTRAL_LIVE_POLICY_VERSION = JEV_CENTRAL_POLICY_VERSION
/**
 * The Jev path needs a wider request window than the deterministic one.
 *
 * The D4 English holdout measured 206 ms p50, 525 ms p95, 915 ms p99 and
 * 1,225 ms max for `jev-central`. A 1,200 ms deadline sits inside that tail, so
 * a normal slow turn was recorded as incomplete. The window is the maximum of
 * the configured base and this value; a fast turn still answers at once.
 */
export const JEV_LIVE_REQUEST_WINDOW_MS = 2_000
/** Space between the policy deadline and the window, for the failure report. */
export const JEV_LIVE_DEADLINE_MARGIN_MS = 300
/** The deadline for a given request window; always inside it. */
export function jevLiveDeadlineMs(requestWindowMs: number): number {
  return Math.max(1, requestWindowMs - JEV_LIVE_DEADLINE_MARGIN_MS)
}
/** Below the default request window, so the failure is still recorded. */
export const JEV_LIVE_DEFAULT_DEADLINE_MS = jevLiveDeadlineMs(JEV_LIVE_REQUEST_WINDOW_MS)

export type JevLiveFailureCause = 'timeout' | 'error'

export interface JevLiveFailure {
  readonly turnId: string
  readonly cause: JevLiveFailureCause
}

export interface JevCentralLivePolicyOptions {
  readonly judge: JevRoutingJudge
  /** Deterministic policy; it owns interjections, not failed calls. */
  readonly fallback: PersonaTurnPolicy<RoutingContext>
  readonly deadlineMs?: number
  /** Called once per failed turn, never once per persona. */
  readonly onFailure?: (failure: JevLiveFailure) => void
}

type CentralOutcome =
  | { readonly kind: 'speak'; readonly personaId: string; readonly request: TurnRequest }
  | { readonly kind: 'yield' }

const DECLINE: PersonaPolicyDecision = { kind: 'decline' }

/** One turn's central outcome, memoised so both persona calls share one batch. */
interface TurnCache {
  readonly turnId: string
  readonly outcome: Promise<CentralOutcome>
}

export function createJevCentralLivePolicy(
  options: JevCentralLivePolicyOptions,
): PersonaTurnPolicy<RoutingContext> {
  const deadlineMs = options.deadlineMs ?? JEV_LIVE_DEFAULT_DEADLINE_MS
  let cache: TurnCache | undefined

  async function decideFromModel(
    input: PersonaPolicyInput<RoutingContext>,
  ): Promise<CentralOutcome> {
    const result = await runJevRoutingReplay(input.context, 'central_selection', options.judge, {
      // The central path takes its speaker from the Choice, never the seed.
      seed: 0,
      deadlineMs,
    })
    if (!result.ok) {
      options.onFailure?.({ turnId: input.turnId, cause: result.cause })
      // A failed call is incomplete, never a decline: the fallback would publish
      // a deterministic answer the model never gave. Reject instead so the
      // driver records `policy_failed` and the turn stays visibly incomplete.
      throw new Error(`jev-central failed on ${input.turnId}: ${result.error}`)
    }
    const { outcome } = result.decision
    return outcome.kind === 'speak'
      ? { kind: 'speak', personaId: outcome.personaId, request: outcome.request }
      : { kind: 'yield' }
  }

  function outcomeFor(input: PersonaPolicyInput<RoutingContext>): Promise<CentralOutcome> {
    // Turns are sequential, so keeping only the current turn is enough to share
    // one batch between its persona calls and to bound memory.
    if (cache?.turnId !== input.turnId) {
      cache = { turnId: input.turnId, outcome: decideFromModel(input) }
    }
    return cache.outcome
  }

  return {
    async decide(input) {
      // Interjection has no move-contract semantics; the fallback owns it.
      if (input.action !== 'speak') return options.fallback.decide(input)
      const outcome = await outcomeFor(input)
      if (outcome.kind === 'yield') return DECLINE
      if (outcome.personaId !== input.personaId) return DECLINE
      return { kind: 'request', request: outcome.request }
    },
  }
}
