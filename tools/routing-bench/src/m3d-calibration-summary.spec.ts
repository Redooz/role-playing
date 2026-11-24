import { describe, expect, it } from 'vitest'
import type { RoutingArmLanguageReport, RoutingMatrixEntry } from '@rp/eval-harness'
import {
  calibrationSummary,
  declineTallies,
  referenceReadings,
  type ReferenceReadings,
} from './m3d-calibration-summary.js'

const reference: ReferenceReadings = {
  runId: 'm3d-cal-reference-en-r1',
  requiredSpeakerRate: 0.4,
  silenceAppropriateRate: 0,
  acceptableSpeakerRate: 0.3,
}

function arm(overrides: Partial<RoutingArmLanguageReport> = {}): RoutingArmLanguageReport {
  return {
    armId: 'jev-central',
    lang: 'en',
    n: 40,
    completed: 40,
    incomplete: 0,
    classes: {
      speak: { total: 28, completed: 28, incomplete: 0, appropriate: 20, rate: 20 / 28 },
      silence: { total: 10, completed: 10, incomplete: 0, appropriate: 8, rate: 0.8 },
      mixed: { total: 2, completed: 2, incomplete: 0 },
    },
    acceptable: 30,
    acceptableOutcomeRate: 0.75,
    falseSpeak: 4,
    falseSpeakRate: 0.1,
    falseYield: 6,
    falseYieldRate: 0.15,
    timeouts: 0,
    unsettledFallbacks: 1,
    timeoutRate: 0,
    unsettledFallbackRate: 0.025,
    fallbackRate: 0.025,
    latencyMs: null,
    usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 },
    ...overrides,
  }
}

function decisionEntry(
  armId: string,
  declines: readonly { personaId: string; reason: string }[],
): RoutingMatrixEntry {
  return {
    armId,
    lang: 'en',
    artifact: {
      schemaVersion: '1.0.0',
      kind: 'routing.decision',
      contentClass: 'restricted',
      trialId: 'trial',
      taskId: 'task',
      arm: { topology: 'central_selection', judgmentSource: 'jev' },
      contextHash: '0'.repeat(64),
      policyLatencyMs: 1,
      outcome: 'completed',
      observation: { kind: 'deterministic' },
      decision: {
        schemaVersion: '1.1.0',
        decisionId: 'decision-1',
        turnId: 'turn-1',
        lang: 'en',
        topology: 'central_selection',
        judgmentSource: 'jev',
        policyVersion: 'm3d-jev-central-v2',
        eligiblePersonaIds: ['manager', 'peer'],
        requests: [],
        declines: declines.map((decline) => ({ ...decline })),
        unsettledPersonas: [],
        moveJudgments: {
          scope: 'central',
          move: { closingMove: 0.1, selfAnswer: 0.1, thinkingAloud: 0.1, sideComment: 0.1 },
        },
        outcome: { kind: 'user_yield', reason: 'all_declined' },
        fallback: { kind: 'none' },
      },
    },
    label: {
      intent: 'post-demo-handover',
      acceptablePersonaIds: [],
      allowUserYield: true,
      labelSource: 'agent',
    },
  } as RoutingMatrixEntry
}

describe('referenceReadings', () => {
  it('reads the three class metrics from a finished run', () => {
    expect(
      referenceReadings('run', {
        'turn_taking.required_speaker_rate': 0.4,
        'turn_taking.silence_appropriate_rate': 0,
        'turn_taking.acceptable_speaker_rate': 0.3,
      }),
    ).toEqual({ ...reference, runId: 'run' })
  })

  it('rejects a missing or non-finite reading instead of using zero', () => {
    expect(() => referenceReadings('run', { 'turn_taking.required_speaker_rate': 0.4 })).toThrow(
      /silence_appropriate_rate/u,
    )
    expect(() =>
      referenceReadings('run', {
        'turn_taking.required_speaker_rate': Number.NaN,
        'turn_taking.silence_appropriate_rate': 0,
        'turn_taking.acceptable_speaker_rate': 0.3,
      }),
    ).toThrow(/required_speaker_rate/u)
    expect(() =>
      referenceReadings('run', {
        'turn_taking.required_speaker_rate': '0.4',
        'turn_taking.silence_appropriate_rate': 0,
        'turn_taking.acceptable_speaker_rate': 0.3,
      }),
    ).toThrow(/no finite "turn_taking.required_speaker_rate" reading/u)
    for (const missing of [null, 1, '0.4', []]) {
      expect(() => referenceReadings('run', missing)).toThrow(/no metrics record/u)
    }
  })
})

