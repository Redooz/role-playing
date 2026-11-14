import { afterEach, describe, expect, it } from 'vitest'
import type { GoldenEntry, TaskEntry } from './schema.js'
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
