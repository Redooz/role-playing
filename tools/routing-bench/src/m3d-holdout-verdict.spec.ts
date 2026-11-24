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
    expect(verdict.checks.map((check) => [check.id, check.ok])).toEqual([
      ['complete', true],
      ['speak', true],
      ['silence', true],
      ['incumbent_speak', true],
      ['incumbent_silence', true],
    ])
    expect(verdict.costPerDecision).toBeCloseTo(0.0001, 6)
    expect(verdict.p95Ms).toBe(400)
    expect(verdict.fallbackRate).toBeCloseTo(2 / 144, 6)
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

  it('keeps the incumbent check even though the real floors dominate it', () => {
    // Both pre-registered speak floors sit above the recorded incumbent, so a
    // met floor implies a met incumbent. The check stays explicit so a future
    // floor change cannot silently drop it.
    const met = armVerdict(withRates(0.83, 0.9), targets)
    expect(met.adoptable).toBe(true)
    expect(met.checks[3]).toMatchObject({ id: 'incumbent_speak', ok: true })

    const strict = armVerdict(withRates(0.83, 0.9), {
      ...targets,
      speakFloor: 0.7,
      incumbentSpeakRate: 0.9,
    })
    expect(strict.adoptable).toBe(false)
    expect(strict.reasons).toEqual(['speak rate 0.830 is below the incumbent 0.900'])
  })

  it('fails the silence floor and reports it once', () => {
    const verdict = armVerdict(withRates(0.9, 0.6), targets)
    expect(verdict.adoptable).toBe(false)
    expect(verdict.reasons).toEqual(['silence rate 0.600 is below 0.750'])
  })

  it('keeps the incumbent silence check reachable', () => {
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

  it('treats a missing rate as unreadable, not as zero', () => {
    const verdict = armVerdict(withRates(null, 0.9), targets)
    expect(verdict.adoptable).toBe(false)
    expect(verdict.speakRate).toBeNull()
    expect(verdict.reasons).toEqual([
      'no completed speak decision, so the speak rate cannot be read',
    ])
  })

  it('leaves cost per decision null when no cost was recorded', () => {
    const verdict = armVerdict(
      arm({ usage: { inputTokens: null, outputTokens: null, costUsd: null } }),
      targets,
    )
    expect(verdict.costPerDecision).toBeNull()
  })
})

describe('selectHoldoutArm', () => {
  const en = (overrides: Partial<RoutingArmLanguageReport> = {}) =>
    armVerdict(arm({ lang: 'en', ...overrides }), HOLDOUT_TARGETS.en)
  const fr = (overrides: Partial<RoutingArmLanguageReport> = {}) =>
    armVerdict(arm({ lang: 'fr', ...overrides }), HOLDOUT_TARGETS.fr)

  it('adopts nothing when no arm clears both languages', () => {
    const selection = selectHoldoutArm([
      en({ armId: 'jev-central' }),
      fr({ armId: 'jev-central', incomplete: 2, completed: 142 }),
    ])
    expect(selection.adoptableArmIds).toEqual([])
    expect(selection.adoptedArmId).toBeNull()
    expect(selection.ranking).toEqual([])
    expect(selection.reason).toMatch(/no arm clears every floor/u)
  })

  it('excludes an arm that clears one language only', () => {
    const selection = selectHoldoutArm([
      en({ armId: 'jev-central' }),
      fr({ armId: 'jev-central' }),
      en({ armId: 'jev-persona' }),
      fr({
        armId: 'jev-persona',
        classes: { ...arm().classes, silence: { ...arm().classes.silence, rate: 0.5 } },
      }),
    ])
    expect(selection.adoptableArmIds).toEqual(['jev-central'])
    expect(selection.adoptedArmId).toBe('jev-central')
    expect(selection.ranking).toHaveLength(1)
  })

  it('ranks by the worse language on each rate, then cost, p95 and fallback rate', () => {
    const cheap = [
      en({ armId: 'jev-central', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } }),
      fr({
        armId: 'jev-central',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
        classes: { ...arm().classes, speak: { ...arm().classes.speak, rate: 0.9 } },
      }),
    ]
    const dear = [
      en({
        armId: 'jev-persona',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.02 },
        classes: { ...arm().classes, speak: { ...arm().classes.speak, rate: 0.95 } },
      }),
      fr({
        armId: 'jev-persona',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.02 },
        classes: { ...arm().classes, speak: { ...arm().classes.speak, rate: 0.88 } },
      }),
    ]
    const selection = selectHoldoutArm([...cheap, ...dear])
    // Persona has the better EN speak rate but the worse FR one; the minimum decides.
    expect(selection.ranking.map((entry) => entry.armId)).toEqual(['jev-central', 'jev-persona'])
    expect(selection.ranking[0]).toMatchObject({
      worstSpeakRate: 90 / 102,
      worstSilenceRate: 30 / 36,
      costPerDecision: 0.01 / 144,
      worstP95Ms: 400,
      worstFallbackRate: 2 / 144,
    })
    expect(selection.adoptedArmId).toBe('jev-central')
  })

  it('breaks a full tie by the cheaper arm and keeps the reason explicit', () => {
    const selection = selectHoldoutArm([
      en({ armId: 'jev-persona', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0002 } }),
      fr({ armId: 'jev-persona', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0002 } }),
      en({ armId: 'jev-central', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0001 } }),
      fr({ armId: 'jev-central', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0001 } }),
    ])
    expect(selection.ranking.map((entry) => entry.armId)).toEqual(['jev-central', 'jev-persona'])
    expect(selection.adoptedArmId).toBe('jev-central')
    expect(selection.reason).toBe(
      'adopted jev-central by the pre-registered order: worst speak rate, worst silence rate, cost per decision, worst p95, worst fallback rate',
    )
  })

  it('ranks by p95 when rates and cost tie', () => {
    const selection = selectHoldoutArm([
      en({
        armId: 'jev-persona',
        latencyMs: { count: 144, min: 1, p50: 2, p95: 500, p99: 9, max: 9 },
      }),
      fr({
        armId: 'jev-persona',
        latencyMs: { count: 144, min: 1, p50: 2, p95: 500, p99: 9, max: 9 },
      }),
      en({
        armId: 'jev-central',
        latencyMs: { count: 144, min: 1, p50: 2, p95: 300, p99: 9, max: 9 },
      }),
      fr({
        armId: 'jev-central',
        latencyMs: { count: 144, min: 1, p50: 2, p95: 300, p99: 9, max: 9 },
      }),
    ])
    expect(selection.adoptedArmId).toBe('jev-central')
  })

  it('ranks by fallback rate when rates, cost and p95 tie', () => {
    const selection = selectHoldoutArm([
      en({ armId: 'jev-persona', fallbackRate: 0.2 }),
      fr({ armId: 'jev-persona', fallbackRate: 0.2 }),
      en({ armId: 'jev-central', fallbackRate: 0.05 }),
      fr({ armId: 'jev-central', fallbackRate: 0.05 }),
    ])
    expect(selection.adoptedArmId).toBe('jev-central')
  })

  it('refuses to adopt an arm whose ranking key cannot be read', () => {
    const selection = selectHoldoutArm([
      en({ armId: 'jev-central', latencyMs: null }),
      fr({ armId: 'jev-central', latencyMs: null }),
    ])
    expect(selection.adoptableArmIds).toEqual(['jev-central'])
    expect(selection.adoptedArmId).toBeNull()
    expect(selection.reason).toMatch(/no readable ranking key/u)
  })
})
