import { routingDecisionSchema } from '@rp/routing-policy'
import { routingOutcomeLabelSchema } from '../tasks/schema.js'
import { labelClass } from '../tasks/label-class.js'
import { classAppropriate, type RoutingMatrixEntry } from './routing-matrix.js'

/**
 * Per-family routing readings (M3d D3).
 *
 * A family is the frozen label taxonomy entry (`TT-S5`, `TT-S6`, ...). It
 * explains *why* an arm missed: a miss in one family is a different contract
 * question from a miss in another. Ratings follow the class rule exactly: only
 * a speak or silence decision is rated, `mixed` is counted and excluded, and an
 * incomplete decision never enters a denominator.
 */

export interface FamilyReading {
  readonly armId: string
  readonly lang: 'en' | 'fr'
  readonly family: string
  /** Completed or incomplete decisions in this family. */
  readonly total: number
  readonly completed: number
  readonly incomplete: number
  /** Completed decisions in the family that answered their class correctly. */
  readonly appropriate: number
  /** Completed speak or silence decisions; the only rating denominator. */
  readonly rated: number
  /** Completed `mixed` decisions, counted and excluded. */
  readonly mixed: number
  /** `appropriate / rated`; `null` on a zero denominator. */
  readonly rate: number | null
}

interface Tally {
  total: number
  completed: number
  incomplete: number
  appropriate: number
  rated: number
  mixed: number
}

function emptyTally(): Tally {
  return { total: 0, completed: 0, incomplete: 0, appropriate: 0, rated: 0, mixed: 0 }
}

function reading(tally: Tally): Omit<FamilyReading, 'armId' | 'lang' | 'family'> {
  return {
    total: tally.total,
    completed: tally.completed,
    incomplete: tally.incomplete,
    appropriate: tally.appropriate,
    rated: tally.rated,
    mixed: tally.mixed,
    rate: tally.rated === 0 ? null : tally.appropriate / tally.rated,
  }
}

/** Group entries by arm, language and label family, in a stable order. */
export function familyBreakdown(entries: readonly RoutingMatrixEntry[]): readonly FamilyReading[] {
  const tallies = new Map<
    string,
    { armId: string; lang: 'en' | 'fr'; family: string; tally: Tally }
  >()

  for (const entry of entries) {
    const label = routingOutcomeLabelSchema.parse(entry.label)
    const klass = labelClass(label)
    const family = label.family ?? 'unlabelled'
    const key = `${entry.armId}\u0000${entry.lang}\u0000${family}`
    let group = tallies.get(key)
    if (group === undefined) {
      group = { armId: entry.armId, lang: entry.lang, family, tally: emptyTally() }
      tallies.set(key, group)
    }

    const tally = group.tally
    tally.total += 1
    if (entry.artifact.outcome === 'infrastructure_incomplete') {
      tally.incomplete += 1
      continue
    }

    tally.completed += 1
    if (klass === 'mixed') {
      tally.mixed += 1
      continue
    }
    tally.rated += 1
    const decision = routingDecisionSchema.parse(entry.artifact.decision)
    if (classAppropriate(klass, decision.outcome, label.acceptablePersonaIds)) {
      tally.appropriate += 1
    }
  }

  return [...tallies.values()]
    .map((group) => ({
      armId: group.armId,
      lang: group.lang,
      family: group.family,
      ...reading(group.tally),
    }))
    .sort(
      (left, right) =>
        left.armId.localeCompare(right.armId) ||
        left.lang.localeCompare(right.lang) ||
        left.family.localeCompare(right.family),
    )
}
