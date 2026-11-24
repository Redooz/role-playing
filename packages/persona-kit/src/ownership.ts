import type { RoutingOwner } from '@rp/routing-policy'
import type { ScenarioVariant } from '@rp/scenario-kit'
import { normalizeKeywordText, tokens, unique } from './keywords.js'

/**
 * Parse scenario ownership facts into public routing state (M3d D1).
 *
 * A fact owns a topic only when it names one persona and one responsibility in
 * one sentence, for example "Sam owns the action list" or "Samir est
 * responsable de la liste d'actions". A context fact such as "the demo was on
 * Thursday" stays context: it creates no owner.
 *
 * This module reads scenario data and persona names only. It never reads a
 * golden label, a task file or a transcript.
 */

export interface OwnershipPerson {
  readonly personaId: string
  /** Display name and aliases; the first name is enough in these scenarios. */
  readonly names: readonly string[]
}

export class UnparsedOwnershipFactError extends Error {
  readonly factIndex: number
  readonly fact: string

  constructor(factIndex: number, fact: string) {
    super(`ownership fact ${factIndex} cannot be parsed: ${JSON.stringify(fact)}`)
    this.name = 'UnparsedOwnershipFactError'
    this.factIndex = factIndex
    this.fact = fact
  }
}

export class UnknownOwnershipPersonaError extends Error {
  readonly factIndex: number
  readonly fact: string
  readonly personaName: string

  constructor(factIndex: number, fact: string, personaName: string) {
    super(
      `ownership fact ${factIndex} names an unknown persona "${personaName}": ${JSON.stringify(fact)}`,
    )
    this.name = 'UnknownOwnershipPersonaError'
    this.factIndex = factIndex
    this.fact = fact
    this.personaName = personaName
  }
}

export class AmbiguousOwnershipPersonaError extends Error {
  readonly factIndex: number
  readonly fact: string
  readonly personaName: string

  constructor(factIndex: number, fact: string, personaName: string) {
    super(
      `ownership fact ${factIndex} names an ambiguous persona "${personaName}": ${JSON.stringify(fact)}`,
    )
    this.name = 'AmbiguousOwnershipPersonaError'
    this.factIndex = factIndex
    this.fact = fact
    this.personaName = personaName
  }
}

export class ConflictingOwnershipError extends Error {
  readonly firstIndex: number
  readonly secondIndex: number
  readonly topic: string

  constructor(firstIndex: number, secondIndex: number, topic: string) {
    super(
      `ownership facts ${firstIndex} and ${secondIndex} claim different personas for "${topic}"`,
    )
    this.name = 'ConflictingOwnershipError'
    this.firstIndex = firstIndex
    this.secondIndex = secondIndex
    this.topic = topic
  }
}

/** A marker that says the sentence intends to assign a responsibility. */
const OWNERSHIP_MARKER = /\b(?:owns|responsible|responsable)\b|\ben charge\b/iu

const EN_OWNERSHIP = /^(?<name>.+?) (?:owns|is responsible for) (?<topic>.+)$/iu

const FR_OWNERSHIP =
  /^(?<name>.+?) (?:est responsable|est en charge) (?:de la |des |du |de l[’']|de )(?<topic>.+)$/iu

function normalizeName(name: string, lang: 'en' | 'fr'): string {
  return normalizeKeywordText(name.trim(), lang).replace(/\s+/gu, ' ')
}

function nameIndexFor(
  persons: readonly OwnershipPerson[],
  lang: 'en' | 'fr',
): ReadonlyMap<string, ReadonlySet<string>> {
  const index = new Map<string, Set<string>>()
  for (const person of persons) {
    for (const name of person.names) {
      const key = normalizeName(name, lang)
      if (key === '') continue
      const ids = index.get(key) ?? new Set<string>()
      ids.add(person.personaId)
      index.set(key, ids)
    }
  }
  return index
}

function personaIdsFor(
  name: string,
  index: ReadonlyMap<string, ReadonlySet<string>>,
  factIndex: number,
  fact: string,
  lang: 'en' | 'fr',
): string[] {
  const ids = index.get(normalizeName(name, lang))
  if (ids === undefined) throw new UnknownOwnershipPersonaError(factIndex, fact, name)
  if (ids.size > 1) throw new AmbiguousOwnershipPersonaError(factIndex, fact, name)
  return [...ids]
}

function samePersonas(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const ids = new Set(left)
  return right.every((id) => ids.has(id))
}

function normalizeTopic(topic: string): string {
  return topic
    .trim()
    .replace(/[.!?;:,]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function keywordsForTopic(topic: string, lang: 'en' | 'fr'): string[] {
  const keywords = unique(tokens(topic, lang))
  return keywords.length === 0 ? [normalizeKeywordText(topic, lang)] : keywords
}

/** Parse every ownership fact in one scenario variant, in fact order. */
export function ownershipFromFacts(
  variant: ScenarioVariant,
  persons: readonly OwnershipPerson[],
): readonly RoutingOwner[] {
  const lang = variant.lang
  const pattern = lang === 'fr' ? FR_OWNERSHIP : EN_OWNERSHIP
  const names = nameIndexFor(persons, lang)
  const owners: RoutingOwner[] = []
  const claimed = new Map<
    string,
    { readonly personaIds: readonly string[]; readonly index: number }
  >()

  for (const [factIndex, fact] of variant.facts.entries()) {
    const match = pattern.exec(fact.trim())
    const name = match?.groups?.['name']
    const rawTopic = match?.groups?.['topic']

    if (name === undefined || rawTopic === undefined) {
      if (OWNERSHIP_MARKER.test(fact)) throw new UnparsedOwnershipFactError(factIndex, fact)
      continue
    }

    const personaIds = personaIdsFor(name, names, factIndex, fact, lang)
    const topic = normalizeTopic(rawTopic)
    if (topic === '') throw new UnparsedOwnershipFactError(factIndex, fact)

    const key = normalizeKeywordText(topic, lang)
    const prior = claimed.get(key)
    if (prior !== undefined) {
      if (!samePersonas(prior.personaIds, personaIds)) {
        throw new ConflictingOwnershipError(prior.index, factIndex, topic)
      }
      continue
    }

    claimed.set(key, { personaIds, index: factIndex })
    owners.push({
      topic,
      keywords: keywordsForTopic(topic, lang),
      personaIds,
      source: 'fact',
      sourceFactIndex: factIndex,
    })
  }

  return owners
}

/**
 * Scoped scenario objectives that name their persona are ownership claims too.
 *
 * A shared objective has no `personaIds`; it describes the learner's goal, not
 * one persona's responsibility, so it creates no owner.
 */
export function ownershipFromObjectives(
  variant: ScenarioVariant,
  eligiblePersonaIds: readonly string[],
): readonly RoutingOwner[] {
  const eligible = new Set(eligiblePersonaIds)
  const owners: RoutingOwner[] = []

  for (const objective of variant.objectives) {
    const scoped = objective.personaIds
    if (scoped === undefined || scoped.length === 0) continue
    if (!scoped.every((personaId) => eligible.has(personaId))) continue
    owners.push({
      topic: objective.description,
      keywords:
        objective.keywords === undefined
          ? keywordsForTopic(objective.description, variant.lang)
          : [...objective.keywords],
      personaIds: [...scoped],
      source: 'objective',
      objectiveId: objective.id,
    })
  }

  return owners
}
