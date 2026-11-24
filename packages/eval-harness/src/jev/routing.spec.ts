import { parseRoutingContext } from '@rp/routing-policy'
import { describe, expect, it } from 'vitest'
import { JevInvalidResponseError, JevUnavailableError } from './errors.js'
import {
  buildCentralRoutingJudgment,
  buildPersonaRoutingJudgment,
  CENTRAL_SPEAKER_QUESTION_ID,
  createJevRoutingJudge,
  DIRECTLY_ADDRESSED_QUESTION_ID,
  M3D_ROUTING_RUBRIC_VERSION,
  MOVE_QUESTION_IDS,
} from './routing.js'
import type { JevBatchJudgment, JevBatchSuccess } from './types.js'

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
  {
    topic: 'the plan',
    keywords: ['plan'],
    personaIds: ['manager', 'peer'],
    source: 'fact' as const,
    sourceFactIndex: 0,
  },
]

function context(overrides: { lastUser?: string; lang?: 'en' | 'fr' } = {}) {
  return parseRoutingContext({
    decisionId: 'decision-1',
    turnId: 'turn-1',
    lang: overrides.lang ?? 'en',
    coveredObjectiveIds: [],
    owners: [...owners],
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

const quietMoves = {
  closingMove: 0.1,
  selfAnswer: 0.1,
  thinkingAloud: 0.1,
  sideComment: 0.1,
}

function centralAnswers(
  move: Partial<typeof quietMoves> = {},
  choice?: string,
): JevBatchSuccess['answers'] {
  const answers: Record<string, JevBatchSuccess['answers'][string]> = {
    [MOVE_QUESTION_IDS.closingMove]: { type: 'noul', noul: move.closingMove ?? 0.1 },
    [MOVE_QUESTION_IDS.selfAnswer]: { type: 'noul', noul: move.selfAnswer ?? 0.1 },
    [MOVE_QUESTION_IDS.thinkingAloud]: { type: 'noul', noul: move.thinkingAloud ?? 0.1 },
    [MOVE_QUESTION_IDS.sideComment]: { type: 'noul', noul: move.sideComment ?? 0.1 },
  }
  if (choice !== undefined) {
    answers[CENTRAL_SPEAKER_QUESTION_ID] = {
      type: 'choice',
      choice,
      probabilities: { manager: 0.4, peer: 0.6 },
      confidence: 0.6,
    }
  }
  return answers
}

function personaAnswers(directlyAddressed = 0.9): JevBatchSuccess['answers'] {
  return {
    [MOVE_QUESTION_IDS.closingMove]: { type: 'noul', noul: 0.1 },
    [MOVE_QUESTION_IDS.selfAnswer]: { type: 'noul', noul: 0.2 },
    [MOVE_QUESTION_IDS.thinkingAloud]: { type: 'noul', noul: 0.1 },
    [MOVE_QUESTION_IDS.sideComment]: { type: 'noul', noul: 0.2 },
    [DIRECTLY_ADDRESSED_QUESTION_ID]: { type: 'noul', noul: directlyAddressed },
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
  it('builds one public state with four move Nouls', () => {
    const built = buildCentralRoutingJudgment(context())
    expect(built.metadata).toMatchObject({
      id: 'm3d-routing-central-v2',
      lang: 'en',
      rubricVersion: M3D_ROUTING_RUBRIC_VERSION,
      graderVersion: 'typesafe/jev-1.14',
      extractionVersion: 'none',
    })
    expect(Object.keys(built.questions)).toEqual(Object.values(MOVE_QUESTION_IDS))
  })

  it('adds the Choice only when the turn has a declared pair', () => {
    const pair = buildCentralRoutingJudgment(context({ lastUser: 'Who owns the plan?' }))
    expect(Object.keys(pair.questions).sort()).toEqual(
      [CENTRAL_SPEAKER_QUESTION_ID, ...Object.values(MOVE_QUESTION_IDS)].sort(),
    )
    const choice = pair.questions[CENTRAL_SPEAKER_QUESTION_ID]
    if (choice?.type !== 'choice') throw new Error('expected a choice question')
    expect(Object.keys(choice.criteria)).toEqual(['manager', 'peer'])
    expect(choice.criteria.peer).toContain('Sam Carter')
  })

  it('publishes the ownership list with source audit fields', () => {
    const built = buildCentralRoutingJudgment(context())
    const state = built.state as { readonly owners: readonly Record<string, unknown>[] }
    expect(state.owners).toHaveLength(4)
    expect(state.owners[0]).toEqual({
      topic: 'the handoff',
      persona_ids: ['peer'],
      source: 'objective',
      objective_id: 'handoff',
    })
    expect(state.owners[3]).toEqual({
      topic: 'the plan',
      persona_ids: ['manager', 'peer'],
      source: 'fact',
      source_fact_index: 0,
    })
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

  it('writes French question copy', () => {
    const built = buildCentralRoutingJudgment(
      context({ lang: 'fr', lastUser: 'Qui gère le plan ?' }),
    )
    const closing = built.questions[MOVE_QUESTION_IDS.closingMove]
    if (closing?.type !== 'noul') throw new Error('expected a noul question')
    expect(closing.instructions).toContain('termine')
    expect(closing.criteria.true).toContain('clôt')
    const choice = built.questions[CENTRAL_SPEAKER_QUESTION_ID]
    expect(choice?.instructions).toContain('propriétaires déclarés')
  })

  it('writes the exact English move copy', () => {
    const built = buildCentralRoutingJudgment(context())
    expect(built.questions[MOVE_QUESTION_IDS.closingMove]).toStrictEqual({
      type: 'noul',
      instructions: 'Is the learner ending the exchange with `learner_utterance`?',
      criteria: {
        true: 'The learner closes, wraps up or concludes the exchange.',
        false: 'The learner is still continuing the exchange.',
      },
    })
    expect(built.questions[MOVE_QUESTION_IDS.selfAnswer]).toMatchObject({
      instructions: 'Is the learner answering their own question with `learner_utterance`?',
    })
    expect(built.questions[MOVE_QUESTION_IDS.thinkingAloud]).toMatchObject({
      instructions: 'Is the learner thinking aloud without addressing a persona?',
    })
    expect(built.questions[MOVE_QUESTION_IDS.sideComment]).toMatchObject({
      instructions:
        'Is the learner making a side comment beside the exchange rather than continuing it?',
    })
  })
})

describe('buildPersonaRoutingJudgment', () => {
  it('builds four move Nouls plus direct address for one persona', () => {
    const ctx = context()
    const built = buildPersonaRoutingJudgment(ctx, ctx.personas[1]!)
    expect(Object.keys(built.questions).sort()).toEqual(
      [DIRECTLY_ADDRESSED_QUESTION_ID, ...Object.values(MOVE_QUESTION_IDS)].sort(),
    )
    for (const question of Object.values(built.questions)) {
      expect(question.type).toBe('noul')
    }
  })

  it('includes only that persona and its objectives', () => {
    const ctx = context()
    const built = buildPersonaRoutingJudgment(ctx, ctx.personas[1]!)
    expect(built.state).toMatchObject({
      persona: { id: 'peer', name: 'Sam Carter', role: 'peer colleague' },
      objectives: [
        { id: 'handoff', description: 'Confirm the handoff.' },
        { id: 'cover', description: 'Find cover.' },
      ],
    })
    expect(built.state).not.toHaveProperty('eligible_personas')
    expect(built.state).not.toHaveProperty('labels')
  })

  it('writes French persona questions', () => {
    const ctx = context({ lang: 'fr' })
    const built = buildPersonaRoutingJudgment(ctx, ctx.personas[0]!)
    expect(built.questions[MOVE_QUESTION_IDS.thinkingAloud]?.instructions).toContain('à voix haute')
    const addressed = built.questions[DIRECTLY_ADDRESSED_QUESTION_ID]
    if (addressed?.type !== 'noul') throw new Error('expected a noul question')
    expect(addressed.criteria.true).toContain('nomme')
  })

  it('writes the exact English direct-address question', () => {
    const ctx = context()
    const built = buildPersonaRoutingJudgment(ctx, ctx.personas[1]!)
    expect(built.questions[DIRECTLY_ADDRESSED_QUESTION_ID]).toStrictEqual({
      type: 'noul',
      instructions: 'Does `learner_utterance` directly address `persona` by name or role?',
      criteria: {
        true: 'The learner names the persona or their role and speaks to them directly.',
        false: 'The learner does not name or directly address the persona.',
      },
    })
  })
})

describe('createJevRoutingJudge', () => {
  it('maps a valid central batch to four moves and keeps the exact result', async () => {
    const exact = success(centralAnswers(), Object.values(MOVE_QUESTION_IDS))
    const { judge, calls } = judgeWith(exact)
    const result = await judge.judgeCentral(context())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.observation.judgment).toEqual({ move: quietMoves })
    expect(result.observation.exact).toBe(exact)
    expect(calls).toHaveLength(1)
    expect(Object.keys(calls[0]!.questions)).toHaveLength(4)
  })

  it('maps a pair Choice inside the declared owners', async () => {
    const exact = success(centralAnswers({}, 'peer'), [
      CENTRAL_SPEAKER_QUESTION_ID,
      ...Object.values(MOVE_QUESTION_IDS),
    ])
    const result = await createJevRoutingJudge({
      async decideMany() {
        return exact
      },
    }).judgeCentral(context({ lastUser: 'Who owns the plan?' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.observation.judgment.selectedPersonaId).toBe('peer')
  })

  it('rejects a pair Choice outside the declared owners', async () => {
    const exact = success(centralAnswers({}, 'client'), [
      CENTRAL_SPEAKER_QUESTION_ID,
      ...Object.values(MOVE_QUESTION_IDS),
    ])
    const result = await createJevRoutingJudge({
      async decideMany() {
        return exact
      },
    }).judgeCentral(context({ lastUser: 'Who owns the plan?' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
    expect(result.error.message).toContain('not a declared owner')
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

  it('rejects a wrong answer type instead of defaulting to zero', async () => {
    const exact = success(
      {
        ...centralAnswers(),
        [MOVE_QUESTION_IDS.sideComment]: { type: 'choice', choice: 'x', probabilities: { x: 1 } },
      },
      Object.values(MOVE_QUESTION_IDS),
    )
    const result = await createJevRoutingJudge({
      async decideMany() {
        return exact
      },
    }).judgeCentral(context())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
    expect(result.error.message).toBe('Jev did not return a Noul answer for "side_comment".')
  })

  it('rejects a missing move Noul answer by name', async () => {
    const answers: Record<string, JevBatchSuccess['answers'][string]> = { ...centralAnswers() }
    delete answers[MOVE_QUESTION_IDS.thinkingAloud]
    const result = await createJevRoutingJudge({
      async decideMany() {
        return success(answers, Object.values(MOVE_QUESTION_IDS))
      },
    }).judgeCentral(context())
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error.message).toBe('Jev did not return a Noul answer for "thinking_aloud".')
  })

  it('wraps a non-Jev central failure and keeps the cause', async () => {
    const exact = success(centralAnswers(), Object.values(MOVE_QUESTION_IDS))
    Object.defineProperty(exact, 'answers', {
      get() {
        throw new Error('plain central failure')
      },
    })
    const result = await createJevRoutingJudge({
      async decideMany() {
        return exact
      },
    }).judgeCentral(context())

    expect(result).toMatchObject({
      ok: false,
      questionIds: Object.values(MOVE_QUESTION_IDS),
    })
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
    expect(result.error.message).toBe('Could not read the central Jev judgment.')
    expect(result.error.cause).toBeInstanceOf(Error)
    expect((result.error.cause as Error).message).toBe('plain central failure')
  })

  it('maps five valid persona answers', async () => {
    const ctx = context()
    const exact = success(personaAnswers(0.9), [
      DIRECTLY_ADDRESSED_QUESTION_ID,
      ...Object.values(MOVE_QUESTION_IDS),
    ])
    const result = await createJevRoutingJudge({
      async decideMany() {
        return exact
      },
    }).judgePersona(ctx, ctx.personas[1]!)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.observation.judgments).toEqual({
      ...quietMoves,
      selfAnswer: 0.2,
      sideComment: 0.2,
      directlyAddressed: 0.9,
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
        ...personaAnswers(),
        [DIRECTLY_ADDRESSED_QUESTION_ID]: { type: 'choice', choice: 'x', probabilities: { x: 1 } },
      },
      [DIRECTLY_ADDRESSED_QUESTION_ID, ...Object.values(MOVE_QUESTION_IDS)],
    )
    const result = await createJevRoutingJudge({
      async decideMany() {
        return exact
      },
    }).judgePersona(ctx, ctx.personas[0]!)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
    expect(result.error.message).toBe('Jev did not return a Noul answer for "directly_addressed".')
  })

  it('rejects a missing persona move answer by name', async () => {
    const ctx = context()
    const answers: Record<string, JevBatchSuccess['answers'][string]> = { ...personaAnswers() }
    delete answers[MOVE_QUESTION_IDS.closingMove]
    const result = await createJevRoutingJudge({
      async decideMany() {
        return success(answers, [
          DIRECTLY_ADDRESSED_QUESTION_ID,
          ...Object.values(MOVE_QUESTION_IDS),
        ])
      },
    }).judgePersona(ctx, ctx.personas[0]!)

    expect(result).toMatchObject({
      ok: false,
      questionIds: [DIRECTLY_ADDRESSED_QUESTION_ID, ...Object.values(MOVE_QUESTION_IDS)],
    })
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
    expect(result.error.message).toBe('Jev did not return a Noul answer for "closing_move".')
  })

  it('wraps a non-Jev persona failure and keeps the cause', async () => {
    const ctx = context()
    const exact = success(personaAnswers(), [
      DIRECTLY_ADDRESSED_QUESTION_ID,
      ...Object.values(MOVE_QUESTION_IDS),
    ])
    Object.defineProperty(exact, 'answers', {
      get() {
        throw new Error('plain persona failure')
      },
    })
    const result = await createJevRoutingJudge({
      async decideMany() {
        return exact
      },
    }).judgePersona(ctx, ctx.personas[0]!)

    expect(result).toMatchObject({
      ok: false,
      questionIds: [DIRECTLY_ADDRESSED_QUESTION_ID, ...Object.values(MOVE_QUESTION_IDS)],
    })
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
    expect(result.error.message).toBe('Could not read the persona Jev judgments.')
    expect(result.error.cause).toBeInstanceOf(Error)
    expect((result.error.cause as Error).message).toBe('plain persona failure')
  })
})
