import type { RoutingContext } from './schemas.js'

export interface CentralJudgmentInput {
  readonly anyoneWarranted: number
  readonly selectedPersonaId: string
}

export type CentralJudgmentResult =
  | {
      readonly ok: true
      readonly anyoneWarranted: number
      readonly selectedPersonaId: string
    }
  | {
      readonly ok: false
      readonly reason: 'invalid_probability' | 'unknown_persona'
    }

/**
 * Validate the two central decision-model answers before code uses them.
 *
 * A probability outside [0, 1] or a Choice winner outside the eligible set is an
 * invalid model response, never a speaker. Deadline and fallback policy stay in
 * the runner, not here.
 */
export function interpretCentralJudgment(input: CentralJudgmentInput): CentralJudgmentResult {
  if (
    !Number.isFinite(input.anyoneWarranted) ||
    input.anyoneWarranted < 0 ||
    input.anyoneWarranted > 1
  ) {
    return { ok: false, reason: 'invalid_probability' }
  }
  if (input.selectedPersonaId.length === 0) {
    return { ok: false, reason: 'unknown_persona' }
  }
  return {
    ok: true,
    anyoneWarranted: input.anyoneWarranted,
    selectedPersonaId: input.selectedPersonaId,
  }
}

/** Check that a central judge selected one of the context's eligible personas. */
export function interpretCentralJudgmentForContext(
  context: RoutingContext,
  input: CentralJudgmentInput,
): CentralJudgmentResult {
  const interpreted = interpretCentralJudgment(input)
  if (!interpreted.ok) return interpreted
  if (!context.personas.some((persona) => persona.id === interpreted.selectedPersonaId)) {
    return { ok: false, reason: 'unknown_persona' }
  }
  return interpreted
}
