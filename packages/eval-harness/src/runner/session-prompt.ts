import {
  buildPersonaPrompt,
  personaById,
  PROMPT_TEMPLATE_VERSION,
  promptVersionForStyle,
  type BuiltPersonaPrompt,
  type PromptStyle,
} from '@rp/persona-kit'
import { canonicalizeLocale, hashValue } from '@rp/shared'
import { scenarioById } from '@rp/scenario-kit'
import type { TaskEntry } from '../tasks/schema.js'

/**
 * Session prompt resolution (M2 D7).
 *
 * Resolves the persona, scenario, locale and pinned date a session task names,
 * then renders the versioned prompt family. A missing persona, scenario,
 * version or locale variant is a task error, never a fallback.
 */

/** A session task is missing its prompt date, persona, scenario or script. */
export class SessionTaskError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionTaskError'
  }
}

export interface SessionPromptContext {
  readonly prompt: BuiltPersonaPrompt
  readonly locale: string
}

export interface SessionPersonaPrompt extends SessionPromptContext {
  readonly personaId: string
}

export type SessionPromptMode = 'persona' | 'generic'

function resolvePersonaPrompt(
  task: TaskEntry,
  personaId: string,
  currentDate: string,
  mode: SessionPromptMode,
  style: PromptStyle,
): SessionPromptContext {
  const session = task.session
  if (task.mode !== 'session' || session === undefined) {
    throw new SessionTaskError(`task ${task.id} is not a session task`)
  }

  const locale = canonicalizeLocale(task.locale ?? task.lang)
  if (mode === 'generic') {
    return { prompt: buildGenericPrompt(task.lang, locale, currentDate), locale }
  }

  const persona = personaById(personaId)
  const scenario = scenarioById(session.scenarioId)
  if (persona.version !== session.personaVersion) {
    throw new SessionTaskError(
      `persona ${persona.id} is version ${persona.version}, not ${session.personaVersion}`,
    )
  }
  if (scenario.version !== session.scenarioVersion) {
    throw new SessionTaskError(
      `scenario ${scenario.id} is version ${scenario.version}, not ${session.scenarioVersion}`,
    )
  }

  const prompt = buildPersonaPrompt({ persona, scenario, locale, currentDate, style })
  return { prompt, locale }
}

/** Resolve persona, scenario, locale and render the versioned prompt. */
export function resolveSessionPrompt(
  task: TaskEntry,
  currentDate: string,
  mode: SessionPromptMode = 'persona',
  style: PromptStyle = 'harmony',
): SessionPromptContext {
  const session = task.session
  if (task.mode !== 'session' || session === undefined) {
    throw new SessionTaskError(`task ${task.id} is not a session task`)
  }
  return resolvePersonaPrompt(task, session.personaId, currentDate, mode, style)
}

/**
 * Resolve one prompt per eligible persona in driver order.
 *
 * A single-persona task keeps the M2 path. A multi-persona task requires the
 * persona prompt mode: the generic baseline has one identity and cannot speak as
 * two characters.
 */
export function resolveSessionPrompts(
  task: TaskEntry,
  currentDate: string,
  mode: SessionPromptMode = 'persona',
  style: PromptStyle = 'harmony',
): SessionPersonaPrompt[] {
  const session = task.session
  if (task.mode !== 'session' || session === undefined) {
    throw new SessionTaskError(`task ${task.id} is not a session task`)
  }

  const personaIds = session.personaIds ?? [session.personaId]
  if (personaIds.length > 1 && mode === 'generic') {
    throw new SessionTaskError(
      `task ${task.id} has ${personaIds.length} personas; the generic baseline supports one`,
    )
  }

  return personaIds.map((personaId) => ({
    personaId,
    ...resolvePersonaPrompt(task, personaId, currentDate, mode, style),
  }))
}

/**
 * M1-style generic baseline prompt. It has no persona identity, scenario facts
 * or two-bucket split, so the capability run compares the candidate against the
 * behaviour M1 actually had.
 */
export const GENERIC_PROMPT_TEMPLATE_VERSION = 'm2-generic-baseline-v1'

function buildGenericPrompt(
  lang: 'en' | 'fr',
  locale: string,
  currentDate: string,
): BuiltPersonaPrompt {
  const instruction = [
    '# Instructions',
    'You are a helpful assistant in a workplace role-play.',
    `Reply in ${lang === 'fr' ? 'French' : 'English'} (locale ${locale}).`,
    'Speak in plain text only, with no Markdown or emoji.',
    'Keep each reply short and ask at most one question.',
  ].join('\n')

  const promptVersion = GENERIC_PROMPT_TEMPLATE_VERSION
  const promptHash = hashValue({ mode: 'generic', lang, locale, currentDate, instruction })
  return {
    promptVersion,
    promptHash,
    locale,
    style: 'harmony',
    greetingPack: instruction,
    sessionPack: instruction,
    greetingSystemPrompt: instruction,
    sessionSystemPrompt: instruction,
    systemMessages: {
      greeting: [{ role: 'system', content: instruction }],
      session: [{ role: 'system', content: instruction }],
    },
  }
}

/** The template version a session manifest must agree with. */
export const SESSION_PROMPT_TEMPLATE_VERSION = PROMPT_TEMPLATE_VERSION

/** The template version for each prompt family. */
export const SESSION_PROMPT_TEMPLATE_VERSIONS: Readonly<Record<PromptStyle, string>> = {
  harmony: PROMPT_TEMPLATE_VERSION,
  gemma: promptVersionForStyle('gemma'),
}
