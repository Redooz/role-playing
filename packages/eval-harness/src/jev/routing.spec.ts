import { parseRoutingContext } from '@rp/routing-policy'
import { describe, expect, it } from 'vitest'
import { JevInvalidResponseError, JevUnavailableError } from './errors.js'
import {
  buildCentralRoutingJudgment,
  buildPersonaRoutingJudgment,
  CENTRAL_CONTRIBUTION_QUESTION_ID,
  CENTRAL_SPEAKER_QUESTION_ID,
  createJevRoutingJudge,
  M3A_ROUTING_RUBRIC_VERSION,
  PERSONA_JUDGMENT_QUESTION_IDS,
} from './routing.js'
import type { JevBatchJudgment, JevBatchSuccess } from './types.js'

function context(overrides: { lastUser?: string; covered?: string[]; lang?: 'en' | 'fr' } = {}) {
  return parseRoutingContext({
    decisionId: 'decision-1',
    turnId: 'turn-1',
    lang: overrides.lang ?? 'en',
    coveredObjectiveIds: overrides.covered ?? [],
    personas: [
      {
        id: 'manager',
        displayName: 'Katherine Brooks',
        aliases: ['Katherine'],
        role: 'manager',
        objectives: [
          { id: 'deadline', description: 'Agree a delivery deadline.', keywords: ['deadline'] },
        ],
      },
      {
        id: 'peer',
        displayName: 'Sam Carter',
        aliases: ['Sam'],
        role: 'peer colleague',
        objectives: [
          { id: 'handoff', description: 'Confirm the handoff.', keywords: ['handoff'] },
          { id: 'cover', description: 'Find cover.', keywords: ['cover'] },
        ],
      },
      {
        id: 'client',
        displayName: 'Julian Moore',
        aliases: ['Julian'],
        role: 'external client',
        objectives: [
          { id: 'contract', description: 'Resolve the renewal.', keywords: ['renewal'] },
        ],
      },
    ],
    transcript: [
      {
        speaker: { kind: 'persona', personaId: 'manager' },
        text: 'The client needs a date.',
      },
      {
        speaker: { kind: 'user' },
        text: overrides.lastUser ?? 'Sam, can you confirm the handoff?',
      },
    ],
  })
}

