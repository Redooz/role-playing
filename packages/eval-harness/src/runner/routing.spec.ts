import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRoutingContext } from '@rp/routing-policy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JevUnavailableError } from '../jev/errors.js'
import type { RoutingCentralObservation, RoutingPersonaObservation } from '../jev/routing.js'
import type { JevBatchSuccess } from '../jev/types.js'
import {
  DETERMINISTIC_POLICY_VERSION,
  JEV_CENTRAL_POLICY_VERSION,
  JEV_PERSONA_POLICY_VERSION,
  routingArtifact,
  routingDecisionArtifactSchema,
  runDeterministicRoutingReplay,
  runJevRoutingReplay,
  writeRoutingArtifacts,
} from './routing.js'

const owners = [
  {
    topic: 'the handoff',
    keywords: ['handoff'],
    personaIds: ['peer'],
    source: 'objective' as const,
    objectiveId: 'handoff',
  },
  {
    topic: 'the deadline',
    keywords: ['deadline'],
    personaIds: ['manager'],
    source: 'objective' as const,
    objectiveId: 'deadline',
  },
  {
    topic: 'the renewal',
    keywords: ['renewal'],
    personaIds: ['client'],
    source: 'objective' as const,
    objectiveId: 'contract',
  },
]

const context = parseRoutingContext({
  decisionId: 'decision-1',
  turnId: 'turn-1',
  lang: 'en',
  coveredObjectiveIds: [],
  owners: [...owners],
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

const pairContext = parseRoutingContext({
  decisionId: 'decision-pair',
  turnId: 'turn-2',
  lang: 'en',
  coveredObjectiveIds: [],
  owners: [
    {
      topic: 'the plan',
      keywords: ['plan'],
      personaIds: ['manager', 'peer'],
      source: 'fact',
      sourceFactIndex: 0,
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
  ],
  transcript: [{ speaker: { kind: 'user' }, text: 'Who owns the plan?' }],
})

const tieContext = parseRoutingContext({
  decisionId: 'decision-tie',
  turnId: 'turn-2',
  lang: 'en',
  coveredObjectiveIds: [],
  owners: [],
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
  ],
  transcript: [
    { speaker: { kind: 'user' }, text: 'Katherine and Sam, please confirm the deadline.' },
  ],
})

function success(answers: JevBatchSuccess['answers'], questionIds: string[]): JevBatchSuccess {
  const response = {
    model: 'typesafe/jev-1.14-20261014',
    answers,
    usage: { input_tokens: 10, output_tokens: 2 },
  }
  return {
    ok: true,
    questionIds,
    request: { model: 'typesafe/jev-1.14', state: {}, questions: {} },
    response,
    raw: response,
    answers,
    distributions: {},
    usage: response.usage,
    servedModel: response.model,
    cache: { key: 'a'.repeat(64), hit: false, stored: true },
  }
}

const quiet = {
  closingMove: 0.1,
  selfAnswer: 0.1,
  thinkingAloud: 0.1,
  sideComment: 0.1,
}

type MoveOverrides = Partial<typeof quiet>

function central(move: MoveOverrides = {}, selectedPersonaId?: string): RoutingCentralObservation {
  const answerSet = {
    closing_move: { type: 'noul' as const, noul: move.closingMove ?? 0.1 },
    self_answer: { type: 'noul' as const, noul: move.selfAnswer ?? 0.1 },
    thinking_aloud: { type: 'noul' as const, noul: move.thinkingAloud ?? 0.1 },
    side_comment: { type: 'noul' as const, noul: move.sideComment ?? 0.1 },
  }
  const questionIds = Object.keys(answerSet)
  const exact =
    selectedPersonaId === undefined
      ? success(answerSet, questionIds)
      : success(
          {
            ...answerSet,
            best_speaker: {
              type: 'choice',
              choice: selectedPersonaId,
              probabilities: { manager: 0.4, peer: 0.6 },
            },
          },
          [...questionIds, 'best_speaker'],
        )
  return {
    judgment: {
      move: {
        closingMove: move.closingMove ?? 0.1,
        selfAnswer: move.selfAnswer ?? 0.1,
        thinkingAloud: move.thinkingAloud ?? 0.1,
        sideComment: move.sideComment ?? 0.1,
      },
      ...(selectedPersonaId === undefined ? {} : { selectedPersonaId }),
    },
    exact,
  }
}

function personaObservation(
  overrides: Partial<RoutingPersonaObservation['judgments']> = {},
): RoutingPersonaObservation {
  const judgments = { ...quiet, directlyAddressed: 0, ...overrides }
  return {
    judgments,
    exact: success(
      {
        closing_move: { type: 'noul', noul: judgments.closingMove },
        self_answer: { type: 'noul', noul: judgments.selfAnswer },
        thinking_aloud: { type: 'noul', noul: judgments.thinkingAloud },
        side_comment: { type: 'noul', noul: judgments.sideComment },
        directly_addressed: { type: 'noul', noul: judgments.directlyAddressed },
      },
      ['closing_move', 'self_answer', 'thinking_aloud', 'side_comment', 'directly_addressed'],
    ),
  }
}

/** Freeze the monotonic clock so latency assertions are exact, not wall-clock flaky. */
function freezeClock(at = 1_000): void {
  vi.spyOn(performance, 'now').mockReturnValue(at)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runDeterministicRoutingReplay', () => {
  it('returns a speak decision and deterministic observation', () => {
    const result = runDeterministicRoutingReplay(context, 'central_selection', 1)
    expect(result.ok).toBe(true)
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.decision.policyVersion).toBe(DETERMINISTIC_POLICY_VERSION)
    expect(result.observation).toEqual({ kind: 'deterministic' })
  })

  it('returns an all-declined decision when no one contributes', () => {
    const noContribution = parseRoutingContext({
      ...context,
      owners: [],
      transcript: [{ speaker: { kind: 'user' }, text: 'Thanks, noted.' }],
    })
    const result = runDeterministicRoutingReplay(noContribution, 'persona_requests', 1)
    expect(result.decision.outcome).toEqual({ kind: 'user_yield', reason: 'all_declined' })
  })
})

