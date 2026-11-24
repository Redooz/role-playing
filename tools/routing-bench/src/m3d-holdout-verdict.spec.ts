import type { RoutingArmLanguageReport } from '@rp/eval-harness'
import { describe, expect, it } from 'vitest'
import {
  armVerdict,
  HOLDOUT_TARGETS,
  selectHoldoutArm,
  type HoldoutTargets,
} from './m3d-holdout-verdict.js'

const targets: HoldoutTargets = HOLDOUT_TARGETS.en

/** A complete arm that clears every EN floor unless a field says otherwise. */
function arm(overrides: Partial<RoutingArmLanguageReport> = {}): RoutingArmLanguageReport {
  return {
    armId: 'jev-central',
    lang: 'en',
    n: 144,
    completed: 144,
    incomplete: 0,
    classes: {
      speak: { total: 102, completed: 102, incomplete: 0, appropriate: 90, rate: 90 / 102 },
      silence: { total: 36, completed: 36, incomplete: 0, appropriate: 30, rate: 30 / 36 },
      mixed: { total: 6, completed: 6, incomplete: 0 },
    },
    acceptable: 120,
    acceptableOutcomeRate: 120 / 144,
    falseSpeak: 6,
    falseSpeakRate: 6 / 144,
    falseYield: 12,
    falseYieldRate: 12 / 144,
    timeouts: 0,
    unsettledFallbacks: 2,
    timeoutRate: 0,
    unsettledFallbackRate: 2 / 144,
    fallbackRate: 2 / 144,
    latencyMs: { count: 144, min: 100, p50: 200, p95: 400, p99: 500, max: 600 },
    usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.0144 },
    ...overrides,
  }
}

function withRates(
  speak: number | null,
  silence: number | null,
  overrides: Partial<RoutingArmLanguageReport> = {},
): RoutingArmLanguageReport {
  const base = arm(overrides)
  return {
    ...base,
    classes: {
      speak: { ...base.classes.speak, rate: speak },
      silence: { ...base.classes.silence, rate: silence },
      mixed: base.classes.mixed,
    },
  }
}

describe('HOLDOUT_TARGETS', () => {
  it('uses the pre-registered floors and recorded incumbent readings', () => {
    expect(HOLDOUT_TARGETS.en.speakFloor).toBe(0.826)
    expect(HOLDOUT_TARGETS.fr.speakFloor).toBe(0.768)
    expect(HOLDOUT_TARGETS.en.silenceFloor).toBe(0.75)
    expect(HOLDOUT_TARGETS.fr.silenceFloor).toBe(0.75)
    expect(HOLDOUT_TARGETS.en.incumbentSpeakRate).toBeCloseTo(0.765, 3)
    expect(HOLDOUT_TARGETS.fr.incumbentSpeakRate).toBeCloseTo(0.647, 3)
    expect(HOLDOUT_TARGETS.en.incumbentSilenceRate).toBeCloseTo(0.667, 3)
    expect(HOLDOUT_TARGETS.fr.incumbentSilenceRate).toBeCloseTo(0.667, 3)
  })
})

