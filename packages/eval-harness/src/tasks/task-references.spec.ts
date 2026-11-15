import { afterEach, describe, expect, it } from 'vitest'
import type { TaskEntry } from './schema.js'
import type { TaskViolation } from './violations.js'
import {
  checkRequiredMetadata,
  checkRoutingReferences,
  checkSessionReferences,
} from './task-references.js'
import { validateTaskTree } from './validate.js'
import {
  cleanupTempDirs,
  makeTree,
  routingContext,
  routingTask,
  taskEntry,
  taskPath,
} from './task-tree.fixtures.js'

afterEach(cleanupTempDirs)

describe('task references', () => {
  it('flags a task without provenance', async () => {
    const { provenance: _provenance, ...withoutProvenance } = taskEntry()
    const root = await makeTree({
      [taskPath('en', 'no-provenance')]: withoutProvenance,
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toContain('MISSING_PROVENANCE')
    expect(violations[0]?.path).toBe(taskPath('en', 'no-provenance'))
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

function sessionEntry(
  overrides: Partial<NonNullable<TaskEntry['session']>> = {},
  entryOverrides: Partial<TaskEntry> = {},
): TaskEntry {
  return taskEntry({
    id: 'en-session-1',
    mode: 'session',
    content: { turns: [] },
    session: {
      personaId: 'manager',
      personaVersion: '1.0.0',
      scenarioId: 'request-deadline-extension',
      scenarioVersion: '1.0.0',
      scriptedUserTurns: ['Could I have two more days?'],
      ...overrides,
    },
    ...entryOverrides,
  })
}

describe('checkRequiredMetadata', () => {
  it('accepts a complete metadata block', () => {
    expect(checkMeta(taskEntry())).toStrictEqual([])
  })

  it('reports missing provenance with the M0 default hint', () => {
    const { provenance: _provenance, ...raw } = taskEntry()

    expect(checkMeta(raw)).toStrictEqual([
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'MISSING_PROVENANCE',
        message: 'provenance is required (M0 default: { "source": "synthetic" })',
      },
    ])
  })

  it('accepts a provenance value of any shape; the schema validates it later', () => {
    expect(checkMeta({ ...taskEntry(), provenance: null })).toStrictEqual([])
  })

  it.each([[''], [42], [null], [undefined]])(
    'rejects the empty or non-string consentScope %j',
    (consentScope) => {
      expect(checkMeta({ ...taskEntry(), consentScope })).toStrictEqual([
        {
          path: 'evals/tasks/ds/v1/en/a.json',
          code: 'MISSING_CONSENT_SCOPE',
          message: 'consentScope must be a non-empty string',
        },
      ])
    },
  )

  it('accepts a non-empty consentScope', () => {
    expect(
      checkMeta({ ...taskEntry(), consentScope: 'synthetic-no-consent-required' }),
    ).toStrictEqual([])
  })

  it.each([[{}], [[]], ['rubric-v1'], [null]])(
    'rejects annotationVersions %j',
    (annotationVersions) => {
      expect(checkMeta({ ...taskEntry(), annotationVersions })).toStrictEqual([
        {
          path: 'evals/tasks/ds/v1/en/a.json',
          code: 'MISSING_ANNOTATION_VERSIONS',
          message: 'annotationVersions must be a non-empty record of name → version',
        },
      ])
    },
  )

  it('accepts a non-empty annotationVersions record', () => {
    expect(checkMeta({ ...taskEntry(), annotationVersions: { rubric: 'v1' } })).toStrictEqual([])
  })

  it('reports all three metadata violations in the order the rules run', () => {
    const violations = checkMeta({ id: 'task-001', lang: 'en' })

    expect(violations).toStrictEqual([
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'MISSING_PROVENANCE',
        message: 'provenance is required (M0 default: { "source": "synthetic" })',
      },
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'MISSING_CONSENT_SCOPE',
        message: 'consentScope must be a non-empty string',
      },
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'MISSING_ANNOTATION_VERSIONS',
        message: 'annotationVersions must be a non-empty record of name → version',
      },
    ])
  })

  it.each([[null], [[]], ['not an object'], [42]])('ignores the non-record value %j', (raw) => {
    expect(checkMeta(raw)).toStrictEqual([])
  })
})

describe('checkRoutingReferences', () => {
  it('accepts routing personas that are registered', () => {
    expect(checkRouting(routingTask())).toStrictEqual([])
  })

  it('skips a replay task even when it carries a routing block', () => {
    const entry = taskEntry({ routing: routingTask().routing })
    expect(checkRouting(entry)).toStrictEqual([])
  })

  it('does not resolve routing personas for a replay task', () => {
    const entry = routingTask({
      mode: 'replay',
      routing: {
        context: {
          ...routingContext,
          personas: [{ ...routingContext.personas[0]!, id: 'ghost' }],
        },
      },
    })
    expect(checkRouting(entry)).toStrictEqual([])
  })

  it('skips a routing task with no routing block', () => {
    const entry = routingTask({ routing: undefined })
    expect(checkRouting(entry)).toStrictEqual([])
  })

  it('reports every unknown routing persona', () => {
    const entry = routingTask({
      routing: {
        context: {
          ...routingContext,
          personas: [
            { ...routingContext.personas[0]!, id: 'ghost-one' },
            routingContext.personas[1]!,
            { ...routingContext.personas[0]!, id: 'ghost-two' },
          ],
        },
      },
    })

    expect(checkRouting(entry)).toStrictEqual([
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'ROUTING_PERSONA_UNKNOWN',
        message: 'routing persona "ghost-one" does not resolve to a registered persona',
      },
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'ROUTING_PERSONA_UNKNOWN',
        message: 'routing persona "ghost-two" does not resolve to a registered persona',
      },
    ])
  })

  it('accepts a routing task with no personas in its context', () => {
    const entry = routingTask({
      routing: { context: { ...routingContext, personas: [] } },
    })
    expect(checkRouting(entry)).toStrictEqual([])
  })
})

