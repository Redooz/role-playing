import { scenarioById, type ScenarioVariant } from '@rp/scenario-kit'
import { describe, expect, it } from 'vitest'
import { personaById, type PersonaVariant } from '../index.js'
import { renderGemmaPacks } from './template-gemma.js'

const DATE = '2026-11-08'
const manager = personaById('manager')
const scenario = scenarioById('request-deadline-extension')
const personaVariant = manager.variants['en']!
const scenarioVariant = scenario.variants['en']!

function render(
  persona: PersonaVariant = personaVariant,
  variant: ScenarioVariant = scenarioVariant,
  input: Partial<Parameters<typeof renderGemmaPacks>[0]> = {},
) {
  return renderGemmaPacks({
    persona,
    scenario: variant,
    role: 'Engineering manager',
    organization: 'Northwind Analytics',
    cefrBand: 'B2',
    currentDate: DATE,
    ...input,
  })
}

describe('Gemma prompt sentence and capitalisation helpers', () => {
  it('normalises trailing punctuation in data-provided sentences', () => {
    const base = render()
    const ending = (setting: string) => {
      const packs = render(personaVariant, {
        ...scenarioVariant,
        setting,
        learnerRole: 'a developer.',
        opening: { ...scenarioVariant.opening, situation: 'Urgent!' },
      })
      return packs.greetingPack
    }

    expect(base.greetingPack).toContain(`Setting: ${scenarioVariant.setting}`)
    expect(ending('It ends today.')).toMatch(/Setting: It ends today\.\n/)
    expect(ending('It ends today...')).toMatch(/Setting: It ends today\.\n/)
    expect(ending('Really?!')).toMatch(/Setting: Really\?!\n/)
    expect(ending('Done…')).toMatch(/Setting: Done…\n/)
    expect(ending('Wait? Then continue')).toMatch(/Setting: Wait\? Then continue\.\n/)
    expect(ending('  Padded  ')).toMatch(/Setting: Padded\.\n/)
    expect(ending('anything')).toMatch(/Learner role: a developer\.\n/)
    expect(ending('anything')).toMatch(/Situation: Urgent!$/)
  })

  it('capitalises the first letter without changing the rest', () => {
    expect(
      render({ ...personaVariant, voice: { ...personaVariant.voice, tone: 'direct' } })
        .greetingPack,
    ).toContain('\nDirect.\n')
    expect(
      render({ ...personaVariant, voice: { ...personaVariant.voice, tone: 'éloquent' } })
        .greetingPack,
    ).toContain('\nÉloquent.\n')
    expect(
      render({ ...personaVariant, voice: { ...personaVariant.voice, tone: 'Already Direct' } })
        .greetingPack,
    ).toContain('\nAlready Direct.\n')
    expect(
      render({ ...personaVariant, voice: { ...personaVariant.voice, tone: '' } }).greetingPack,
    ).toContain('\n.\n')
  })

  it('uses the persona display name and role in the opening line', () => {
    const packs = render({ ...personaVariant, displayName: 'Zoé' }, scenarioVariant, {
      role: 'designer',
      organization: 'Example Ltd',
    })
    expect(packs.greetingPack.startsWith('You are Zoé, the designer at Example Ltd.')).toBe(true)
  })

  it('renders disclosures, no-question policy and an empty example list', () => {
    const packs = render(
      {
        ...personaVariant,
        style: { ...personaVariant.style, avoid: [], questionPolicy: 'none' },
        greeting: { ...personaVariant.greeting, requiredDisclosure: 'I am the manager.' },
        examples: [],
      },
      {
        ...scenarioVariant,
        opening: {
          ...scenarioVariant.opening,
          requiredDisclosure: 'The deadline is Friday.',
        },
      },
    )

    expect(packs.greetingPack).toContain('You must disclose: I am the manager.')
    expect(packs.greetingPack).toContain('You must disclose: The deadline is Friday.')
    expect(packs.greetingPack).toContain('Do not ask questions.')
    expect(packs.greetingPack).not.toContain('Ask at most one question per turn.')
    expect(packs.greetingPack).not.toContain('Avoid:')
    expect(packs.sessionPack).not.toContain('EXAMPLES')
  })

  it('renders example pairs when they exist', () => {
    const packs = render({
      ...personaVariant,
      examples: [
        { user: 'Can I have more time?', persona: 'How much time?' },
        { user: 'Maybe Friday?', persona: 'Friday works.' },
      ],
    })
    expect(packs.sessionPack).toContain('EXAMPLES')
    expect(packs.sessionPack).toContain('Learner: Can I have more time?')
    expect(packs.sessionPack).toContain('Katherine Brooks: How much time?')
    expect(packs.sessionPack).toContain('Learner: Maybe Friday?')
  })
})
