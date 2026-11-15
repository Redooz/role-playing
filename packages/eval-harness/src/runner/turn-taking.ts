import type { TranscriptRecord } from '@rp/session-core'
import { createDeterministicInvariantGrader, type Grader, type TrialRecord } from './grader.js'
import { labelClass, type LabelClass } from './label-class.js'

/**
 * Code grader for M3b turn-taking.
 *
 * It compares the granted speakers of each scripted user turn with the golden
 * acceptable-speaker set. A turn is acceptable when at least one person who
 * actually spoke is acceptable, so a replacement grant can still satisfy the
 * label; a turn with no grant is judged against `allowUserYield`. Every count
 * and ratio stays in ordinary code; no model is called. A missing label set is
 * a configuration gap, not a zero.
 */
export const TURN_TAKING_GRADER_ID = 'turn-taking-speakers'
export const TURN_TAKING_GRADER_VERSION = '1.1.0'
export const METRIC_ACCEPTABLE_SPEAKER_RATE = 'turn_taking.acceptable_speaker_rate'
/** Higher is better: speak-required turns with a grant to an acceptable persona. */
export const METRIC_REQUIRED_SPEAKER_RATE = 'turn_taking.required_speaker_rate'
/** Higher is better: silence-required turns that granted nobody. */
export const METRIC_SILENCE_APPROPRIATE_RATE = 'turn_taking.silence_appropriate_rate'

interface TurnGrants {
  readonly turnIndex: number
  readonly personaIds: readonly string[]
}

/** One label class's readings; `total` is the denominator. */
export interface TurnClassReading {
  readonly total: number
  readonly appropriate: number
  /** `appropriate / total`; `null` on a zero denominator. */
  readonly rate: number | null
}

interface TurnTally {
  total: number
  appropriate: number
}

function newTurnTally(): TurnTally {
  return { total: 0, appropriate: 0 }
}

function turnClassReading(tally: TurnTally): TurnClassReading {
  return {
    total: tally.total,
    appropriate: tally.appropriate,
    rate: tally.total === 0 ? null : tally.appropriate / tally.total,
  }
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

/**
 * Score one completed trial per label class.
 *
 * `speak` counts a turn as appropriate only when a persona in the label set was
 * granted; a turn with no grant is not appropriate there. `silence` counts a
 * turn as appropriate only when nobody was granted. `mixed` is counted and
 * never rated. A label whose `turnIndex` has no transcript record keeps the
 * existing reading: no grants, so it can only satisfy a silence class.
 */
export function scoreTrialTurnClasses(trial: TrialRecord): {
  readonly speak: TurnClassReading
  readonly silence: TurnClassReading
  readonly mixed: { readonly total: number }
} {
  const speak = newTurnTally()
  const silence = newTurnTally()
  let mixed = 0
  if (!trial.ok || !isMultiPersona(trial) || trial.golden?.speakerLabels === undefined) {
    return {
      speak: turnClassReading(speak),
      silence: turnClassReading(silence),
      mixed: { total: mixed },
    }
  }

  const grants = new Map(grantsByUserTurn(trial.records).map((turn) => [turn.turnIndex, turn]))
  // The same labelled-turn set as `scoreTrialTurnTaking`: one label per turn, so
  // the three class totals always add up to the all-turn denominator.
  const labels = new Map(
    trial.golden.speakerLabels.map((label) => [label.turnIndex, label] as const),
  )
  for (const [turnIndex, label] of labels) {
    const klass: LabelClass = labelClass(label)
    if (klass === 'mixed') {
      mixed += 1
      continue
    }
    const speakers = grants.get(turnIndex)?.personaIds ?? []
    const appropriate =
      klass === 'speak'
        ? speakers.some((personaId) => label.acceptablePersonaIds.includes(personaId))
        : speakers.length === 0
    const tally = klass === 'speak' ? speak : silence
    tally.total += 1
    if (appropriate) tally.appropriate += 1
  }
  return {
    speak: turnClassReading(speak),
    silence: turnClassReading(silence),
    mixed: { total: mixed },
  }
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
      const speak = newTurnTally()
      const silence = newTurnTally()
      for (const trial of trials) {
        const scored = scoreTrialTurnTaking(trial)
        turns += scored.turns
        acceptable += scored.acceptable
        const classes = scoreTrialTurnClasses(trial)
        speak.total += classes.speak.total
        speak.appropriate += classes.speak.appropriate
        silence.total += classes.silence.total
        silence.appropriate += classes.silence.appropriate
      }
      if (turns === 0) {
        throw new Error(
          'turn-taking grader found no labelled multi-persona trials; labels are missing',
        )
      }
      const metrics: Record<string, number> = {
        ...invariantMetrics,
        [METRIC_ACCEPTABLE_SPEAKER_RATE]: acceptable / turns,
      }
      // An empty class is unmeasured, so it is omitted rather than reported as
      // zero: the verdict layer reads a missing metric as inconclusive.
      if (speak.total > 0) metrics[METRIC_REQUIRED_SPEAKER_RATE] = speak.appropriate / speak.total
      if (silence.total > 0) {
        metrics[METRIC_SILENCE_APPROPRIATE_RATE] = silence.appropriate / silence.total
      }
      return metrics
    },
  }
}
