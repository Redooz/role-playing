import { describe, expect, it } from 'vitest'
import {
  agreementFailures,
  annotatorCase,
  labelsAgree,
  outcomeSignature,
  parseRoutingLabel,
  summarizeRoutingAgreement,
} from './routing-labels.mjs'

function label(overrides = {}) {
  return {
    caseId: 'case-a',
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
    expect(() => parseRoutingLabel(label({ caseId: '' }))).toThrow(/caseId/i)
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
      label({ caseId: 'case-b' }),
      label({ caseId: 'case-c', lang: 'fr', acceptablePersonaIds: ['manager'] }),
    ]
    const right = [
      label(),
      label({ caseId: 'case-b', acceptablePersonaIds: ['manager'] }),
      label({ caseId: 'case-c', lang: 'fr', acceptablePersonaIds: ['manager'] }),
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

  it('reports unmatched case ids', () => {
    const summary = summarizeRoutingAgreement([label()], [label({ caseId: 'other' })])
    expect(summary.n).toBe(0)
    expect(summary.unmatched).toEqual(['case-a', 'other'])
  })

  it('rejects a language mismatch for the same task', () => {
    expect(() => summarizeRoutingAgreement([label()], [label({ lang: 'fr' })])).toThrow(
      /language mismatch/i,
    )
  })
})

describe('agreementFailures', () => {
  it('passes when every language clears the bar', () => {
    expect(
      agreementFailures(
        { byLang: { en: { n: 2, exact: 2, exactRate: 1 }, fr: { n: 2, exact: 2, exactRate: 1 } } },
        0.8,
      ),
    ).toEqual([])
  })

  it('names each language below the bar', () => {
    expect(
      agreementFailures(
        {
          byLang: {
            en: { n: 2, exact: 2, exactRate: 1 },
            fr: { n: 2, exact: 1, exactRate: 0.5 },
          },
        },
        0.8,
      ),
    ).toEqual(['fr: 0.500 < 0.800'])
  })

  it('fails a language with no matched cases', () => {
    expect(agreementFailures({ byLang: { en: { n: 0, exact: 0, exactRate: 0 } } }, 0.8)).toEqual([
      'en: no matched cases',
    ])
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

  it('keeps only annotator-visible state under an opaque id', () => {
    expect(annotatorCase(task, 'case-opaque')).toEqual({
      caseId: 'case-opaque',
      lang: 'en',
      cefrBand: 'B1',
      scenarioType: 'deadline',
      scenarioBrief: 'A routing decision.',
      transcript: task.routing.context.transcript,
      personas: task.routing.context.personas,
      coveredObjectiveIds: [],
    })
  })

  it('never includes the task id, split, speakerId or labels', () => {
    const serialized = JSON.stringify(annotatorCase(task, 'case-opaque'))
    expect(serialized).not.toMatch(/routing-001|holdout|speaker-holdout|routingLabels|acceptable/i)
  })

  it('rejects a non-routing task or missing opaque id', () => {
    expect(() => annotatorCase({ ...task, mode: 'session' }, 'case-opaque')).toThrow(
      /routing task/i,
    )
    expect(() => annotatorCase(task, '')).toThrow(/opaque caseId/i)
  })
})