describe('armVerdict', () => {
  it('passes every check when the arm clears each floor', () => {
    const verdict = armVerdict(arm(), targets)
    expect(verdict.adoptable).toBe(true)
    expect(verdict.reasons).toEqual([])
    expect(verdict.checks).toEqual([
      { id: 'complete', ok: true, actual: 144, required: 144 },
      { id: 'speak', ok: true, actual: 90 / 102, required: 0.826 },
      { id: 'silence', ok: true, actual: 30 / 36, required: 0.75 },
      { id: 'incumbent_speak', ok: true, actual: 90 / 102, required: 13 / 17 },
      { id: 'incumbent_silence', ok: true, actual: 30 / 36, required: 8 / 12 },
    ])
    expect(verdict.costPerDecision).toBeCloseTo(0.0001, 6)
    expect(verdict.p95Ms).toBe(400)
    expect(verdict.fallbackRate).toBeCloseTo(2 / 144, 6)
  })

  it('treats a reading exactly at the floor as passing', () => {
    const verdict = armVerdict(withRates(0.826, 0.75), targets)
    expect(verdict.adoptable).toBe(true)
  })

  it('fails the speak floor while still clearing the incumbent', () => {
    const verdict = armVerdict(withRates(0.8, 0.9), targets)
    expect(verdict.adoptable).toBe(false)
    expect(verdict.checks[1]).toEqual({
      id: 'speak',
      ok: false,
      actual: 0.8,
      required: 0.826,
    })
    expect(verdict.checks[3]).toMatchObject({ id: 'incumbent_speak', ok: true })
    expect(verdict.reasons).toEqual(['speak rate 0.800 is below 0.826'])
  })

  it('reports the incumbent floor when the target floor passed', () => {
    // Both real floors sit above the incumbent, so this branch needs a target
    // whose floor is lower than its incumbent reading.
    const verdict = armVerdict(withRates(0.83, 0.9), {
      ...targets,
      speakFloor: 0.7,
      incumbentSpeakRate: 0.9,
    })
    expect(verdict.adoptable).toBe(false)
    expect(verdict.checks[3]).toMatchObject({ id: 'incumbent_speak', ok: false })
    expect(verdict.reasons).toEqual(['speak rate 0.830 is below the incumbent 0.900'])
  })

  it('fails the silence floor and reports it once', () => {
    const verdict = armVerdict(withRates(0.9, 0.6), targets)
    expect(verdict.adoptable).toBe(false)
    expect(verdict.reasons).toEqual(['silence rate 0.600 is below 0.750'])
  })

  it('reports the incumbent silence floor when the target floor passed', () => {
    const verdict = armVerdict(withRates(0.9, 0.9), {
      ...targets,
      silenceFloor: 0.5,
      incumbentSilenceRate: 0.95,
    })
    expect(verdict.adoptable).toBe(false)
    expect(verdict.reasons).toEqual(['silence rate 0.900 is below the incumbent 0.950'])
  })

  it('never adopts an arm with a failed call', () => {
    const verdict = armVerdict(arm({ incomplete: 1, completed: 143, timeouts: 1 }), targets)
    expect(verdict.adoptable).toBe(false)
    expect(verdict.checks[0]).toEqual({ id: 'complete', ok: false, actual: 143, required: 144 })
    expect(verdict.reasons[0]).toBe(
      "1 infrastructure-incomplete decisions; a failed call is not a 'no'",
    )
  })

  it('treats a missing speak rate as unreadable, not as zero', () => {
    const verdict = armVerdict(withRates(null, 0.9), targets)
    expect(verdict.adoptable).toBe(false)
    expect(verdict.speakRate).toBeNull()
    expect(verdict.reasons).toEqual(['no completed speak decision, so its rate cannot be read'])
  })

  it('treats a missing silence rate as unreadable, not as zero', () => {
    const verdict = armVerdict(withRates(0.9, null), targets)
    expect(verdict.adoptable).toBe(false)
    expect(verdict.silenceRate).toBeNull()
    expect(verdict.reasons).toEqual(['no completed silence decision, so its rate cannot be read'])
  })

  it('reports both unreadable rates in metric order', () => {
    const verdict = armVerdict(withRates(null, null), targets)
    expect(verdict.reasons).toEqual([
      'no completed speak decision, so its rate cannot be read',
      'no completed silence decision, so its rate cannot be read',
    ])
  })

  it('leaves cost per decision null when no cost was recorded', () => {
    const verdict = armVerdict(
      arm({ usage: { inputTokens: null, outputTokens: null, costUsd: null } }),
      targets,
    )
    expect(verdict.costPerDecision).toBeNull()
  })

  it('leaves cost per decision null when nothing completed', () => {
    const verdict = armVerdict(
      arm({
        completed: 0,
        incomplete: 144,
        usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.02 },
      }),
      targets,
    )
    expect(verdict.costPerDecision).toBeNull()
  })
})

