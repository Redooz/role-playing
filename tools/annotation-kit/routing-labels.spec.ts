import { describe, expect, it } from 'vitest'
import {
  annotatorCase,
  labelsAgree,
  outcomeSignature,
  parseRoutingLabel,
  summarizeRoutingAgreement,
} from './routing-labels.mjs'

function label(overrides = {}) {
  return {
    taskId: 'routing-en-cal-1',
    lang: 'en',
    intent: 'answer',
    acceptablePersonaIds: ['peer'],
    allowUserYield: false,
    ...overrides,
  }
}

describe('parseRoutingLabel', () => {
  it('accepts a valid label', () => {
    expect(parseRoutingLabel(label())).toEqual(label())
  })

  it('accepts yield-only and mixed outcomes', () => {
    expect(
      parseRoutingLabel(label({ acceptablePersonaIds: [], allowUserYield: true })).allowUserYield,
    ).toBe(true)
    expect(
      parseRoutingLabel(label({ acceptablePersonaIds: ['manager', 'peer'], allowUserYield: true })),
    ).toMatchObject({ acceptablePersonaIds: ['manager', 'peer'], allowUserYield: true })
  })

  it('rejects an empty outcome', () => {
    expect(() =>
      parseRoutingLabel(label({ acceptablePersonaIds: [], allowUserYield: false })),
    ).toThrow(/at least one persona or learner yield/i)
  })

  it('rejects duplicate personas and invalid languages', () => {
    expect(() => parseRoutingLabel(label({ acceptablePersonaIds: ['peer', 'peer'] }))).toThrow(
      /must not repeat/i,
    )
    expect(() => parseRoutingLabel(label({ lang: 'de' }))).toThrow(/en.*fr/i)
  })

  it('rejects malformed scalar fields', () => {
    expect(() => parseRoutingLabel(label({ taskId: '' }))).toThrow(/taskId/i)
    expect(() => parseRoutingLabel(label({ intent: ' ' }))).toThrow(/intent/i)
    expect(() => parseRoutingLabel(label({ allowUserYield: 'yes' }))).toThrow(/boolean/i)
  })
})

describe('outcomeSignature', () => {
  it('is order-independent for personas', () => {
    expect(outcomeSignature(label({ acceptablePersonaIds: ['peer', 'manager'] }))).toBe(
      outcomeSignature(label({ acceptablePersonaIds: ['manager', 'peer'] })),
    )
  })

  it('includes learner yield in the signature', () => {
    expect(outcomeSignature(label({ allowUserYield: true }))).toBe('peer|yield')
  })

  it('compares exact accepted-outcome sets', () => {
    expect(
      labelsAgree(
        label({ acceptablePersonaIds: ['peer', 'manager'] }),
        label({ acceptablePersonaIds: ['manager', 'peer'] }),
      ),
    ).toBe(true)
    expect(labelsAgree(label(), label({ acceptablePersonaIds: ['manager'] }))).toBe(false)
  })
})

describe('summarizeRoutingAgreement', () => {
  it('reports exact agreement overall and per language', () => {
    const left = [
      label(),
      label({ taskId: 'routing-en-cal-2' }),
      label({ taskId: 'routing-fr-cal-1', lang: 'fr', acceptablePersonaIds: ['manager'] }),
    ]
    const right = [
      label(),
      label({ taskId: 'routing-en-cal-2', acceptablePersonaIds: ['manager'] }),
      label({ taskId: 'routing-fr-cal-1', lang: 'fr', acceptablePersonaIds: ['manager'] }),
    ]
    expect(summarizeRoutingAgreement(left, right)).toEqual({
      n: 3,
      exact: 2,
      exactRate: 2 / 3,
      byLang: {
        en: { n: 2, exact: 1, exactRate: 0.5 },
        fr: { n: 1, exact: 1, exactRate: 1 },
      },
      unmatched: [],
    })
  })

  it('reports unmatched task ids', () => {
    const summary = summarizeRoutingAgreement([label()], [label({ taskId: 'other' })])
    expect(summary.n).toBe(0)
    expect(summary.unmatched).toEqual(['other', 'routing-en-cal-1'])
  })

  it('rejects a language mismatch for the same task', () => {
    expect(() => summarizeRoutingAgreement([label()], [label({ lang: 'fr' })])).toThrow(
      /language mismatch/i,
    )
  })
})

describe('annotatorCase', () => {
  const task = {
    id: 'routing-001',
    lang: 'en',
    mode: 'routing',
    cefrBand: 'B1',
    scenarioType: 'deadline',
    content: { scenarioBrief: 'A routing decision.', turns: [] },
    routing: {
      context: {
        transcript: [{ speaker: { kind: 'user' }, text: 'Sam?' }],
        personas: [{ id: 'peer', displayName: 'Sam Carter' }],
        coveredObjectiveIds: [],
      },
    },
    split: 'holdout',
    speakerId: 'speaker-holdout',
    routingLabels: { acceptablePersonaIds: ['peer'] },
  }

  it('keeps only annotator-visible state', () => {
    expect(annotatorCase(task)).toEqual({
      taskId: 'routing-001',
      lang: 'en',
      cefrBand: 'B1',
      scenarioType: 'deadline',
      scenarioBrief: 'A routing decision.',
      transcript: task.routing.context.transcript,
      personas: task.routing.context.personas,
      coveredObjectiveIds: [],
    })
  })

  it('never includes split, speakerId or labels', () => {
    const serialized = JSON.stringify(annotatorCase(task))
    expect(serialized).not.toMatch(/holdout|speaker-holdout|routingLabels|acceptable/i)
  })

  it('rejects a non-routing task', () => {
    expect(() => annotatorCase({ ...task, mode: 'session' })).toThrow(/routing task/i)
  })
})
