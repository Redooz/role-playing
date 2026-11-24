import { parseRoutingContext } from '@rp/routing-policy'
import { describe, expect, it } from 'vitest'
import type { RoutingCentralObservation } from '../jev/routing.js'
import type { JevBatchSuccess } from '../jev/types.js'
import { buildRoutingMatrix, type RoutingMatrixEntry } from './routing-matrix.js'
import {
  routingArtifact,
  runDeterministicRoutingReplay,
  runJevRoutingReplay,
  type RoutingDecisionArtifact,
  type RoutingReplaySuccess,
} from './routing.js'

const context = parseRoutingContext({
  decisionId: 'decision-1',
  turnId: 'turn-1',
  lang: 'en',
  coveredObjectiveIds: [],
  owners: [
    {
      topic: 'the handoff',
      keywords: ['handoff'],
      personaIds: ['peer'],
      source: 'objective',
      objectiveId: 'handoff',
    },
  ],
  personas: [
    {
      id: 'manager',
      displayName: 'Katherine Brooks',
      aliases: ['Katherine'],
      role: 'manager',
      objectives: [{ id: 'deadline', description: 'Agree a deadline.', keywords: ['deadline'] }],
    },
    {
      id: 'peer',
      displayName: 'Sam Carter',
      aliases: ['Sam'],
      role: 'peer colleague',
      objectives: [{ id: 'handoff', description: 'Confirm handoff.', keywords: ['handoff'] }],
    },
    {
      id: 'client',
      displayName: 'Julian Moore',
      aliases: ['Julian'],
      role: 'external client',
      objectives: [{ id: 'contract', description: 'Resolve renewal.', keywords: ['renewal'] }],
    },
  ],
  transcript: [
    { speaker: { kind: 'persona', personaId: 'manager' }, text: 'We need a date.' },
    { speaker: { kind: 'user' }, text: 'Sam, can you confirm the handoff?' },
  ],
})

const label = (personaId: string) => ({
  intent: 'test',
  acceptablePersonaIds: [personaId],
  allowUserYield: false,
  labelSource: 'agent' as const,
})

function artifactFor(result: RoutingReplaySuccess, armId: string, taskId = 'decision-1') {
  return routingArtifact(context, result, {
    trialId: `0:en:${taskId}`,
    taskId,
    arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
  })
}

const speak = runDeterministicRoutingReplay(context, 'central_selection', 1)
const noContribution = runDeterministicRoutingReplay(
  parseRoutingContext({
    ...context,
    transcript: [{ speaker: { kind: 'user' }, text: 'Thanks, noted.' }],
  }),
  'central_selection',
  1,
)

function successWithUsage(usage: {
  input_tokens: number
  output_tokens: number
  cost?: number
}): JevBatchSuccess {
  const response = { model: 'typesafe/jev-1.14-20261014', answers: {}, usage }
  return {
    ok: true,
    questionIds: ['a', 'b'],
    request: { model: 'typesafe/jev-1.14', state: {}, questions: {} },
    response,
    raw: response,
    answers: {},
    distributions: {},
    usage,
    servedModel: response.model,
    cache: { key: 'a'.repeat(64), hit: false, stored: false },
  }
}

function centralWithUsage(observation: JevBatchSuccess): RoutingCentralObservation {
  return {
    judgment: {
      move: { closingMove: 0.1, selfAnswer: 0.1, thinkingAloud: 0.1, sideComment: 0.1 },
      selectedPersonaId: 'peer',
    },
    exact: observation,
  }
}

