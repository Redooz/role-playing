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

  it('returns only the five label fields, in a detached copy', () => {
    const raw = {
      ...label({ acceptablePersonaIds: ['manager', 'peer'] }),
      operatorOnly: 'never-for-annotators',
    }
    const parsed = parseRoutingLabel(raw)
    expect(parsed).toStrictEqual({
      caseId: 'case-a',
      intent: 'answer',
      acceptablePersonaIds: ['manager', 'peer'],
      allowUserYield: false,
      lang: 'en',
    })
    expect(parsed.acceptablePersonaIds).not.toBe(raw.acceptablePersonaIds)
    parsed.acceptablePersonaIds.push('peer')
    expect(raw.acceptablePersonaIds).toStrictEqual(['manager', 'peer'])
  })

  it.each(['en', 'fr'])('accepts the %s language tag', (lang) => {
    expect(parseRoutingLabel(label({ lang })).lang).toBe(lang)
  })

  it.each([
    ['null', null, 'routing label must be a JSON object'],
    ['an array', [], 'routing label must be a JSON object'],
    ['a string', 'case-a', 'routing label must be a JSON object'],
    ['a number', 7, 'routing label must be a JSON object'],
    ['a non-string caseId', label({ caseId: 5 }), 'caseId must be a non-empty string'],
    ['an empty caseId', label({ caseId: '' }), 'caseId must be a non-empty string'],
    ['a non-string intent', label({ intent: 5 }), 'intent must be a non-empty string'],
    ['a whitespace intent', label({ intent: '\t \n' }), 'intent must be a non-empty string'],
    [
      'a non-array persona list',
      label({ acceptablePersonaIds: 'peer' }),
      'acceptablePersonaIds must be an array of non-empty strings',
    ],
    [
      'a non-string persona entry',
      label({ acceptablePersonaIds: ['peer', 5] }),
      'acceptablePersonaIds must be an array of non-empty strings',
    ],
    [
      'an empty persona entry',
      label({ acceptablePersonaIds: [''] }),
      'acceptablePersonaIds must be an array of non-empty strings',
    ],
    [
      'repeated personas',
      label({ acceptablePersonaIds: ['peer', 'peer'] }),
      'acceptablePersonaIds must not repeat',
    ],
    [
      'a non-boolean yield flag',
      label({ allowUserYield: 'yes' }),
      'allowUserYield must be a boolean',
    ],
    [
      'an empty outcome',
      label({ acceptablePersonaIds: [], allowUserYield: false }),
      'a label must accept at least one persona or learner yield',
    ],
    ['a non-string language', label({ lang: 5 }), 'lang must be "en" or "fr"'],
    ['an unknown language', label({ lang: 'de' }), 'lang must be "en" or "fr"'],
  ])('rejects %s with the exact message', (_name, raw, message) => {
    expect(() => parseRoutingLabel(raw)).toThrowError(new Error(message))
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

  it('sorts personas and omits yield when it is not accepted', () => {
    expect(
      outcomeSignature(label({ acceptablePersonaIds: ['peer', 'manager'], allowUserYield: false })),
    ).toBe('manager|peer')
  })

  it('signs a yield-only outcome', () => {
    expect(outcomeSignature(label({ acceptablePersonaIds: [], allowUserYield: true }))).toBe(
      'yield',
    )
  })

  it('compares exact accepted-outcome sets', () => {
    expect(
      labelsAgree(
        label({ acceptablePersonaIds: ['peer', 'manager'] }),
        label({ acceptablePersonaIds: ['manager', 'peer'] }),
      ),
    ).toBe(true)
    expect(labelsAgree(label(), label({ acceptablePersonaIds: ['manager'] }))).toBe(false)
    expect(labelsAgree(label(), label({ allowUserYield: true }))).toBe(false)
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

  it('names the mismatched task and both languages', () => {
    expect(() => summarizeRoutingAgreement([label()], [label({ lang: 'fr' })])).toThrowError(
      new Error('language mismatch for case-a: en vs fr'),
    )
  })

  it('returns a zero summary for no labels at all', () => {
    expect(summarizeRoutingAgreement([], [])).toStrictEqual({
      n: 0,
      exact: 0,
      exactRate: 0,
      byLang: {},
      unmatched: [],
    })
  })

  it('sorts unmatched case ids from both passes', () => {
    const summary = summarizeRoutingAgreement(
      [label({ caseId: 'z-case' }), label({ caseId: 'a-case' })],
      [label({ caseId: 'm-case' }), label({ caseId: 'a-case' })],
    )
    expect(summary.n).toBe(1)
    expect(summary.exact).toBe(1)
    expect(summary.unmatched).toStrictEqual(['m-case', 'z-case'])
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

  it('treats the pre-registered bar as inclusive', () => {
    expect(
      agreementFailures({ byLang: { en: { n: 4, exact: 3, exactRate: 0.75 } } }, 0.75),
    ).toEqual([])
  })

  it('rounds both rates to three decimals in the failure text', () => {
    expect(
      agreementFailures({ byLang: { en: { n: 3, exact: 2, exactRate: 2 / 3 } } }, 0.8),
    ).toEqual(['en: 0.667 < 0.800'])
  })

  it('reports every failing language in iteration order', () => {
    expect(
      agreementFailures(
        {
          byLang: {
            en: { n: 2, exact: 1, exactRate: 0.5 },
            fr: { n: 0, exact: 0, exactRate: 0 },
          },
        },
        0.8,
      ),
    ).toEqual(['en: 0.500 < 0.800', 'fr: no matched cases'])
  })

  it('passes when no language was measured', () => {
    expect(agreementFailures({ byLang: {} }, 0.8)).toEqual([])
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

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'routing-001'],
    ['a number', 7],
  ])('rejects %s as a task with the exact guard message', (_name, value) => {
    expect(() => annotatorCase(value, 'case-opaque')).toThrowError(
      new Error('only a routing task can become an annotator case'),
    )
  })

  it('rejects a task with no mode and a task with no routing context', () => {
    const { mode: _mode, ...withoutMode } = task
    expect(() => annotatorCase(withoutMode, 'case-opaque')).toThrowError(
      new Error('only a routing task can become an annotator case'),
    )
    expect(() => annotatorCase({ ...task, routing: undefined }, 'case-opaque')).toThrowError(
      new Error('routing task has no context'),
    )
    expect(() => annotatorCase({ ...task, routing: {} }, 'case-opaque')).toThrowError(
      new Error('routing task has no context'),
    )
  })

  it.each([
    ['a number', 5],
    ['an empty string', ''],
  ])('rejects %s as an opaque case id', (_name, caseId) => {
    expect(() => annotatorCase(task, caseId)).toThrowError(
      new Error('an annotator case needs an opaque caseId'),
    )
  })

  it('defaults a missing scenario brief to an empty string', () => {
    const { content: _content, ...withoutContent } = task
    expect(annotatorCase(withoutContent, 'case-opaque').scenarioBrief).toBe('')
    expect(annotatorCase({ ...task, content: {} }, 'case-opaque').scenarioBrief).toBe('')
    expect(annotatorCase({ ...task, content: null }, 'case-opaque').scenarioBrief).toBe('')
  })
})
