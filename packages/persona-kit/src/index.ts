/**
 * `@rp/persona-kit` — versioned persona specifications and the deterministic
 * prompt builder (M2 D1/D3).
 *
 * Data plus pure functions. No clock, environment, file or provider access.
 */

export * from './persona.js'
export * from './lookup.js'
export * from './routing-context.js'
export * from './prompt/version.js'
export { buildPersonaPrompt, PromptVariantError } from './prompt/build.js'
export type {
  BuildPersonaPromptOptions,
  BuiltPersonaPrompt,
  PromptSystemMessage,
} from './prompt/build.js'

export { managerPersona } from './personas/manager.js'
export { peerPersona } from './personas/peer.js'
export { clientPersona } from './personas/client.js'

import { managerPersona } from './personas/manager.js'
import { peerPersona } from './personas/peer.js'
import { clientPersona } from './personas/client.js'
import type { PersonaSpec } from './persona.js'

/** Every persona shipped by M2. */
export const PERSONAS: readonly PersonaSpec[] = [managerPersona, peerPersona, clientPersona]

/** Every persona keyed by id. */
export const PERSONAS_BY_ID: ReadonlyMap<string, PersonaSpec> = new Map(
  PERSONAS.map((persona) => [persona.id, persona]),
)

export class UnknownPersonaError extends Error {
  constructor(id: string) {
    super(`unknown persona "${id}"`)
    this.name = 'UnknownPersonaError'
  }
}

/** Look up a persona by id. Unknown ids are a hard error. */
export function personaById(id: string): PersonaSpec {
  const persona = PERSONAS_BY_ID.get(id)
  if (persona === undefined) throw new UnknownPersonaError(id)
  return persona
}