function success(answers: JevBatchSuccess['answers'], questionIds: string[]): JevBatchSuccess {
  const response = {
    model: 'typesafe/jev-1.14-20261014',
    answers,
    usage: { input_tokens: 100, output_tokens: 10, cost: 0.0001 },
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

function centralAnswers(noul = 0.9, choice = 'peer'): JevBatchSuccess['answers'] {
  return {
    [CENTRAL_CONTRIBUTION_QUESTION_ID]: { type: 'noul', noul },
    [CENTRAL_SPEAKER_QUESTION_ID]: {
      type: 'choice',
      choice,
      probabilities: { manager: 0.1, peer: 0.8, client: 0.1 },
      confidence: 0.8,
    },
  }
}

function judgeWith(exact: JevBatchSuccess) {
  const calls: JevBatchJudgment[] = []
  return {
    calls,
    judge: createJevRoutingJudge({
      async decideMany(input) {
        calls.push(input)
        return exact
      },
    }),
  }
}

describe('buildCentralRoutingJudgment', () => {
  it('builds one public state with two questions', () => {
    const built = buildCentralRoutingJudgment(context())
    expect(built.metadata).toMatchObject({
      id: 'm3a-routing-central-v1',
      lang: 'en',
      rubricVersion: M3A_ROUTING_RUBRIC_VERSION,
      graderVersion: 'typesafe/jev-1.14',
      extractionVersion: 'none',
    })
    expect(Object.keys(built.questions).sort()).toEqual([
      CENTRAL_CONTRIBUTION_QUESTION_ID,
      CENTRAL_SPEAKER_QUESTION_ID,
    ])
  })

  it('uses concrete eligible persona ids as Choice option names', () => {
    const built = buildCentralRoutingJudgment(context())
    const choice = built.questions[CENTRAL_SPEAKER_QUESTION_ID]
    if (choice?.type !== 'choice') throw new Error('expected a choice question')
    expect(Object.keys(choice.criteria)).toEqual(['manager', 'peer', 'client'])
    expect(choice.criteria.peer).toContain('Sam Carter')
    expect(choice.criteria.peer).toContain('Confirm the handoff.')
  })

  it('includes named conversation turns and the learner utterance', () => {
    const built = buildCentralRoutingJudgment(context())
    expect(built.state).toMatchObject({
      learner_utterance: 'Sam, can you confirm the handoff?',
      conversation: [
        { speaker: 'Katherine Brooks', role: 'persona', text: 'The client needs a date.' },
        { speaker: 'Learner', role: 'learner', text: 'Sam, can you confirm the handoff?' },
      ],
      eligible_personas: [
        { id: 'manager', name: 'Katherine Brooks', role: 'manager' },
        { id: 'peer', name: 'Sam Carter', role: 'peer colleague' },
        { id: 'client', name: 'Julian Moore', role: 'external client' },
      ],
    })
  })

  it('does not include labels or routing outcomes in the state', () => {
    const serialized = JSON.stringify(buildCentralRoutingJudgment(context()).state)
    expect(serialized).not.toMatch(/acceptable|expected|label|outcome/i)
  })

  it('writes French question copy for French context', () => {
    const built = buildCentralRoutingJudgment(context({ lang: 'fr' }))
    const noul = built.questions[CENTRAL_CONTRIBUTION_QUESTION_ID]
    const choice = built.questions[CENTRAL_SPEAKER_QUESTION_ID]
    if (noul?.type !== 'noul') throw new Error('expected a noul question')
    expect(noul.instructions).toContain('contribution pertinente')
    expect(noul.criteria.true).toContain('information utile')
    expect(choice?.instructions).toContain('doit parler ensuite')
  })
})

describe('buildPersonaRoutingJudgment', () => {
  it('builds five atomic Nouls for one persona', () => {
    const ctx = context()
    const built = buildPersonaRoutingJudgment(ctx, ctx.personas[1]!)
    expect(Object.keys(built.questions)).toEqual(Object.values(PERSONA_JUDGMENT_QUESTION_IDS))
    for (const question of Object.values(built.questions)) {
      expect(question.type).toBe('noul')
    }
  })

  it('includes only that persona and its objectives', () => {
    const ctx = context({ covered: ['handoff'] })
    const built = buildPersonaRoutingJudgment(ctx, ctx.personas[1]!)
    expect(built.state).toMatchObject({
      persona: { id: 'peer', name: 'Sam Carter', role: 'peer colleague' },
      objectives: [
        { id: 'handoff', description: 'Confirm the handoff.', covered: true },
        { id: 'cover', description: 'Find cover.', covered: false },
      ],
    })
    expect(built.state).not.toHaveProperty('covered_objective_ids')
    expect(built.state).not.toHaveProperty('eligible_personas')
    expect(built.state).not.toHaveProperty('labels')
  })

  it('writes French persona questions', () => {
    const ctx = context({ lang: 'fr' })
    const built = buildPersonaRoutingJudgment(ctx, ctx.personas[0]!)
    expect(
      built.questions[PERSONA_JUDGMENT_QUESTION_IDS.pauseWouldBenefitUser]?.instructions,
    ).toContain('pause')
    const addressed = built.questions[PERSONA_JUDGMENT_QUESTION_IDS.directlyAddressed]
    if (addressed?.type !== 'noul') throw new Error('expected a noul question')
    expect(addressed.criteria.true).toContain('nomme')
  })
})

describe('createJevRoutingJudge', () => {
  it('maps a valid central batch to a judgment and keeps the exact result', async () => {
    const exact = success(centralAnswers(), [
      CENTRAL_CONTRIBUTION_QUESTION_ID,
      CENTRAL_SPEAKER_QUESTION_ID,
    ])
    const { judge, calls } = judgeWith(exact)
    const result = await judge.judgeCentral(context())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.observation.judgment).toEqual({
      anyoneWarranted: 0.9,
      selectedPersonaId: 'peer',
    })
    expect(result.observation.exact).toBe(exact)
    expect(calls).toHaveLength(1)
    expect(Object.keys(calls[0]!.questions)).toHaveLength(2)
  })

  it('propagates a central client failure without inventing an answer', async () => {
    const error = new JevUnavailableError('down', { reason: 'network' })
    const judge = createJevRoutingJudge({
      async decideMany() {
        return {
          ok: false,
          error,
          questionIds: ['a', 'b'],
          cache: { key: null, hit: false, stored: false },
        }
      },
    })
    expect(await judge.judgeCentral(context())).toEqual({
      ok: false,
      error,
      questionIds: ['a', 'b'],
    })
  })

  it('rejects a selected persona outside the eligible set', async () => {
    const exact = success(centralAnswers(0.9, 'ghost'), [
      CENTRAL_CONTRIBUTION_QUESTION_ID,
      CENTRAL_SPEAKER_QUESTION_ID,
    ])
    const judge = createJevRoutingJudge({
      async decideMany() {
        return exact
      },
    })
    const result = await judge.judgeCentral(context())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects a wrong answer type instead of defaulting to zero', async () => {
    const exact = success(
      {
        [CENTRAL_CONTRIBUTION_QUESTION_ID]: { type: 'noul', noul: 0.9 },
        [CENTRAL_SPEAKER_QUESTION_ID]: { type: 'noul', noul: 0.8 },
      },
      [CENTRAL_CONTRIBUTION_QUESTION_ID, CENTRAL_SPEAKER_QUESTION_ID],
    )
    const judge = createJevRoutingJudge({
      async decideMany() {
        return exact
      },
    })
    const result = await judge.judgeCentral(context())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('maps five valid persona answers', async () => {
    const ctx = context()
    const exact = success(
      {
        [PERSONA_JUDGMENT_QUESTION_IDS.directlyAddressed]: { type: 'noul', noul: 0.9 },
        [PERSONA_JUDGMENT_QUESTION_IDS.hasRelevantContribution]: { type: 'noul', noul: 0.8 },
        [PERSONA_JUDGMENT_QUESTION_IDS.addsUncoveredInformation]: { type: 'noul', noul: 0.7 },
        [PERSONA_JUDGMENT_QUESTION_IDS.hasUnmetRelevantObjective]: { type: 'noul', noul: 0.6 },
        [PERSONA_JUDGMENT_QUESTION_IDS.pauseWouldBenefitUser]: { type: 'noul', noul: 0.1 },
      },
      Object.values(PERSONA_JUDGMENT_QUESTION_IDS),
    )
    const judge = createJevRoutingJudge({
      async decideMany() {
        return exact
      },
    })
    const result = await judge.judgePersona(ctx, ctx.personas[1]!)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.observation.judgments).toEqual({
      directlyAddressed: 0.9,
      hasRelevantContribution: 0.8,
      addsUncoveredInformation: 0.7,
      hasUnmetRelevantObjective: 0.6,
      pauseWouldBenefitUser: 0.1,
    })
    expect(result.observation.exact).toBe(exact)
  })

  it('propagates a persona client failure', async () => {
    const error = new JevUnavailableError('timeout', { reason: 'timeout' })
    const judge = createJevRoutingJudge({
      async decideMany() {
        return {
          ok: false,
          error,
          questionIds: ['x'],
          cache: { key: null, hit: false, stored: false },
        }
      },
    })
    const ctx = context()
    expect(await judge.judgePersona(ctx, ctx.personas[0]!)).toEqual({
      ok: false,
      error,
      questionIds: ['x'],
    })
  })

  it('rejects a persona batch with the wrong answer type', async () => {
    const ctx = context()
    const exact = success(
      {
        [PERSONA_JUDGMENT_QUESTION_IDS.directlyAddressed]: { type: 'noul', noul: 0.9 },
        [PERSONA_JUDGMENT_QUESTION_IDS.hasRelevantContribution]: { type: 'noul', noul: 0.8 },
        [PERSONA_JUDGMENT_QUESTION_IDS.addsUncoveredInformation]: { type: 'noul', noul: 0.7 },
        [PERSONA_JUDGMENT_QUESTION_IDS.hasUnmetRelevantObjective]: { type: 'noul', noul: 0.6 },
        [PERSONA_JUDGMENT_QUESTION_IDS.pauseWouldBenefitUser]: {
          type: 'choice',
          choice: 'x',
          probabilities: { x: 1 },
        },
      },
      Object.values(PERSONA_JUDGMENT_QUESTION_IDS),
    )
    const judge = createJevRoutingJudge({
      async decideMany() {
        return exact
      },
    })
    const result = await judge.judgePersona(ctx, ctx.personas[0]!)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })
})
