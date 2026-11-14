import type { Clock } from '@rp/shared'
import type { PersonaPolicyInput, PersonaTurnPolicy, SessionArbiterInput } from './arbiter-port.js'
import { decideWithin, interjectRequestFor } from './policy-decisions.js'

/**
 * The interjection half of one active grant.
 *
 * Every candidate answers through the policy port. A timeout or an error is a
 * failed policy call, never a decline; a malformed request is a failed call,
 * never a fabricated request. The arbiter collects the accepted requests with
 * its own comparator and this module never grants, revokes or orders a turn.
 */

export interface InterjectionTurn {
  readonly turnId: string
  readonly grantId: string
}

export interface InterjectionHost<Context> {
  readonly clock: Clock
  readonly policy: PersonaTurnPolicy<Context>
  readonly requestWindowMs: number
  /** Personas that may interject: not the holder, not declined, not failed. */
  readonly candidates: readonly { readonly personaId: string }[]
  readonly policyInput: (
    personaId: string,
    turnId: string,
    action: 'interject',
    targetGrantId: string,
  ) => PersonaPolicyInput<Context>
  readonly markFailed: (personaId: string) => void
  readonly reduce: (input: SessionArbiterInput<Context>) => Promise<void>
}

export async function collectInterjections<Context>(
  turn: InterjectionTurn,
  host: InterjectionHost<Context>,
): Promise<void> {
  await Promise.all(
    host.candidates.map(async (persona) => {
      const outcome = await decideWithin(
        host.policy,
        host.policyInput(persona.personaId, turn.turnId, 'interject', turn.grantId),
        host.requestWindowMs,
      )

      if (outcome.kind === 'timeout' || outcome.kind === 'error') {
        host.markFailed(persona.personaId)
        await host.reduce({
          kind: 'policy_failed',
          turnId: turn.turnId,
          personaId: persona.personaId,
          cause: outcome.kind,
          nowMs: host.clock.now(),
        })
        return
      }
      if (outcome.decision.kind === 'decline') return

      const interject = interjectRequestFor(
        turn.turnId,
        persona.personaId,
        turn.grantId,
        outcome.decision,
      )
      if (interject === undefined) {
        host.markFailed(persona.personaId)
        await host.reduce({
          kind: 'policy_failed',
          turnId: turn.turnId,
          personaId: persona.personaId,
          cause: 'error',
          nowMs: host.clock.now(),
        })
        return
      }

      await host.reduce({ kind: 'request', request: interject, nowMs: host.clock.now() })
    }),
  )
}
