import { parseRoutingContext } from '@rp/routing-policy'
import { describe, expect, it } from 'vitest'
import type { RoutingCentralObservation } from '../jev/routing.js'
import type { JevBatchSuccess } from '../jev/types.js'
import { buildRoutingMatrix } from './routing-matrix.js'
import {
  routingArtifact,
  runDeterministicRoutingReplay,
  type RoutingReplaySuccess,
} from './routing.js'

const context = parseRoutingContext({
  decisionId: 'decision-1',
  turnId: 'turn-1',
  lang: 'en',
  coveredObjectiveIds: [],
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
    judgment: { anyoneWarranted: 0.9, selectedPersonaId: 'peer' },
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

  it('counts timeout and unsettled fallbacks', async () => {
    const timeout = await (async () => {
      const { runJevRoutingReplay } = await import('./routing.js')
      return runJevRoutingReplay(
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
    })()
    if (!timeout.ok) throw new Error('expected timeout fallback')
    const report = buildRoutingMatrix([
      { armId: 'jev', lang: 'en', artifact: artifactFor(timeout, 'jev'), label: label('peer') },
    ])
    expect(report.arms[0]).toMatchObject({
      timeoutFallbacks: 1,
      timeoutFallbackRate: 1,
      fallbackRate: 1,
      unsettledFallbacks: 0,
    })
  })

  it('returns null rates for an empty bucket', () => {
    expect(buildRoutingMatrix([])).toEqual({ schemaVersion: 1, arms: [] })
  })
})
