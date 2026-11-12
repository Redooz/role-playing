import { parseRoutingContext, type RoutingContext, type RoutingPersona } from '@rp/routing-policy'
import {
  scenarioVariant,
  type ScenarioObjective,
  type ScenarioSpec,
  type ScenarioVariant,
} from '@rp/scenario-kit'
import type { PersonaSpec } from './persona.js'
import { personaVariant } from './lookup.js'

/**
 * Build the public routing context for a multi-persona session turn.
 *
 * The context is derived only from scenario, persona and conversation data
 * that the learner can already see. Gold labels never enter it. The builder is
 * pure: the caller supplies the turn id, the committed history and the
 * scenario version.
 *
 * Persona objectives come from the scenario's scoped objectives in a
 * multi-persona variant and fall back to that persona's registered goals when
 * a scenario has no scoped objective. Existing M2 single-persona data keeps
 * using every applicable objective.
 */

export interface SessionRoutingMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
  /** Present on assistant messages in a multi-persona session. */
  readonly personaId?: string
}

export interface BuildSessionRoutingContextOptions {
  readonly turnId: string
  readonly personas: readonly PersonaSpec[]
  readonly scenario: ScenarioSpec
  readonly locale: string
  readonly messages: readonly SessionRoutingMessage[]
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'what',
  'when',
  'where',
  'which',
  'while',
  'into',
  'your',
  'you',
  'are',
  'was',
  'were',
  'have',
  'has',
  'had',
  'can',
  'could',
  'would',
  'should',
  'les',
  'des',
  'une',
  'aux',
  'avec',
  'pour',
  'dans',
  'sur',
  'est',
  'sont',
  'que',
  'qui',
  'quoi',
  'dont',
  'plus',
  'pas',
  'par',
  'vos',
  'votre',
  'son',
  'ses',
  'leur',
])

function tokens(text: string, lang: 'en' | 'fr'): string[] {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase(lang)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))]
}

/** Concrete terms for a scenario objective; explicit keywords win. */
export function routingKeywordsForObjective(
  objective: ScenarioObjective,
  lang: 'en' | 'fr',
): string[] {
  if (objective.keywords !== undefined) return unique(objective.keywords)
  const phrase = objective.id.replace(/[-_]+/gu, ' ').trim()
  const keywords = unique([phrase, ...tokens(`${phrase} ${objective.description}`, lang)]).slice(
    0,
    8,
  )
  return keywords.length === 0 ? [objective.id] : keywords
}

function scopedObjectives(variant: ScenarioVariant, personaId: string): ScenarioObjective[] {
  return variant.objectives.filter((objective) => objective.personaIds?.includes(personaId))
}

function routingPersona(
  variant: ScenarioVariant,
  persona: PersonaSpec,
  lang: 'en' | 'fr',
): RoutingPersona {
  const personaId = persona.id
  const personaData = personaVariant(persona, variant.locale)
  const objectives = scopedObjectives(variant, personaId)
  const routingObjectives =
    objectives.length > 0
      ? objectives.map((objective) => ({
          id: objective.id,
          description: objective.description,
          keywords: routingKeywordsForObjective(objective, lang),
        }))
      : personaData.goals.map((goal, index) => {
          const keywords = unique(tokens(goal, lang)).slice(0, 6)
          return {
            id: `${personaId}-goal-${index + 1}`,
            description: goal,
            keywords: keywords.length === 0 ? [personaId] : keywords,
          }
        })
  const nameParts = personaData.displayName.split(/\s+/u)
  const firstName = nameParts[0]
  return {
    id: personaId,
    displayName: personaData.displayName,
    aliases: firstName !== undefined && firstName !== personaData.displayName ? [firstName] : [],
    role: persona.role,
    objectives:
      routingObjectives.length > 0
        ? routingObjectives
        : [{ id: `${personaId}-contribution`, description: persona.role, keywords: [personaId] }],
  }
}

/** Build and validate one turn's public routing context. */
export function buildSessionRoutingContext(
  options: BuildSessionRoutingContextOptions,
): RoutingContext {
  if (options.personas.length === 0) throw new Error('a routing context needs a persona')
  const personaIds = options.personas.map((persona) => persona.id)
  if (new Set(personaIds).size !== personaIds.length) {
    throw new Error('routing persona ids must be unique')
  }

  const variant = scenarioVariant(options.scenario, options.locale)
  for (const personaId of personaIds) {
    if (!variant.personaIds.includes(personaId)) {
      throw new Error(`scenario "${options.scenario.id}" does not include persona "${personaId}"`)
    }
  }

  if (options.messages.length === 0) {
    throw new Error('a routing context needs the committed user utterance')
  }
  const last = options.messages.at(-1)
  if (last?.role !== 'user') {
    throw new Error('a routing context must end with a committed user utterance')
  }

  const openingPersonaId = personaIds[0]!
  const personas = options.personas.map((persona) => routingPersona(variant, persona, variant.lang))
  return parseRoutingContext({
    decisionId: options.turnId,
    turnId: options.turnId,
    lang: variant.lang,
    personas,
    coveredObjectiveIds: [],
    transcript: options.messages.map((message) =>
      message.role === 'user'
        ? { speaker: { kind: 'user' }, text: message.content }
        : {
            speaker: {
              kind: 'persona',
              personaId: message.personaId ?? openingPersonaId,
            },
            text: message.content,
          },
    ),
  })
}
