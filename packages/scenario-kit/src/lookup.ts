import { canonicalizeLocale } from '@rp/shared'
import type { ScenarioObjective, ScenarioSpec, ScenarioVariant } from './scenario.js'

/**
 * Scenario lookup and validation entry points (M2 D2).
 *
 * Kept separate from the Zod declarations so the behaviour-bearing selection
 * path can be mutation-tested without mutating schema literals.
 */

export class ScenarioVariantMissingError extends Error {
  readonly scenarioId: string
  readonly locale: string

  constructor(scenarioId: string, locale: string) {
    super(
      `scenario "${scenarioId}" has no variant for locale "${locale}"; a missing locale is a hard error, not a fallback`,
    )
    this.name = 'ScenarioVariantMissingError'
    this.scenarioId = scenarioId
    this.locale = locale
  }
}

/** Select exactly one locale variant. Never falls back to another locale. */
export function scenarioVariant(scenario: ScenarioSpec, locale: string): ScenarioVariant {
  const canonical = canonicalizeLocale(locale)
  const variant = scenario.variants[canonical]
  if (variant === undefined) throw new ScenarioVariantMissingError(scenario.id, canonical)
  return variant
}

/** An objective without `personaIds` applies to every persona in the variant. */
export function objectiveAppliesToPersona(
  objective: ScenarioObjective,
  personaId: string,
): boolean {
  return objective.personaIds === undefined || objective.personaIds.includes(personaId)
}

/** The objectives one persona may see. Order follows the variant data. */
export function objectivesForPersona(
  variant: ScenarioVariant,
  personaId: string,
): ScenarioObjective[] {
  return variant.objectives.filter((objective) => objectiveAppliesToPersona(objective, personaId))
}