describe('declineTallies', () => {
  it('counts each decline reason per arm and sorts', () => {
    expect(
      declineTallies([
        decisionEntry('jev-persona', [
          { personaId: 'manager', reason: 'no_owner' },
          { personaId: 'peer', reason: 'not_owner' },
        ]),
        decisionEntry('jev-central', [
          { personaId: 'manager', reason: 'not_owner' },
          { personaId: 'peer', reason: 'not_owner' },
        ]),
      ]),
    ).toEqual([
      { armId: 'jev-central', lang: 'en', reason: 'not_owner', count: 2 },
      { armId: 'jev-persona', lang: 'en', reason: 'no_owner', count: 1 },
      { armId: 'jev-persona', lang: 'en', reason: 'not_owner', count: 1 },
    ])
  })
})

describe('calibrationSummary', () => {
  function matrix(arms: readonly RoutingArmLanguageReport[]) {
    return { schemaVersion: 3 as const, arms }
  }

  it('assembles the summary and marks complete runs', () => {
    const summary = calibrationSummary({
      lang: 'en',
      reference,
      matrix: matrix([arm()]),
      families: [],
      entries: [
        decisionEntry('jev-central', [
          { personaId: 'manager', reason: 'not_owner' },
          { personaId: 'peer', reason: 'not_owner' },
        ]),
      ],
      tasks: 10,
      contexts: 40,
      expectedContexts: 40,
    })
    expect(summary.schemaVersion).toBe('1.0.0')
    expect(summary.note).toMatch(/^Calibration only\./u)
    expect(summary).toMatchObject({
      suite: 'm3d-routing-calibration',
      lang: 'en',
      tasks: 10,
      contexts: 40,
      expectedContexts: 40,
      reference,
    })
    expect(summary.invariants).toEqual([
      {
        id: 'routing.contexts_complete',
        ok: true,
        detail: '40 contexts built against 40 expected',
      },
      {
        id: 'routing.decisions_complete',
        ok: true,
        detail: '0 infrastructure-incomplete decisions',
      },
    ])
    expect(summary.declineReasons).toEqual([
      { armId: 'jev-central', lang: 'en', reason: 'not_owner', count: 2 },
    ])
  })

  it('fails the completion invariant on an incomplete decision or a context mismatch', () => {
    const summary = calibrationSummary({
      lang: 'fr',
      reference,
      matrix: matrix([arm({ armId: 'jev-persona', incomplete: 1, completed: 39, n: 40 })]),
      families: [],
      entries: [
        decisionEntry('jev-persona', [
          { personaId: 'manager', reason: 'not_owner' },
          { personaId: 'peer', reason: 'not_owner' },
        ]),
      ],
      tasks: 9,
      contexts: 39,
      expectedContexts: 40,
    })
    expect(summary.invariants).toEqual([
      {
        id: 'routing.contexts_complete',
        ok: false,
        detail: '39 contexts built against 40 expected',
      },
      {
        id: 'routing.decisions_complete',
        ok: false,
        detail: '1 infrastructure-incomplete decisions',
      },
    ])
  })

  it('sums an incomplete count across arms instead of subtracting it', () => {
    const summary = calibrationSummary({
      lang: 'en',
      reference,
      matrix: matrix([
        arm({ armId: 'jev-central', incomplete: 1, completed: 39 }),
        arm({ armId: 'jev-persona', incomplete: 1, completed: 39 }),
      ]),
      families: [],
      entries: [
        decisionEntry('jev-central', [
          { personaId: 'manager', reason: 'not_owner' },
          { personaId: 'peer', reason: 'not_owner' },
        ]),
        decisionEntry('jev-persona', [
          { personaId: 'manager', reason: 'not_owner' },
          { personaId: 'peer', reason: 'not_owner' },
        ]),
      ],
      tasks: 10,
      contexts: 40,
      expectedContexts: 40,
    })
    expect(summary.invariants[1]).toEqual({
      id: 'routing.decisions_complete',
      ok: false,
      detail: '2 infrastructure-incomplete decisions',
    })
  })
})
