import type { JevRoutingJudge } from '@rp/eval-harness'
import { createJevCentralLivePolicy } from '@rp/eval-harness'
import { createDetPersonaLivePolicy, type RoutingContext } from '@rp/routing-policy'
import type { PersonaTurnPolicy } from '@rp/session-core'
import type { RoutingChoice } from './routing-choice.js'

/**
 * Build the session's routing policy from the chosen arm (M3d D6).
 *
 * `det-persona` is the deterministic incumbent and the fallback. `jev-central`
 * wraps it: one central Jev batch per turn, answered by the move contract, with
 * the incumbent answering any turn the model call cannot serve. The judge
 * factory runs only for `jev-central`, so a canned or French session never
 * opens a Jev client.
 */
export interface SessionRoutingPolicyOptions {
  readonly choice: RoutingChoice
  readonly createJudge: () => Pick<JevRoutingJudge, 'judgeCentral'>
  readonly onFallback: (failure: {
    readonly turnId: string
    readonly cause: 'timeout' | 'error'
  }) => void
}

export function createSessionRoutingPolicy(
  options: SessionRoutingPolicyOptions,
): PersonaTurnPolicy<RoutingContext> {
  const detPersona = createDetPersonaLivePolicy()
  return options.choice === 'jev-central'
    ? createJevCentralLivePolicy({
        judge: options.createJudge(),
        fallback: detPersona,
        onFailure: options.onFallback,
      })
    : detPersona
}