describe('runJevRoutingReplay central', () => {
  it('speaks for the unique owner when every move answer is settled no', async () => {
    const judge = {
      async judgeCentral() {
        return { ok: true as const, observation: central() }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    const result = await runJevRoutingReplay(context, 'central_selection', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.decision.policyVersion).toBe(JEV_CENTRAL_POLICY_VERSION)
    expect(result.decision.moveJudgments).toEqual({ scope: 'central', move: quiet })
    expect(result.observation.kind).toBe('jev')
  })

  it('yields when the move is a settled self-directed one', async () => {
    const judge = {
      async judgeCentral() {
        return { ok: true as const, observation: central({ closingMove: 0.8 }) }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    const result = await runJevRoutingReplay(context, 'central_selection', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok && result.decision.outcome).toEqual({
      kind: 'user_yield',
      reason: 'all_declined',
    })
    expect(
      result.ok && result.decision.declines.every((d) => d.reason === 'self_directed_move'),
    ).toBe(true)
  })

  it('yields when no ownership claim matches the utterance', async () => {
    const noOwner = parseRoutingContext({
      ...context,
      transcript: [{ speaker: { kind: 'user' }, text: 'Thanks, noted.' }],
    })
    const judge = {
      async judgeCentral() {
        return { ok: true as const, observation: central() }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    const result = await runJevRoutingReplay(noOwner, 'central_selection', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok && result.decision.outcome).toEqual({
      kind: 'user_yield',
      reason: 'all_declined',
    })
  })

  it('uses the owner rule and records the unsettled fallback', async () => {
    const judge = {
      async judgeCentral() {
        return { ok: true as const, observation: central({ sideComment: 0.5 }) }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    const result = await runJevRoutingReplay(context, 'central_selection', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.decision.fallback).toEqual({ kind: 'deterministic', cause: 'unsettled' })
    expect(result.decision.judgmentSource).toBe('jev')
  })

  it('lets a pair Choice select one declared owner', async () => {
    const judge = {
      async judgeCentral() {
        return { ok: true as const, observation: central({}, 'manager') }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    const result = await runJevRoutingReplay(pairContext, 'central_selection', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok && result.decision.outcome).toMatchObject({
      kind: 'speak',
      personaId: 'manager',
    })
  })

  it('yields when an out-of-pair Choice reaches the runner', async () => {
    const judge = {
      async judgeCentral() {
        return { ok: true as const, observation: central({}, 'client') }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    const result = await runJevRoutingReplay(pairContext, 'central_selection', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok && result.decision.outcome).toEqual({
      kind: 'user_yield',
      reason: 'all_declined',
    })
  })

  it('rejects a non-positive deadline', async () => {
    const judge = {
      async judgeCentral() {
        return { ok: true as const, observation: central() }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    for (const deadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        runJevRoutingReplay(context, 'central_selection', judge, { seed: 1, deadlineMs }),
      ).rejects.toThrow(/positive finite/i)
    }
  })

  it('uses the shared Noul bounds at exactly 0.3 and 0.7', async () => {
    for (const [value, expectedKind] of [
      [0.3, 'speak'],
      [0.7, 'user_yield'],
    ] as const) {
      const judge = {
        async judgeCentral() {
          return { ok: true as const, observation: central({ closingMove: value }) }
        },
        async judgePersona() {
          throw new Error('unexpected')
        },
      }
      const result = await runJevRoutingReplay(context, 'central_selection', judge, {
        seed: 1,
        deadlineMs: 1000,
      })
      expect(result.ok && result.decision.outcome.kind).toBe(expectedKind)
    }
  })

  it('returns infrastructure-incomplete for a provider failure', async () => {
    const error = new JevUnavailableError('down', { reason: 'network' })
    const judge = {
      async judgeCentral() {
        return { ok: false as const, error, questionIds: ['a'] }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    const result = await runJevRoutingReplay(context, 'central_selection', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result).toMatchObject({ ok: false, kind: 'infrastructure_incomplete', error: 'down' })
  })
})

describe('runJevRoutingReplay persona requests', () => {
  it('derives requests from the move answers and ranks a declared pair', async () => {
    const judge = {
      async judgeCentral() {
        throw new Error('unexpected')
      },
      async judgePersona(_context: typeof pairContext, persona: { id: string }) {
        return {
          ok: true as const,
          observation: personaObservation({
            directlyAddressed: persona.id === 'peer' ? 0.9 : 0,
          }),
        }
      },
    }
    const result = await runJevRoutingReplay(pairContext, 'persona_requests', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.decision.policyVersion).toBe(JEV_PERSONA_POLICY_VERSION)
    expect(result.decision.moveJudgments).toMatchObject({ scope: 'persona' })
  })

  it('takes the maximum move answer across personas', async () => {
    const judge = {
      async judgeCentral() {
        throw new Error('unexpected')
      },
      async judgePersona(_context: typeof context, persona: { id: string }) {
        return {
          ok: true as const,
          observation: personaObservation(persona.id === 'manager' ? { sideComment: 0.8 } : {}),
        }
      },
    }
    const result = await runJevRoutingReplay(context, 'persona_requests', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok && result.decision.outcome).toEqual({
      kind: 'user_yield',
      reason: 'all_declined',
    })
  })

  it('uses the owner rule when one persona move answer is unsettled', async () => {
    const judge = {
      async judgeCentral() {
        throw new Error('unexpected')
      },
      async judgePersona(_context: typeof context, persona: { id: string }) {
        return {
          ok: true as const,
          observation: personaObservation(persona.id === 'client' ? { closingMove: 0.5 } : {}),
        }
      },
    }
    const result = await runJevRoutingReplay(context, 'persona_requests', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision.fallback).toEqual({ kind: 'deterministic', cause: 'unsettled' })
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
  })

  it('turns a timeout into incomplete, not a decision', async () => {
    const judge = {
      async judgeCentral() {
        throw new Error('unexpected')
      },
      async judgePersona() {
        await new Promise(() => {})
        throw new Error('unreachable')
      },
    }
    const result = await runJevRoutingReplay(context, 'persona_requests', judge, {
      seed: 1,
      deadlineMs: 5,
    })
    expect(result).toMatchObject({
      ok: false,
      kind: 'infrastructure_incomplete',
    })
    if (result.ok) return
    expect(result.error).toContain('timed out')
  })

  it('turns an unexpected rejection into incomplete, not a decision', async () => {
    const judge = {
      async judgeCentral() {
        throw new Error('unexpected')
      },
      async judgePersona() {
        throw new Error('boom')
      },
    }
    const result = await runJevRoutingReplay(context, 'persona_requests', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result).toMatchObject({
      ok: false,
      kind: 'infrastructure_incomplete',
      cause: 'error',
      error: 'boom',
    })
  })
})

describe('routing artifacts', () => {
  it('wraps a success as a restricted exact record', () => {
    const result = runDeterministicRoutingReplay(context, 'central_selection', 1)
    const artifact = routingArtifact(context, result, {
      trialId: '0:en:decision-1',
      taskId: 'decision-1',
      arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
    })
    expect(artifact).toMatchObject({
      kind: 'routing.decision',
      contentClass: 'restricted',
      outcome: 'completed',
      taskId: 'decision-1',
      arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
    })
    expect(artifact.contextHash).toMatch(/^[0-9a-f]{64}$/)
    expect(routingDecisionArtifactSchema.safeParse(artifact).success).toBe(true)
  })

  it('records a timeout as incomplete without a decision', async () => {
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
    expect(timeout).toMatchObject({ ok: false, cause: 'timeout' })
    const artifact = routingArtifact(context, timeout, {
      trialId: '0:en:decision-1',
      taskId: 'decision-1',
      arm: { topology: 'persona_requests', judgmentSource: 'jev' },
    })
    expect(artifact).toMatchObject({
      outcome: 'infrastructure_incomplete',
      observation: { kind: 'timeout' },
    })
    expect(artifact.error).toContain('timed out')
    expect(artifact).not.toHaveProperty('decision')
  })

  it('records an incomplete failure without a decision', () => {
    const artifact = routingArtifact(
      context,
      {
        ok: false,
        kind: 'infrastructure_incomplete',
        cause: 'error',
        error: 'down',
        questionIds: ['q'],
        policyLatencyMs: 9,
      },
      {
        trialId: '0:en:decision-1',
        taskId: 'decision-1',
        arm: { topology: 'persona_requests', judgmentSource: 'jev' },
      },
    )
    expect(artifact).toMatchObject({
      outcome: 'infrastructure_incomplete',
      observation: { kind: 'none' },
      error: 'down',
    })
    expect(artifact).not.toHaveProperty('decision')
  })

  it('appends restricted JSONL records instead of overwriting earlier decisions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'routing-artifacts-'))
    try {
      const artifact = routingArtifact(
        context,
        runDeterministicRoutingReplay(context, 'central_selection', 1),
        {
          trialId: '0:en:decision-1',
          taskId: 'decision-1',
          arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
        },
      )
      const path = join(directory, 'routing', 'decisions.jsonl')
      await writeRoutingArtifacts(path, [artifact])
      await writeRoutingArtifacts(path, [artifact])
      const lines = (await readFile(path, 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)).toMatchObject({
        kind: 'routing.decision',
        contentClass: 'restricted',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves an empty failure message with a non-empty artifact detail', () => {
    const artifact = routingArtifact(
      context,
      {
        ok: false,
        kind: 'infrastructure_incomplete',
        cause: 'error',
        error: '   ',
        questionIds: [],
        policyLatencyMs: 1,
      },
      {
        trialId: '0:en:decision-1',
        taskId: 'decision-1',
        arm: { topology: 'central_selection', judgmentSource: 'jev' },
      },
    )
    expect(artifact.error).toBe('routing policy failed without a message')
  })
})

describe('runDeterministicRoutingReplay exact decisions', () => {
  it('keeps the seeded tie-break for both topologies', () => {
    for (const topology of ['central_selection', 'persona_requests'] as const) {
      const result = runDeterministicRoutingReplay(tieContext, topology, 1)
      expect(result.decision).toMatchObject({
        decisionId: 'decision-tie',
        turnId: 'turn-2',
        lang: 'en',
        topology,
        judgmentSource: 'deterministic',
        policyVersion: DETERMINISTIC_POLICY_VERSION,
        eligiblePersonaIds: ['manager', 'peer'],
        unsettledPersonas: [],
        fallback: { kind: 'none' },
      })
      expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'manager' })
      expect(result.observation).toStrictEqual({ kind: 'deterministic' })
    }
    expect(
      runDeterministicRoutingReplay(tieContext, 'persona_requests', 2).decision.outcome,
    ).toMatchObject({ kind: 'speak', personaId: 'peer' })
  })

  it('measures policy latency from the monotonic clock', () => {
    freezeClock(5_000)
    expect(runDeterministicRoutingReplay(context, 'central_selection', 1).policyLatencyMs).toBe(0)
  })
})

describe('runJevRoutingReplay exact records', () => {
  it('records a central failure with its question ids and no decision', async () => {
    freezeClock()
    const error = new JevUnavailableError('down', { reason: 'network' })
    const result = await runJevRoutingReplay(
      context,
      'central_selection',
      {
        async judgeCentral() {
          return { ok: false as const, error, questionIds: ['closing_move'] }
        },
        async judgePersona() {
          throw new Error('unexpected')
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result).toStrictEqual({
      ok: false,
      kind: 'infrastructure_incomplete',
      cause: 'error',
      error: 'down',
      questionIds: ['closing_move'],
      policyLatencyMs: 0,
    })
  })

  it('records a thrown judge as incomplete with no question ids', async () => {
    freezeClock()
    const result = await runJevRoutingReplay(
      context,
      'persona_requests',
      {
        async judgeCentral() {
          throw new Error('unexpected')
        },
        async judgePersona() {
          throw new Error('judge exploded')
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result).toStrictEqual({
      ok: false,
      kind: 'infrastructure_incomplete',
      cause: 'error',
      error: 'judge exploded',
      questionIds: [],
      policyLatencyMs: 0,
    })
  })

  it('records a persona failure with the failed batch question ids', async () => {
    freezeClock()
    const error = new JevUnavailableError('persona down', { reason: 'http', status: 502 })
    const result = await runJevRoutingReplay(
      context,
      'persona_requests',
      {
        async judgeCentral() {
          throw new Error('unexpected')
        },
        async judgePersona() {
          return { ok: false as const, error, questionIds: ['closing_move'] }
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result).toStrictEqual({
      ok: false,
      kind: 'infrastructure_incomplete',
      cause: 'error',
      error: 'persona down',
      questionIds: ['closing_move'],
      policyLatencyMs: 0,
    })
  })

  it('keeps the central owner decision, its move record and the exact observation', async () => {
    freezeClock()
    const observation = central()
    const result = await runJevRoutingReplay(
      context,
      'central_selection',
      {
        async judgeCentral() {
          return { ok: true as const, observation }
        },
        async judgePersona() {
          throw new Error('unexpected')
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policyLatencyMs).toBe(0)
    expect(result.decision).toMatchObject({
      schemaVersion: '1.1.0',
      decisionId: 'decision-1',
      turnId: 'turn-1',
      lang: 'en',
      topology: 'central_selection',
      judgmentSource: 'jev',
      policyVersion: JEV_CENTRAL_POLICY_VERSION,
      eligiblePersonaIds: ['manager', 'peer', 'client'],
      unsettledPersonas: [],
      fallback: { kind: 'none' },
    })
    expect(result.decision.requests).toEqual([
      {
        turnId: 'turn-1',
        personaId: 'peer',
        action: 'speak',
        urgency: 1,
        confidence: 0.9,
        addressedByUser: true,
        objectiveRelevance: 1,
      },
    ])
    expect(result.decision.declines).toEqual([
      { personaId: 'manager', reason: 'not_owner' },
      { personaId: 'client', reason: 'not_owner' },
    ])
    expect(result.decision.moveJudgments).toEqual({ scope: 'central', move: quiet })
    expect(result.decision.judgments).toBeUndefined()
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.observation).toStrictEqual({ kind: 'jev', central: observation })
  })

  it('uses the owner rule with the same seed when a central move is unsettled', async () => {
    freezeClock()
    const observation = central({ closingMove: 0.5 })
    const result = await runJevRoutingReplay(
      pairContext,
      'central_selection',
      {
        async judgeCentral() {
          return { ok: true as const, observation }
        },
        async judgePersona() {
          throw new Error('unexpected')
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policyLatencyMs).toBe(0)
    expect(result.decision).toMatchObject({
      topology: 'central_selection',
      judgmentSource: 'jev',
      policyVersion: JEV_CENTRAL_POLICY_VERSION,
      fallback: { kind: 'deterministic', cause: 'unsettled' },
    })
    expect(result.decision.outcome).toEqual({ kind: 'user_yield', reason: 'unsettled' })
    expect(result.observation).toStrictEqual({ kind: 'jev', central: observation })
  })

  it('keeps the persona-arm decision and observation when every move settles', async () => {
    freezeClock()
    const observations = {
      manager: personaObservation(),
      peer: personaObservation({ directlyAddressed: 1 }),
      client: personaObservation(),
    }
    const result = await runJevRoutingReplay(
      context,
      'persona_requests',
      {
        async judgeCentral() {
          throw new Error('unexpected')
        },
        async judgePersona(_context, persona) {
          return { ok: true as const, observation: observations[persona.id as 'manager'] }
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policyLatencyMs).toBe(0)
    expect(result.decision).toMatchObject({
      topology: 'persona_requests',
      judgmentSource: 'jev',
      policyVersion: JEV_PERSONA_POLICY_VERSION,
      unsettledPersonas: [],
      fallback: { kind: 'none' },
    })
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.decision.moveJudgments).toMatchObject({
      scope: 'persona',
      byPersona: { peer: { directlyAddressed: 1 } },
    })
    expect(result.observation).toStrictEqual({ kind: 'jev', personas: observations })
  })

  it('clears the deadline timer once the work settles', async () => {
    vi.useFakeTimers()
    try {
      const result = await runJevRoutingReplay(
        context,
        'central_selection',
        {
          async judgeCentral() {
            return { ok: true as const, observation: central() }
          },
          async judgePersona() {
            throw new Error('unexpected')
          },
        },
        { seed: 1, deadlineMs: 60_000 },
      )
      expect(result.ok).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('routing artifact contract', () => {
  it('stamps the pinned artifact schema version', () => {
    const artifact = routingArtifact(
      context,
      runDeterministicRoutingReplay(context, 'central_selection', 1),
      {
        trialId: '0:en:decision-1',
        taskId: 'decision-1',
        arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
      },
    )
    expect(artifact.schemaVersion).toBe('1.0.0')
  })

  it('rejects a context hash that is not exactly 64 lowercase hex characters', () => {
    const artifact = routingArtifact(
      context,
      runDeterministicRoutingReplay(context, 'central_selection', 1),
      {
        trialId: '0:en:decision-1',
        taskId: 'decision-1',
        arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
      },
    )
    for (const contextHash of [`g${'0'.repeat(64)}`, `${'0'.repeat(64)}g`]) {
      const parsed = routingDecisionArtifactSchema.safeParse({ ...artifact, contextHash })
      expect(parsed.success).toBe(false)
      if (parsed.success) continue
      expect(parsed.error.issues[0]).toMatchObject({
        code: 'invalid_format',
        path: ['contextHash'],
      })
    }
  })
})

describe('writeRoutingArtifacts contract', () => {
  it('writes nothing at all for an empty record list', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'routing-artifacts-'))
    try {
      const path = join(directory, 'routing', 'decisions.jsonl')
      await writeRoutingArtifacts(path, [])
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes one JSON line per record with a trailing newline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'routing-artifacts-'))
    try {
      const first = routingArtifact(
        context,
        runDeterministicRoutingReplay(context, 'central_selection', 1),
        {
          trialId: '0:en:a',
          taskId: 'a',
          arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
        },
      )
      const second = routingArtifact(
        context,
        runDeterministicRoutingReplay(context, 'central_selection', 1),
        {
          trialId: '0:en:b',
          taskId: 'b',
          arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
        },
      )
      const path = join(directory, 'routing', 'decisions.jsonl')
      await writeRoutingArtifacts(path, [first, second])
      expect(await readFile(path, 'utf8')).toBe(
        `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