describe('checkSessionReferences', () => {
  it('accepts a session that resolves every reference', () => {
    expect(checkSession(sessionEntry())).toStrictEqual([])
  })

  it('accepts a multi-persona session whose scenario covers both personas', () => {
    const entry = sessionEntry({
      personaIds: ['manager', 'peer'],
      scenarioId: 'standup-scope-change',
      scriptedUserTurns: ['Sam, what is finished?', 'Katherine, what ships?'],
    })
    expect(checkSession(entry)).toStrictEqual([])
  })

  it('uses the entry locale, not the base language, to select variants', () => {
    const entry = sessionEntry({}, { locale: 'fr-CA' })
    expect(checkSession(entry)).toStrictEqual([])
  })

  it('skips a replay task even when it carries a session block', () => {
    const entry = sessionEntry({}, { mode: 'replay' })
    expect(checkSession(entry)).toStrictEqual([])
  })

  it('does not resolve session references for a replay task', () => {
    const entry = sessionEntry({ personaId: 'ghost' }, { mode: 'replay' })
    expect(checkSession(entry)).toStrictEqual([])
  })

  it('skips a session task with no session block', () => {
    expect(checkSession(taskEntry({ mode: 'session' }))).toStrictEqual([])
  })

  it('reports an unknown persona and still checks the other persona ids', () => {
    const entry = sessionEntry({ personaIds: ['ghost', 'manager'] })

    expect(checkSession(entry)).toStrictEqual([
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'SESSION_REFERENCE_MISSING',
        message: 'personaId "ghost" does not resolve to a registered persona',
      },
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'SESSION_PERSONA_MISMATCH',
        message: 'scenario "request-deadline-extension" does not include persona "ghost"',
      },
    ])
  })

  it('reports a persona version mismatch', () => {
    const entry = sessionEntry({ personaVersion: '2.0.0' })

    expect(checkSession(entry)).toStrictEqual([
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'SESSION_VERSION_MISMATCH',
        message: 'persona "manager" is version "1.0.0", not "2.0.0"',
      },
    ])
  })

  it('reports a persona and scenario with no variant for the locale', () => {
    const entry = sessionEntry({}, { locale: 'en-AU' })

    expect(checkSession(entry)).toStrictEqual([
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'SESSION_LOCALE_MISSING',
        message: 'persona "manager" has no variant for locale "en-AU"',
      },
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'SESSION_LOCALE_MISSING',
        message: 'scenario "request-deadline-extension" has no variant for locale "en-AU"',
      },
    ])
  })

  it('reports an unknown scenario without also reporting a persona mismatch', () => {
    const entry = sessionEntry({ personaIds: ['manager', 'peer'], scenarioId: 'ghost-scenario' })

    expect(checkSession(entry)).toStrictEqual([
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'SESSION_REFERENCE_MISSING',
        message: 'scenarioId "ghost-scenario" does not resolve to a registered scenario',
      },
    ])
  })

  it('reports a scenario version mismatch', () => {
    const entry = sessionEntry({ scenarioVersion: '9.9.9' })

    expect(checkSession(entry)).toStrictEqual([
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'SESSION_VERSION_MISMATCH',
        message: 'scenario "request-deadline-extension" is version "1.0.0", not "9.9.9"',
      },
    ])
  })

  it('reports a persona that the scenario does not include', () => {
    const entry = sessionEntry({ personaIds: ['manager', 'client'] })

    expect(checkSession(entry)).toStrictEqual([
      {
        path: 'evals/tasks/ds/v1/en/a.json',
        code: 'SESSION_PERSONA_MISMATCH',
        message: 'scenario "request-deadline-extension" does not include persona "client"',
      },
    ])
  })
})

function checkMeta(raw: unknown): TaskViolation[] {
  const violations: TaskViolation[] = []
  checkRequiredMetadata(raw, 'evals/tasks/ds/v1/en/a.json', violations)
  return violations
}

function checkRouting(entry: TaskEntry): TaskViolation[] {
  const violations: TaskViolation[] = []
  checkRoutingReferences(entry, 'evals/tasks/ds/v1/en/a.json', violations)
  return violations
}

function checkSession(entry: TaskEntry): TaskViolation[] {
  const violations: TaskViolation[] = []
  checkSessionReferences(entry, 'evals/tasks/ds/v1/en/a.json', violations)
  return violations
}
