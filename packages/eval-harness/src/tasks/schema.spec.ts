import type { RoutingContext } from '@rp/routing-policy'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { expectedSchemas, writeSchemaFiles } from './generate-schemas.js'
import {
  taskEntrySchema,
  goldenEntrySchema,
  hasMeasuredAgreement,
  type TaskEntry,
  type GoldenEntry,
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
