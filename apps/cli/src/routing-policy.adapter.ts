import {
  createJevCentralLivePolicy,
  jevLiveDeadlineMs,
  JEV_LIVE_REQUEST_WINDOW_MS,
  type JevLiveFailure,
  type JevRoutingJudge,
} from '@rp/eval-harness'
import { createDetPersonaLivePolicy, type RoutingContext } from '@rp/routing-policy'
import type { PersonaTurnPolicy } from '@rp/session-core'
import { routingChoiceFor, type RoutingChoice, type RoutingRequest } from './routing-choice.js'

/**
 * Build the session's routing policy, its header label and its choice (M3d D6).
 *
 * `det-persona` is the deterministic incumbent. `jev-central` wraps it: one
 * central Jev batch per turn, answered by the move contract, with the incumbent
 * owning interjections. A failed model call is never answered by the incumbent;
 * the policy rejects and the driver records the failure. The judge factory runs
 * only for `jev-central`, so a canned or French session never opens a Jev
 * client.
 */
export interface SessionRoutingOptions {
  readonly requested: RoutingRequest
  readonly provider: 'canned' | 'live'
  readonly lang: 'en' | 'fr'
  readonly personaCount: number
  /** The configured multi-persona request window, before the Jev adjustment. */
  readonly requestWindowMs: number
  readonly env: Readonly<Record<string, string | undefined>>
  readonly createJudge: (apiKey: string) => JevRoutingJudge
  readonly onFallback: (failure: JevLiveFailure) => void
}

export interface SessionRouting {
  readonly choice: RoutingChoice
  /** Shown in the session header, so a reader knows which policy speaks. */
  readonly label: string
  /** Stderr note when `auto` wanted Jev but the key is missing. */
  readonly note?: string
  /** The window the driver and arbiter must use for this policy. */
  readonly requestWindowMs: number
  readonly policy: PersonaTurnPolicy<RoutingContext>
}

const JEV_LABEL = 'jev-central (English)'
const DET_LABEL = 'det-persona'
const NO_KEY_LABEL = 'det-persona (OPENROUTER_API_KEY missing: Jev routing off)'

export function createSessionRouting(options: SessionRoutingOptions): SessionRouting {
  const apiKey = (options.env['OPENROUTER_API_KEY'] ?? '').trim()
  const routing = routingChoiceFor({
    requested: options.requested,
    provider: options.provider,
    lang: options.lang,
    personaCount: options.personaCount,
    hasRouterKey: apiKey !== '',
  })
  const detPersona = createDetPersonaLivePolicy()

  if (routing.choice !== 'jev-central') {
    return routing.warning === undefined
      ? {
          choice: 'det-persona',
          label: DET_LABEL,
          requestWindowMs: options.requestWindowMs,
          policy: detPersona,
        }
      : {
          choice: 'det-persona',
          label: NO_KEY_LABEL,
          note: 'this English session uses det-persona routing',
          requestWindowMs: options.requestWindowMs,
          policy: detPersona,
        }
  }
  const requestWindowMs = Math.max(options.requestWindowMs, JEV_LIVE_REQUEST_WINDOW_MS)
  return {
    choice: 'jev-central',
    label: JEV_LABEL,
    requestWindowMs,
    policy: createJevCentralLivePolicy({
      judge: options.createJudge(apiKey),
      fallback: detPersona,
      deadlineMs: jevLiveDeadlineMs(requestWindowMs),
      onFailure: options.onFallback,
    }),
  }
}
