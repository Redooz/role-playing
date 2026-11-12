import { hashValue } from '@rp/shared'
import { type ScenarioSpec, scenarioVariant } from '@rp/scenario-kit'
import { PersonaVariantMissingError, personaVariant } from '../lookup.js'
import type { PersonaSpec } from '../persona.js'
import {
  renderBoundaries,
  renderExamples,
  renderGoals,
  renderHeader,
  renderLanguageAndLocale,
  renderOpening,
  renderRole,
  renderScenarioDetails,
  renderScene,
  renderStyle,
} from './template.js'
import {
  DEFAULT_PROMPT_STYLE,
  DEFAULT_REASONING_EFFORT,
  promptVersionForStyle,
  type PromptStyle,
  type ReasoningEffort,
} from './version.js'
import { renderGemmaPacks } from './template-gemma.js'

/**
 * Deterministic persona prompt builder (M2 D3).
 *
 * The prompt is split into two packs:
 *
 * - **A, greeting pack** — identity, scene, language/locale and the opening
 *   constraint. Enough to produce the first turn and nothing else.
 * - **B, session pack** — goals, boundaries, style, scenario facts, objectives
 *   and examples.
 *
 * The first turn uses A only; later turns use A + B. That makes the first-word
 * path independent of the rest of the scenario: delaying or removing B cannot
 * change a byte of A.
 */

export interface PromptSystemMessage {
  readonly role: 'system'
  readonly content: string
}

export interface BuildPersonaPromptOptions {
  readonly persona: PersonaSpec
  readonly scenario: ScenarioSpec
  readonly locale: string
  /**
   * Pinned `YYYY-MM-DD` date from the run manifest. Never `Date.now()`: the
   * prompt hash must be reproducible.
   */
  readonly currentDate: string
  readonly reasoningEffort?: ReasoningEffort
  /** Prompt family. Defaults to the pinned Groq `harmony` style. */
  readonly style?: PromptStyle
  /** Override only in tests; production uses the style's template constant. */
  readonly promptVersion?: string
}

export interface BuiltPersonaPrompt {
  readonly promptVersion: string
  readonly promptHash: string
  readonly locale: string
  /** Prompt family used to render this prompt. */
  readonly style: PromptStyle
  /** Pack A only, without the Harmony header. */
  readonly greetingPack: string
  /** Pack B only, without the header or pack A. */
  readonly sessionPack: string
  readonly greetingSystemPrompt: string
  readonly sessionSystemPrompt: string
  readonly systemMessages: {
    readonly greeting: readonly PromptSystemMessage[]
    readonly session: readonly PromptSystemMessage[]
  }
}

export class PromptVariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromptVariantError'
  }
}

const PINNED_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Build the two context packs and their hashes. Pure. */
export function buildPersonaPrompt(options: BuildPersonaPromptOptions): BuiltPersonaPrompt {
  if (!PINNED_DATE.test(options.currentDate)) {
    throw new PromptVariantError(
      `currentDate must be a pinned YYYY-MM-DD string, got ${JSON.stringify(options.currentDate)}`,
    )
  }

  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT
  const style = options.style ?? DEFAULT_PROMPT_STYLE
  const promptVersion = options.promptVersion ?? promptVersionForStyle(style)

  // Both lookups are hard failures. A missing locale must never fall back.
  let persona: ReturnType<typeof personaVariant>
  try {
    persona = personaVariant(options.persona, options.locale)
  } catch (error) {
    if (error instanceof PersonaVariantMissingError) throw error
    throw new PromptVariantError(error instanceof Error ? error.message : String(error))
  }
  const scenario = scenarioVariant(options.scenario, options.locale)

  if (!scenario.personaIds.includes(options.persona.id)) {
    throw new PromptVariantError(
      `scenario "${options.scenario.id}" does not include persona "${options.persona.id}"`,
    )
  }
  // A non-opening persona has session instructions but no greeting pack. This
  // changes no existing M2 render: every M2 scenario has one persona and that
  // persona opens. The prompt version therefore stays put until an existing
  // accepted render changes.
  const opens = scenario.opening.personaId === options.persona.id

  let greetingPack: string
  let sessionPack: string
  let greetingSystemPrompt: string
  let sessionSystemPrompt: string

  if (style === 'gemma') {
    const packs = renderGemmaPacks({
      personaId: options.persona.id,
      persona,
      scenario,
      role: options.persona.role,
      organization: options.persona.organization,
      cefrBand: options.scenario.cefrBand,
      currentDate: options.currentDate,
    })
    greetingPack = packs.greetingPack
    sessionPack = packs.sessionPack
    // No Harmony header: Gemma guidance puts the instructions directly in the
    // first user turn and has no analysis/commentary/final channel vocabulary.
    greetingSystemPrompt = greetingPack
    sessionSystemPrompt = `${greetingSystemPrompt}\n\n${sessionPack}`
  } else {
    const header = renderHeader({ currentDate: options.currentDate, reasoningEffort })

    greetingPack = [
      renderRole(persona, options.persona.role, options.persona.organization),
      renderScene(scenario),
      renderLanguageAndLocale(persona, scenario, options.scenario.cefrBand),
      ...(opens ? [renderOpening(persona, scenario)] : []),
    ].join('\n\n')

    const examples = renderExamples(persona)
    sessionPack = [
      renderGoals(persona),
      renderBoundaries(persona),
      renderStyle(persona),
      renderScenarioDetails(scenario, options.persona.id),
      ...(examples === '' ? [] : [examples]),
    ].join('\n\n')

    greetingSystemPrompt = `${header}\n\n# Instructions\n\n${greetingPack}`
    sessionSystemPrompt = `${greetingSystemPrompt}\n\n${sessionPack}`
  }

  const promptHash = hashValue({
    promptVersion,
    style,
    personaId: options.persona.id,
    personaVersion: options.persona.version,
    scenarioId: options.scenario.id,
    scenarioVersion: options.scenario.version,
    locale: persona.locale,
    currentDate: options.currentDate,
    reasoningEffort,
    greetingPack,
    sessionPack,
  })

  return {
    promptVersion,
    promptHash,
    locale: persona.locale,
    style,
    greetingPack,
    sessionPack,
    greetingSystemPrompt,
    sessionSystemPrompt,
    systemMessages: {
      greeting: [{ role: 'system', content: greetingSystemPrompt }],
      session: [{ role: 'system', content: sessionSystemPrompt }],
    },
  }
}
