#!/usr/bin/env node
/**
 * Context-free speaker-label cases (M3c P5).
 *
 * One case is one learner turn in one scripted session. The case carries the
 * scenario state and the learner turns up to that point, never the split, task
 * id, authored label or another pass. Those stay in the operator manifest.
 */
import { createHash } from 'node:crypto'

/** Classify one speaker label by who may speak next. */
export function labelClass(label) {
  if (label.acceptablePersonaIds.length === 0) return 'silence'
  return label.allowUserYield ? 'mixed' : 'speak'
}

/** Stable opaque id for one task turn. */
export function caseIdFor(taskId, turnIndex) {
  return `case-${createHash('sha256').update(`${taskId}:${turnIndex}`).digest('hex').slice(0, 16)}`
}

/**
 * Build the annotator-visible case. `variant` is the scenario locale variant and
 * `personas` are `{ id, displayName }` for every eligible persona.
 */
export function annotatorCase(task, variant, personas, turnIndex) {
  return {
    caseId: caseIdFor(task.id, turnIndex),
    lang: task.lang,
    locale: task.locale,
    turnIndex,
    scenarioBrief: task.content.scenarioBrief ?? '',
    setting: variant.setting,
    learnerRole: variant.learnerRole,
    facts: [...variant.facts],
    objectives: variant.objectives.map((objective) => ({
      id: objective.id,
      description: objective.description,
      ...(objective.personaIds === undefined ? {} : { personaIds: [...objective.personaIds] }),
      ...(objective.keywords === undefined ? {} : { keywords: [...objective.keywords] }),
    })),
    personas,
    learnerTurns: task.session.scriptedUserTurns.slice(0, turnIndex + 1),
  }
}

/** The operator-only row that maps a case back to its task and expected class. */
export function manifestRow(task, turnIndex, expectedClass) {
  return {
    caseId: caseIdFor(task.id, turnIndex),
    taskId: task.id,
    turnIndex,
    lang: task.lang,
    locale: task.locale,
    split: task.split,
    expectedClass,
  }
}
