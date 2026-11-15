import {
  PersonaVariantMissingError,
  PROMPT_TEMPLATE_VERSION,
  type PromptStyle,
} from '@rp/persona-kit'
import { UnknownPersonaError } from '@rp/persona-kit'
import { hashValue, LocaleTagError } from '@rp/shared'
import { UnknownScenarioError } from '@rp/scenario-kit'
import { describe, expect, it } from 'vitest'
import type { TaskEntry } from '../tasks/schema.js'
import { sessionTask, DATE } from './session.fixtures.js'
import {
  GENERIC_PROMPT_TEMPLATE_VERSION,
  SESSION_PROMPT_TEMPLATE_VERSIONS,
  SESSION_PROMPT_TEMPLATE_VERSION,
  SessionTaskError,
  resolveSessionPrompt,
  resolveSessionPrompts,
} from './session-prompt.js'

function genericInstruction(language: 'English' | 'French', locale: string): string {
  return [
    '# Instructions',
    'You are a helpful assistant in a workplace role-play.',
    `Reply in ${language} (locale ${locale}).`,
    'Speak in plain text only, with no Markdown or emoji.',
    'Keep each reply short and ask at most one question.',
  ].join('\n')
}

function withSession(overrides: Record<string, unknown>): TaskEntry {
  return sessionTask({
    session: {
      ...(sessionTask().session as object),
      ...overrides,
    },
  } as Partial<TaskEntry>)
}

function multiPersonaPromptTask(): TaskEntry {
  return sessionTask({
    id: 'en-multi-prompt-001',
    scenarioType: 'standup-scope-change',
    session: {
      ...(sessionTask().session as object),
      personaIds: ['manager', 'peer'],
      scenarioId: 'standup-scope-change',
    },
  } as Partial<TaskEntry>)
}

