/**
 * Prompt template version (M2 D3/D3a).
 *
 * A prompt is a pure function of versioned inputs. Bumping this string is
 * required whenever a section, its ordering or its wording changes, because it
 * participates in `promptHash` and in the canned request hash.
 */
export const PROMPT_TEMPLATE_VERSION = 'm2-prompt-v1'

/**
 * Gemma prompt template version.
 *
 * A separate version is required because the Gemma pack is a different prompt
 * contract, not another wording of the Harmony pack. A run declares its style
 * and the manifest must name the matching version.
 */
export const GEMMA_PROMPT_TEMPLATE_VERSION = 'm2-prompt-gemma-v1'

/** Prompt families. `harmony` is the pinned Groq persona style. */
export const PROMPT_STYLES = ['harmony', 'gemma'] as const

export type PromptStyle = (typeof PROMPT_STYLES)[number]

export const DEFAULT_PROMPT_STYLE: PromptStyle = 'harmony'

/** The template version a style builds. */
export function promptVersionForStyle(style: PromptStyle): string {
  return style === 'gemma' ? GEMMA_PROMPT_TEMPLATE_VERSION : PROMPT_TEMPLATE_VERSION
}

/** Fixed knowledge cutoff for the Harmony-style header. */
export const PROMPT_KNOWLEDGE_CUTOFF = '2024-06'

/** Reasoning effort written into the header and sent to Groq. */
export type ReasoningEffort = 'low' | 'medium' | 'high'

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low'

/** Fixed model parameters recorded with every prompt (M2 D3). */
export const PERSONA_GENERATION_PARAMETERS = {
  temperature: 0.6,
  topP: 0.95,
  maxCompletionTokens: 512,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  includeReasoning: false,
} as const

/**
 * Regional conventions appended to `## Language and locale`.
 *
 * A locale with no entry still gets its base-language guidance; the entry is
 * content, not a fallback for variant selection.
 */
export const LOCALE_CONVENTIONS: Readonly<Record<string, readonly string[]>> = {
  en: ['Use region-neutral English.', 'Keep spelling and vocabulary consistent within one reply.'],
  'en-GB': [
    'Use British English spelling: organise, prioritise, colour, centre.',
    'Prefer British workplace phrasing such as "sort out", "booked" and "afterwards".',
    'Write dates as day month year, for example 6 November.',
  ],
  fr: [
    'Utilisez un français standard.',
    'Vouvoyez la personne dans un contexte professionnel.',
    'Utilisez la ponctuation française, avec une espace avant les deux-points et le point d’interrogation.',
  ],
  'fr-CA': [
    'Utilisez le français québécois courant : courriel, échéancier, fin de semaine, rencontre.',
    'Évitez les anglicismes inutiles et les tournures proprement européennes.',
    'Vouvoyez la personne dans un contexte professionnel.',
  ],
}

/** Base-language guidance used when only the base language is known. */
export const BASE_LANGUAGE_CONVENTIONS: Readonly<Record<'en' | 'fr', readonly string[]>> = {
  en: ['Reply in English only.', 'Do not switch language because the learner does.'],
  fr: ['Répondez uniquement en français.', 'Ne changez pas de langue si l’apprenant le fait.'],
}
