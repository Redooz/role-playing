/**
 * Classifies one routing or speaker label by who is allowed to speak.
 *
 * Both code graders share this single rule instead of copying it: a label either
 * requires a persona to speak, requires the learner to continue alone, or accepts
 * both (`mixed`, reported but never folded into a class rate).
 *
 * It lives under `tasks/` because the task walker also classifies labels when it
 * checks a version's `composition.json`. The validation layer must not import
 * from `runner/`, so the shared rule sits on the side the walker owns.
 */

/** The three label classes, in report order. */
export const LABEL_CLASSES = ['speak', 'silence', 'mixed'] as const

/** Who a label requires to produce the next turn. */
export type LabelClass = (typeof LABEL_CLASSES)[number]

/** The two label fields the class rule reads; every label family carries both. */
export interface LabelClassInput {
  readonly acceptablePersonaIds: readonly string[]
  readonly allowUserYield: boolean
}

/**
 * Classify one label.
 *
 * A label that accepts neither a persona nor a learner yield is rejected by
 * `routingOutcomeLabelSchema` and `speakerLabelSchema`; it is never classified
 * here, because guessing a class would manufacture a denominator.
 */
export function labelClass(label: LabelClassInput): LabelClass {
  if (label.acceptablePersonaIds.length > 0) return label.allowUserYield ? 'mixed' : 'speak'
  if (!label.allowUserYield) {
    throw new Error('a label must accept at least one persona or learner yield')
  }
  return 'silence'
}
