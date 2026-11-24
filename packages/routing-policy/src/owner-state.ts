import { z } from 'zod'

/**
 * Public ownership claim in the routing context (M3d D1/D2).
 *
 * One claim says which persona or declared pair owns a topic, and whether the
 * claim came from a scenario fact or a persona-scoped objective. The audit
 * field differs by source, so a claim can never carry both or neither.
 */
export const routingOwnerSchema = z
  .strictObject({
    /** The responsibility phrase, for example "the action list". */
    topic: z.string().min(1),
    /** Concrete terms used to match the learner's topic. */
    keywords: z.array(z.string().min(1)).min(1),
    /** The persona or declared pair that owns the topic. */
    personaIds: z.array(z.string().min(1)).min(1),
    /** Whether the claim is a scenario fact or a persona-scoped objective. */
    source: z.enum(['fact', 'objective']),
    /** Index in the scenario variant's `facts`; required for a fact claim. */
    sourceFactIndex: z.number().int().nonnegative().optional(),
    /** Scenario objective id; required for an objective claim. */
    objectiveId: z.string().min(1).optional(),
  })
  .superRefine((owner, ctx) => {
    if (owner.source === 'fact') {
      if (owner.sourceFactIndex === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['sourceFactIndex'],
          message: 'a fact owner needs a source fact index',
        })
      }
      if (owner.objectiveId !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['objectiveId'],
          message: 'a fact owner cannot name an objective',
        })
      }
      return
    }

    if (owner.objectiveId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['objectiveId'],
        message: 'an objective owner needs an objective id',
      })
    }
    if (owner.sourceFactIndex !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceFactIndex'],
        message: 'an objective owner cannot name a fact index',
      })
    }
  })

export type RoutingOwner = z.infer<typeof routingOwnerSchema>
