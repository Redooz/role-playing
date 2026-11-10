import type { RoutingContext, RoutingJudgments, RoutingPersona } from './schemas.js'

/** Lowercase and Unicode-normalise text for deterministic matching. */
export function normalizeRoutingText(text: string, lang: RoutingContext['lang']): string {
  return text.normalize('NFKC').toLocaleLowerCase(lang)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Match a whole phrase, not a substring inside another word.
 *
 * `Sam` must match "Sam," and "Sam?" but not "same". Unicode letter/number
 * classes keep accented French words intact.
 */
export function containsRoutingTerm(
  text: string,
  term: string,
  lang: RoutingContext['lang'],
): boolean {
  const normalizedText = normalizeRoutingText(text, lang)
  const normalizedTerm = normalizeRoutingText(term, lang).trim()
  if (normalizedTerm.length === 0) return false

  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedTerm)}([^\\p{L}\\p{N}]|$)`,
    'u',
  )
  return pattern.test(normalizedText)
}

/** The committed utterance is guaranteed by `routingContextSchema` to be last. */
export function lastUserUtterance(context: RoutingContext): string {
  const last = context.transcript.at(-1)
  if (last === undefined || last.speaker.kind !== 'user') {
    throw new Error('routing context has no committed user utterance')
  }
  return last.text
}

/** Whether the learner addressed this persona by display name or alias. */
export function isPersonaAddressed(
  context: RoutingContext,
  persona: RoutingPersona,
  utterance = lastUserUtterance(context),
): boolean {
  return [persona.displayName, ...persona.aliases].some((name) =>
    containsRoutingTerm(utterance, name, context.lang),
  )
}

/** Matched persona objectives that are not already covered by public state. */
export function uncoveredMatchedObjectives(
  context: RoutingContext,
  persona: RoutingPersona,
  utterance = lastUserUtterance(context),
): RoutingPersona['objectives'] {
  const covered = new Set(context.coveredObjectiveIds)
  return persona.objectives.filter(
    (objective) =>
      !covered.has(objective.id) &&
      objective.keywords.some((keyword) => containsRoutingTerm(utterance, keyword, context.lang)),
  )
}

/** Deterministic judgments from public, policy-visible state. */
export function deterministicJudgments(
  context: RoutingContext,
  persona: RoutingPersona,
  utterance = lastUserUtterance(context),
): RoutingJudgments {
  const addressed = isPersonaAddressed(context, persona, utterance)
  const uncovered = uncoveredMatchedObjectives(context, persona, utterance)
  const relevant = addressed || uncovered.length > 0
  const hasUnmetObjective = relevant && persona.objectives.length > uncovered.length

  return {
    directlyAddressed: addressed ? 1 : 0,
    hasRelevantContribution: relevant ? 1 : 0,
    addsUncoveredInformation: uncovered.length > 0 ? 1 : 0,
    hasUnmetRelevantObjective: hasUnmetObjective ? 1 : 0,
    pauseWouldBenefitUser: relevant ? 0 : 1,
  }
}

/** Objective relevance used only by deterministic ranking. */
export function objectiveRelevanceFor(
  context: RoutingContext,
  persona: RoutingPersona,
  utterance = lastUserUtterance(context),
): number {
  if (isPersonaAddressed(context, persona, utterance)) return 1

  const uncovered = uncoveredMatchedObjectives(context, persona, utterance)
  return Math.min(1, uncovered.length / persona.objectives.length)
}

/** Deterministic urgency is a bounded proxy; it never pretends to read emotion. */
export function urgencyFor(
  context: RoutingContext,
  persona: RoutingPersona,
  utterance = lastUserUtterance(context),
): number {
  if (isPersonaAddressed(context, persona, utterance)) return 1
  return uncoveredMatchedObjectives(context, persona, utterance).length > 0 ? 0.6 : 0
}

/** Index of each persona's most recent transcript turn; never-spoken is absent. */
export function lastPersonaTurnIndexes(context: RoutingContext): ReadonlyMap<string, number> {
  const indexes = new Map<string, number>()
  for (const [index, turn] of context.transcript.entries()) {
    if (turn.speaker.kind === 'persona') indexes.set(turn.speaker.personaId, index)
  }
  return indexes
}
