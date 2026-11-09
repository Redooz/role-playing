import { describe, expect, it } from 'vitest'
import {
  SCENARIOS,
  ScenarioVariantMissingError,
  defineScenario,
  scenarioById,
  scenarioVariant,
  type ScenarioSpec,
} from './index.js'

describe('scenario data', () => {
  it('ships one scenario per persona type with every seeded locale', () => {
    expect(SCENARIOS).toHaveLength(3)
    for (const scenario of SCENARIOS) {
      expect(Object.keys(scenario.variants).sort()).toEqual(['en', 'en-GB', 'fr', 'fr-CA'])
      for (const variant of Object.values(scenario.variants)) {
        expect(variant.scriptedUser.turns.length).toBeGreaterThanOrEqual(4)
        expect(variant.personaIds).toContain(variant.opening.personaId)
      }
    }
  })

  it('selects exactly one locale variant', () => {
    const scenario = scenarioById('request-deadline-extension')
    expect(scenarioVariant(scenario, 'en-GB').locale).toBe('en-GB')
    expect(scenarioVariant(scenario, 'fr-CA').locale).toBe('fr-CA')
    expect(scenarioVariant(scenario, 'fr').locale).toBe('fr')
  })

  it('treats a missing locale as a hard error', () => {
    const scenario = scenarioById('request-deadline-extension')
    const narrowed: ScenarioSpec = {
      ...scenario,
      variants: { en: scenario.variants['en']! },
    }
    expect(() => scenarioVariant(narrowed, 'fr-CA')).toThrow(ScenarioVariantMissingError)
  })

  it('reports the missing scenario, locale and a hard-error message', () => {
    const scenario = scenarioById('request-deadline-extension')
    const narrowed: ScenarioSpec = {
      ...scenario,
      variants: { en: scenario.variants['en']! },
    }
    try {
      scenarioVariant(narrowed, ' FR-ca ')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioVariantMissingError)
      expect((error as ScenarioVariantMissingError).name).toBe('ScenarioVariantMissingError')
      expect((error as ScenarioVariantMissingError).scenarioId).toBe('request-deadline-extension')
      expect((error as ScenarioVariantMissingError).locale).toBe('fr-CA')
      expect((error as Error).message).toBe(
        'scenario "request-deadline-extension" has no variant for locale "fr-CA"; a missing locale is a hard error, not a fallback',
      )
    }
  })

  it('makes the learner decline in the decline-meeting scenario', () => {
    const scenario = scenarioById('decline-meeting-invitation')
    for (const locale of ['en', 'en-GB', 'fr', 'fr-CA'] as const) {
      const variant = scenarioVariant(scenario, locale)
      expect(variant.scriptedUser.turns[0]?.text).toMatch(
        /doesn't work|doesn't suit|ne me convient pas/u,
      )
    }
  })

  it('keeps the scripted user in the variant language and locale', () => {
    for (const scenario of SCENARIOS) {
      for (const variant of Object.values(scenario.variants)) {
        expect(variant.scriptedUser.lang).toBe(variant.lang)
        expect(variant.scriptedUser.locale).toBe(variant.locale)
      }
    }
  })

  it('rejects a variant whose locale does not match its base language', () => {
    const scenario = scenarioById('request-deadline-extension')
    const broken = {
      ...scenario,
      variants: {
        ...scenario.variants,
        en: { ...scenario.variants['en'], locale: 'fr-CA' },
      },
    }
    expect(() => defineScenario(broken)).toThrow()
  })
})