describe('resolveSessionPrompt', () => {
  it('renders the pinned Harmony persona prompt for the task locale', () => {
    const resolved = resolveSessionPrompt(sessionTask(), DATE)

    expect(resolved.locale).toBe('en')
    expect(resolved.prompt.style).toBe('harmony')
    expect(resolved.prompt.promptVersion).toBe('m2-prompt-v2')
    expect(resolved.prompt.promptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(resolved.prompt.greetingSystemPrompt).toContain('## Opening')
    expect(resolved.prompt.greetingSystemPrompt).not.toContain('## Goals')
    expect(resolved.prompt.sessionSystemPrompt).toContain('## Goals')
    expect(resolved.prompt.systemMessages.greeting).toEqual([
      { role: 'system', content: resolved.prompt.greetingSystemPrompt },
    ])
  })

  it('uses the en-GB variant copy when the task names that locale', () => {
    const resolved = resolveSessionPrompt(
      sessionTask({ locale: 'en-GB', id: 'en-gb-session-deadline-001' }),
      DATE,
    )

    expect(resolved.locale).toBe('en-GB')
    expect(resolved.prompt.locale).toBe('en-GB')
    expect(resolved.prompt.greetingSystemPrompt).toContain('organise')
    expect(resolved.prompt.greetingSystemPrompt).toContain('day month year')
  })

  it('uses the French variant copy and locale conventions', () => {
    const fr = resolveSessionPrompt(
      sessionTask({ lang: 'fr', locale: 'fr', id: 'fr-session-deadline-001' }),
      DATE,
    )
    const frCa = resolveSessionPrompt(
      sessionTask({ lang: 'fr', locale: 'fr-CA', id: 'fr-ca-session-deadline-001' }),
      DATE,
    )

    expect(fr.locale).toBe('fr')
    expect(fr.prompt.locale).toBe('fr')
    expect(fr.prompt.greetingSystemPrompt).toContain('Répondez uniquement en français.')
    expect(frCa.locale).toBe('fr-CA')
    expect(frCa.prompt.locale).toBe('fr-CA')
    expect(frCa.prompt.greetingSystemPrompt).toContain('courriel')
    expect(fr.prompt.promptHash).not.toBe(frCa.prompt.promptHash)
  })

  it('canonicalizes the task locale tag before prompt selection', () => {
    const resolved = resolveSessionPrompt(sessionTask({ locale: 'EN-gb' }), DATE)

    expect(resolved.locale).toBe('en-GB')
    expect(resolved.prompt.locale).toBe('en-GB')
  })

  it('falls back to the task language when the task has no locale', () => {
    const resolved = resolveSessionPrompt(
      sessionTask({ lang: 'fr', locale: undefined, id: 'fr-session-deadline-001' }),
      DATE,
    )

    expect(resolved.locale).toBe('fr')
    expect(resolved.prompt.locale).toBe('fr')
    expect(resolved.prompt.greetingSystemPrompt).toContain('Répondez uniquement en français.')
  })

  it('builds the generic baseline prompt without persona identity', () => {
    const resolved = resolveSessionPrompt(sessionTask(), DATE, 'generic')
    const instruction = genericInstruction('English', 'en')

    expect(resolved.locale).toBe('en')
    expect(resolved.prompt.promptVersion).toBe(GENERIC_PROMPT_TEMPLATE_VERSION)
    expect(resolved.prompt.style).toBe('harmony')
    expect(resolved.prompt.greetingPack).toBe(instruction)
    expect(resolved.prompt.sessionPack).toBe(instruction)
    expect(resolved.prompt.greetingSystemPrompt).toBe(instruction)
    expect(resolved.prompt.sessionSystemPrompt).toBe(instruction)
    expect(resolved.prompt.systemMessages).toStrictEqual({
      greeting: [{ role: 'system', content: instruction }],
      session: [{ role: 'system', content: instruction }],
    })
    expect(resolved.prompt.promptHash).toBe(
      hashValue({ mode: 'generic', lang: 'en', locale: 'en', currentDate: DATE, instruction }),
    )
  })

  it('writes the French generic instruction for a French locale', () => {
    const resolved = resolveSessionPrompt(
      sessionTask({ lang: 'fr', locale: 'fr-CA', id: 'fr-ca-session-deadline-001' }),
      DATE,
      'generic',
    )
    const instruction = genericInstruction('French', 'fr-CA')

    expect(resolved.locale).toBe('fr-CA')
    expect(resolved.prompt.greetingSystemPrompt).toBe(instruction)
    expect(resolved.prompt.promptHash).toBe(
      hashValue({
        mode: 'generic',
        lang: 'fr',
        locale: 'fr-CA',
        currentDate: DATE,
        instruction,
      }),
    )
  })

  it('hashes the generic prompt from every input, not a constant', () => {
    const en = resolveSessionPrompt(sessionTask(), DATE, 'generic')
    const fr = resolveSessionPrompt(
      sessionTask({ lang: 'fr', locale: 'fr', id: 'fr-session-deadline-001' }),
      DATE,
      'generic',
    )
    const later = resolveSessionPrompt(sessionTask(), '2026-12-01', 'generic')

    expect(en.prompt.promptHash).not.toBe(fr.prompt.promptHash)
    expect(en.prompt.promptHash).not.toBe(later.prompt.promptHash)
    expect(resolveSessionPrompt(sessionTask(), DATE, 'generic').prompt.promptHash).toBe(
      en.prompt.promptHash,
    )
  })

  it('renders the Gemma prompt family when the run asks for it', () => {
    const resolved = resolveSessionPrompt(sessionTask(), DATE, 'persona', 'gemma')

    expect(resolved.prompt.style).toBe('gemma')
    expect(resolved.prompt.promptVersion).toBe('m2-prompt-gemma-v2')
    expect(resolved.prompt.greetingSystemPrompt).not.toContain('You are ChatGPT')
    expect(resolved.prompt.greetingSystemPrompt).not.toBe(
      resolveSessionPrompt(sessionTask(), DATE, 'persona', 'harmony').prompt.greetingSystemPrompt,
    )
  })

  it('rejects a task that is not a session task', () => {
    const task = sessionTask({ mode: 'replay' } as Partial<TaskEntry>)

    expect(() => resolveSessionPrompt(task, DATE)).toThrow(SessionTaskError)
    expect(() => resolveSessionPrompt(task, DATE)).toThrow(`task ${task.id} is not a session task`)
  })

  it('rejects a session task without a session block', () => {
    const task = sessionTask({ session: undefined } as Partial<TaskEntry>)

    expect(() => resolveSessionPrompt(task, DATE)).toThrow(`task ${task.id} is not a session task`)
  })

  it('rejects a persona whose version differs from the task pin', () => {
    const task = withSession({ personaVersion: '9.9.9' })

    expect(() => resolveSessionPrompt(task, DATE)).toThrow(SessionTaskError)
    expect(() => resolveSessionPrompt(task, DATE)).toThrow(
      /^persona manager is version 1\.0\.0, not 9\.9\.9$/u,
    )
  })

  it('rejects a scenario whose version differs from the task pin', () => {
    const task = withSession({ scenarioVersion: '9.9.9' })

    expect(() => resolveSessionPrompt(task, DATE)).toThrow(SessionTaskError)
    expect(() => resolveSessionPrompt(task, DATE)).toThrow(
      /^scenario request-deadline-extension is version 1\.0\.0, not 9\.9\.9$/u,
    )
  })

  it('rejects an unknown persona id with the lookup error', () => {
    const task = withSession({ personaId: 'ghost' })

    expect(() => resolveSessionPrompt(task, DATE)).toThrow(UnknownPersonaError)
    expect(() => resolveSessionPrompt(task, DATE)).toThrow('unknown persona "ghost"')
  })

  it('rejects an unknown scenario id with the lookup error', () => {
    const task = withSession({ scenarioId: 'ghost' })

    expect(() => resolveSessionPrompt(task, DATE)).toThrow(UnknownScenarioError)
    expect(() => resolveSessionPrompt(task, DATE)).toThrow('unknown scenario "ghost"')
  })

  it('rejects a locale with no persona variant instead of falling back', () => {
    const task = sessionTask({ locale: 'en-AU' })

    expect(() => resolveSessionPrompt(task, DATE)).toThrow(PersonaVariantMissingError)
    expect(() => resolveSessionPrompt(task, DATE)).toThrow(
      'persona "manager" has no variant for locale "en-AU"',
    )
  })

  it('rejects the en-UK tag instead of mapping it to en-GB', () => {
    const task = sessionTask({ locale: 'en-UK' })

    expect(() => resolveSessionPrompt(task, DATE)).toThrow(LocaleTagError)
    expect(() => resolveSessionPrompt(task, DATE)).toThrow(
      'en-UK is not a valid region tag; use en-GB',
    )
  })
})

describe('resolveSessionPrompts', () => {
  it('returns one prompt for a single-persona task', () => {
    const prompts = resolveSessionPrompts(sessionTask(), DATE)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.personaId).toBe('manager')
    expect(prompts[0]?.locale).toBe('en')
    expect(prompts[0]?.prompt.promptVersion).toBe(PROMPT_TEMPLATE_VERSION)
  })

  it('returns one prompt per persona in driver order', () => {
    const task = multiPersonaPromptTask()
    const prompts = resolveSessionPrompts(task, DATE)

    expect(prompts.map((entry) => entry.personaId)).toEqual(['manager', 'peer'])
    expect(new Set(prompts.map((entry) => entry.prompt.promptHash)).size).toBe(2)
    expect(prompts.every((entry) => entry.locale === 'en')).toBe(true)
  })

  it('uses the same prompt style for every persona', () => {
    const task = multiPersonaPromptTask()
    const prompts = resolveSessionPrompts(task, DATE, 'persona', 'gemma')

    expect(prompts.map((entry) => entry.prompt.style)).toEqual(['gemma', 'gemma'])
    expect(prompts.map((entry) => entry.prompt.promptVersion)).toEqual([
      'm2-prompt-gemma-v2',
      'm2-prompt-gemma-v2',
    ])
  })

  it('allows the generic baseline for a single-persona task', () => {
    const prompts = resolveSessionPrompts(sessionTask(), DATE, 'generic')

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.prompt.promptVersion).toBe(GENERIC_PROMPT_TEMPLATE_VERSION)
  })

  it('refuses the generic baseline for a multi-persona task', () => {
    const task = multiPersonaPromptTask()

    expect(() => resolveSessionPrompts(task, DATE, 'generic')).toThrow(SessionTaskError)
    expect(() => resolveSessionPrompts(task, DATE, 'generic')).toThrow(
      `task ${task.id} has 2 personas; the generic baseline supports one`,
    )
  })

  it('rejects a non-session task before resolving any persona', () => {
    const task = sessionTask({ mode: 'replay' } as Partial<TaskEntry>)

    expect(() => resolveSessionPrompts(task, DATE)).toThrow(`task ${task.id} is not a session task`)
  })

  it('rejects a session task without a session block', () => {
    const task = sessionTask({ session: undefined } as Partial<TaskEntry>)

    expect(() => resolveSessionPrompts(task, DATE)).toThrow(`task ${task.id} is not a session task`)
  })

  it('defaults to persona prompts and the Harmony family', () => {
    const defaults = resolveSessionPrompts(sessionTask(), DATE)
    const explicit = resolveSessionPrompts(sessionTask(), DATE, 'persona', 'harmony')

    expect(defaults).toStrictEqual(explicit)
  })
})

