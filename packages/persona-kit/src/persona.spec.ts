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

  it('selects exactly one variant and never falls back', () => {
    const persona = personaById('manager')
    expect(personaVariant(persona, 'en-GB').locale).toBe('en-GB')
    const narrowed: PersonaSpec = {
      ...persona,
      variants: { en: persona.variants['en']! },
    }
    expect(() => personaVariant(narrowed, 'fr')).toThrow(PersonaVariantMissingError)
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
