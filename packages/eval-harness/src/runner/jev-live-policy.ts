import {
  assembleRoutingDecision,
  deriveMoveDecision,
  type RoutingContext,
} from '@rp/routing-policy'
import type {
  PersonaPolicyDecision,
  PersonaPolicyInput,
  PersonaTurnPolicy,
  TurnRequest,
} from '@rp/session-core'
import type { JevRoutingJudge } from '../jev/routing.js'
import { withinDeadline } from './routing.js'

/**
 * Live `jev-central` routing policy (M3d D6).
 *
 * The multi-persona driver asks the policy once per persona per turn. This
 * policy runs one central Jev batch for the turn, shares it between those calls,
 * and maps the ownership-first decision to one request and the other declines.
 *
 * A timeout, transport error, invalid answer or contract violation is never a
 * decline and never a fabricated speaker: the policy answers from the injected
 * deterministic fallback and reports the cause once per turn. The driver's own
 * request window stays the outer bound; this deadline is the inner one.
 */

export const JEV_CENTRAL_LIVE_POLICY_ID = 'jev-central'
export const JEV_CENTRAL_LIVE_POLICY_VERSION = 'm3d-jev-central-live-v1'
/** Below the driver's 1,500 ms request window, so the fallback still answers. */
export const JEV_LIVE_DEFAULT_DEADLINE_MS = 1_200

export type JevLiveFailureCause = 'timeout' | 'error'

export interface JevLiveFailure {
  readonly turnId: string
  readonly cause: JevLiveFailureCause
}

export interface JevCentralLivePolicyOptions {
  readonly judge: Pick<JevRoutingJudge, 'judgeCentral'>
  /** Deterministic policy used when the model call fails or cannot decide. */
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
  readonly outcome: Promise<CentralOutcome | null>
}

/**
 * Create the live central policy.
 *
 * `fallback` is a policy, not a decision, because an interjection or a failed
 * call must be answered per persona exactly as the fallback would answer it.
 */
export function createJevCentralLivePolicy(
  options: JevCentralLivePolicyOptions,
): PersonaTurnPolicy<RoutingContext> {
  const deadlineMs = options.deadlineMs ?? JEV_LIVE_DEFAULT_DEADLINE_MS
  let cache: TurnCache | undefined

  function failed(turnId: string, cause: JevLiveFailureCause): null {
    options.onFailure?.({ turnId, cause })
    return null
  }

  async function decideFromModel(
    input: PersonaPolicyInput<RoutingContext>,
  ): Promise<CentralOutcome | null> {
    let raced
    try {
      raced = await withinDeadline(options.judge.judgeCentral(input.context), deadlineMs)
    } catch {
      return failed(input.turnId, 'error')
    }
    if (raced.kind === 'timeout') return failed(input.turnId, 'timeout')
    if (!raced.value.ok) return failed(input.turnId, 'error')

    const { judgment } = raced.value.observation
    // A contract violation is a programming error, so it rejects and the driver
    // records a failed policy call instead of inventing an answer.
    const derived = deriveMoveDecision({
      context: input.context,
      moves: judgment.move,
      topology: 'central_selection',
      // The central path takes its speaker from the Choice, never the seed.
      seed: 0,
      ...(judgment.selectedPersonaId === undefined
        ? {}
        : { selectedPersonaId: judgment.selectedPersonaId }),
    })
    const decision = assembleRoutingDecision({
      context: input.context,
      topology: 'central_selection',
      judgmentSource: 'jev',
      policyVersion: JEV_CENTRAL_LIVE_POLICY_VERSION,
      moveJudgments: { scope: 'central', move: judgment.move },
      requests: derived.requests,
      declines: derived.declines,
      unsettledPersonas: [],
      ...(derived.kind === 'speak' && derived.personaId !== undefined
        ? { selectedPersonaId: derived.personaId }
        : {}),
      fallback:
        derived.fallbackCause === null
          ? { kind: 'none' }
          : { kind: 'deterministic', cause: derived.fallbackCause },
    })
    return decision.outcome.kind === 'speak'
      ? {
          kind: 'speak',
          personaId: decision.outcome.personaId,
          request: decision.outcome.request,
        }
      : { kind: 'yield' }
  }

  function outcomeFor(input: PersonaPolicyInput<RoutingContext>): Promise<CentralOutcome | null> {
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
      if (outcome === null) return options.fallback.decide(input)
      if (outcome.kind === 'yield') return DECLINE
      if (outcome.personaId !== input.personaId) return DECLINE
      return { kind: 'request', request: outcome.request }
    },
  }
}
