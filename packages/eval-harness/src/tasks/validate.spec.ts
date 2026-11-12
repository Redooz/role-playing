import type { RoutingContext } from '@rp/routing-policy'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskEntry, GoldenEntry } from './schema.js'
import { validateTaskTree } from './validate.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Writes the given `relative path -> JSON value` map into a fresh temp tree. */
async function makeTree(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rp-eval-tree-'))
  tempDirs.push(root)
  for (const [relativePath, value] of Object.entries(files)) {
    const target = join(root, relativePath)
    await mkdir(dirname(target), { recursive: true })
    const contents = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    await writeFile(target, contents, 'utf8')
  }
  return root
}

function taskPath(
  lang: 'en' | 'fr',
  name: string,
  dataset = 'synthetic-workplace',
  version = 'v1',
): string {
  return `evals/tasks/${dataset}/${version}/${lang}/${name}.json`
}

function goldenPath(lang: 'en' | 'fr', name: string): string {
  return `evals/golden/${lang}/v1/${name}.json`
}

function taskEntry(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 'task-001',
    lang: 'en',
    mode: 'replay',
    domain: 'workplace',
    scenarioType: 'request-deadline-extension',
    cefrBand: 'B1',
    speakerId: 'speaker-001',
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
    id: 'golden-001',
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

const routingContext: RoutingContext = {
  decisionId: 'routing-001',
  turnId: 'turn-001',
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
    id: 'routing-001',
    mode: 'routing',
    content: { scenarioBrief: 'A routing decision.', turns: [] },
    routing: { context: routingContext },
    ...overrides,
  })
}

function routingGolden(overrides: Partial<GoldenEntry> = {}): GoldenEntry {
  return goldenEntry({
    taskId: 'routing-001',
    routingLabels: undefined,
    dimensionScores: undefined,
    routingOutcome: {
      intent: 'confirm-handoff',
      acceptablePersonaIds: ['peer'],
      allowUserYield: false,
      labelSource: 'agent',
    },
    ...overrides,
  })
}

