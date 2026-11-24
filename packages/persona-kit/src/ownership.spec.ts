import { scenarioById, type ScenarioVariant } from '@rp/scenario-kit'
import { describe, expect, it } from 'vitest'
import { personaById } from './index.js'
import { personaVariant } from './lookup.js'
import {
  AmbiguousOwnershipPersonaError,
  ConflictingOwnershipError,
  UnparsedOwnershipFactError,
  UnknownOwnershipPersonaError,
  type OwnershipPerson,
  ownershipFromFacts,
} from './ownership.js'

const localeByLanguage = {
  en: ['en', 'en-GB'],
  fr: ['fr', 'fr-CA'],
} as const

function personsFor(locale: string): OwnershipPerson[] {
  return (['manager', 'peer'] as const).map((personaId) => {
    const variant = personaVariant(personaById(personaId), locale)
    const firstName = variant.displayName.split(/\s+/u)[0]!
    return { personaId, names: [variant.displayName, firstName] }
  })
}

function variant(locale: string): ScenarioVariant {
  return scenarioById('post-demo-handover').variants[locale]!
}

function withFacts(facts: readonly string[]): ScenarioVariant {
  return { ...variant('en'), facts: [...facts] }
}

describe('ownershipFromFacts', () => {
  it('parses every ownership fact in the English handover variants', () => {
    for (const locale of localeByLanguage.en) {
      const owners = ownershipFromFacts(variant(locale), personsFor(locale))
      expect(owners).toHaveLength(5)
      expect(owners.map((owner) => owner.sourceFactIndex)).toEqual([1, 2, 3, 4, 5])
      expect(owners.map((owner) => owner.personaIds)).toEqual([
        ['peer'],
        ['manager'],
        ['manager'],
        ['manager'],
        ['peer'],
      ])
      expect(owners[0]?.topic).toBe('the follow-up notes from the demo')
      expect(owners[0]?.keywords).toContain('notes')
      expect(owners[4]?.topic).toBe('the action list')
    }
  })

  it('parses the French handover variants with localised names', () => {
    for (const locale of localeByLanguage.fr) {
      const owners = ownershipFromFacts(variant(locale), personsFor(locale))
      expect(owners).toHaveLength(5)
      expect(owners.map((owner) => owner.personaIds)).toEqual([
        ['peer'],
        ['manager'],
        ['manager'],
        ['manager'],
        ['peer'],
      ])
      expect(owners[1]?.topic).toBe('communication client après la démo')
      expect(owners[3]?.topic).toContain('liste')
      expect(owners[3]?.topic).toContain('avant la démo')
      expect(owners[0]?.keywords).toContain('notes')
    }
  })

  it('ignores context facts that assign no responsibility', () => {
    const owners = ownershipFromFacts(variant('en'), personsFor('en'))
    expect(owners.every((owner) => owner.sourceFactIndex !== 0)).toBe(true)
    expect(owners.every((owner) => owner.sourceFactIndex !== 6)).toBe(true)
  })

  it('finds no owner in a scenario whose facts only give context', () => {
    expect(
      ownershipFromFacts(scenarioById('standup-scope-change').variants['en']!, personsFor('en')),
    ).toEqual([])
  })

  it('matches a full display name as well as a first name', () => {
    const owners = ownershipFromFacts(
      withFacts(['Sam Carter owns the action list.']),
      personsFor('en'),
    )
    expect(owners).toEqual([
      {
        topic: 'the action list',
        keywords: ['action', 'list'],
        personaIds: ['peer'],
        sourceFactIndex: 0,
      },
    ])
  })

  it('deduplicates the same owner and topic', () => {
    const owners = ownershipFromFacts(
      withFacts(['Sam owns the action list.', 'Sam owns the action list.']),
      personsFor('en'),
    )
    expect(owners).toHaveLength(1)
  })

  it('rejects an ownership fact that names an unknown persona', () => {
    expect(() =>
      ownershipFromFacts(withFacts(['Maria owns the budget.']), personsFor('en')),
    ).toThrow(UnknownOwnershipPersonaError)
  })

  it('rejects a responsibility sentence with no topic', () => {
    expect(() => ownershipFromFacts(withFacts(['Sam owns.']), personsFor('en'))).toThrow(
      UnparsedOwnershipFactError,
    )
  })

  it('rejects two personas who claim the same topic', () => {
    expect(() =>
      ownershipFromFacts(
        withFacts(['Sam owns the action list.', 'Katherine owns the action list.']),
        personsFor('en'),
      ),
    ).toThrow(ConflictingOwnershipError)
  })

  it('rejects an ambiguous persona name', () => {
    const persons: OwnershipPerson[] = [
      { personaId: 'manager', names: ['Sam'] },
      { personaId: 'peer', names: ['Sam'] },
    ]
    expect(() => ownershipFromFacts(withFacts(['Sam owns the action list.']), persons)).toThrow(
      AmbiguousOwnershipPersonaError,
    )
  })
})
