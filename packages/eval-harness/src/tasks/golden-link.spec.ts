import { afterEach, describe, expect, it } from 'vitest'
import type { GoldenEntry, TaskEntry } from './schema.js'
import type { GoldenLocation, TaskLocation } from './layout.js'
import type { TaskViolation } from './violations.js'
import {
  checkGoldenAgreement,
  checkGoldenTaskLink,
  registerTaskForGolden,
  taskLinkKey,
  type TaskLinkRecord,
} from './golden-link.js'
import { validateTaskTree } from './validate.js'
import {
  cleanupTempDirs,
  goldenEntry,
  goldenPath,
  makeTree,
  routingGolden,
  routingTask,
  taskEntry,
  taskPath,
} from './task-tree.fixtures.js'

afterEach(cleanupTempDirs)

describe('golden entries', () => {
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

const LINK_PATH = 'evals/golden/en/v1/golden.json'

function englishTaskLocation(overrides: Partial<TaskLocation> = {}): TaskLocation {
  return {
    dataset: 'synthetic-workplace',
    version: 'v1',
    lang: 'en',
    scope: 'synthetic-workplace/v1/en',
    ...overrides,
  }
}

function englishGoldenLocation(overrides: Partial<GoldenLocation> = {}): GoldenLocation {
  return { version: 'v1', lang: 'en', scope: 'en/v1', ...overrides }
}

function linkRecord(overrides: Partial<TaskLinkRecord> = {}): TaskLinkRecord {
  return {
    split: 'calibration',
    path: 'evals/tasks/synthetic-workplace/v1/en/task.json',
    ...overrides,
  }
}

function linkMap(
  records: TaskLinkRecord[],
  key: { lang?: string; version?: string; locale?: string; taskId?: string } = {},
): Map<string, TaskLinkRecord[]> {
  return new Map([
    [
      taskLinkKey(
        key.lang ?? 'en',
        key.version ?? 'v1',
        key.locale ?? 'en',
        key.taskId ?? 'task-001',
      ),
      records,
    ],
  ])
}

function sessionTaskEntry(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return taskEntry({
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

function speakerLabels(count: number) {
  return Array.from({ length: count }, (_, turnIndex) => ({
    turnIndex,
    acceptablePersonaIds: ['manager'],
    allowUserYield: false,
    labelSource: 'agent' as const,
  }))
}

describe('taskLinkKey', () => {
  it('joins the four key parts with a NUL separator', () => {
    expect(taskLinkKey('en', 'v1', 'en-GB', 'task-001')).toBe('en\u0000v1\u0000en-GB\u0000task-001')
  })

  it('keeps keys with the same text but different parts distinct', () => {
    expect(taskLinkKey('en', 'v1', 'en', 'a-b')).not.toBe(taskLinkKey('en', 'v1', 'en', 'a\u0000b'))
    expect(taskLinkKey('fr', 'v2', 'fr-CA', 't1')).toBe('fr\u0000v2\u0000fr-CA\u0000t1')
  })
})

describe('registerTaskForGolden', () => {
  it('records a replay task with only its split and path', () => {
    const tasks = new Map<string, TaskLinkRecord[]>()

    registerTaskForGolden(tasks, englishTaskLocation(), taskEntry(), 'evals/tasks/en/task.json')

    expect(tasks).toStrictEqual(
      new Map([
        [
          'en\u0000v1\u0000en\u0000task-001',
          [{ split: 'calibration', path: 'evals/tasks/en/task.json' }],
        ],
      ]),
    )
  })

  it('records the eligible persona ids of a routing task', () => {
    const tasks = new Map<string, TaskLinkRecord[]>()

    registerTaskForGolden(
      tasks,
      englishTaskLocation(),
      routingTask(),
      'evals/tasks/en/routing.json',
    )

    expect(tasks.get('en\u0000v1\u0000en\u0000routing-001')).toStrictEqual([
      {
        split: 'calibration',
        path: 'evals/tasks/en/routing.json',
        routing: { eligiblePersonaIds: ['manager', 'peer'] },
      },
    ])
  })

  it('records the persona ids and scripted-turn count of a session task', () => {
    const tasks = new Map<string, TaskLinkRecord[]>()

    registerTaskForGolden(
      tasks,
      englishTaskLocation(),
      sessionTaskEntry({ id: 'en-session-multi' }),
      'evals/tasks/en/session.json',
    )

    expect(tasks.get('en\u0000v1\u0000en\u0000en-session-multi')).toStrictEqual([
      {
        split: 'calibration',
        path: 'evals/tasks/en/session.json',
        session: { personaIds: ['manager', 'peer'], turns: 2 },
      },
    ])
  })

  it('falls back to the single personaId when personaIds is absent', () => {
    const tasks = new Map<string, TaskLinkRecord[]>()

    registerTaskForGolden(
      tasks,
      englishTaskLocation(),
      sessionTaskEntry({
        id: 'en-session-single',
        session: {
          personaId: 'manager',
          personaVersion: '1.0.0',
          scenarioId: 'request-deadline-extension',
          scenarioVersion: '1.0.0',
          scriptedUserTurns: ['Could I have two more days?'],
        },
      }),
      'evals/tasks/en/single.json',
    )

    expect(tasks.get('en\u0000v1\u0000en\u0000en-session-single')).toStrictEqual([
      {
        split: 'calibration',
        path: 'evals/tasks/en/single.json',
        session: { personaIds: ['manager'], turns: 1 },
      },
    ])
  })

  it('keys by the entry locale when it is set, and by the path language otherwise', () => {
    const tasks = new Map<string, TaskLinkRecord[]>()

    registerTaskForGolden(
      tasks,
      englishTaskLocation(),
      taskEntry({ id: 'en-GB-task', locale: 'en-GB' }),
      'evals/tasks/en/gb.json',
    )
    registerTaskForGolden(
      tasks,
      englishTaskLocation({ lang: 'fr', scope: 'synthetic-workplace/v1/fr' }),
      taskEntry({ id: 'fr-task', lang: 'fr' }),
      'evals/tasks/fr/task.json',
    )

    expect([...tasks.keys()]).toStrictEqual([
      'en\u0000v1\u0000en-GB\u0000en-GB-task',
      'fr\u0000v1\u0000fr\u0000fr-task',
    ])
  })

  it('appends to the existing records for a duplicate task instead of replacing them', () => {
    const tasks = new Map<string, TaskLinkRecord[]>()

    registerTaskForGolden(tasks, englishTaskLocation(), taskEntry(), 'evals/tasks/en/first.json')
    registerTaskForGolden(
      tasks,
      englishTaskLocation(),
      taskEntry({ split: 'holdout' }),
      'evals/tasks/en/second.json',
    )

    expect(tasks.get('en\u0000v1\u0000en\u0000task-001')).toStrictEqual([
      { split: 'calibration', path: 'evals/tasks/en/first.json' },
      { split: 'holdout', path: 'evals/tasks/en/second.json' },
    ])
  })
})

describe('checkGoldenAgreement', () => {
  const measured = {
    annotators: ['annotator-a', 'annotator-b'],
    metric: 'cohen_kappa',
    value: 0.8,
  }

  it('accepts a stable entry with measured agreement and reports no violation', () => {
    const violations: TaskViolation[] = []

    const missing = checkGoldenAgreement(
      { status: 'stable', annotatorAgreement: measured },
      LINK_PATH,
      violations,
    )

    expect(missing).toBe(false)
    expect(violations).toStrictEqual([])
  })

  it('reports a stable entry without agreement under GOLDEN_AGREEMENT_MISSING', () => {
    const violations: TaskViolation[] = []

    const missing = checkGoldenAgreement({ status: 'stable' }, LINK_PATH, violations)

    expect(missing).toBe(true)
    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'GOLDEN_AGREEMENT_MISSING',
        message:
          "status 'stable' requires annotatorAgreement measured with at least 2 distinct annotators, a metric, and a value",
      },
    ])
  })

  it.each([
    ['one annotator', { ...measured, annotators: ['annotator-a'] }],
    ['a repeated annotator', { ...measured, annotators: ['annotator-a', 'annotator-a'] }],
    ['a blank metric', { ...measured, metric: '' }],
    ['a missing value', { annotators: measured.annotators, metric: measured.metric }],
  ])('rejects a stable entry with %s', (_name, annotatorAgreement) => {
    const violations: TaskViolation[] = []

    const missing = checkGoldenAgreement(
      { status: 'stable', annotatorAgreement },
      LINK_PATH,
      violations,
    )

    expect(missing).toBe(true)
    expect(violations.map((violation) => violation.code)).toStrictEqual([
      'GOLDEN_AGREEMENT_MISSING',
    ])
  })

  it('ignores a draft entry without agreement', () => {
    const violations: TaskViolation[] = []

    const missing = checkGoldenAgreement({ status: 'draft' }, LINK_PATH, violations)

    expect(missing).toBe(false)
    expect(violations).toStrictEqual([])
  })

  it.each([
    ['null', null],
    ['an array', [{ status: 'stable' }]],
    ['a string', 'stable'],
    ['a number', 42],
    ['undefined', undefined],
    ['a boolean', true],
  ])('treats %s as not a golden record', (_name, raw) => {
    const violations: TaskViolation[] = []

    const missing = checkGoldenAgreement(raw, LINK_PATH, violations)

    expect(missing).toBe(false)
    expect(violations).toStrictEqual([])
  })
})

describe('checkGoldenTaskLink', () => {
  it('reports a locale whose base language differs from the path language', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord({ session: { personaIds: ['manager'], turns: 1 } })])

    checkGoldenTaskLink(
      goldenEntry({ taskId: 'task-001', locale: 'fr-CA' }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'GOLDEN_LOCALE_MISMATCH',
        message: 'entry locale "fr-CA" does not match path language "en"',
      },
      {
        path: LINK_PATH,
        code: 'GOLDEN_TASK_MISSING',
        message:
          'taskId "task-001" does not resolve to a task with lang "en", locale "fr-CA" and version "v1"',
      },
    ])
  })

  it('accepts a regional locale of the same base language', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord()], { locale: 'en-GB' })

    checkGoldenTaskLink(
      goldenEntry({ taskId: 'task-001', locale: 'en-GB' }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([])
  })

  it('requires a routing outcome to name its task', () => {
    const violations: TaskViolation[] = []

    checkGoldenTaskLink(
      goldenEntry({
        taskId: undefined,
        routingLabels: undefined,
        dimensionScores: undefined,
        routingOutcome: {
          intent: 'confirm-handoff',
          acceptablePersonaIds: ['peer'],
          allowUserYield: false,
          labelSource: 'agent',
        },
      }),
      englishGoldenLocation(),
      LINK_PATH,
      new Map(),
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'ROUTING_LABEL_INVALID',
        message: 'a routingOutcome label must name the routing taskId it labels',
      },
    ])
  })

  it('requires speaker labels to name their task', () => {
    const violations: TaskViolation[] = []

    checkGoldenTaskLink(
      goldenEntry({
        taskId: undefined,
        routingLabels: undefined,
        dimensionScores: undefined,
        speakerLabels: speakerLabels(1),
      }),
      englishGoldenLocation(),
      LINK_PATH,
      new Map(),
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'SPEAKER_LABEL_INVALID',
        message: 'a speakerLabels entry must name the session taskId it labels',
      },
    ])
  })

  it('reports an unlinked golden entry with no task, routing or speaker labels', () => {
    const violations: TaskViolation[] = []

    checkGoldenTaskLink(
      goldenEntry({ taskId: undefined, routingLabels: undefined, dimensionScores: undefined }),
      englishGoldenLocation(),
      LINK_PATH,
      new Map(),
      violations,
    )

    expect(violations).toStrictEqual([])
  })

  it('reports a taskId that does not resolve in the same language, locale and version', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord()])

    checkGoldenTaskLink(
      goldenEntry({ taskId: 'missing-task' }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'GOLDEN_TASK_MISSING',
        message:
          'taskId "missing-task" does not resolve to a task with lang "en", locale "en" and version "v1"',
      },
    ])
  })

  it('reports a key that maps to an empty record list', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([])

    checkGoldenTaskLink(
      goldenEntry({ taskId: 'task-001' }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'GOLDEN_TASK_MISSING',
        message:
          'taskId "task-001" does not resolve to a task with lang "en", locale "en" and version "v1"',
      },
    ])
  })

  it('reports a split that differs from the task split', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord()])

    checkGoldenTaskLink(
      goldenEntry({ taskId: 'task-001', split: 'holdout' }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'GOLDEN_TASK_SPLIT_MISMATCH',
        message: 'golden entry split "holdout" does not match task "task-001" split (calibration)',
      },
    ])
  })

  it('accepts a split that matches one of several duplicate task records', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord(), linkRecord({ split: 'holdout' })])

    checkGoldenTaskLink(
      goldenEntry({ taskId: 'task-001', split: 'holdout' }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([])
  })

  it('reports speaker labels that point at a non-session task', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord()])

    checkGoldenTaskLink(
      goldenEntry({
        taskId: 'task-001',
        routingLabels: undefined,
        dimensionScores: undefined,
        speakerLabels: speakerLabels(1),
      }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'SPEAKER_LABEL_INVALID',
        message: 'speakerLabels point at task "task-001", which is not a session task',
      },
    ])
  })

  it('reports speaker labels whose count does not cover every scripted turn', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord({ session: { personaIds: ['manager', 'peer'], turns: 2 } })])

    checkGoldenTaskLink(
      goldenEntry({
        taskId: 'task-001',
        routingLabels: undefined,
        dimensionScores: undefined,
        speakerLabels: speakerLabels(1),
      }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'SPEAKER_LABEL_INVALID',
        message: 'speakerLabels cover 1 turn(s), but task "task-001" has 2 scripted user turn(s)',
      },
    ])
  })

  it('reports a turn index at or beyond the scripted turns', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord({ session: { personaIds: ['manager', 'peer'], turns: 2 } })])

    checkGoldenTaskLink(
      goldenEntry({
        taskId: 'task-001',
        routingLabels: undefined,
        dimensionScores: undefined,
        speakerLabels: [
          {
            turnIndex: 0,
            acceptablePersonaIds: ['manager'],
            allowUserYield: false,
            labelSource: 'agent',
          },
          {
            turnIndex: 2,
            acceptablePersonaIds: ['peer'],
            allowUserYield: false,
            labelSource: 'agent',
          },
        ],
      }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'SPEAKER_LABEL_INVALID',
        message: 'speakerLabels turnIndex 2 is outside task "task-001"',
      },
    ])
  })

  it('reports an acceptable speaker who is not eligible in the session task', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord({ session: { personaIds: ['manager', 'peer'], turns: 2 } })])

    checkGoldenTaskLink(
      goldenEntry({
        taskId: 'task-001',
        routingLabels: undefined,
        dimensionScores: undefined,
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
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'SPEAKER_LABEL_INVALID',
        message: 'acceptable persona "client" is not eligible in session task "task-001"',
      },
    ])
  })

  it('accepts complete speaker labels for a multi-persona session', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord({ session: { personaIds: ['manager', 'peer'], turns: 2 } })])

    checkGoldenTaskLink(
      goldenEntry({
        taskId: 'task-001',
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
      }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([])
  })

  it('does not confuse the missing record with a session mismatch', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([
      linkRecord({ split: 'holdout', session: { personaIds: ['manager'], turns: 1 } }),
    ])

    checkGoldenTaskLink(
      goldenEntry({
        taskId: 'task-001',
        routingLabels: undefined,
        dimensionScores: undefined,
        speakerLabels: speakerLabels(1),
      }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'GOLDEN_TASK_SPLIT_MISMATCH',
        message: 'golden entry split "calibration" does not match task "task-001" split (holdout)',
      },
      {
        path: LINK_PATH,
        code: 'SPEAKER_LABEL_INVALID',
        message: 'speakerLabels point at task "task-001", which is not a session task',
      },
    ])
  })

  it('reports a routing outcome that points at a non-routing task', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord()])
    const routingOutcome = {
      intent: 'confirm-handoff',
      acceptablePersonaIds: ['peer'],
      allowUserYield: false,
      labelSource: 'agent' as const,
    }

    checkGoldenTaskLink(
      goldenEntry({
        taskId: 'task-001',
        routingLabels: undefined,
        dimensionScores: undefined,
        routingOutcome,
      }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'ROUTING_LABEL_INVALID',
        message: 'routingOutcome label points at task "task-001", which is not a routing task',
      },
    ])
  })

  it('does not confuse the missing routing record with a routing mismatch', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([
      linkRecord({ split: 'holdout', routing: { eligiblePersonaIds: ['peer'] } }),
    ])

    checkGoldenTaskLink(
      goldenEntry({
        taskId: 'task-001',
        routingLabels: undefined,
        dimensionScores: undefined,
        routingOutcome: {
          intent: 'confirm-handoff',
          acceptablePersonaIds: ['peer'],
          allowUserYield: false,
          labelSource: 'agent',
        },
      }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'GOLDEN_TASK_SPLIT_MISMATCH',
        message: 'golden entry split "calibration" does not match task "task-001" split (holdout)',
      },
      {
        path: LINK_PATH,
        code: 'ROUTING_LABEL_INVALID',
        message: 'routingOutcome label points at task "task-001", which is not a routing task',
      },
    ])
  })

  it('reports an acceptable persona who is not eligible in the routing task', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord({ routing: { eligiblePersonaIds: ['peer'] } })])

    checkGoldenTaskLink(
      goldenEntry({
        taskId: 'task-001',
        routingLabels: undefined,
        dimensionScores: undefined,
        routingOutcome: {
          intent: 'confirm-handoff',
          acceptablePersonaIds: ['manager', 'peer'],
          allowUserYield: false,
          labelSource: 'agent',
        },
      }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([
      {
        path: LINK_PATH,
        code: 'ROUTING_LABEL_INVALID',
        message: 'acceptable persona "manager" is not eligible in task "task-001"',
      },
    ])
  })

  it('accepts a routing outcome whose personas are all eligible', () => {
    const violations: TaskViolation[] = []
    const tasks = linkMap([linkRecord({ routing: { eligiblePersonaIds: ['peer'] } })])

    checkGoldenTaskLink(
      goldenEntry({
        taskId: 'task-001',
        routingLabels: undefined,
        dimensionScores: undefined,
        routingOutcome: {
          intent: 'confirm-handoff',
          acceptablePersonaIds: ['peer'],
          allowUserYield: true,
          labelSource: 'agent',
        },
      }),
      englishGoldenLocation(),
      LINK_PATH,
      tasks,
      violations,
    )

    expect(violations).toStrictEqual([])
  })
})