describe('buildRoutingMatrix', () => {
  it('reports acceptable, false-speak, false-yield and incomplete separately', () => {
    const report = buildRoutingMatrix([
      { armId: 'det', lang: 'en', artifact: artifactFor(speak, 'det', 'ok'), label: label('peer') },
      {
        armId: 'det',
        lang: 'en',
        artifact: artifactFor(speak, 'det', 'wrong'),
        label: label('manager'),
      },
      {
        armId: 'det',
        lang: 'en',
        artifact: artifactFor(noContribution, 'det', 'yield-wrong'),
        label: label('peer'),
      },
      {
        armId: 'det',
        lang: 'en',
        artifact: routingArtifact(
          context,
          {
            ok: false,
            kind: 'infrastructure_incomplete',
            error: 'down',
            questionIds: [],
            policyLatencyMs: 12,
          },
          {
            trialId: '0:en:bad',
            taskId: 'bad',
            arm: { topology: 'central_selection', judgmentSource: 'jev' },
          },
        ),
        label: label('peer'),
      },
    ])
    expect(report.arms).toHaveLength(1)
    const arm = report.arms[0]!
    expect(arm).toMatchObject({
      armId: 'det',
      lang: 'en',
      n: 4,
      completed: 3,
      incomplete: 1,
      acceptable: 1,
      acceptableOutcomeRate: 1 / 3,
      falseSpeak: 1,
      falseSpeakRate: 1 / 3,
      falseYield: 1,
      falseYieldRate: 1 / 3,
    })
  })

  it('separates arms and languages and sorts stably', () => {
    const report = buildRoutingMatrix([
      { armId: 'z', lang: 'fr', artifact: artifactFor(speak, 'z'), label: label('peer') },
      { armId: 'a', lang: 'fr', artifact: artifactFor(speak, 'a'), label: label('peer') },
      { armId: 'a', lang: 'en', artifact: artifactFor(speak, 'a'), label: label('peer') },
    ])
    expect(report.arms.map((arm) => `${arm.armId}:${arm.lang}`)).toEqual(['a:en', 'a:fr', 'z:fr'])
  })

  it('reports latency percentiles over every recorded decision', () => {
    const report = buildRoutingMatrix(
      [10, 20, 30].map((latencyMs, index) => ({
        armId: 'lat',
        lang: 'en' as const,
        artifact: artifactFor(
          {
            ...speak,
            policyLatencyMs: latencyMs,
          },
          'lat',
          `lat-${index}`,
        ),
        label: label('peer'),
      })),
    )
    expect(report.arms[0]?.latencyMs).toMatchObject({
      count: 3,
      min: 10,
      p50: 20,
      p95: 29,
      p99: 29.8,
      max: 30,
    })
  })

  it('keeps unknown usage as null, never zero', () => {
    const report = buildRoutingMatrix([
      { armId: 'det', lang: 'en', artifact: artifactFor(speak, 'det'), label: label('peer') },
    ])
    expect(report.arms[0]?.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    })
  })

  it('does not invent a cost when a usage field is missing', () => {
    const missingTokens = successWithUsage({
      input_tokens: undefined as never,
      output_tokens: 2,
      cost: 0.001,
    })
    const result: RoutingReplaySuccess = {
      ...speak,
      observation: { kind: 'jev', central: centralWithUsage(missingTokens) },
    }
    const report = buildRoutingMatrix([
      { armId: 'jev', lang: 'en', artifact: artifactFor(result, 'jev'), label: label('peer') },
    ])
    expect(report.arms[0]?.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    })
  })

  it('sums persona-arm usage without requiring a central batch', () => {
    const result: RoutingReplaySuccess = {
      ...speak,
      observation: {
        kind: 'jev',
        personas: {
          manager: {
            judgments: {
              closingMove: 0.1,
              selfAnswer: 0.1,
              thinkingAloud: 0.1,
              sideComment: 0.1,
              directlyAddressed: 0,
            },
            exact: successWithUsage({ input_tokens: 4, output_tokens: 1, cost: 0.0002 }),
          },
          peer: {
            judgments: {
              closingMove: 0.1,
              selfAnswer: 0.1,
              thinkingAloud: 0.1,
              sideComment: 0.1,
              directlyAddressed: 1,
            },
            exact: successWithUsage({ input_tokens: 6, output_tokens: 2, cost: 0.0003 }),
          },
        },
      },
    }
    const report = buildRoutingMatrix([
      { armId: 'jev', lang: 'en', artifact: artifactFor(result, 'jev'), label: label('peer') },
    ])
    expect(report.arms[0]?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      costUsd: 0.0005,
    })
  })

  it('sums known Jev usage', () => {
    const result: RoutingReplaySuccess = {
      ...speak,
      policyLatencyMs: 15,
      observation: {
        kind: 'jev',
        central: centralWithUsage(
          successWithUsage({ input_tokens: 10, output_tokens: 2, cost: 0.001 }),
        ),
      },
    }
    const report = buildRoutingMatrix([
      { armId: 'jev', lang: 'en', artifact: artifactFor(result, 'jev'), label: label('peer') },
    ])
    expect(report.arms[0]?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.001,
    })
  })

  it('treats a timeout as incomplete, never as an acceptable yield', async () => {
    const timeout = await runJevRoutingReplay(
      context,
      'persona_requests',
      {
        async judgeCentral() {
          throw new Error('unexpected')
        },
        async judgePersona() {
          await new Promise(() => {})
          throw new Error('unreachable')
        },
      },
      { seed: 1, deadlineMs: 5 },
    )
    expect(timeout.ok).toBe(false)
    const report = buildRoutingMatrix([
      {
        armId: 'jev',
        lang: 'en',
        artifact: routingArtifact(context, timeout, {
          trialId: '0:en:timeout',
          taskId: 'timeout',
          arm: { topology: 'persona_requests', judgmentSource: 'jev' },
        }),
        label: { ...label('peer'), allowUserYield: true },
      },
    ])
    expect(report.arms[0]).toMatchObject({
      n: 1,
      completed: 0,
      incomplete: 1,
      acceptable: 0,
      acceptableOutcomeRate: null,
      falseYield: 0,
      timeoutFallbacks: 0,
      timeoutFallbackRate: 0,
      unsettledFallbackRate: 0,
      fallbackRate: 0,
    })
  })

  it('reports unsettled fallbacks separately', async () => {
    const unsettled = await runJevRoutingReplay(
      context,
      'persona_requests',
      {
        async judgeCentral() {
          throw new Error('unexpected')
        },
        async judgePersona(_context, persona) {
          return {
            ok: true as const,
            observation: {
              judgments:
                persona.id === 'client'
                  ? {
                      closingMove: 0.5,
                      selfAnswer: 0.1,
                      thinkingAloud: 0.1,
                      sideComment: 0.1,
                      directlyAddressed: 0,
                    }
                  : {
                      closingMove: 0.1,
                      selfAnswer: 0.1,
                      thinkingAloud: 0.1,
                      sideComment: 0.1,
                      directlyAddressed: 0,
                    },
              exact: successWithUsage({ input_tokens: 1, output_tokens: 1, cost: 0.0001 }),
            },
          }
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    if (!unsettled.ok) throw new Error('expected unsettled fallback')
    const report = buildRoutingMatrix([
      { armId: 'jev', lang: 'en', artifact: artifactFor(unsettled, 'jev'), label: label('peer') },
    ])
    expect(report.arms[0]).toMatchObject({
      unsettledFallbacks: 1,
      unsettledFallbackRate: 1,
      timeoutFallbacks: 0,
      fallbackRate: 1,
    })
  })

  it('returns null rates for an empty bucket', () => {
    expect(buildRoutingMatrix([])).toEqual({ schemaVersion: 2, arms: [] })
  })
})

const acceptPeer = {
  intent: 'handoff',
  acceptablePersonaIds: ['peer'],
  allowUserYield: false,
  labelSource: 'agent' as const,
}
const acceptAnyYield = { ...acceptPeer, allowUserYield: true }

function failedArtifact(latencyMs: number): RoutingDecisionArtifact {
  return routingArtifact(
    context,
    {
      ok: false,
      kind: 'infrastructure_incomplete',
      error: 'down',
      questionIds: [],
      policyLatencyMs: latencyMs,
    },
    {
      trialId: '0:en:failed',
      taskId: 'failed',
      arm: { topology: 'central_selection', judgmentSource: 'jev' },
    },
  )
}

function speakWithFallback(
  cause: 'timeout' | 'unsettled',
  latencyMs: number,
): RoutingDecisionArtifact {
  return routingArtifact(
    context,
    {
      ...speak,
      policyLatencyMs: latencyMs,
      decision: { ...speak.decision, fallback: { kind: 'deterministic', cause } },
      observation: {
        kind: 'jev',
        central: centralWithUsage(
          successWithUsage({ input_tokens: 2, output_tokens: 1, cost: 0.0001 }),
        ),
      },
    },
    {
      trialId: `0:en:${cause}`,
      taskId: cause,
      arm: { topology: 'central_selection', judgmentSource: 'jev' },
    },
  )
}

const completeExact = () => successWithUsage({ input_tokens: 4, output_tokens: 1, cost: 0.0005 })

function personaUsageArtifact(exact: unknown): RoutingDecisionArtifact {
  const judgments = {
    closingMove: 0.1,
    selfAnswer: 0.1,
    thinkingAloud: 0.1,
    sideComment: 0.1,
    directlyAddressed: 0,
  }
  const result = {
    ...speak,
    observation: {
      kind: 'jev',
      personas: {
        manager: { judgments, exact },
        peer: { judgments, exact: completeExact() },
      },
    },
  } as unknown as RoutingReplaySuccess
  return artifactFor(result, 'usage', 'usage')
}

describe('buildRoutingMatrix per-arm record', () => {
  it('reports the complete arm record with every counter and rate', () => {
    const entries: RoutingMatrixEntry[] = [
      {
        armId: 'det',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'det', 'speak-ok-1'),
        label: acceptPeer,
      },
      {
        armId: 'det',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'det', 'speak-ok-2'),
        label: acceptPeer,
      },
      {
        armId: 'det',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'det', 'speak-wrong'),
        label: label('manager'),
      },
      {
        armId: 'det',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'det', 'speak-wrong-2'),
        label: label('manager'),
      },
      {
        armId: 'det',
        lang: 'en',
        artifact: artifactFor({ ...noContribution, policyLatencyMs: 25 }, 'det', 'yield-ok-1'),
        label: acceptAnyYield,
      },
      {
        armId: 'det',
        lang: 'en',
        artifact: artifactFor({ ...noContribution, policyLatencyMs: 25 }, 'det', 'yield-ok-2'),
        label: acceptAnyYield,
      },
      {
        armId: 'det',
        lang: 'en',
        artifact: artifactFor({ ...noContribution, policyLatencyMs: 25 }, 'det', 'yield-wrong'),
        label: acceptPeer,
      },
      { armId: 'det', lang: 'en', artifact: failedArtifact(25), label: acceptPeer },
    ]
    expect(buildRoutingMatrix(entries).arms[0]).toStrictEqual({
      armId: 'det',
      lang: 'en',
      n: 8,
      completed: 7,
      incomplete: 1,
      classes: {
        speak: {
          total: 6,
          completed: 5,
          incomplete: 1,
          appropriate: 2,
          rate: 2 / 5,
        },
        silence: {
          total: 0,
          completed: 0,
          incomplete: 0,
          appropriate: 0,
          rate: null,
        },
        mixed: { total: 2, completed: 2, incomplete: 0 },
      },
      acceptable: 4,
      acceptableOutcomeRate: 4 / 7,
      falseSpeak: 2,
      falseSpeakRate: 2 / 7,
      falseYield: 1,
      falseYieldRate: 1 / 7,
      timeoutFallbacks: 0,
      unsettledFallbacks: 0,
      timeoutFallbackRate: 0,
      unsettledFallbackRate: 0,
      fallbackRate: 0,
      latencyMs: { count: 8, min: 25, p50: 25, p95: 25, p99: 25, max: 25 },
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    })
  })

  it('does not depend on the input order of latencies', () => {
    const report = buildRoutingMatrix(
      [30, 10, 20].map((latencyMs, index) => ({
        armId: 'lat',
        lang: 'en' as const,
        artifact: artifactFor({ ...speak, policyLatencyMs: latencyMs }, 'lat', `lat-${index}`),
        label: acceptPeer,
      })),
    )
    expect(report.arms[0]?.latencyMs).toMatchObject({
      count: 3,
      min: 10,
      p50: 20,
      p95: 29,
      p99: 29.8,
      max: 30,
    })
  })

  it('separates unsettled fallbacks from ordinary decisions', () => {
    const report = buildRoutingMatrix([
      {
        armId: 'fb',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'fb', 'none'),
        label: acceptPeer,
      },
      {
        armId: 'fb',
        lang: 'en',
        artifact: speakWithFallback('unsettled', 25),
        label: acceptPeer,
      },
    ])
    expect(report.arms[0]).toStrictEqual({
      armId: 'fb',
      lang: 'en',
      n: 2,
      completed: 2,
      incomplete: 0,
      classes: {
        speak: { total: 2, completed: 2, incomplete: 0, appropriate: 2, rate: 1 },
        silence: { total: 0, completed: 0, incomplete: 0, appropriate: 0, rate: null },
        mixed: { total: 0, completed: 0, incomplete: 0 },
      },
      acceptable: 2,
      acceptableOutcomeRate: 1,
      falseSpeak: 0,
      falseSpeakRate: 0,
      falseYield: 0,
      falseYieldRate: 0,
      timeoutFallbacks: 0,
      unsettledFallbacks: 1,
      timeoutFallbackRate: 0,
      unsettledFallbackRate: 1 / 2,
      fallbackRate: 1 / 2,
      latencyMs: { count: 2, min: 25, p50: 25, p95: 25, p99: 25, max: 25 },
      usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.0001 },
    })
  })

  it('counts a failed call as incomplete, never as a resolved decision', () => {
    const report = buildRoutingMatrix([
      { armId: 'fb', lang: 'en', artifact: failedArtifact(25), label: acceptAnyYield },
      {
        armId: 'fb',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'fb', 'none'),
        label: acceptPeer,
      },
    ])
    expect(report.arms[0]).toStrictEqual({
      armId: 'fb',
      lang: 'en',
      n: 2,
      completed: 1,
      incomplete: 1,
      classes: {
        speak: { total: 1, completed: 1, incomplete: 0, appropriate: 1, rate: 1 },
        silence: { total: 0, completed: 0, incomplete: 0, appropriate: 0, rate: null },
        mixed: { total: 1, completed: 0, incomplete: 1 },
      },
      acceptable: 1,
      acceptableOutcomeRate: 1,
      falseSpeak: 0,
      falseSpeakRate: 0,
      falseYield: 0,
      falseYieldRate: 0,
      timeoutFallbacks: 0,
      unsettledFallbacks: 0,
      timeoutFallbackRate: 0,
      unsettledFallbackRate: 0,
      fallbackRate: 0,
      latencyMs: { count: 2, min: 25, p50: 25, p95: 25, p99: 25, max: 25 },
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    })
  })
})