describe('session prompt template constants', () => {
  it('pin each prompt family to its template version', () => {
    expect(SESSION_PROMPT_TEMPLATE_VERSION).toBe('m2-prompt-v2')
    expect(GENERIC_PROMPT_TEMPLATE_VERSION).toBe('m2-generic-baseline-v1')
    expect(SESSION_PROMPT_TEMPLATE_VERSIONS).toStrictEqual({
      harmony: 'm2-prompt-v2',
      gemma: 'm2-prompt-gemma-v2',
    } satisfies Record<PromptStyle, string>)
  })

  it('name the task error so a failed resolution is diagnosable', () => {
    const task = sessionTask({ mode: 'replay' } as Partial<TaskEntry>)
    try {
      resolveSessionPrompt(task, DATE)
      throw new Error('expected resolveSessionPrompt to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SessionTaskError)
      expect((error as Error).name).toBe('SessionTaskError')
    }
  })
})

describe('non-session tasks without a session block', () => {
  function nonSessionWithoutSession(): TaskEntry {
    return sessionTask({ mode: 'replay', session: undefined } as Partial<TaskEntry>)
  }

  it('rejects before reading fields off a missing session block', () => {
    const task = nonSessionWithoutSession()

    expect(() => resolveSessionPrompt(task, DATE)).toThrow(SessionTaskError)
    expect(() => resolveSessionPrompt(task, DATE)).toThrow(`task ${task.id} is not a session task`)
  })

  it('rejects in the multi-persona resolver before reading fields off a missing session', () => {
    const task = nonSessionWithoutSession()

    expect(() => resolveSessionPrompts(task, DATE)).toThrow(SessionTaskError)
    expect(() => resolveSessionPrompts(task, DATE)).toThrow(`task ${task.id} is not a session task`)
  })
})
