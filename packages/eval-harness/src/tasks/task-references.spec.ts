import { afterEach, describe, expect, it } from 'vitest'
import type { TaskEntry } from './schema.js'
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