describe('buildRoutingMatrix usage completeness', () => {
  it.each([
    ['a missing exact batch', undefined],
    ['a missing usage block', {}],
    [
      'a missing input token count',
      successWithUsage({ input_tokens: undefined as never, output_tokens: 1, cost: 0.0002 }),
    ],
    [
      'a missing output token count',
      successWithUsage({ input_tokens: 4, output_tokens: undefined as never, cost: 0.0002 }),
    ],
    ['a missing cost', successWithUsage({ input_tokens: 4, output_tokens: 1, cost: undefined })],
  ])('keeps every total null when one batch has %s', (_case, exact) => {
    const report = buildRoutingMatrix([
      {
        armId: 'usage',
        lang: 'en',
        artifact: personaUsageArtifact(exact),
        label: acceptPeer,
      },
    ])
    expect(report.arms[0]?.usage).toStrictEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    })
  })

  it('sums a central batch together with persona batches', () => {
    const result = {
      ...speak,
      observation: {
        kind: 'jev',
        central: centralWithUsage(
          successWithUsage({ input_tokens: 10, output_tokens: 2, cost: 0.001 }),
        ),
        personas: {
          peer: {
            judgments: {
              closingMove: 0.1,
              selfAnswer: 0.1,
              thinkingAloud: 0.1,
              sideComment: 0.1,
              directlyAddressed: 1,
            },
            exact: completeExact(),
          },
        },
      },
    } as RoutingReplaySuccess
    const report = buildRoutingMatrix([
      { armId: 'jev', lang: 'en', artifact: artifactFor(result, 'jev'), label: acceptPeer },
    ])
    expect(report.arms[0]?.usage).toStrictEqual({
      inputTokens: 14,
      outputTokens: 3,
      costUsd: 0.0015,
    })
  })
})

