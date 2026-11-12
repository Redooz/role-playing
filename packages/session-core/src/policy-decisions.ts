import type {
  PersonaPolicyDecision,
  PersonaPolicyInput,
  PersonaTurnPolicy,
} from './arbiter-port.js'
import type { TurnRequest } from './events.js'

/**
 * Policy adaptation for one multi-persona turn.
 *
 * A policy answers; the arbiter decides. A timeout or an error is a failed
 * policy call, never a decline, and a decision that names the wrong turn,
 * persona or action is malformed rather than silently accepted.
 */

export type PolicyOutcome =
  | { readonly kind: 'decision'; readonly decision: PersonaPolicyDecision }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error' }

export async function decideWithin<Context>(
  policy: PersonaTurnPolicy<Context>,
  input: PersonaPolicyInput<Context>,
  timeoutMs: number,
): Promise<PolicyOutcome> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<PolicyOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })

  try {
    return await Promise.race([
      Promise.resolve(policy.decide(input)).then((decision): PolicyOutcome => ({
        kind: 'decision',
        decision,
      })),
      timeout,
    ])
  } catch {
    return { kind: 'error' }
  } finally {
    clearTimeout(timer)
  }
}

/** The request for a `speak` decision, or `undefined` when it is malformed. */
export function speakRequestFor(
  turnId: string,
  personaId: string,
  decision: PersonaPolicyDecision,
): TurnRequest | undefined {
  if (decision.kind !== 'request') return undefined
  const request = decision.request
  if (request.turnId !== turnId || request.personaId !== personaId) return undefined
  return request.action === 'speak' ? request : undefined
}

/** The request for an `interject` decision, or `undefined` when it is malformed. */
export function interjectRequestFor(
  turnId: string,
  personaId: string,
  grantId: string,
  decision: PersonaPolicyDecision,
): TurnRequest | undefined {
  if (decision.kind !== 'request') return undefined
  const request = decision.request
  if (
    request.turnId !== turnId ||
    request.personaId !== personaId ||
    request.action !== 'interject' ||
    request.targetGrantId !== grantId
  ) {
    return undefined
  }
  return request
}
