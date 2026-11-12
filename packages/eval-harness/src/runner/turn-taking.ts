import type { TranscriptRecord } from '@rp/session-core'
import { createDeterministicInvariantGrader, type Grader, type TrialRecord } from './grader.js'

/**
 * Code grader for M3b turn-taking.
 *
 * It compares the actual first speaker of each scripted user turn with the
 * golden acceptable-speaker set. Every count and ratio stays in ordinary code;
 * no model is called. A missing label set is a configuration gap, not a zero.
 */
export const TURN_TAKING_GRADER_ID = 'turn-taking-speakers'
export const TURN_TAKING_GRADER_VERSION = '1.0.0'
export const METRIC_ACCEPTABLE_SPEAKER_RATE = 'turn_taking.acceptable_speaker_rate'

interface TurnGrants {
  readonly turnIndex: number
  readonly personaIds: readonly string[]
}

function grantsByUserTurn(records: readonly TranscriptRecord[]): TurnGrants[] {
  let turnIndex = -1
  const turns: TurnGrants[] = []
  for (const record of records) {
    if (record.kind === 'user.utterance.committed') {
      turnIndex += 1
      turns.push({ turnIndex, personaIds: [] })
      continue
    }
    if (record.kind !== 'turn.granted' || turnIndex < 0) continue
    const grant = (record.payload as { grant?: { personaId?: unknown } }).grant
    const personaId = grant?.personaId
    if (typeof personaId !== 'string' || personaId.length === 0) continue
    const current = turns[turnIndex]
    if (current === undefined) continue
    turns[turnIndex] = {
      turnIndex,
      personaIds: [...current.personaIds, personaId],
    }
  }
  return turns
}

function isMultiPersona(trial: TrialRecord): boolean {
  return (trial.task?.session?.personaIds?.length ?? 1) > 1
}

/** Score one completed trial's labelled user turns. */
export function scoreTrialTurnTaking(trial: TrialRecord): {
  readonly turns: number
  readonly acceptable: number
} {
  if (!trial.ok || !isMultiPersona(trial) || trial.golden?.speakerLabels === undefined) {
    return { turns: 0, acceptable: 0 }
  }

  const labels = new Map(
    trial.golden.speakerLabels.map((label) => [label.turnIndex, label] as const),
  )
  const grants = new Map(grantsByUserTurn(trial.records).map((turn) => [turn.turnIndex, turn]))
  let turns = 0
  let acceptable = 0
  for (const [turnIndex, label] of labels) {
    turns += 1
    const speakers = grants.get(turnIndex)?.personaIds ?? []
    const accepted =
      speakers.length === 0
        ? label.allowUserYield
        : speakers.some((personaId) => label.acceptablePersonaIds.includes(personaId))
    if (accepted) acceptable += 1
  }
  return { turns, acceptable }
}

/** Create the M3b turn-taking code grader. */
export function createTurnTakingGrader(): Grader {
  return {
    id: TURN_TAKING_GRADER_ID,
    kind: 'code',
    version: TURN_TAKING_GRADER_VERSION,
    async score(context) {
      const invariantMetrics = await createDeterministicInvariantGrader().score(context)
      const { trials } = context
      let turns = 0
      let acceptable = 0
      for (const trial of trials) {
        const scored = scoreTrialTurnTaking(trial)
        turns += scored.turns
        acceptable += scored.acceptable
      }
      if (turns === 0) {
        throw new Error(
          'turn-taking grader found no labelled multi-persona trials; labels are missing',
        )
      }
      return { ...invariantMetrics, [METRIC_ACCEPTABLE_SPEAKER_RATE]: acceptable / turns }
    },
  }
}