describe('validateTaskTree', () => {
  it('passes a valid English/French tree', async () => {
    const root = await makeTree({
      [taskPath('en', 'cal')]: taskEntry({ id: 'en-1', speakerId: 'en-speaker-cal' }),
      [taskPath('en', 'hold')]: taskEntry({
        id: 'en-2',
        speakerId: 'en-speaker-hold',
        split: 'holdout',
      }),
      [taskPath('fr', 'cal')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker-cal',
      }),
      [goldenPath('en', 'g')]: goldenEntry(),
      [goldenPath('fr', 'g')]: goldenEntry({ id: 'golden-fr-001', lang: 'fr' }),
    })

    expect(await validateTaskTree(root)).toEqual([])
  })

  it('accepts a valid routing task and matching routing label', async () => {
    const root = await makeTree({
      [taskPath('en', 'routing-001')]: routingTask(),
      [goldenPath('en', 'routing-001')]: routingGolden(),
    })
    expect(await validateTaskTree(root)).toEqual([])
  })

  it('flags a routing task without a routing outcome label', async () => {
    const root = await makeTree({
      [taskPath('en', 'routing-001')]: routingTask(),
    })
    expect((await validateTaskTree(root)).map((violation) => violation.code)).toContain(
      'ROUTING_LABEL_MISSING',
    )
  })

  it('flags an unknown routing persona', async () => {
    const root = await makeTree({
      [taskPath('en', 'routing-001')]: routingTask({
        routing: {
          context: {
            ...routingContext,
            personas: [
              routingContext.personas[0]!,
              { ...routingContext.personas[1]!, id: 'ghost' },
            ],
          },
        },
      }),
    })
    expect((await validateTaskTree(root)).map((violation) => violation.code)).toContain(
      'ROUTING_PERSONA_UNKNOWN',
    )
  })

  it('flags an acceptable persona that is not eligible in the task', async () => {
    const root = await makeTree({
      [taskPath('en', 'routing-001')]: routingTask(),
      [goldenPath('en', 'routing-001')]: routingGolden({
        routingOutcome: {
          intent: 'unknown',
          acceptablePersonaIds: ['client'],
          allowUserYield: false,
          labelSource: 'agent',
        },
      }),
    })
    expect((await validateTaskTree(root)).map((violation) => violation.code)).toContain(
      'ROUTING_LABEL_INVALID',
    )
  })

  it('requires a routing label to name its task', async () => {
    const root = await makeTree({
      [taskPath('en', 'routing-001')]: routingTask(),
      [goldenPath('en', 'routing-001')]: routingGolden({ taskId: undefined }),
    })
    expect((await validateTaskTree(root)).map((violation) => violation.code)).toContain(
      'ROUTING_LABEL_INVALID',
    )
  })

  it('rejects a routing label on a replay task', async () => {
    const root = await makeTree({
      [taskPath('en', 'replay-task')]: taskEntry({ id: 'replay-task' }),
      [goldenPath('en', 'replay-task')]: routingGolden({ taskId: 'replay-task' }),
    })
    expect((await validateTaskTree(root)).map((violation) => violation.code)).toContain(
      'ROUTING_LABEL_INVALID',
    )
  })

  it('detects a speaker that leaks across calibration and holdout', async () => {
    const root = await makeTree({
      [taskPath('en', 'cal')]: taskEntry({
        id: 'en-1',
        speakerId: 'shared-speaker',
        split: 'calibration',
      }),
      [taskPath('en', 'hold')]: taskEntry({
        id: 'en-2',
        speakerId: 'shared-speaker',
        split: 'holdout',
      }),
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toEqual([
      'SPLIT_LEAKAGE',
      'SPLIT_LEAKAGE',
    ])
    expect(violations.map((violation) => violation.path)).toEqual([
      taskPath('en', 'cal'),
      taskPath('en', 'hold'),
    ])
  })

  it('scopes the split rule per dataset, version, and language', async () => {
    const root = await makeTree({
      [taskPath('en', 'cal')]: taskEntry({
        id: 'en-1',
        speakerId: 'shared-speaker',
        split: 'calibration',
      }),
      [taskPath('fr', 'hold')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'shared-speaker',
        split: 'holdout',
      }),
      [taskPath('en', 'other-dataset-hold', 'other-workplace')]: taskEntry({
        id: 'other-1',
        speakerId: 'shared-speaker',
        split: 'holdout',
      }),
      [taskPath('en', 'v2-hold', 'synthetic-workplace', 'v2')]: taskEntry({
        id: 'v2-1',
        speakerId: 'shared-speaker',
        split: 'holdout',
      }),
    })

    expect(await validateTaskTree(root)).toEqual([])
  })

  it('flags a task without provenance', async () => {
    const { provenance: _provenance, ...withoutProvenance } = taskEntry()
    const root = await makeTree({
      [taskPath('en', 'no-provenance')]: withoutProvenance,
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toContain('MISSING_PROVENANCE')
    expect(violations[0]?.path).toBe(taskPath('en', 'no-provenance'))
  })

  it('flags a path/entry language mismatch', async () => {
    const root = await makeTree({
      [taskPath('en', 'wrong-lang')]: taskEntry({ lang: 'fr' }),
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toContain('LANG_PATH_MISMATCH')
  })

  it('flags duplicate ids inside one dataset/version/language scope', async () => {
    const root = await makeTree({
      [taskPath('en', 'first')]: taskEntry({ id: 'duplicate-id' }),
      [taskPath('en', 'second')]: taskEntry({ id: 'duplicate-id', speakerId: 'speaker-002' }),
      [taskPath('fr', 'third')]: taskEntry({ id: 'duplicate-id', lang: 'fr' }),
    })

    const violations = await validateTaskTree(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      path: taskPath('en', 'second'),
      code: 'DUPLICATE_ID',
    })
  })

  it('rejects a stable golden entry without measured agreement', async () => {
    const root = await makeTree({
      [goldenPath('en', 'stable')]: goldenEntry({ status: 'stable' }),
    })

    const violations = await validateTaskTree(root)
    expect(violations).toEqual([
      {
        path: goldenPath('en', 'stable'),
        code: 'GOLDEN_AGREEMENT_MISSING',
        message: expect.stringContaining('annotatorAgreement'),
      },
    ])
  })

  it('rejects a stable golden entry with only one annotator', async () => {
    const root = await makeTree({
      [goldenPath('en', 'stable')]: goldenEntry({
        status: 'stable',
        annotatorAgreement: { annotators: ['annotator-a'], metric: 'cohen_kappa', value: 0.8 },
      }),
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toEqual(['GOLDEN_AGREEMENT_MISSING'])
  })

  it('accepts a stable golden entry with measured agreement', async () => {
    const root = await makeTree({
      [goldenPath('en', 'stable')]: goldenEntry({
        status: 'stable',
        annotatorAgreement: {
          annotators: ['annotator-a', 'annotator-b'],
          metric: 'cohen_kappa',
          value: 0.71,
        },
      }),
    })

    expect(await validateTaskTree(root)).toEqual([])
  })

  it('rejects a golden entry whose taskId does not resolve', async () => {
    const root = await makeTree({
      [taskPath('en', 'task')]: taskEntry(),
      [goldenPath('en', 'golden')]: goldenEntry({ taskId: 'missing-task' }),
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toEqual(['GOLDEN_TASK_MISSING'])
  })

  it('rejects a golden entry whose split differs from its task', async () => {
    const root = await makeTree({
      [taskPath('en', 'task')]: taskEntry({ split: 'holdout' }),
      [goldenPath('en', 'golden')]: goldenEntry({ taskId: 'task-001', split: 'calibration' }),
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toEqual(['GOLDEN_TASK_SPLIT_MISMATCH'])
  })

  it('rejects a golden entry that links to a task in another language', async () => {
    const root = await makeTree({
      [taskPath('fr', 'task')]: taskEntry({ id: 'fr-task-001', lang: 'fr' }),
      [goldenPath('en', 'golden')]: goldenEntry({ taskId: 'fr-task-001' }),
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toEqual(['GOLDEN_TASK_MISSING'])
  })

  it('accepts a golden entry linked to a task in the same split', async () => {
    const root = await makeTree({
      [taskPath('en', 'task')]: taskEntry(),
      [goldenPath('en', 'golden')]: goldenEntry({ taskId: 'task-001', split: 'calibration' }),
    })

    expect(await validateTaskTree(root)).toEqual([])
  })

  it('reports schema violations with the failing field', async () => {
    const root = await makeTree({
      [taskPath('en', 'bad-cefr')]: { ...taskEntry(), cefrBand: 'D1' },
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toEqual(['SCHEMA_VIOLATION'])
    expect(violations[0]?.path).toBe(taskPath('en', 'bad-cefr'))
    expect(violations[0]?.message).toContain('cefrBand')
  })

  it('reports files outside the layout contract', async () => {
    const root = await makeTree({
      'evals/tasks/stray.json': taskEntry(),
    })

    const violations = await validateTaskTree(root)
    expect(violations).toEqual([
      {
        path: 'evals/tasks/stray.json',
        code: 'INVALID_LAYOUT',
        message: expect.stringContaining('evals/tasks/<dataset>/<version>/<lang>'),
      },
    ])
  })

  it('reports invalid JSON without throwing', async () => {
    const root = await makeTree({
      [taskPath('en', 'broken')]: '{ "id": ',
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toEqual(['INVALID_JSON'])
  })

  it('reports a missing evals directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-eval-tree-'))
    tempDirs.push(root)

    const violations = await validateTaskTree(root)
    expect(violations).toEqual([
      {
        path: 'evals',
        code: 'EVALS_DIR_MISSING',
        message: expect.stringContaining(root),
      },
    ])
  })

  it('passes the committed evals tree (gate G3)', async () => {
    expect(await validateTaskTree(REPO_ROOT)).toEqual([])
  })
})

describe('seeded task tree', () => {
  it('ships three synthetic tasks per language and one draft golden entry', async () => {
    for (const lang of ['en', 'fr'] as const) {
      const taskDir = join(REPO_ROOT, 'evals/tasks/synthetic-workplace/v1', lang)
      const taskFiles = (await readdir(taskDir)).filter((name) => name.endsWith('.json')).sort()
      expect(taskFiles).toHaveLength(3)

      const entries: TaskEntry[] = []
      for (const fileName of taskFiles) {
        entries.push(JSON.parse(await readFile(join(taskDir, fileName), 'utf8')) as TaskEntry)
      }

      expect(entries.filter((entry) => entry.split === 'calibration')).toHaveLength(2)
      expect(entries.filter((entry) => entry.split === 'holdout')).toHaveLength(1)
      expect(new Set(entries.map((entry) => entry.speakerId)).size).toBe(3)
      for (const entry of entries) {
        expect(entry.lang).toBe(lang)
        expect(entry.provenance.source).toBe('synthetic')
        expect(entry.consentScope).toBe('synthetic-no-consent-required')
      }

      const goldenDir = join(REPO_ROOT, 'evals/golden', lang, 'v1')
      const goldenFile =
        lang === 'en'
          ? 'golden-en-v1-report-deadline-001.json'
          : 'golden-fr-v1-rapport-delai-001.json'
      const golden = JSON.parse(await readFile(join(goldenDir, goldenFile), 'utf8')) as GoldenEntry
      expect(golden.status).toBe('draft')
      expect(golden.annotatorAgreement).toBeUndefined()
    }
  })
})

describe('session task references', () => {
  function sessionTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
    return taskEntry({
      mode: 'session',
      content: { turns: [] },
      session: {
        personaId: 'manager',
        personaVersion: '1.0.0',
        scenarioId: 'request-deadline-extension',
        scenarioVersion: '1.0.0',
        scriptedUserTurns: ['Could I have two more days?'],
      },
      ...overrides,
    })
  }

  it('accepts a session task with a registered persona and scenario', async () => {
    const root = await makeTree({
      [taskPath('en', 'session')]: sessionTask({ id: 'en-session-1' }),
      [taskPath('fr', 'session')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker',
      }),
    })
    expect(await validateTaskTree(root)).toEqual([])
  })

  it('accepts a locale variant task', async () => {
    const root = await makeTree({
      [taskPath('en', 'session')]: sessionTask({ id: 'en-session-1', locale: 'en-GB' }),
      [taskPath('fr', 'session')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker',
      }),
    })
    expect(await validateTaskTree(root)).toEqual([])
  })

  it('reports a missing persona reference', async () => {
    const root = await makeTree({
      [taskPath('en', 'session')]: sessionTask({
        id: 'en-session-1',
        session: {
          personaId: 'ghost',
          personaVersion: '1.0.0',
          scenarioId: 'request-deadline-extension',
          scenarioVersion: '1.0.0',
          scriptedUserTurns: ['Hello?'],
        },
      }),
      [taskPath('fr', 'session')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker',
      }),
    })
    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toContain('SESSION_REFERENCE_MISSING')
  })

  it('reports a locale with no persona variant instead of falling back', async () => {
    const root = await makeTree({
      [taskPath('en', 'session')]: sessionTask({ id: 'en-session-1', locale: 'en-AU' }),
      [taskPath('fr', 'session')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker',
      }),
    })
    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toContain('SESSION_LOCALE_MISSING')
  })

  it('rejects a session task with no session block', async () => {
    const root = await makeTree({
      [taskPath('en', 'session')]: taskEntry({
        id: 'en-session-1',
        mode: 'session',
        content: { turns: [] },
      }),
      [taskPath('fr', 'session')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker',
      }),
    })
    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toContain('SCHEMA_VIOLATION')
  })
})

describe('multi-persona task and speaker-label validation', () => {
  function multiTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
    return taskEntry({
      id: 'en-session-multi',
      mode: 'session',
      scenarioType: 'standup-scope-change',
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
      id: 'golden-en-session-multi',
      taskId: 'en-session-multi',
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
          acceptablePersonaIds: ['manager', 'peer'],
          allowUserYield: false,
          labelSource: 'agent',
        },
      ],
      ...overrides,
    })
  }

  it('accepts a covered multi-persona task and its speaker labels', async () => {
    const root = await makeTree({
      [taskPath('en', 'multi')]: multiTask(),
      [goldenPath('en', 'multi')]: speakerGolden(),
      [taskPath('fr', 'other')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker',
      }),
    })
    expect(await validateTaskTree(root)).toEqual([])
  })

  it('rejects a multi-persona session that lists an unknown persona', async () => {
    const task = multiTask()
    const root = await makeTree({
      [taskPath('en', 'multi')]: {
        ...task,
        session: { ...task.session!, personaIds: ['manager', 'ghost'] },
      },
      [taskPath('fr', 'other')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker',
      }),
    })
    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toContain('SESSION_REFERENCE_MISSING')
  })

  it('rejects a persona that the scenario does not include', async () => {
    const task = multiTask()
    const root = await makeTree({
      [taskPath('en', 'multi')]: {
        ...task,
        session: { ...task.session!, scenarioId: 'request-deadline-extension' },
      },
      [taskPath('fr', 'other')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker',
      }),
    })
    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toContain('SESSION_PERSONA_MISMATCH')
  })

  it('rejects speaker labels on a non-session task or with the wrong count', async () => {
    const replay = taskEntry({ id: 'en-session-multi' })
    const root = await makeTree({
      [taskPath('en', 'multi')]: replay,
      [goldenPath('en', 'multi')]: speakerGolden(),
      [taskPath('fr', 'other')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker',
      }),
    })
    expect((await validateTaskTree(root)).map((violation) => violation.code)).toContain(
      'SPEAKER_LABEL_INVALID',
    )

    const root2 = await makeTree({
      [taskPath('en', 'multi')]: multiTask(),
      [goldenPath('en', 'multi')]: speakerGolden({
        speakerLabels: [
          {
            turnIndex: 0,
            acceptablePersonaIds: ['peer'],
            allowUserYield: false,
            labelSource: 'agent',
          },
        ],
      }),
      [taskPath('fr', 'other')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker',
      }),
    })
    expect((await validateTaskTree(root2)).map((violation) => violation.code)).toContain(
      'SPEAKER_LABEL_INVALID',
    )
  })

  it('rejects an acceptable persona that is not eligible in the task', async () => {
    const root = await makeTree({
      [taskPath('en', 'multi')]: multiTask(),
      [goldenPath('en', 'multi')]: speakerGolden({
        speakerLabels: [
          {
            turnIndex: 0,
            acceptablePersonaIds: ['client'],
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
      }),
      [taskPath('fr', 'other')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker',
      }),
    })
    expect((await validateTaskTree(root)).map((violation) => violation.code)).toContain(
      'SPEAKER_LABEL_INVALID',
    )
  })
})
