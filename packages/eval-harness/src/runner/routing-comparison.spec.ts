import { parseRoutingContext } from '@rp/routing-policy'
import { describe, expect, it } from 'vitest'
import type { RoutingArmLanguageReport, RoutingMatrixReport } from './routing-matrix.js'
import {
  computeRoutingArmVerdicts,
  runRoutingComparison,
  type RoutingComparisonTask,
} from './routing-comparison.js'
import { runDeterministicRoutingReplay } from './routing.js'

const context = parseRoutingContext({
  decisionId: 'task-1',
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

const label = {
  intent: 'handoff',
  acceptablePersonaIds: ['peer'],
  allowUserYield: false,
  labelSource: 'agent' as const,
}

const tasks: RoutingComparisonTask[] = [{ taskId: 'task-1', lang: 'en', context, label }]

function armReport(
  armId: string,
  lang: 'en' | 'fr',
  rate: number,
  incomplete = 0,
): RoutingArmLanguageReport {
  return {
    armId,
    lang,
    n: 30,
    completed: 30 - incomplete,
    incomplete,
    acceptable: Math.round(rate * (30 - incomplete)),
    acceptableOutcomeRate: rate,
    falseSpeak: 0,
    falseSpeakRate: 0,
    falseYield: 0,
    falseYieldRate: 0,
    timeoutFallbacks: 0,
    unsettledFallbacks: 0,
    timeoutFallbackRate: 0,
    unsettledFallbackRate: 0,
    fallbackRate: 0,
    latencyMs: null,
    usage: { inputTokens: null, outputTokens: null, costUsd: null },
  }
}

function matrix(arms: RoutingArmLanguageReport[]): RoutingMatrixReport {
  return { schemaVersion: 1, arms }
}

describe('runRoutingComparison', () => {
  it('runs every arm on every task and builds a matrix and exact artifacts', async () => {
    const run = await runRoutingComparison(tasks, [
      {
        armId: 'det',
        arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
        async run(taskContext) {
          return runDeterministicRoutingReplay(taskContext, 'central_selection', 1)
        },
      },
      {
        armId: 'det2',
        arm: { topology: 'persona_requests', judgmentSource: 'deterministic' },
        async run(taskContext) {
          return runDeterministicRoutingReplay(taskContext, 'persona_requests', 1)
        },
      },
    ])
    expect(run.entries).toHaveLength(2)
    expect(run.artifactsByArm.det).toHaveLength(1)
    expect(run.artifactsByArm.det2).toHaveLength(1)
    expect(run.matrix.arms).toHaveLength(2)
    expect(run.matrix.arms[0]?.acceptableOutcomeRate).toBe(1)
  })

  it('rejects duplicate arm ids', async () => {
    const arm = {
      armId: 'duplicate',
      arm: { topology: 'central_selection' as const, judgmentSource: 'deterministic' as const },
      async run() {
        return runDeterministicRoutingReplay(context, 'central_selection', 1)
      },
    }
    await expect(runRoutingComparison(tasks, [arm, arm])).rejects.toThrow(/unique/i)
  })
})

describe('computeRoutingArmVerdicts', () => {
  it('marks a candidate per language when the MDE is met', () => {
    const verdicts = computeRoutingArmVerdicts(
      matrix([
        armReport('det', 'en', 0.5),
        armReport('jev', 'en', 0.8),
        armReport('det', 'fr', 0.5),
        armReport('jev', 'fr', 0.6),
      ]),
      'det',
      0.2,
    )
    expect(verdicts).toEqual([
      expect.objectContaining({ armId: 'det', lang: 'en', verdict: 'baseline' }),
      expect.objectContaining({
        armId: 'det',
        lang: 'fr',
        verdict: 'baseline',
      }),
      expect.objectContaining({
        armId: 'jev',
        lang: 'en',
        verdict: 'target_met',
        delta: expect.closeTo(0.3, 10),
      }),
      expect.objectContaining({ armId: 'jev', lang: 'fr', verdict: 'target_missed' }),
    ])
  })

  it('never passes an arm with incomplete trials', () => {
    const verdicts = computeRoutingArmVerdicts(
      matrix([armReport('det', 'en', 0.5), armReport('jev', 'en', 0.9, 1)]),
      'det',
      0.2,
    )
    expect(verdicts.find((entry) => entry.armId === 'jev')).toMatchObject({
      verdict: 'incomplete',
      incomplete: 1,
      delta: null,
    })
  })

  it('requires the baseline and every language', () => {
    expect(() =>
      computeRoutingArmVerdicts(matrix([armReport('jev', 'en', 0.9)]), 'det', 0.2),
    ).toThrow(/baseline arm/i)
    expect(() =>
      computeRoutingArmVerdicts(
        matrix([armReport('det', 'en', 0.5), armReport('jev', 'fr', 0.9)]),
        'det',
        0.2,
      ),
    ).toThrow(/missing language/i)
  })

  it('rejects a non-positive MDE', () => {
    expect(() => computeRoutingArmVerdicts(matrix([]), 'det', 0)).toThrow(/positive/i)
  })
})
