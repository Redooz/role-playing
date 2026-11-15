import type { RoutingContext } from '@rp/routing-policy'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { expectedSchemas, writeSchemaFiles } from './generate-schemas.js'
import {
  CEFR_BANDS,
  LANGS,
  SPLITS,
  annotatorAgreementSchema,
  cefrBandSchema,
  goldenEntrySchema,
  hasMeasuredAgreement,
  langSchema,
  localeTagSchema,
  provenanceSchema,
  routingOutcomeLabelSchema,
  routingTaskSchema,
  sessionTaskSchema,
  speakerLabelSchema,
  splitSchema,
  taskContentSchema,
  taskEntrySchema,
  taskModeSchema,
  turnSchema,
  type GoldenEntry,
  type RoutingOutcomeLabel,
  type SpeakerLabel,
  type TaskEntry,
} from './schema.js'

const SCHEMAS_DIR = fileURLToPath(new URL('../../../../evals/schemas', import.meta.url))

function taskEntry(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 'en-task-001',
    lang: 'en',
    mode: 'replay',
    domain: 'workplace',
    scenarioType: 'request-deadline-extension',
    cefrBand: 'B1',
    speakerId: 'speaker-en-001',
    split: 'calibration',
    provenance: { source: 'synthetic' },
    consentScope: 'synthetic-no-consent-required',
    annotationVersions: { rubric: 'v1' },
    content: {
      scenarioBrief: 'A learner asks a manager for more time.',
      turns: [
        { role: 'persona', text: 'How is it going?' },
        { role: 'user', text: 'Could I have two more days?' },
      ],
    },
    ...overrides,
  }
}

const routingContext: RoutingContext = {
  decisionId: 'en-task-001',
  turnId: 'turn-1',
  lang: 'en',
  transcript: [
    { speaker: { kind: 'persona', personaId: 'manager' }, text: 'We need a date.' },
    { speaker: { kind: 'user' }, text: 'Sam, can you confirm the handoff?' },
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
  coveredObjectiveIds: [],
}

function routingTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return taskEntry({
    mode: 'routing',
    content: { scenarioBrief: 'A routing decision.', turns: [] },
    routing: { context: routingContext },
    ...overrides,
  })
}

function goldenEntry(overrides: Partial<GoldenEntry> = {}): GoldenEntry {
  return {
    id: 'en-golden-001',
    lang: 'en',
    split: 'calibration',
    routingLabels: { intent: 'request-deadline-extension', expectedPersonaId: 'persona-manager' },
    dimensionScores: { clarity: { score: 4 } },
    evidenceSpans: [{ turnIndex: 1, textRef: 'two more days' }],
    pairwisePreferences: [],
    status: 'draft',
    ...overrides,
  }
}

const measuredAgreement = {
  annotators: ['annotator-a', 'annotator-b'],
  metric: 'cohen_kappa',
  value: 0.71,
}

