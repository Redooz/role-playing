import { z } from 'zod'

/**
 * Atomic self-directed move judgments from rubric v2 (M3d D2).
 *
 * Each Noul answers one narrow question about the learner's last utterance.
 * Ownership and the speaking decision are code, never a model judgment.
 */
export const routingMoveJudgmentsSchema = z.strictObject({
  closingMove: z.number().min(0).max(1),
  selfAnswer: z.number().min(0).max(1),
  thinkingAloud: z.number().min(0).max(1),
  sideComment: z.number().min(0).max(1),
})

export type RoutingMoveJudgments = z.infer<typeof routingMoveJudgmentsSchema>

/** Persona-arm move judgments add direct address, used only to rank owners. */
export const routingPersonaMoveJudgmentsSchema = routingMoveJudgmentsSchema.extend({
  directlyAddressed: z.number().min(0).max(1),
})

export type RoutingPersonaMoveJudgments = z.infer<typeof routingPersonaMoveJudgmentsSchema>

/** Where a decision's atomic move judgments came from, and at what scope. */
export const routingMoveJudgmentsRecordSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('central'),
    move: routingMoveJudgmentsSchema,
  }),
  z.strictObject({
    scope: z.literal('persona'),
    byPersona: z.record(z.string().min(1), routingPersonaMoveJudgmentsSchema),
  }),
])

export type RoutingMoveJudgmentsRecord = z.infer<typeof routingMoveJudgmentsRecordSchema>
