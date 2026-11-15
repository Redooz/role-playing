import { describe, expect, it } from 'vitest'
import { taskEntrySchema, type TaskEntry } from './schema.js'

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
    content: { turns: [{ role: 'user', text: 'Hello.' }] },
    ...overrides,
  } as TaskEntry
}

describe('task locale validation', () => {
  it.each(['e', 'en--GB', 'not_a_tag', ''])(
    'returns an invalid result for the malformed locale %j instead of throwing',
    (locale) => {
      expect(() => taskEntrySchema.safeParse({ ...taskEntry(), locale })).not.toThrow()
      const result = taskEntrySchema.safeParse({ ...taskEntry(), locale })
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.some((issue) => issue.path[0] === 'locale')).toBe(true)
    },
  )

  it('still reports a valid locale whose base language does not match the task', () => {
    const result = taskEntrySchema.safeParse({ ...taskEntry({ lang: 'fr' }), locale: 'en-GB' })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        code: 'custom',
        path: ['locale'],
        message: 'locale "en-GB" does not match base language "fr"',
      }),
    )
  })

  it('accepts a valid locale whose base language matches the task', () => {
    expect(taskEntrySchema.safeParse({ ...taskEntry(), locale: 'en-GB' }).success).toBe(true)
  })
})