describe('taskEntrySchema', () => {
  it('accepts a synthetic entry with the M0 default metadata', () => {
    expect(taskEntrySchema.safeParse(taskEntry()).success).toBe(true)
  })

  it('rejects an unknown CEFR band', () => {
    const result = taskEntrySchema.safeParse({ ...taskEntry(), cefrBand: 'D1' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['cefrBand'])
  })

  it('rejects a missing consentScope and empty annotationVersions', () => {
    const result = taskEntrySchema.safeParse({
      ...taskEntry(),
      consentScope: '',
      annotationVersions: {},
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path[0])).toEqual(
      expect.arrayContaining(['consentScope', 'annotationVersions']),
    )
  })

  it('requires structured provenance, not a bare string', () => {
    const result = taskEntrySchema.safeParse({
      ...taskEntry(),
      provenance: 'synthetic',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['provenance'])
  })

  it('requires collectedAt for recorded provenance', () => {
    const withoutDate = taskEntrySchema.safeParse(taskEntry({ provenance: { source: 'recorded' } }))
    expect(withoutDate.success).toBe(false)
    expect(withoutDate.error?.issues[0]?.path).toEqual(['provenance', 'collectedAt'])

    const withDate = taskEntrySchema.safeParse(
      taskEntry({
        provenance: { source: 'recorded', collectedAt: '2026-10-01T09:30:00Z' },
      }),
    )
    expect(withDate.success).toBe(true)
  })

  it('accepts a routing task with no recorded content turns', () => {
    expect(taskEntrySchema.safeParse(routingTask()).success).toBe(true)
  })

  it('requires a routing block for mode routing', () => {
    const result = taskEntrySchema.safeParse({ ...routingTask(), routing: undefined })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['routing'])
  })

  it('rejects a routing block on a replay task', () => {
    const result = taskEntrySchema.safeParse({
      ...taskEntry(),
      routing: { context: routingContext },
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['routing'])
  })

  it('rejects recorded content turns on a routing task', () => {
    const result = taskEntrySchema.safeParse(
      routingTask({
        content: {
          turns: [{ role: 'user', text: 'A recorded turn.' }],
        },
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['content', 'turns'])
  })

  it('requires the routing decision id and language to match the task', () => {
    const wrongId = taskEntrySchema.safeParse(
      routingTask({
        routing: { context: { ...routingContext, decisionId: 'other' } },
      }),
    )
    expect(wrongId.success).toBe(false)
    expect(wrongId.error?.issues[0]?.path).toEqual(['routing', 'context', 'decisionId'])

    const wrongLang = taskEntrySchema.safeParse(
      routingTask({
        routing: { context: { ...routingContext, lang: 'fr' } },
      }),
    )
    expect(wrongLang.success).toBe(false)
    expect(wrongLang.error?.issues[0]?.path).toEqual(['routing', 'context', 'lang'])
  })
})

describe('goldenEntrySchema', () => {
  it('allows an unstable draft without an agreement block', () => {
    expect(goldenEntrySchema.safeParse(goldenEntry()).success).toBe(true)
  })

  it('rejects status stable when agreement has not been measured', () => {
    const result = goldenEntrySchema.safeParse(goldenEntry({ status: 'stable' }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['annotatorAgreement'])
  })

  it('rejects status stable with a single annotator', () => {
    const result = goldenEntrySchema.safeParse(
      goldenEntry({
        status: 'stable',
        annotatorAgreement: { ...measuredAgreement, annotators: ['annotator-a'] },
      }),
    )
    expect(result.success).toBe(false)
  })

  it('accepts status stable with two annotators, a metric, and a value', () => {
    const result = goldenEntrySchema.safeParse(
      goldenEntry({ status: 'stable', annotatorAgreement: measuredAgreement }),
    )
    expect(result.success).toBe(true)
  })

  it('requires at least one dimension score', () => {
    const result = goldenEntrySchema.safeParse(goldenEntry({ dimensionScores: {} }))
    expect(result.success).toBe(false)
  })

  it('rejects scores outside the 1-5 scale', () => {
    const result = goldenEntrySchema.safeParse(
      goldenEntry({ dimensionScores: { clarity: { score: 6 } } }),
    )
    expect(result.success).toBe(false)
  })

  it('accepts a routingOutcome without dimension scores', () => {
    const result = goldenEntrySchema.safeParse(
      goldenEntry({
        taskId: 'en-task-001',
        routingLabels: undefined,
        dimensionScores: undefined,
        routingOutcome: {
          intent: 'confirm-handoff',
          acceptablePersonaIds: ['peer'],
          allowUserYield: false,
          labelSource: 'agent',
        },
      }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts learner yield as a routing outcome', () => {
    expect(
      goldenEntrySchema.safeParse(
        goldenEntry({
          routingLabels: undefined,
          dimensionScores: undefined,
          routingOutcome: {
            intent: 'no-contribution',
            acceptablePersonaIds: [],
            allowUserYield: true,
            labelSource: 'agent',
          },
        }),
      ).success,
    ).toBe(true)
  })

  it('rejects a routing outcome that accepts neither a persona nor yield', () => {
    const result = goldenEntrySchema.safeParse(
      goldenEntry({
        routingLabels: undefined,
        dimensionScores: undefined,
        routingOutcome: {
          intent: 'empty',
          acceptablePersonaIds: [],
          allowUserYield: false,
          labelSource: 'agent',
        },
      }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects duplicate acceptable personas', () => {
    const result = goldenEntrySchema.safeParse(
      goldenEntry({
        routingLabels: undefined,
        dimensionScores: undefined,
        routingOutcome: {
          intent: 'duplicate',
          acceptablePersonaIds: ['peer', 'peer'],
          allowUserYield: false,
          labelSource: 'agent',
        },
      }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects both routing label shapes at once', () => {
    const result = goldenEntrySchema.safeParse(
      goldenEntry({
        routingOutcome: {
          intent: 'both',
          acceptablePersonaIds: ['peer'],
          allowUserYield: false,
          labelSource: 'agent',
        },
      }),
    )
    expect(result.success).toBe(false)
  })

  it('requires one routing label shape', () => {
    const result = goldenEntrySchema.safeParse(
      goldenEntry({ routingLabels: undefined, dimensionScores: undefined }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects stable status for agent routing labels', () => {
    const result = goldenEntrySchema.safeParse(
      goldenEntry({
        routingLabels: undefined,
        dimensionScores: undefined,
        status: 'stable',
        annotatorAgreement: measuredAgreement,
        routingOutcome: {
          intent: 'agent-only',
          acceptablePersonaIds: ['peer'],
          allowUserYield: false,
          labelSource: 'agent',
        },
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['routingOutcome', 'labelSource'])
  })

  it('allows stable status for human routing labels with agreement', () => {
    expect(
      goldenEntrySchema.safeParse(
        goldenEntry({
          routingLabels: undefined,
          dimensionScores: undefined,
          status: 'stable',
          annotatorAgreement: measuredAgreement,
          routingOutcome: {
            intent: 'human-labelled',
            acceptablePersonaIds: ['peer'],
            allowUserYield: false,
            labelSource: 'human',
          },
        }),
      ).success,
    ).toBe(true)
  })

  it('accepts a trial reference that matches the harness trial id', () => {
    const result = goldenEntrySchema.safeParse(
      goldenEntry({
        taskId: 'en-b1-report-deadline-001',
        runId: 'm2-persona-scenarios-lk',
        round: 2,
        trialId: '2:en:en-b1-report-deadline-001',
      }),
    )
    expect(result.success).toBe(true)
  })

  it('requires the trial reference fields together and a matching trial id', () => {
    const partial = goldenEntrySchema.safeParse(goldenEntry({ runId: 'run-1' }))
    expect(partial.success).toBe(false)

    const mismatched = goldenEntrySchema.safeParse(
      goldenEntry({
        taskId: 'en-b1-report-deadline-001',
        runId: 'run-1',
        round: 2,
        trialId: '3:en:en-b1-report-deadline-001',
      }),
    )
    expect(mismatched.success).toBe(false)
  })
})

describe('hasMeasuredAgreement', () => {
  it('requires two distinct annotators', () => {
    expect(hasMeasuredAgreement(measuredAgreement)).toBe(true)
    expect(
      hasMeasuredAgreement({ ...measuredAgreement, annotators: ['annotator-a', 'annotator-a'] }),
    ).toBe(false)
    expect(hasMeasuredAgreement(undefined)).toBe(false)
  })
})

describe('committed JSON schemas', () => {
  it('match z.toJSONSchema output', async () => {
    // Snapshot-update path, opt-in only. Normal test runs never touch the repo.
    if (process.env['UPDATE_SCHEMAS'] === '1') {
      await writeSchemaFiles(SCHEMAS_DIR)
    }

    const expected = expectedSchemas()
    for (const [fileName, expectedSchema] of Object.entries(expected)) {
      const committed = await readFile(join(SCHEMAS_DIR, fileName), 'utf8').catch(() => undefined)
      expect(
        committed,
        `${fileName} is missing. Regenerate with: UPDATE_SCHEMAS=1 npx vitest run packages/eval-harness/src/tasks/schema.spec.ts`,
      ).toBeDefined()
      if (committed === undefined) continue
      expect(
        JSON.parse(committed) as unknown,
        `${fileName} is out of date with schema.ts. Regenerate, then run: npx prettier --write evals/schemas`,
      ).toEqual(expectedSchema)
    }

    const committedFiles = (await readdir(SCHEMAS_DIR)).filter((name) => name.endsWith('.json'))
    expect(committedFiles.sort()).toEqual(Object.keys(expected).sort())
  })
})

describe('multi-persona task and speaker labels', () => {
  function multiSession(overrides: Partial<TaskEntry> = {}): TaskEntry {
    return taskEntry({
      mode: 'session',
      content: { scenarioBrief: 'A scope change at stand-up.', turns: [] },
      session: {
        personaId: 'manager',
        personaIds: ['manager', 'peer'],
        personaVersion: '1.0.0',
        scenarioId: 'standup-scope-change',
        scenarioVersion: '1.0.0',
        scriptedUserTurns: ['Sam, what is finished?', 'Katherine, what ships?'],
      },
      ...overrides,
    })
  }

  function speakerGolden(overrides: Partial<GoldenEntry> = {}): GoldenEntry {
    return goldenEntry({
      routingLabels: undefined,
      dimensionScores: undefined,
      speakerLabels: [
        {
          turnIndex: 0,
          acceptablePersonaIds: ['peer'],
          allowUserYield: false,
          labelSource: 'agent',
        },
        {
          turnIndex: 1,
          acceptablePersonaIds: ['manager'],
          allowUserYield: false,
          labelSource: 'agent',
        },
      ],
      ...overrides,
    })
  }

  it('accepts a session task with personaIds in driver order', () => {
    expect(taskEntrySchema.safeParse(multiSession()).success).toBe(true)
  })

  it('rejects duplicate personas and an opening persona that is not first', () => {
    const duplicates = multiSession()
    const first = taskEntrySchema.safeParse({
      ...duplicates,
      session: { ...duplicates.session!, personaIds: ['manager', 'manager'] },
    })
    expect(first.success).toBe(false)

    const wrongOpening = taskEntrySchema.safeParse({
      ...duplicates,
      session: { ...duplicates.session!, personaIds: ['peer', 'manager'] },
    })
    expect(wrongOpening.success).toBe(false)
    expect(wrongOpening.error?.issues[0]?.message).toContain('opening personaId')
  })

  it('accepts speakerLabels without routing labels or dimension scores', () => {
    const result = goldenEntrySchema.safeParse(speakerGolden())
    expect(result.success).toBe(true)
  })

  it('rejects speakerLabels mixed with routing labels or a non-consecutive turn set', () => {
    const mixed = goldenEntrySchema.safeParse(
      speakerGolden({
        routingOutcome: {
          intent: 'x',
          acceptablePersonaIds: ['manager'],
          allowUserYield: false,
          labelSource: 'agent',
        },
      }),
    )
    expect(mixed.success).toBe(false)

    const gap = goldenEntrySchema.safeParse(
      speakerGolden({
        speakerLabels: [
          {
            turnIndex: 1,
            acceptablePersonaIds: ['peer'],
            allowUserYield: false,
            labelSource: 'agent',
          },
        ],
      }),
    )
    expect(gap.success).toBe(false)
    expect(gap.error?.issues[0]?.message).toContain('first user turn')
  })

  it('refuses a stable entry with agent speaker labels', () => {
    const result = goldenEntrySchema.safeParse(speakerGolden({ status: 'stable' }))
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain(
      "agent speaker labels cannot be 'stable'",
    )
  })
})

// ---------------------------------------------------------------------------
// Contract coverage: every constant, field rule, refinement message and
// boundary value declared in `schema.ts`.
// ---------------------------------------------------------------------------

type IssueSnapshot = { code?: string | undefined; path: PropertyKey[]; message: string }

type ParseResult = {
  success: boolean
  error?: { issues: ReadonlyArray<IssueSnapshot> }
}

function firstIssue(parsed: ParseResult): IssueSnapshot {
  if (parsed.success) throw new Error('expected the schema to reject the input')
  const issue = parsed.error?.issues[0]
  if (issue === undefined) throw new Error('expected the schema to report an issue')
  return { code: issue.code, path: [...issue.path], message: issue.message }
}

function issueList(parsed: ParseResult): IssueSnapshot[] {
  if (parsed.success) return []
  return (parsed.error?.issues ?? []).map((issue) => ({
    code: issue.code,
    path: [...issue.path],
    message: issue.message,
  }))
}

function expectCustomIssue(
  parsed: ParseResult,
  expected: { path: PropertyKey[]; message: string },
): void {
  expect(parsed.success).toBe(false)
  expect(firstIssue(parsed)).toEqual({
    code: 'custom',
    path: expected.path,
    message: expected.message,
  })
}

function sessionEntry(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return taskEntry({
    mode: 'session',
    content: { scenarioBrief: 'A scope change at stand-up.', turns: [] },
    session: {
      personaId: 'manager',
      personaIds: ['manager', 'peer'],
      personaVersion: '1.0.0',
      scenarioId: 'standup-scope-change',
      scenarioVersion: '1.0.0',
      scriptedUserTurns: ['Sam, what is finished?', 'Katherine, what ships?'],
    },
    ...overrides,
  })
}

function speakerLabel(overrides: Record<string, unknown> = {}): SpeakerLabel {
  const label: SpeakerLabel = {
    turnIndex: 0,
    acceptablePersonaIds: ['peer'],
    allowUserYield: false,
    labelSource: 'agent',
  }
  return { ...label, ...overrides } as SpeakerLabel
}

function routingOutcome(overrides: Record<string, unknown> = {}): RoutingOutcomeLabel {
  const label: RoutingOutcomeLabel = {
    intent: 'confirm-handoff',
    acceptablePersonaIds: ['peer'],
    allowUserYield: false,
    labelSource: 'agent',
  }
  return { ...label, ...overrides } as RoutingOutcomeLabel
}

function outcomeGolden(overrides: Partial<GoldenEntry> = {}): GoldenEntry {
  return goldenEntry({
    routingLabels: undefined,
    dimensionScores: undefined,
    routingOutcome: routingOutcome(),
    ...overrides,
  })
}

function speakerLabelGolden(overrides: Record<string, unknown> = {}): GoldenEntry {
  return {
    ...goldenEntry(),
    routingLabels: undefined,
    dimensionScores: undefined,
    speakerLabels: [speakerLabel({ turnIndex: 0 }), speakerLabel({ turnIndex: 1 })],
    ...overrides,
  } as GoldenEntry
}

describe('task schema constants', () => {
  it('pins the languages, CEFR bands and splits', () => {
    expect(LANGS).toEqual(['en', 'fr'])
    expect(CEFR_BANDS).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'])
    expect(SPLITS).toEqual(['calibration', 'holdout'])
  })

  it.each(['en', 'fr'])('accepts language %s', (lang) => {
    expect(langSchema.parse(lang)).toBe(lang)
  })

  it('rejects an unknown language', () => {
    expect(langSchema.safeParse('de').success).toBe(false)
  })

  it.each(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'])('accepts CEFR band %s', (band) => {
    expect(cefrBandSchema.parse(band)).toBe(band)
  })

  it('rejects an unknown CEFR band', () => {
    expect(cefrBandSchema.safeParse('D1').success).toBe(false)
    expect(cefrBandSchema.safeParse('b1').success).toBe(false)
  })

  it.each(['calibration', 'holdout'])('accepts split %s', (split) => {
    expect(splitSchema.parse(split)).toBe(split)
  })

  it('rejects an unknown split', () => {
    expect(splitSchema.safeParse('test').success).toBe(false)
  })

  it.each(['replay', 'session', 'routing'])('accepts task mode %s', (mode) => {
    expect(taskModeSchema.parse(mode)).toBe(mode)
  })

  it('rejects an unknown task mode', () => {
    expect(taskModeSchema.safeParse('live').success).toBe(false)
  })
})

describe('provenanceSchema contract', () => {
  it('accepts synthetic provenance without a date and with a note', () => {
    expect(provenanceSchema.safeParse({ source: 'synthetic' }).success).toBe(true)
    expect(
      provenanceSchema.safeParse({
        source: 'synthetic',
        note: 'authored for the M0 seed set',
      }).success,
    ).toBe(true)
  })

  it('accepts recorded provenance with a UTC or offset timestamp', () => {
    expect(
      provenanceSchema.safeParse({
        source: 'recorded',
        collectedAt: '2026-10-01T09:30:00Z',
      }).success,
    ).toBe(true)
    expect(
      provenanceSchema.safeParse({
        source: 'recorded',
        collectedAt: '2026-10-01T09:30:00+02:00',
      }).success,
    ).toBe(true)
  })

  it('requires collectedAt for recorded provenance', () => {
    expectCustomIssue(provenanceSchema.safeParse({ source: 'recorded' }), {
      path: ['collectedAt'],
      message: 'recorded provenance must state collectedAt so retention and deletion can be scoped',
    })
  })

  it.each([
    ['unknown source', { source: 'scraped' }],
    ['empty note', { source: 'synthetic', note: '' }],
    ['unknown key', { source: 'synthetic', capturedBy: 'someone' }],
    ['invalid timestamp', { source: 'recorded', collectedAt: 'yesterday' }],
    ['missing source', {}],
  ])('rejects %s', (_name, input) => {
    expect(provenanceSchema.safeParse(input).success).toBe(false)
  })
})

describe('turnSchema and taskContentSchema contract', () => {
  it('accepts both speaker roles', () => {
    expect(
      turnSchema.safeParse({ role: 'user', text: 'Could I have two more days?' }).success,
    ).toBe(true)
    expect(turnSchema.safeParse({ role: 'persona', text: 'How is it going?' }).success).toBe(true)
  })

  it.each([
    ['unknown role', { role: 'system', text: 'Ignored.' }],
    ['empty text', { role: 'user', text: '' }],
    ['unknown key', { role: 'user', text: 'Hello.', speakerId: 'x' }],
    ['missing text', { role: 'user' }],
  ])('turnSchema rejects %s', (_name, input) => {
    expect(turnSchema.safeParse(input).success).toBe(false)
  })

  it('accepts an empty turn list and an optional scenario brief', () => {
    expect(taskContentSchema.safeParse({ turns: [] }).success).toBe(true)
    expect(
      taskContentSchema.safeParse({
        scenarioBrief: 'A learner asks a manager for more time.',
        turns: [{ role: 'user', text: 'Could I have two more days?' }],
      }).success,
    ).toBe(true)
  })

  it.each([
    ['empty scenarioBrief', { scenarioBrief: '', turns: [] }],
    ['unknown key', { turns: [], rubricVersion: 'v1' }],
    ['missing turns', { scenarioBrief: 'A brief.' }],
    ['turn with an unknown key', { turns: [{ role: 'user', text: 'Hi.', id: 't1' }] }],
  ])('taskContentSchema rejects %s', (_name, input) => {
    expect(taskContentSchema.safeParse(input).success).toBe(false)
  })
})

describe('localeTagSchema contract', () => {
  it.each(['en', 'fr', 'en-GB', 'fr-CA', 'en-gb'])('accepts locale %s', (locale) => {
    expect(localeTagSchema.safeParse(locale).success).toBe(true)
  })

  it.each([
    ['a one-character tag', 'e'],
    ['a base language without copy', 'de-DE'],
    ['an unknown tag', 'zz'],
    ['the wrong UK region tag', 'en-UK'],
    ['an empty tag', ''],
  ])('rejects %s', (_name, locale) => {
    expect(localeTagSchema.safeParse(locale).success).toBe(false)
  })

  it('reports the canonical-locale message for a tag outside en and fr', () => {
    expectCustomIssue(localeTagSchema.safeParse('de-DE'), {
      path: [],
      message: 'expected a canonical BCP 47 locale tag with an en or fr base language',
    })
  })
})

describe('sessionTaskSchema contract', () => {
  const validSession = {
    personaId: 'manager',
    personaIds: ['manager', 'peer'],
    personaVersion: '1.0.0',
    scenarioId: 'standup-scope-change',
    scenarioVersion: '1.0.0',
    scriptedUserTurns: ['Sam, what is finished?', 'Katherine, what ships?'],
  }

  it('accepts personas, scripted turns and canned recorded turns', () => {
    expect(sessionTaskSchema.safeParse(validSession).success).toBe(true)
    expect(
      sessionTaskSchema.safeParse({
        ...validSession,
        recordedPersonaTurns: ['Sam: the migration.', 'Katherine: the release.'],
      }).success,
    ).toBe(true)
  })

  it('accepts one or three personas and rejects four', () => {
    expect(sessionTaskSchema.safeParse({ ...validSession, personaIds: ['manager'] }).success).toBe(
      true,
    )
    expect(
      sessionTaskSchema.safeParse({ ...validSession, personaIds: ['manager', 'peer', 'coach'] })
        .success,
    ).toBe(true)
    expect(
      sessionTaskSchema.safeParse({
        ...validSession,
        personaIds: ['manager', 'peer', 'coach', 'narrator'],
      }).success,
    ).toBe(false)
  })

  it.each([
    ['empty personaIds', { personaIds: [] }],
    ['an empty persona id', { personaIds: [''] }],
    ['empty personaId', { personaId: '' }],
    ['empty personaVersion', { personaVersion: '' }],
    ['empty scenarioId', { scenarioId: '' }],
    ['empty scenarioVersion', { scenarioVersion: '' }],
    ['empty scriptedUserTurns', { scriptedUserTurns: [] }],
    ['an empty scripted turn', { scriptedUserTurns: [''] }],
    ['empty recordedPersonaTurns', { recordedPersonaTurns: [] }],
    ['an empty recorded turn', { recordedPersonaTurns: [''] }],
    ['an unknown key', { driver: 'text' }],
    ['missing personaId', { personaId: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(sessionTaskSchema.safeParse({ ...validSession, ...patch }).success).toBe(false)
  })
})

describe('routingTaskSchema contract', () => {
  it('accepts a routing context block', () => {
    expect(routingTaskSchema.safeParse({ context: routingContext }).success).toBe(true)
  })

  it.each([
    ['missing context', {}],
    ['an unknown key', { context: routingContext, decision: 'manager' }],
    ['an empty transcript', { context: { ...routingContext, transcript: [] } }],
    [
      'a single persona',
      { context: { ...routingContext, personas: [routingContext.personas[0]] } },
    ],
  ])('rejects %s', (_name, input) => {
    expect(routingTaskSchema.safeParse(input).success).toBe(false)
  })
})

describe('taskEntrySchema field rules', () => {
  it('defaults mode to replay when the field is absent', () => {
    const parsed = taskEntrySchema.parse({ ...taskEntry(), mode: undefined })
    expect(parsed.mode).toBe('replay')
  })

  it('accepts each task mode', () => {
    expect(taskEntrySchema.safeParse(taskEntry()).success).toBe(true)
    expect(taskEntrySchema.safeParse(sessionEntry()).success).toBe(true)
    expect(taskEntrySchema.safeParse(routingTask()).success).toBe(true)
  })

  it('accepts a locale that matches the base language', () => {
    expect(taskEntrySchema.safeParse(taskEntry({ locale: 'en-GB' })).success).toBe(true)
    expect(taskEntrySchema.safeParse(taskEntry({ locale: 'en' })).success).toBe(true)
  })

  it('accepts non-empty annotation versions', () => {
    expect(
      taskEntrySchema.safeParse(
        taskEntry({ annotationVersions: { rubric: 'v1', annotationGuideline: 'v1' } }),
      ).success,
    ).toBe(true)
  })

  it('rejects empty annotation versions with the declared message', () => {
    expectCustomIssue(taskEntrySchema.safeParse(taskEntry({ annotationVersions: {} })), {
      path: ['annotationVersions'],
      message: 'annotationVersions must name at least one annotation artifact',
    })
  })

  it.each([
    ['empty id', { id: '' }],
    ['unknown lang', { lang: 'de' }],
    ['unknown mode', { mode: 'live' }],
    ['empty domain', { domain: '' }],
    ['empty scenarioType', { scenarioType: '' }],
    ['unknown cefrBand', { cefrBand: 'D1' }],
    ['empty speakerId', { speakerId: '' }],
    ['unknown split', { split: 'test' }],
    ['empty consentScope', { consentScope: '' }],
    ['missing provenance', { provenance: undefined }],
    ['missing content', { content: undefined }],
    ['empty annotation version key', { annotationVersions: { '': 'v1' } }],
    ['empty annotation version value', { annotationVersions: { rubric: '' } }],
    ['an unknown key', { owner: 'nico' }],
  ])('rejects %s', (_name, patch) => {
    expect(taskEntrySchema.safeParse({ ...taskEntry(), ...patch }).success).toBe(false)
  })
})

describe('taskEntrySchema refinements', () => {
  it('rejects a locale whose base language is not the task language', () => {
    expectCustomIssue(taskEntrySchema.safeParse(taskEntry({ locale: 'fr-CA' })), {
      path: ['locale'],
      message: 'locale "fr-CA" does not match base language "en"',
    })
  })

  it('rejects a routing block on a non-routing task', () => {
    expectCustomIssue(
      taskEntrySchema.safeParse({
        ...taskEntry(),
        routing: { context: routingContext },
      }),
      { path: ['routing'], message: "only a routing task may carry a 'routing' block" },
    )
  })

  it('requires a session block for mode session', () => {
    expectCustomIssue(taskEntrySchema.safeParse(sessionEntry({ session: undefined })), {
      path: ['session'],
      message: "a session task requires a 'session' block",
    })
  })

  it('rejects routing context on a session task', () => {
    const parsed = taskEntrySchema.safeParse(sessionEntry({ routing: { context: routingContext } }))
    expect(parsed.success).toBe(false)
    expect(issueList(parsed)).toContainEqual({
      code: 'custom',
      path: ['routing'],
      message: 'a session task cannot carry routing context',
    })
  })

  it('rejects stored turns on a session task', () => {
    expectCustomIssue(
      taskEntrySchema.safeParse(
        sessionEntry({ content: { turns: [{ role: 'user', text: 'A stored turn.' }] } }),
      ),
      {
        path: ['content', 'turns'],
        message: 'a session task must not store persona turns; the model generates them',
      },
    )
  })

  it('rejects duplicate session personaIds', () => {
    const entry = sessionEntry()
    expectCustomIssue(
      taskEntrySchema.safeParse({
        ...entry,
        session: { ...entry.session!, personaIds: ['manager', 'manager'] },
      }),
      {
        path: ['session', 'personaIds'],
        message: 'session personaIds must not repeat',
      },
    )
  })

  it('requires the first session persona to be the opening persona', () => {
    const entry = sessionEntry()
    expectCustomIssue(
      taskEntrySchema.safeParse({
        ...entry,
        session: { ...entry.session!, personaIds: ['peer', 'manager'] },
      }),
      {
        path: ['session', 'personaIds'],
        message: 'the first session persona must be the opening personaId',
      },
    )
  })

  it('requires a routing block for mode routing', () => {
    expectCustomIssue(taskEntrySchema.safeParse(routingTask({ routing: undefined })), {
      path: ['routing'],
      message: "a routing task requires a 'routing' block",
    })
  })

  it('requires the routing decisionId to equal the task id', () => {
    expectCustomIssue(
      taskEntrySchema.safeParse(
        routingTask({ routing: { context: { ...routingContext, decisionId: 'other' } } }),
      ),
      {
        path: ['routing', 'context', 'decisionId'],
        message: 'routing decisionId must equal the task id "en-task-001"',
      },
    )
  })

  it('requires the routing context language to match the task language', () => {
    expectCustomIssue(
      taskEntrySchema.safeParse(
        routingTask({ routing: { context: { ...routingContext, lang: 'fr' } } }),
      ),
      {
        path: ['routing', 'context', 'lang'],
        message: 'routing context language "fr" does not match task language "en"',
      },
    )
  })

  it('rejects a session block on a routing task', () => {
    expectCustomIssue(
      taskEntrySchema.safeParse({
        ...routingTask(),
        session: sessionEntry().session,
      }),
      { path: ['session'], message: 'a routing task cannot carry a session block' },
    )
  })

  it('rejects stored turns on a routing task', () => {
    expectCustomIssue(
      taskEntrySchema.safeParse(
        routingTask({ content: { turns: [{ role: 'user', text: 'A stored turn.' }] } }),
      ),
      {
        path: ['content', 'turns'],
        message: 'a routing task stores its transcript in the routing context',
      },
    )
  })

  it('rejects a session block on a replay task', () => {
    expectCustomIssue(taskEntrySchema.safeParse(taskEntry({ session: sessionEntry().session })), {
      path: ['session'],
      message: "only a session task may carry a 'session' block",
    })
  })

  it('requires at least one recorded turn for a replay task', () => {
    expectCustomIssue(taskEntrySchema.safeParse(taskEntry({ content: { turns: [] } })), {
      path: ['content', 'turns'],
      message: 'a replay task requires at least one recorded turn',
    })
  })
})

describe('annotatorAgreementSchema contract', () => {
  it('accepts a measured agreement block with a note and timestamp', () => {
    expect(
      annotatorAgreementSchema.safeParse({
        annotators: ['annotator-a', 'annotator-b'],
        metric: 'cohen_kappa',
        value: 0.71,
        measuredAt: '2026-10-01T09:30:00+02:00',
        notes: 'Blind double-labelling pass.',
      }).success,
    ).toBe(true)
  })

  it.each([
    ['a single annotator', { annotators: ['annotator-a'] }],
    ['a value of -1', { value: -1 }],
    ['a value of 0', { value: 0 }],
    ['a value of 1', { value: 1 }],
    ['a UTC timestamp', { measuredAt: '2026-10-01T09:30:00Z' }],
  ])('accepts %s', (_name, patch) => {
    expect(
      annotatorAgreementSchema.safeParse({
        annotators: ['annotator-a', 'annotator-b'],
        metric: 'cohen_kappa',
        value: 0.71,
        ...patch,
      }).success,
    ).toBe(true)
  })

  it.each([
    ['empty annotators', { annotators: [] }],
    ['an empty annotator id', { annotators: [''] }],
    ['empty metric', { metric: '' }],
    ['a value above 1', { value: 1.5 }],
    ['a value below -1', { value: -1.5 }],
    ['a NaN value', { value: Number.NaN }],
    ['an infinite value', { value: Number.POSITIVE_INFINITY }],
    ['an invalid timestamp', { measuredAt: 'yesterday' }],
    ['empty notes', { notes: '' }],
    ['an unknown key', { reviewer: 'nico' }],
  ])('rejects %s', (_name, patch) => {
    expect(
      annotatorAgreementSchema.safeParse({
        annotators: ['annotator-a', 'annotator-b'],
        metric: 'cohen_kappa',
        value: 0.71,
        ...patch,
      }).success,
    ).toBe(false)
  })

  it('rejects a missing annotators list', () => {
    expect(annotatorAgreementSchema.safeParse({ metric: 'cohen_kappa', value: 0.5 }).success).toBe(
      false,
    )
  })
})

describe('hasMeasuredAgreement contract', () => {
  it('requires at least two distinct annotators', () => {
    expect(hasMeasuredAgreement(measuredAgreement)).toBe(true)
    expect(hasMeasuredAgreement({ ...measuredAgreement, annotators: ['annotator-a'] })).toBe(false)
    expect(
      hasMeasuredAgreement({ ...measuredAgreement, annotators: ['annotator-a', 'annotator-a'] }),
    ).toBe(false)
  })

  it('rejects a missing or malformed agreement block', () => {
    expect(hasMeasuredAgreement(undefined)).toBe(false)
    expect(hasMeasuredAgreement({})).toBe(false)
    expect(hasMeasuredAgreement('cohen_kappa')).toBe(false)
    expect(hasMeasuredAgreement({ ...measuredAgreement, metric: '' })).toBe(false)
    expect(hasMeasuredAgreement({ ...measuredAgreement, value: 1.5 })).toBe(false)
  })
})

describe('routingOutcomeLabelSchema contract', () => {
  it('accepts one or more personas and both label sources', () => {
    expect(routingOutcomeLabelSchema.safeParse(routingOutcome()).success).toBe(true)
    expect(
      routingOutcomeLabelSchema.safeParse(
        routingOutcome({
          acceptablePersonaIds: ['manager', 'peer'],
          labelSource: 'human',
          note: 'Confirmed by two annotators.',
        }),
      ).success,
    ).toBe(true)
  })

  it('accepts an empty acceptable list only with learner yield', () => {
    expect(
      routingOutcomeLabelSchema.safeParse(
        routingOutcome({ acceptablePersonaIds: [], allowUserYield: true }),
      ).success,
    ).toBe(true)
    expectCustomIssue(
      routingOutcomeLabelSchema.safeParse(
        routingOutcome({ acceptablePersonaIds: [], allowUserYield: false }),
      ),
      {
        path: ['acceptablePersonaIds'],
        message: 'a routing label must accept at least one persona or learner yield',
      },
    )
  })

  it('rejects duplicate acceptable personas', () => {
    expectCustomIssue(
      routingOutcomeLabelSchema.safeParse(
        routingOutcome({ acceptablePersonaIds: ['peer', 'peer'] }),
      ),
      {
        path: ['acceptablePersonaIds'],
        message: 'acceptablePersonaIds must not repeat',
      },
    )
  })

  it.each([
    ['empty intent', { intent: '' }],
    ['an empty persona id', { acceptablePersonaIds: [''] }],
    ['an unknown label source', { labelSource: 'llm' }],
    ['empty note', { note: '' }],
    ['an unknown key', { confidence: 0.9 }],
    ['a missing yield flag', { allowUserYield: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(routingOutcomeLabelSchema.safeParse(routingOutcome(patch)).success).toBe(false)
  })
})

describe('speakerLabelSchema contract', () => {
  it('accepts a first turn and a later turn', () => {
    expect(speakerLabelSchema.safeParse(speakerLabel()).success).toBe(true)
    expect(
      speakerLabelSchema.safeParse(
        speakerLabel({ turnIndex: 3, acceptablePersonaIds: ['manager', 'peer'] }),
      ).success,
    ).toBe(true)
  })

  it('accepts an empty acceptable list only with learner yield', () => {
    expect(
      speakerLabelSchema.safeParse(speakerLabel({ acceptablePersonaIds: [], allowUserYield: true }))
        .success,
    ).toBe(true)
    expectCustomIssue(
      speakerLabelSchema.safeParse(
        speakerLabel({ acceptablePersonaIds: [], allowUserYield: false }),
      ),
      {
        path: ['acceptablePersonaIds'],
        message: 'a speaker label must accept at least one persona or learner yield',
      },
    )
  })

  it('rejects duplicate acceptable personas', () => {
    expectCustomIssue(
      speakerLabelSchema.safeParse(speakerLabel({ acceptablePersonaIds: ['peer', 'peer'] })),
      {
        path: ['acceptablePersonaIds'],
        message: 'acceptablePersonaIds must not repeat',
      },
    )
  })

  it.each([
    ['a negative turn index', { turnIndex: -1 }],
    ['a fractional turn index', { turnIndex: 0.5 }],
    ['an empty persona id', { acceptablePersonaIds: [''] }],
    ['an unknown label source', { labelSource: 'llm' }],
    ['empty note', { note: '' }],
    ['an unknown key', { weight: 1 }],
    ['a missing yield flag', { allowUserYield: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(speakerLabelSchema.safeParse(speakerLabel(patch)).success).toBe(false)
  })
})

describe('label family and distractor fields (M3c P2)', () => {
  it('accepts a family and a distractor flag on a routing outcome', () => {
    const parsed = routingOutcomeLabelSchema.safeParse(
      routingOutcome({ family: 'state-negative', distractor: true }),
    )

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.family).toBe('state-negative')
      expect(parsed.data.distractor).toBe(true)
    }
  })

  it('accepts a family and a false distractor flag on a speaker label', () => {
    const parsed = speakerLabelSchema.safeParse(
      speakerLabel({ family: 'open-question', distractor: false }),
    )

    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.distractor).toBe(false)
  })

  it('keeps both fields optional', () => {
    const parsed = routingOutcomeLabelSchema.parse(routingOutcome())

    expect(parsed.family).toBeUndefined()
    expect(parsed.distractor).toBeUndefined()
  })

  it.each([
    ['an empty family', { family: '' }],
    ['a non-boolean distractor', { distractor: 'yes' }],
  ])('rejects %s', (_name, patch) => {
    expect(routingOutcomeLabelSchema.safeParse(routingOutcome(patch)).success).toBe(false)
    expect(speakerLabelSchema.safeParse(speakerLabel(patch)).success).toBe(false)
  })
})

describe('goldenEntrySchema field rules', () => {
  it('accepts a legacy draft with routing labels and dimension scores', () => {
    expect(goldenEntrySchema.safeParse(goldenEntry()).success).toBe(true)
  })

  it('accepts every status, including stable with measured agreement', () => {
    expect(goldenEntrySchema.safeParse(goldenEntry({ status: 'draft' })).success).toBe(true)
    expect(goldenEntrySchema.safeParse(goldenEntry({ status: 'retired' })).success).toBe(true)
    expect(
      goldenEntrySchema.safeParse(
        goldenEntry({ status: 'stable', annotatorAgreement: measuredAgreement }),
      ).success,
    ).toBe(true)
  })

  it('accepts a locale, a task link and a round-zero trial reference', () => {
    expect(goldenEntrySchema.safeParse(goldenEntry({ locale: 'en-GB' })).success).toBe(true)
    expect(
      goldenEntrySchema.safeParse(
        goldenEntry({
          taskId: 'en-task-001',
          runId: 'run-1',
          round: 0,
          trialId: '0:en:en-task-001',
        }),
      ).success,
    ).toBe(true)
  })

  it.each([
    ['empty id', { id: '' }],
    ['unknown lang', { lang: 'de' }],
    ['unknown split', { split: 'test' }],
    ['invalid locale', { locale: 'e' }],
    ['empty taskId', { taskId: '' }],
    ['empty runId', { runId: '' }],
    ['negative round', { round: -1 }],
    ['fractional round', { round: 1.5 }],
    ['empty trialId', { trialId: '' }],
    ['unknown status', { status: 'ground-truth' }],
    ['empty notes', { notes: '' }],
    ['an unknown key', { reviewer: 'nico' }],
    ['missing evidenceSpans', { evidenceSpans: undefined }],
    ['missing pairwisePreferences', { pairwisePreferences: undefined }],
    ['missing status', { status: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(goldenEntrySchema.safeParse({ ...goldenEntry(), ...patch }).success).toBe(false)
  })

  it.each([
    ['empty intent', { intent: '' }],
    ['empty expected persona', { expectedPersonaId: '' }],
    ['an empty acceptable persona', { acceptablePersonaIds: [''] }],
    ['empty note', { note: '' }],
    ['an unknown key', { confidence: 0.8 }],
  ])('rejects routingLabels with %s', (_name, patch) => {
    expect(
      goldenEntrySchema.safeParse(
        goldenEntry({ routingLabels: { intent: 'confirm', expectedPersonaId: 'peer', ...patch } }),
      ).success,
    ).toBe(false)
  })

  it('accepts routingLabels with an empty acceptable list and a note', () => {
    expect(
      goldenEntrySchema.safeParse(
        goldenEntry({
          routingLabels: {
            intent: 'confirm',
            expectedPersonaId: 'peer',
            acceptablePersonaIds: [],
            note: 'Either persona can answer.',
          },
        }),
      ).success,
    ).toBe(true)
  })

  it.each([
    ['empty intent', { intent: '' }],
    ['an empty acceptable persona', { acceptablePersonaIds: [''] }],
    ['an unknown label source', { labelSource: 'llm' }],
    ['empty note', { note: '' }],
    ['an unknown key', { confidence: 0.8 }],
  ])('rejects a routingOutcome with %s', (_name, patch) => {
    expect(
      goldenEntrySchema.safeParse(outcomeGolden({ routingOutcome: routingOutcome(patch) })).success,
    ).toBe(false)
  })

  it('accepts routingOutcome with an optional note', () => {
    expect(
      goldenEntrySchema.safeParse(
        outcomeGolden({
          routingOutcome: routingOutcome({ labelSource: 'human', note: 'Reviewed.' }),
        }),
      ).success,
    ).toBe(true)
  })

  it.each([
    ['an empty label list', { speakerLabels: [] }],
    ['a negative turn index', { speakerLabels: [speakerLabel({ turnIndex: -1 })] }],
    [
      'an empty acceptable persona',
      { speakerLabels: [speakerLabel({ acceptablePersonaIds: [''] })] },
    ],
    ['an unknown label source', { speakerLabels: [speakerLabel({ labelSource: 'llm' })] }],
    ['an unknown key', { speakerLabels: [{ ...speakerLabel(), weight: 1 }] }],
  ])('rejects speakerLabels with %s', (_name, patch) => {
    expect(goldenEntrySchema.safeParse(speakerLabelGolden(patch)).success).toBe(false)
  })

  it('accepts a single speaker label and three consecutive labels', () => {
    expect(
      goldenEntrySchema.safeParse(
        speakerLabelGolden({ speakerLabels: [speakerLabel({ turnIndex: 0 })] }),
      ).success,
    ).toBe(true)
    expect(
      goldenEntrySchema.safeParse(
        speakerLabelGolden({
          speakerLabels: [
            speakerLabel({ turnIndex: 0 }),
            speakerLabel({ turnIndex: 1, acceptablePersonaIds: ['manager'] }),
            speakerLabel({ turnIndex: 2, acceptablePersonaIds: [], allowUserYield: true }),
          ],
        }),
      ).success,
    ).toBe(true)
  })

  it('accepts dimension scores on the 1-5 scale', () => {
    expect(
      goldenEntrySchema.safeParse(goldenEntry({ dimensionScores: { clarity: { score: 1 } } }))
        .success,
    ).toBe(true)
    expect(
      goldenEntrySchema.safeParse(
        goldenEntry({ dimensionScores: { clarity: { score: 5, rationale: 'Clear ask.' } } }),
      ).success,
    ).toBe(true)
  })

  it('rejects empty dimension scores with the declared message', () => {
    expectCustomIssue(goldenEntrySchema.safeParse(goldenEntry({ dimensionScores: {} })), {
      path: ['dimensionScores'],
      message: 'dimensionScores must contain at least one dimension',
    })
  })

  it.each([
    ['a score below the scale', { clarity: { score: 0 } }],
    ['a score above the scale', { clarity: { score: 6 } }],
    ['a fractional score', { clarity: { score: 4.5 } }],
    ['empty rationale', { clarity: { score: 4, rationale: '' } }],
    ['an unknown key', { clarity: { score: 4, weight: 2 } }],
    ['an empty dimension name', { '': { score: 4 } }],
  ])('rejects dimensionScores with %s', (_name, dimensionScores) => {
    expect(goldenEntrySchema.safeParse(goldenEntry({ dimensionScores })).success).toBe(false)
  })

  it('accepts an evidence span on the first turn', () => {
    expect(
      goldenEntrySchema.safeParse(
        goldenEntry({ evidenceSpans: [{ turnIndex: 0, textRef: 'two more days' }] }),
      ).success,
    ).toBe(true)
  })

  it.each([
    ['a negative turn index', { turnIndex: -1, textRef: 'x' }],
    ['a fractional turn index', { turnIndex: 0.5, textRef: 'x' }],
    ['an empty text reference', { turnIndex: 0, textRef: '' }],
    ['an empty dimension', { turnIndex: 0, textRef: 'x', dimension: '' }],
    ['an empty note', { turnIndex: 0, textRef: 'x', note: '' }],
    ['an unknown key', { turnIndex: 0, textRef: 'x', weight: 1 }],
    ['a missing text reference', { turnIndex: 0 }],
  ])('rejects an evidence span with %s', (_name, span) => {
    expect(goldenEntrySchema.safeParse({ ...goldenEntry(), evidenceSpans: [span] }).success).toBe(
      false,
    )
  })

  it.each([['self'], ['opponent'], ['tie']] as const)('accepts preference %s', (preference) => {
    expect(
      goldenEntrySchema.safeParse(
        goldenEntry({
          pairwisePreferences: [
            {
              opponentId: 'baseline-arm',
              preference,
              presentationOrder: 'self-first',
              blinded: true,
            },
          ],
        }),
      ).success,
    ).toBe(true)
  })

  it.each([['self-first'], ['opponent-first']] as const)(
    'accepts presentation order %s',
    (presentationOrder) => {
      expect(
        goldenEntrySchema.safeParse(
          goldenEntry({
            pairwisePreferences: [
              {
                opponentId: 'baseline-arm',
                preference: 'tie',
                presentationOrder,
                blinded: true,
                note: 'Indistinguishable.',
              },
            ],
          }),
        ).success,
      ).toBe(true)
    },
  )

  it.each([
    ['empty opponentId', { opponentId: '' }],
    ['an unknown preference', { preference: 'both' }],
    ['an unknown presentation order', { presentationOrder: 'random' }],
    ['empty note', { note: '' }],
    ['an unknown key', { weight: 1 }],
    ['a missing blinded flag', { blinded: undefined }],
  ])('rejects a pairwise preference with %s', (_name, patch) => {
    expect(
      goldenEntrySchema.safeParse({
        ...goldenEntry(),
        pairwisePreferences: [
          {
            opponentId: 'baseline-arm',
            preference: 'tie',
            presentationOrder: 'self-first',
            blinded: true,
            ...patch,
          },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('goldenEntrySchema refinements', () => {
  it.each([
    ['runId alone', { runId: 'run-1' }],
    ['round alone', { round: 1 }],
    ['trialId alone', { trialId: '1:en:en-golden-001' }],
    ['taskId and trialId', { taskId: 'en-task-001', trialId: '1:en:en-task-001' }],
    ['taskId and round', { taskId: 'en-task-001', round: 1 }],
    ['round and trialId', { round: 1, trialId: '1:en:en-golden-001' }],
  ])('requires the trial reference as a set: %s', (_name, patch) => {
    const parsed = goldenEntrySchema.safeParse({ ...goldenEntry(), ...patch })
    expect(parsed.success).toBe(false)
    const issues = issueList(parsed)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toEqual({
      code: 'custom',
      path: ['trialId'],
      message: 'runId, round and trialId must be supplied together',
    })
  })

  it('requires trialId to match the harness trial id', () => {
    expectCustomIssue(
      goldenEntrySchema.safeParse(
        goldenEntry({
          taskId: 'en-b1-report-deadline-001',
          runId: 'm2-persona-scenarios-lk',
          round: 2,
          trialId: '3:en:en-b1-report-deadline-001',
        }),
      ),
      {
        path: ['trialId'],
        message: 'trialId must match "2:en:en-b1-report-deadline-001"',
      },
    )
  })

  it('requires one label family', () => {
    expectCustomIssue(
      goldenEntrySchema.safeParse({
        ...goldenEntry(),
        routingLabels: undefined,
        dimensionScores: undefined,
      }),
      {
        path: ['routingLabels'],
        message: 'a golden entry requires routingLabels, routingOutcome or speakerLabels',
      },
    )
  })

  it('rejects legacy routing labels together with a routing outcome', () => {
    expectCustomIssue(
      goldenEntrySchema.safeParse(goldenEntry({ routingOutcome: routingOutcome() })),
      {
        path: ['routingOutcome'],
        message: 'routingLabels and routingOutcome are mutually exclusive',
      },
    )
  })

  it('rejects speaker labels combined with routing labels', () => {
    expectCustomIssue(
      goldenEntrySchema.safeParse(speakerLabelGolden({ routingOutcome: routingOutcome() })),
      {
        path: ['speakerLabels'],
        message: 'speakerLabels cannot be combined with routing labels',
      },
    )
  })

  it('requires speaker labels to start at the first user turn', () => {
    const parsed = goldenEntrySchema.safeParse(
      speakerLabelGolden({ speakerLabels: [speakerLabel({ turnIndex: 2 })] }),
    )
    expect(parsed.success).toBe(false)
    expect(issueList(parsed)).toEqual([
      {
        code: 'custom',
        path: ['speakerLabels', 0, 'turnIndex'],
        message: 'speakerLabels must start at the first user turn (index 0)',
      },
    ])
  })

  it('rejects speaker labels combined with legacy routing labels', () => {
    expectCustomIssue(
      goldenEntrySchema.safeParse({
        ...speakerLabelGolden(),
        routingLabels: { intent: 'confirm', expectedPersonaId: 'peer' },
        dimensionScores: { clarity: { score: 4 } },
      }),
      {
        path: ['speakerLabels'],
        message: 'speakerLabels cannot be combined with routing labels',
      },
    )
  })

  it('requires consecutive speaker label turns', () => {
    expectCustomIssue(
      goldenEntrySchema.safeParse(
        speakerLabelGolden({
          speakerLabels: [speakerLabel({ turnIndex: 0 }), speakerLabel({ turnIndex: 2 })],
        }),
      ),
      {
        path: ['speakerLabels', 1, 'turnIndex'],
        message: 'speakerLabels must cover consecutive user turns in order',
      },
    )
  })

  it('requires dimension scores for legacy routing labels', () => {
    expectCustomIssue(goldenEntrySchema.safeParse(goldenEntry({ dimensionScores: undefined })), {
      path: ['dimensionScores'],
      message: 'a legacy routingLabels entry requires dimensionScores',
    })
  })

  it('refuses stable status for agent routing labels', () => {
    expectCustomIssue(
      goldenEntrySchema.safeParse(
        outcomeGolden({ status: 'stable', annotatorAgreement: measuredAgreement }),
      ),
      {
        path: ['routingOutcome', 'labelSource'],
        message:
          "agent routing labels cannot be 'stable'; only blind human double-labelling can be stable",
      },
    )
  })

  it('refuses stable status for agent speaker labels', () => {
    expectCustomIssue(
      goldenEntrySchema.safeParse(
        speakerLabelGolden({ status: 'stable', annotatorAgreement: measuredAgreement }),
      ),
      {
        path: ['speakerLabels'],
        message:
          "agent speaker labels cannot be 'stable'; only blind human double-labelling can be stable",
      },
    )
  })

  it('accepts stable status for human speaker labels with measured agreement', () => {
    expect(
      goldenEntrySchema.safeParse(
        speakerLabelGolden({
          status: 'stable',
          annotatorAgreement: measuredAgreement,
          speakerLabels: [
            speakerLabel({ turnIndex: 0, labelSource: 'human' }),
            speakerLabel({ turnIndex: 1, labelSource: 'human' }),
          ],
        }),
      ).success,
    ).toBe(true)
  })

  it('still refuses stable status when one speaker label is agent-produced', () => {
    const parsed = goldenEntrySchema.safeParse(
      speakerLabelGolden({
        status: 'stable',
        annotatorAgreement: measuredAgreement,
        speakerLabels: [
          speakerLabel({ turnIndex: 0, labelSource: 'human' }),
          speakerLabel({ turnIndex: 1, labelSource: 'agent' }),
        ],
      }),
    )
    expect(parsed.success).toBe(false)
    expect(firstIssue(parsed).path).toEqual(['speakerLabels'])
  })

  it('requires measured agreement for stable status', () => {
    expectCustomIssue(
      goldenEntrySchema.safeParse(
        outcomeGolden({
          status: 'stable',
          routingOutcome: routingOutcome({ labelSource: 'human' }),
        }),
      ),
      {
        path: ['annotatorAgreement'],
        message:
          "status 'stable' requires a measured annotatorAgreement block with at least 2 distinct annotators, a metric, and a value",
      },
    )
  })

  it('accepts a human-labelled stable entry with two measured annotators', () => {
    expect(
      goldenEntrySchema.safeParse(
        outcomeGolden({
          status: 'stable',
          routingOutcome: routingOutcome({ labelSource: 'human' }),
          annotatorAgreement: measuredAgreement,
        }),
      ).success,
    ).toBe(true)
  })
})