describe('selectHoldoutArm', () => {
  /** Two identical, adoptable arms for one language. */
  const pair = (
    armId: string,
    lang: 'en' | 'fr',
    overrides: Partial<RoutingArmLanguageReport> = {},
  ) => armVerdict(arm({ armId, lang, ...overrides }), HOLDOUT_TARGETS[lang])

  it('adopts nothing when no arm clears both languages', () => {
    const selection = selectHoldoutArm([
      pair('jev-central', 'en'),
      pair('jev-central', 'fr', { incomplete: 2, completed: 142 }),
    ])
    expect(selection.adoptableArmIds).toEqual([])
    expect(selection.adoptedArmId).toBeNull()
    expect(selection.ranking).toEqual([])
    expect(selection.reason).toMatch(/no arm clears every floor/u)
  })

  it('excludes an arm that clears one language only', () => {
    const selection = selectHoldoutArm([
      pair('jev-persona', 'en'),
      pair('jev-persona', 'fr', {
        classes: { ...arm().classes, silence: { ...arm().classes.silence, rate: 0.5 } },
      }),
      pair('jev-central', 'en'),
      pair('jev-central', 'fr'),
    ])
    expect(selection.adoptableArmIds).toEqual(['jev-central'])
    expect(selection.adoptedArmId).toBe('jev-central')
    expect(selection.ranking.map((entry) => entry.armId)).toEqual(['jev-central'])
  })

  it('ranks by the worse language speak rate first', () => {
    const selection = selectHoldoutArm([
      pair('jev-central', 'en', {
        classes: { ...arm().classes, speak: { ...arm().classes.speak, rate: 0.84 } },
      }),
      pair('jev-central', 'fr', {
        classes: { ...arm().classes, speak: { ...arm().classes.speak, rate: 0.95 } },
      }),
      pair('jev-persona', 'en', {
        classes: { ...arm().classes, speak: { ...arm().classes.speak, rate: 0.9 } },
      }),
      pair('jev-persona', 'fr', {
        classes: { ...arm().classes, speak: { ...arm().classes.speak, rate: 0.87 } },
      }),
    ])
    expect(selection.ranking.map((entry) => entry.armId)).toEqual(['jev-persona', 'jev-central'])
    expect(selection.ranking[0]).toMatchObject({
      worstSpeakRate: 0.87,
      worstSilenceRate: 30 / 36,
      costPerDecision: 0.0144 / 144,
      worstP95Ms: 400,
      worstFallbackRate: 2 / 144,
    })
    expect(selection.adoptedArmId).toBe('jev-persona')
  })

  it('ranks by the worse language silence rate when speak ties', () => {
    const selection = selectHoldoutArm([
      pair('jev-central', 'en', {
        classes: { ...arm().classes, silence: { ...arm().classes.silence, rate: 0.84 } },
      }),
      pair('jev-central', 'fr', {
        classes: { ...arm().classes, silence: { ...arm().classes.silence, rate: 0.95 } },
      }),
      pair('jev-persona', 'en', {
        classes: { ...arm().classes, silence: { ...arm().classes.silence, rate: 0.9 } },
      }),
      pair('jev-persona', 'fr', {
        classes: { ...arm().classes, silence: { ...arm().classes.silence, rate: 0.87 } },
      }),
    ])
    expect(selection.ranking.map((entry) => entry.armId)).toEqual(['jev-persona', 'jev-central'])
    expect(selection.adoptedArmId).toBe('jev-persona')
  })

  it('ranks by cost per completed decision when both rates tie', () => {
    const selection = selectHoldoutArm([
      pair('jev-central', 'en', {
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0002 },
      }),
      pair('jev-central', 'fr', {
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0002 },
      }),
      pair('jev-persona', 'en', {
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0001 },
      }),
      pair('jev-persona', 'fr', {
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0001 },
      }),
    ])
    expect(selection.ranking.map((entry) => entry.armId)).toEqual(['jev-persona', 'jev-central'])
    expect(selection.ranking[0]?.costPerDecision).toBeCloseTo(0.0001 / 144, 9)
    expect(selection.adoptedArmId).toBe('jev-persona')
  })

  it('ranks by p95 when rates and cost tie', () => {
    const slow = { count: 144, min: 1, p50: 2, p95: 500, p99: 600, max: 700 }
    const fast = { count: 144, min: 1, p50: 2, p95: 400, p99: 500, max: 600 }
    const selection = selectHoldoutArm([
      pair('jev-central', 'en', { latencyMs: slow }),
      pair('jev-central', 'fr', { latencyMs: fast }),
      pair('jev-persona', 'en', { latencyMs: fast }),
      pair('jev-persona', 'fr', { latencyMs: { ...fast, p95: 350 } }),
    ])
    expect(selection.adoptedArmId).toBe('jev-persona')
    expect(selection.ranking.map((entry) => [entry.armId, entry.worstP95Ms])).toEqual([
      ['jev-persona', 400],
      ['jev-central', 500],
    ])
  })

  it('ranks by fallback rate when rates, cost and p95 tie', () => {
    const selection = selectHoldoutArm([
      pair('jev-central', 'en', { fallbackRate: 0.05 }),
      pair('jev-central', 'fr', { fallbackRate: 0.3 }),
      pair('jev-persona', 'en', { fallbackRate: 0.1 }),
      pair('jev-persona', 'fr', { fallbackRate: 0.2 }),
    ])
    expect(selection.adoptedArmId).toBe('jev-persona')
    expect(selection.ranking.map((entry) => [entry.armId, entry.worstFallbackRate])).toEqual([
      ['jev-persona', 0.2],
      ['jev-central', 0.3],
    ])
  })

  it('breaks a full tie by arm id and states the order it used', () => {
    const selection = selectHoldoutArm([
      pair('jev-persona', 'en'),
      pair('jev-persona', 'fr'),
      pair('jev-central', 'en'),
      pair('jev-central', 'fr'),
    ])
    expect(selection.ranking.map((entry) => entry.armId)).toEqual(['jev-central', 'jev-persona'])
    expect(selection.adoptedArmId).toBe('jev-central')
    expect(selection.reason).toBe(
      'adopted jev-central by the pre-registered order: worst speak rate, worst silence rate, cost per decision, worst p95, worst fallback rate',
    )
  })

  it('refuses to adopt when a p95 reading is missing', () => {
    const selection = selectHoldoutArm([
      pair('jev-central', 'en', { latencyMs: null }),
      pair('jev-central', 'fr', { latencyMs: null }),
    ])
    expect(selection.adoptableArmIds).toEqual(['jev-central'])
    expect(selection.adoptedArmId).toBeNull()
    expect(selection.ranking).toEqual([])
    expect(selection.reason).toMatch(/no readable ranking key/u)
  })

  it('refuses to adopt when a cost reading is missing', () => {
    const selection = selectHoldoutArm([
      pair('jev-central', 'en', {
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
      }),
      pair('jev-central', 'fr'),
    ])
    expect(selection.adoptedArmId).toBeNull()
    expect(selection.reason).toMatch(/no readable ranking key/u)
  })

  it('refuses to adopt when a fallback reading is missing', () => {
    const selection = selectHoldoutArm([
      pair('jev-central', 'en', { fallbackRate: null }),
      pair('jev-central', 'fr'),
    ])
    expect(selection.adoptedArmId).toBeNull()
    expect(selection.reason).toMatch(/no readable ranking key/u)
  })
})
