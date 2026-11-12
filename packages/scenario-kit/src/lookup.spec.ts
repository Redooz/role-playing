import { describe, expect, it } from 'vitest'
import { scenarioById, scenarioVariant } from './index.js'
import { objectiveAppliesToPersona, objectivesForPersona } from './lookup.js'

const variant = scenarioVariant(scenarioById('standup-scope-change'), 'en')

describe('objective persona scoping', () => {
  it('treats an objective without personaIds as applying to everyone', () => {
    const shared = variant.objectives.find((objective) => objective.id === 'confirm-scope')!
    expect(shared.personaIds).toBeUndefined()
    expect(objectiveAppliesToPersona(shared, 'manager')).toBe(true)
    expect(objectiveAppliesToPersona(shared, 'peer')).toBe(true)
  })

  it('returns only the shared and matching objectives in variant order', () => {
    expect(objectivesForPersona(variant, 'manager').map((objective) => objective.id)).toEqual([
      'confirm-scope',
      'agree-priority',
      'state-next-step',
    ])
    expect(objectivesForPersona(variant, 'peer').map((objective) => objective.id)).toEqual([
      'confirm-scope',
      'assess-impact',
      'state-next-step',
    ])
  })

  it('does not leak a scoped objective to another persona or an unknown id', () => {
    const peerOnly = variant.objectives.find((objective) => objective.id === 'assess-impact')!
    expect(objectiveAppliesToPersona(peerOnly, 'peer')).toBe(true)
    expect(objectiveAppliesToPersona(peerOnly, 'manager')).toBe(false)
    expect(objectivesForPersona(variant, 'client').map((objective) => objective.id)).toEqual([
      'confirm-scope',
      'state-next-step',
    ])
  })
})
