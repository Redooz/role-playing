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
