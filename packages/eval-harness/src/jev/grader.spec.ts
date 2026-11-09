import { describe, expect, it } from 'vitest'
import { TRANSCRIPT_SCHEMA_VERSION, expectedContentClass } from '@rp/session-core'
import type { TranscriptRecord } from '@rp/session-core'
import { createJevAxisGrader, M2_AXES, M2_JEV_RUBRIC_VERSION } from './grader.js'
import type { JevGrader, JevJudgment, JevResult } from './types.js'
import type { TrialRecord } from '../runner/grader.js'
import type { TaskEntry } from '../tasks/schema.js'

function task(locale: string | undefined): TaskEntry {
  return {
    id: locale === undefined ? 'en-session-001' : `${locale}-session-001`,
    lang: locale?.startsWith('fr') === true ? 'fr' : 'en',
    ...(locale === undefined ? {} : { locale }),
    mode: 'session',
    domain: 'workplace',
    scenarioType: 'request-deadline-extension',
    cefrBand: 'B1',
    speakerId: 'speaker-001',
    split: 'calibration',
    provenance: { source: 'synthetic' },
    consentScope: 'synthetic-no-consent-required',
    annotationVersions: { rubric: 'v2' },
    content: { turns: [] },
    session: {
      personaId: 'manager',
      personaVersion: '1.0.0',
      scenarioId: 'request-deadline-extension',
      scenarioVersion: '1.0.0',
      scriptedUserTurns: ['Could I have two more days?'],
    },
  } as TaskEntry
}

function records(): TranscriptRecord[] {
  const events = [
    { kind: 'user.utterance.committed' as const, payload: { text: 'Could I have two more days?' } },
    {
      kind: 'persona.response.committed' as const,
      payload: { text: 'How much time, and what is still missing?' },
    },
  ]
  return events.map((event, seq) => ({
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    runId: 'run-1',
    seq,
    tSim: 0,
    tWall: 0,
    kind: event.kind,
    payload: event.payload,
    contentClass: expectedContentClass(event.kind),
  }))
}

function trial(locale: string | undefined): TrialRecord {
  return {
    round: 0,
    taskId: 'task',
    lang: locale?.startsWith('fr') === true ? 'fr' : 'en',
    ok: true,
    records: records(),
    violations: [],
    schemaValid: true,
    sequenceValid: true,
    contentClassValid: true,
    providerOutage: false,
    task: task(locale),
  }
}

function fakeJev(probability = 0.82): JevGrader & { calls: JevJudgment[] } {
  const calls: JevJudgment[] = []
  return {
    calls,
    async grade(judgment): Promise<JevResult> {
      calls.push(judgment)
      return {
        ok: true,
        questionId: judgment.metadata.id,
        request: {
          model: 'typesafe/jev-1.14',
          state: judgment.state,
          questions: { [judgment.metadata.id]: judgment.question },
        },
        response: {
          model: 'typesafe/jev-1.14-20261014',
          answers: { [judgment.metadata.id]: { type: 'noul', noul: probability } },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        raw: {},
        distribution: { kind: 'noul', probabilityYes: probability, probabilityNo: 1 - probability },
        usage: { input_tokens: 1, output_tokens: 1 },
        servedModel: 'typesafe/jev-1.14-20261014',
        cache: { key: 'k', hit: false, stored: true },
      }
    },
  }
}

const CONTEXT = (candidate: TrialRecord) => ({
  manifest: {} as never,
  trials: [candidate],
})

describe('Jev axis grader', () => {
  it('asks one atomic question per axis and stores raw probabilities', async () => {
    const jev = fakeJev(0.82)
    const grader = createJevAxisGrader({ client: jev })
    const candidate = trial(undefined)

    const metrics = await grader.score(CONTEXT(candidate))
    const details = await grader.details?.(CONTEXT(candidate))

    expect(jev.calls).toHaveLength(M2_AXES.length - 1)
    expect(Object.keys(metrics).sort()).toEqual(
      [
        ...M2_AXES.filter((axis) => axis !== 'locale.fit'),
        'response.emoji_count',
        'response.markdown_count',
        'response.plain_text_rate',
        'run.failure_rate',
      ].sort(),
    )
    expect(metrics['persona.consistency']).toBeCloseTo(0.82)
    expect(details).toHaveLength(M2_AXES.length - 1)
    expect(details?.every((detail) => detail.probability === 0.82)).toBe(true)
    expect(details?.[0]?.threshold).toBe(0.75)
    expect(details?.[0]?.servedModel).toBe('typesafe/jev-1.14-20261014')
  })

  it('adds the locale-fit axis for a locale variant and stamps the locale', async () => {
    const jev = fakeJev()
    const grader = createJevAxisGrader({ client: jev })
    const candidate = trial('en-GB')

    const metrics = await grader.score(CONTEXT(candidate))
    const details = await grader.details?.(CONTEXT(candidate))

    expect(Object.keys(metrics).sort()).toEqual(
      [
        ...M2_AXES,
        'response.emoji_count',
        'response.markdown_count',
        'response.plain_text_rate',
        'run.failure_rate',
      ].sort(),
    )
    expect(details?.[0]?.locale).toBe('en-GB')
    expect(jev.calls.every((call) => call.metadata.locale === 'en-GB')).toBe(true)
  })

  it('declares the rubric it can ask', () => {
    const grader = createJevAxisGrader({ client: fakeJev() })
    expect(grader.rubricVersion).toBe(M2_JEV_RUBRIC_VERSION)
  })

  it('writes French questions for a French trial', async () => {
    const jev = fakeJev()
    const grader = createJevAxisGrader({ client: jev })
    await grader.score(CONTEXT(trial('fr-CA')))
    expect(jev.calls.every((call) => call.metadata.lang === 'fr')).toBe(true)
    expect(jev.calls[0]?.question.instructions).toMatch(/rôle professionnel/)
    expect(jev.calls.every((call) => call.metadata.rubricVersion === M2_JEV_RUBRIC_VERSION)).toBe(
      true,
    )
    expect(
      jev.calls.some((call) => /accents et traits d’union/u.test(call.question.instructions)),
    ).toBe(true)
    expect(jev.calls.some((call) => /« tu » ou « vous »/u.test(call.question.instructions))).toBe(
      true,
    )
  })

  it('fails the run when Jev returns an error instead of turning it into a no', async () => {
    const failing: JevGrader = {
      async grade(judgment) {
        return {
          ok: false,
          questionId: judgment.metadata.id,
          error: { name: 'JevUnavailableError', message: 'network down' } as never,
          cache: { key: null, hit: false, stored: false },
        }
      },
    }
    const grader = createJevAxisGrader({ client: failing })
    await expect(grader.score(CONTEXT(trial(undefined)))).rejects.toThrow(/not a "no"/)
  })
})
