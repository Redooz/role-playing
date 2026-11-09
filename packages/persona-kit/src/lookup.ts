import { canonicalizeLocale } from '@rp/shared'
import type { PersonaSpec, PersonaVariant } from './persona.js'

/**
 * Persona lookup and validation entry points (M2 D1).
 *
 * Kept separate from the Zod declarations so the behaviour-bearing selection
 * path can be mutation-tested without mutating schema literals.
 */

export class PersonaVariantMissingError extends Error {
  readonly personaId: string
  readonly locale: string

  constructor(personaId: string, locale: string) {
    super(
      `persona "${personaId}" has no variant for locale "${locale}"; a missing locale is a hard error, not a fallback`,
    )
    this.name = 'PersonaVariantMissingError'
    this.personaId = personaId
    this.locale = locale
  }
}

/** Select exactly one locale variant. Never falls back to another locale. */
export function personaVariant(persona: PersonaSpec, locale: string): PersonaVariant {
  const canonical = canonicalizeLocale(locale)
  const variant = persona.variants[canonical]
  if (variant === undefined) throw new PersonaVariantMissingError(persona.id, canonical)
  return variant
}
