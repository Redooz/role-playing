import { describe, expect, it } from 'vitest'
import {
  PERSONAS,
  PersonaVariantMissingError,
  personaById,
  personaVariant,
  definePersona,
  type PersonaSpec,
} from './index.js'

describe('persona data', () => {
  it('ships the three M2 personas with every seeded locale', () => {
    expect(PERSONAS.map((persona) => persona.id)).toEqual(['manager', 'peer', 'client'])
    for (const persona of PERSONAS) {
      expect(Object.keys(persona.variants).sort()).toEqual(['en', 'en-GB', 'fr', 'fr-CA'])
    }
  })

  it('localizes the display name without changing the identity', () => {
    expect(personaVariant(personaById('manager'), 'en').displayName).toBe('Katherine Brooks')
    expect(personaVariant(personaById('manager'), 'fr').displayName).toBe('Catherine Brooks')
    expect(personaVariant(personaById('peer'), 'fr-CA').displayName).toBe('Samir Carter')
    expect(personaVariant(personaById('client'), 'en-GB').displayName).toBe('Julian Moore')
  })

  it('tells the French peer to keep the informal tu form', () => {
    for (const locale of ['fr', 'fr-CA'] as const) {
      const variant = personaVariant(personaById('peer'), locale)
      expect(variant.boundaries.some((boundary) => /Tutoyer/u.test(boundary))).toBe(true)
      expect(variant.boundaries.some((boundary) => /« tu »/u.test(boundary))).toBe(true)
      expect(variant.greeting.opensWith).toMatch(/tutoyant|« tu »/u)
    }
  })

  it('keeps the client out of the account manager role', () => {
    for (const locale of ['en', 'en-GB', 'fr', 'fr-CA'] as const) {
      const variant = personaVariant(personaById('client'), locale)
      expect(
        variant.boundaries.some((boundary) =>
          /not the account manager|pas le chargé de compte/iu.test(boundary),
        ),
      ).toBe(true)
    }
  })

  it('selects exactly one variant and never falls back', () => {
    const persona = personaById('manager')
    expect(personaVariant(persona, 'en-GB').locale).toBe('en-GB')
    const narrowed: PersonaSpec = {
      ...persona,
      variants: { en: persona.variants['en']! },
    }
    expect(() => personaVariant(narrowed, 'fr')).toThrow(PersonaVariantMissingError)
  })

  it('reports the missing persona, locale and a hard-error message', () => {
    const persona = personaById('manager')
    const narrowed: PersonaSpec = {
      ...persona,
      variants: { en: persona.variants['en']! },
    }
    try {
      personaVariant(narrowed, ' FR-ca ')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PersonaVariantMissingError)
      expect((error as PersonaVariantMissingError).name).toBe('PersonaVariantMissingError')
      expect((error as PersonaVariantMissingError).personaId).toBe('manager')
      expect((error as PersonaVariantMissingError).locale).toBe('fr-CA')
      expect((error as Error).message).toBe(
        'persona "manager" has no variant for locale "fr-CA"; a missing locale is a hard error, not a fallback',
      )
    }
  })

  it('rejects a variant whose locale does not match its base language', () => {
    const persona = personaById('manager')
    const broken = {
      ...persona,
      variants: {
        ...persona.variants,
        en: { ...persona.variants['en'], locale: 'fr-CA' },
      },
    }
    expect(() => definePersona(broken)).toThrow()
  })
})
