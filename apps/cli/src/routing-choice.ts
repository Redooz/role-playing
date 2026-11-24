/**
 * Routing policy choice for the multi-persona text session (M3d D6).
 *
 * The English-only adoption of `jev-central` is recorded in `evals/decisions.md`
 * before this wiring. The rules below are the executable form of that row:
 *
 * - `--routing det-persona` always keeps the deterministic incumbent.
 * - Canned mode stays offline and deterministic; it never calls Jev.
 * - A single-persona session has no routing decision to make.
 * - French keeps `det-persona` until a French arm passes its own floors.
 * - English live two-persona sessions use `jev-central` only when an OpenRouter
 *   key is present; otherwise the session runs on `det-persona` and says so.
 */

export type RoutingRequest = 'auto' | 'det-persona'
export type RoutingChoice = 'jev-central' | 'det-persona'

export const ROUTING_REQUESTS: readonly RoutingRequest[] = ['auto', 'det-persona']

export interface RoutingChoiceInput {
  readonly requested: RoutingRequest
  readonly provider: 'canned' | 'live'
  readonly lang: 'en' | 'fr'
  readonly personaCount: number
  readonly hasRouterKey: boolean
}

export interface RoutingDecisionChoice {
  readonly choice: RoutingChoice
  /** Set when `auto` would select Jev but the key is missing. */
  readonly warning?: 'missing-openrouter-key'
}

function parseRequest(value: string | undefined): RoutingRequest {
  const request = value ?? 'auto'
  if (request !== 'auto' && request !== 'det-persona') {
    throw new Error(`--routing must be "auto" or "det-persona", got "${request}"`)
  }
  return request
}

/** Parse and validate `--routing`. A bad value is a usage error. */
export function routingRequestFrom(value: string | undefined): RoutingRequest {
  return parseRequest(value)
}

function isEnglishLiveMultiPersona(input: RoutingChoiceInput): boolean {
  return input.provider === 'live' && input.lang === 'en' && input.personaCount > 1
}

/** Choose the policy for one session. Pure; the caller prints the warning. */
export function routingChoiceFor(input: RoutingChoiceInput): RoutingDecisionChoice {
  if (input.requested === 'det-persona' || !isEnglishLiveMultiPersona(input)) {
    return { choice: 'det-persona' }
  }
  return input.hasRouterKey
    ? { choice: 'jev-central' }
    : { choice: 'det-persona', warning: 'missing-openrouter-key' }
}