const requireSilence = {
  intent: 'no contribution',
  acceptablePersonaIds: [],
  allowUserYield: true,
  labelSource: 'agent' as const,
}

const acceptBoth = {
  intent: 'either',
  acceptablePersonaIds: ['peer'],
  allowUserYield: true,
  labelSource: 'agent' as const,
}

describe('buildRoutingMatrix label classes', () => {
  it('gives each class its own denominator and counts incomplete decisions separately', () => {
    const report = buildRoutingMatrix([
      {
        armId: 'classes',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'classes', 'speak-ok'),
        label: acceptPeer,
      },
      {
        armId: 'classes',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'classes', 'speak-wrong'),
        label: label('manager'),
      },
      {
        armId: 'classes',
        lang: 'en',
        artifact: failedArtifact(25),
        label: acceptPeer,
      },
      {
        armId: 'classes',
        lang: 'en',
        artifact: artifactFor({ ...noContribution, policyLatencyMs: 25 }, 'classes', 'silence-ok'),
        label: requireSilence,
      },
      {
        armId: 'classes',
        lang: 'en',
        artifact: artifactFor(
          { ...noContribution, policyLatencyMs: 25 },
          'classes',
          'silence-ok-2',
        ),
        label: requireSilence,
      },
      {
        armId: 'classes',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'classes', 'silence-wrong'),
        label: requireSilence,
      },
      {
        armId: 'classes',
        lang: 'en',
        artifact: failedArtifact(25),
        label: requireSilence,
      },
      {
        armId: 'classes',
        lang: 'en',
        artifact: artifactFor({ ...noContribution, policyLatencyMs: 25 }, 'classes', 'mixed-ok'),
        label: acceptBoth,
      },
      {
        armId: 'classes',
        lang: 'en',
        artifact: failedArtifact(25),
        label: acceptBoth,
      },
    ])

    const arm = report.arms[0]!
    expect(arm.classes).toStrictEqual({
      speak: { total: 3, completed: 2, incomplete: 1, appropriate: 1, rate: 1 / 2 },
      silence: { total: 4, completed: 3, incomplete: 1, appropriate: 2, rate: 2 / 3 },
      mixed: { total: 2, completed: 1, incomplete: 1 },
    })
    expect(arm).toMatchObject({
      n: 9,
      completed: 6,
      incomplete: 3,
      acceptable: 4,
      acceptableOutcomeRate: 4 / 6,
      falseSpeak: 2,
      falseSpeakRate: 2 / 6,
      falseYield: 0,
      falseYieldRate: 0,
    })
  })

  it('excludes a mixed label from both class rates and counts it', () => {
    const report = buildRoutingMatrix([
      {
        armId: 'mixed',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'mixed', 'mixed-label'),
        label: acceptBoth,
      },
      {
        armId: 'mixed',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'mixed', 'speak-label'),
        label: acceptPeer,
      },
    ])

    expect(report.arms[0]?.classes).toStrictEqual({
      speak: { total: 1, completed: 1, incomplete: 0, appropriate: 1, rate: 1 },
      silence: { total: 0, completed: 0, incomplete: 0, appropriate: 0, rate: null },
      mixed: { total: 1, completed: 1, incomplete: 0 },
    })
  })

  it('reports null for a class with no completed decision, never zero', () => {
    const report = buildRoutingMatrix([
      { armId: 'empty', lang: 'en', artifact: failedArtifact(25), label: acceptPeer },
    ])

    expect(report.arms[0]?.classes).toStrictEqual({
      speak: { total: 1, completed: 0, incomplete: 1, appropriate: 0, rate: null },
      silence: { total: 0, completed: 0, incomplete: 0, appropriate: 0, rate: null },
      mixed: { total: 0, completed: 0, incomplete: 0 },
    })
  })

  it('accepts a speak by either of two acceptable personas', () => {
    const report = buildRoutingMatrix([
      {
        armId: 'two',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'two', 'one'),
        label: { ...acceptPeer, acceptablePersonaIds: ['manager', 'peer'] },
      },
      {
        armId: 'two',
        lang: 'en',
        artifact: artifactFor({ ...speak, policyLatencyMs: 25 }, 'two', 'two'),
        label: { ...acceptPeer, acceptablePersonaIds: ['manager', 'peer'] },
      },
    ])

    expect(report.arms[0]?.classes.speak).toStrictEqual({
      total: 2,
      completed: 2,
      incomplete: 0,
      appropriate: 2,
      rate: 1,
    })
  })
})
