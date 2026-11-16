import { scenarioById, scenarioVariant } from '@rp/scenario-kit'
import { describe, expect, it } from 'vitest'
import { annotatorCase, caseIdFor, labelClass, manifestRow } from './speaker-cases.mjs'

const variant = scenarioVariant(scenarioById('post-demo-handover'), 'en')
const task = {
  id: 'en-b2-handover-en-v2-cal-001',
  lang: 'en',
  locale: 'en',
  split: 'calibration',
  content: { scenarioBrief: 'A handover after the client demo.' },
  session: {
    scriptedUserTurns: ['Katherine, is the rollout still Friday?', 'Thanks, noted.'],
  },
}
const personas = [
  { id: 'manager', displayName: 'Katherine Brooks' },
  { id: 'peer', displayName: 'Sam Carter' },
]

describe('speaker case classification', () => {
  it('classifies speak, silence and mixed', () => {
    expect(labelClass({ acceptablePersonaIds: ['peer'], allowUserYield: false })).toBe('speak')
    expect(labelClass({ acceptablePersonaIds: [], allowUserYield: true })).toBe('silence')
    expect(labelClass({ acceptablePersonaIds: ['peer'], allowUserYield: true })).toBe('mixed')
  })

  it('derives a stable opaque case id from the task and turn', () => {
    expect(caseIdFor('task-a', 0)).toBe(caseIdFor('task-a', 0))
    expect(caseIdFor('task-a', 0)).not.toBe(caseIdFor('task-a', 1))
    expect(caseIdFor('task-a', 0)).toMatch(/^case-[0-9a-f]{16}$/)
    expect(caseIdFor('task-a', 0)).not.toContain('task-a')
  })
})

describe('annotator case', () => {
  it('carries the scenario state and learner turns up to the turn', () => {
    const entry = annotatorCase(task, variant, personas, 1)
    expect(entry.caseId).toBe(caseIdFor(task.id, 1))
    expect(entry.lang).toBe('en')
    expect(entry.locale).toBe('en')
    expect(entry.turnIndex).toBe(1)
    expect(entry.setting).toBe(variant.setting)
    expect(entry.facts).toEqual([...variant.facts])
    expect(entry.personas).toEqual(personas)
    expect(entry.learnerTurns).toEqual(task.session.scriptedUserTurns)
  })

  it('does not leak the task id, split or authored label', () => {
    const serialized = JSON.stringify(annotatorCase(task, variant, personas, 0))
    expect(serialized).not.toContain(task.id)
    expect(serialized).not.toContain('calibration')
    expect(serialized).not.toContain('speakerLabels')
    expect(serialized).not.toContain('acceptablePersonaIds')
  })
})

describe('operator manifest row', () => {
  it('keeps the task, split and expected class operator-only', () => {
    expect(manifestRow(task, 0, 'speak')).toEqual({
      caseId: caseIdFor(task.id, 0),
      taskId: task.id,
      turnIndex: 0,
      lang: 'en',
      locale: 'en',
      split: 'calibration',
      expectedClass: 'speak',
    })
  })
})
