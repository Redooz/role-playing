import { scenarioById, type ScenarioSpec } from '@rp/scenario-kit'
import { describe, expect, it } from 'vitest'
import { personaById } from './index.js'
import { buildSessionRoutingContext, routingKeywordsForObjective } from './routing-context.js'

const messages = [
  {
    role: 'assistant' as const,
    content: 'We need to change the release scope.',
    personaId: 'manager',
  },
  { role: 'user' as const, content: 'Sam, how much of the notification work is finished?' },
]

describe('buildSessionRoutingContext', () => {
  it('builds the two-persona public context for the scope-change scenario', () => {
    const context = buildSessionRoutingContext({
      turnId: 'turn-1',
      personas: [personaById('manager'), personaById('peer')],
      scenario: scenarioById('standup-scope-change'),
      locale: 'en',
      messages,
    })

    expect(context).toMatchObject({
      decisionId: 'turn-1',
      turnId: 'turn-1',
      lang: 'en',
      coveredObjectiveIds: [],
      transcript: [
        { speaker: { kind: 'persona', personaId: 'manager' }, text: messages[0]!.content },
        { speaker: { kind: 'user' }, text: messages[1]!.content },
      ],
    })
    expect(context.personas.map((persona) => persona.id)).toEqual(['manager', 'peer'])
    expect(context.personas[0]?.displayName).toBe('Katherine Brooks')
    expect(context.personas[1]?.displayName).toBe('Sam Carter')
    expect(context.personas[0]?.objectives.map((objective) => objective.id)).toEqual([
      'agree-priority',
    ])
    expect(context.personas[1]?.objectives.map((objective) => objective.id)).toEqual([
      'assess-impact',
    ])
  })

  it('localises names and keywords and gives the opening persona a first-name alias', () => {
    const context = buildSessionRoutingContext({
      turnId: 'turn-1',
      personas: [personaById('manager'), personaById('peer')],
      scenario: scenarioById('standup-scope-change'),
      locale: 'fr-CA',
      messages,
    })
    expect(context.personas[0]).toMatchObject({
      displayName: 'Catherine Brooks',
      aliases: ['Catherine'],
    })
    expect(context.personas[1]?.aliases).toEqual(['Samir'])
    expect(context.personas[0]?.objectives[0]?.keywords).toContain('priorité')
    expect(context.personas[1]?.objectives[0]?.keywords).toContain('notifications')
  })

  it('rejects a single-persona routing context because multi-persona routing needs two', () => {
    expect(() =>
      buildSessionRoutingContext({
        turnId: 'turn-1',
        personas: [personaById('manager')],
        scenario: scenarioById('request-deadline-extension'),
        locale: 'en',
        messages: [{ role: 'user', content: 'I need more time for the report.' }],
      }),
    ).toThrow(/Too small/u)
  })

  it('falls back to registered persona goals when a multi-persona variant has no scoped objective', () => {
    const scenario = scenarioById('standup-scope-change')
    const en = scenario.variants['en']!
    const broken: ScenarioSpec = {
      ...scenario,
      variants: {
        ...scenario.variants,
        en: {
          ...en,
          objectives: en.objectives.filter((objective) => objective.id === 'agree-priority'),
        },
      },
    }
    const context = buildSessionRoutingContext({
      turnId: 'turn-1',
      personas: [personaById('manager'), personaById('peer')],
      scenario: broken,
      locale: 'en',
      messages,
    })
    expect(context.personas[1]?.objectives.map((objective) => objective.id)).toEqual([
      'peer-goal-1',
      'peer-goal-2',
      'peer-goal-3',
    ])
  })

  it('rejects an empty history, a non-user last turn and an unknown persona', () => {
    const base = {
      turnId: 'turn-1',
      personas: [personaById('manager'), personaById('peer')],
      scenario: scenarioById('standup-scope-change'),
      locale: 'en',
    }
    expect(() => buildSessionRoutingContext({ ...base, messages: [] })).toThrow(/committed user/u)
    expect(() =>
      buildSessionRoutingContext({
        ...base,
        messages: [{ role: 'assistant', content: 'Hello.' }],
      }),
    ).toThrow(/committed user utterance/u)
    expect(() =>
      buildSessionRoutingContext({
        ...base,
        personas: [personaById('manager'), { ...personaById('client'), id: 'stranger' }],
        messages,
      }),
    ).toThrow(/does not include persona "stranger"/u)
    expect(() =>
      buildSessionRoutingContext({
        ...base,
        personas: [personaById('manager'), personaById('manager')],
        messages,
      }),
    ).toThrow(/must be unique/u)
  })
})

describe('routingKeywordsForObjective', () => {
  it('uses explicit keywords when the scenario provides them', () => {
    expect(
      routingKeywordsForObjective(
        {
          id: 'deadline',
          description: 'Agree a delivery deadline.',
          successCriteria: ['Name a date'],
          keywords: ['deadline', 'date'],
        },
        'en',
      ),
    ).toEqual(['deadline', 'date'])
  })

  it('derives a phrase and content tokens when no keywords are present', () => {
    const keywords = routingKeywordsForObjective(
      {
        id: 'assess-impact',
        description: 'Ask the peer how much work is already done.',
        successCriteria: ['Ask about completed work'],
      },
      'en',
    )
    expect(keywords).toContain('assess impact')
    expect(keywords).toContain('impact')
    expect(keywords).toContain('work')
    expect(keywords).not.toContain('the')
  })
})
