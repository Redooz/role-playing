import { parseRoutingContext } from '@rp/routing-policy'
import { describe, expect, it } from 'vitest'
import { JevInvalidResponseError, JevUnavailableError } from './errors.js'
import type { JevJudgment, JevJudgmentSuccess } from './types.js'
import {
  buildInterruptionWarrantedJudgment,
  createJevInterruptionJudge,
  INTERRUPTION_WARRANTED_QUESTION_ID,
  M3B_TURN_TAKING_RUBRIC_VERSION,
  type InterruptionWarrantedInput,
} from './turn-taking.js'

function context(lang: 'en' | 'fr' = 'en', lastUser?: string) {
  return parseRoutingContext({
    decisionId: 'decision-1',
    turnId: 'turn-1',
    lang,
    coveredObjectiveIds: [],
    personas: [
      {
        id: 'manager',
        displayName: lang === 'fr' ? 'Catherine Brooks' : 'Katherine Brooks',
        aliases: lang === 'fr' ? ['Catherine'] : ['Katherine'],
        role: lang === 'fr' ? 'responsable' : 'manager',
        objectives: [{ id: 'deadline', description: 'Agree a deadline.', keywords: ['deadline'] }],
      },
      {
        id: 'peer',
        displayName: lang === 'fr' ? 'Samir Carter' : 'Sam Carter',
        aliases: lang === 'fr' ? ['Samir'] : ['Sam'],
        role: lang === 'fr' ? 'collègue' : 'peer colleague',
        objectives: [{ id: 'handoff', description: 'Confirm handoff.', keywords: ['handoff'] }],
      },
    ],
    transcript: [
      { speaker: { kind: 'persona', personaId: 'manager' }, text: 'We need a date.' },
      {
        speaker: { kind: 'user' },
        text: lastUser ?? (lang === 'fr' ? 'Samir, tu peux confirmer ?' : 'Sam, can you confirm?'),
      },
    ],
  })
}

function input(overrides: Partial<InterruptionWarrantedInput> = {}): InterruptionWarrantedInput {
  return {
    context: context(),
    activePersonaId: 'manager',
    partialText: 'The date is not agreed yet, so',
    interjectingPersonaId: 'peer',
    ...overrides,
  }
}

function success(answers: JevJudgmentSuccess['response']['answers']): JevJudgmentSuccess {
  const response = {
    model: 'typesafe/jev-1.14-20261014',
    answers,
    usage: { input_tokens: 20, output_tokens: 2, cost: 0.00001 },
  }
  return {
    ok: true,
    questionId: INTERRUPTION_WARRANTED_QUESTION_ID,
    request: { model: 'typesafe/jev-1.14', state: {}, questions: {} },
    response,
    raw: response,
    distribution: { kind: 'noul', probabilityYes: 0.82, probabilityNo: 0.18 },
    usage: response.usage,
    servedModel: response.model,
    cache: { key: 'b'.repeat(64), hit: false, stored: true },
  }
}

describe('buildInterruptionWarrantedJudgment', () => {
  it('builds one atomic question under the M3b rubric', () => {
    const built = buildInterruptionWarrantedJudgment(input())
    expect(built.metadata).toMatchObject({
      id: 'm3b-interruption-warranted-v1',
      lang: 'en',
      rubricVersion: M3B_TURN_TAKING_RUBRIC_VERSION,
    })
    expect(built.question.type).toBe('noul')
    expect(built.metadata.id).toBe('m3b-interruption-warranted-v1')
  })

  it('keeps the public conversation, both personas and the partial reply', () => {
    const built = buildInterruptionWarrantedJudgment(input())
    expect(built.state).toMatchObject({
      learner_utterance: 'Sam, can you confirm?',
      active_speaker: { id: 'manager', name: 'Katherine Brooks', role: 'manager' },
      active_partial_reply: 'The date is not agreed yet, so',
      interjecting_persona: { id: 'peer', name: 'Sam Carter', role: 'peer colleague' },
      conversation: [
        { speaker: 'Katherine Brooks', role: 'persona', text: 'We need a date.' },
        { speaker: 'Learner', role: 'learner', text: 'Sam, can you confirm?' },
      ],
    })
  })

  it('does not put labels, arm ids or outcomes into the state', () => {
    const serialized = JSON.stringify(buildInterruptionWarrantedJudgment(input()).state)
    expect(serialized).not.toMatch(/acceptable|expected|label|outcome|jev-|det-/i)
  })

  it('writes French instructions and criteria for a French context', () => {
    const built = buildInterruptionWarrantedJudgment(
      input({ context: context('fr'), interjectingPersonaId: 'peer' }),
    )
    const question = built.question
    if (question?.type !== 'noul') throw new Error('expected a Noul question')
    expect(question.instructions).toContain('clairement justifiée')
    expect(question.criteria.true).toContain('corrige un malentendu')
    expect(question.criteria.false).toContain('prochaine réplique')
    expect(built.metadata.lang).toBe('fr')
  })

  it('rejects an empty partial reply and an unknown or identical persona', () => {
    expect(() => buildInterruptionWarrantedJudgment(input({ partialText: '  ' }))).toThrow(
      /partial reply/u,
    )
    expect(() => buildInterruptionWarrantedJudgment(input({ activePersonaId: 'peer' }))).toThrow(
      /own grant/u,
    )
    expect(() =>
      buildInterruptionWarrantedJudgment(input({ interjectingPersonaId: 'stranger' })),
    ).toThrow(/unknown persona "stranger"/u)
  })
})

describe('createJevInterruptionJudge', () => {
  it('returns the raw probability and exact answer', async () => {
    const calls: JevJudgment[] = []
    const judge = createJevInterruptionJudge({
      async grade(judgment) {
        calls.push(judgment)
        return success({
          [INTERRUPTION_WARRANTED_QUESTION_ID]: { type: 'noul', noul: 0.82 },
        })
      },
    })

    const result = await judge.judgeInterruption(input())
    expect(result).toMatchObject({
      ok: true,
      observation: { probability: 0.82, exact: { servedModel: 'typesafe/jev-1.14-20261014' } },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.question.type).toBe('noul')
  })

  it('passes a transport failure through without a probability', async () => {
    const judge = createJevInterruptionJudge({
      async grade() {
        return {
          ok: false,
          questionId: INTERRUPTION_WARRANTED_QUESTION_ID,
          error: new JevUnavailableError('offline', { reason: 'network' }),
          cache: { key: null, hit: false, stored: false },
        }
      },
    })
    const result = await judge.judgeInterruption(input())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('offline')
    expect(result).not.toHaveProperty('observation')
  })

  it('turns a missing or wrong answer type into an invalid response error', async () => {
    const missing = createJevInterruptionJudge({
      async grade() {
        return success({})
      },
    })
    await expect(missing.judgeInterruption(input())).resolves.toMatchObject({
      ok: false,
      error: expect.any(JevInvalidResponseError),
    })

    const wrongType = createJevInterruptionJudge({
      async grade() {
        return success({
          [INTERRUPTION_WARRANTED_QUESTION_ID]: {
            type: 'choice',
            choice: 'yes',
            probabilities: { yes: 0.8, no: 0.2 },
          },
        })
      },
    })
    await expect(wrongType.judgeInterruption(input())).resolves.toMatchObject({
      ok: false,
      error: expect.any(JevInvalidResponseError),
    })
  })
})
