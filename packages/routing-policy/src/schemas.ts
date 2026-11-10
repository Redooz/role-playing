import { sessionLanguageSchema, turnRequestSchema } from '@rp/session-core'
import { z } from 'zod'

/**
 * Offline routing contracts for M3a.
 *
 * These schemas describe a decision after a committed user utterance. They are
 * deliberately separate from the live grant lifecycle: M3a selects an offline
 * outcome, while M3b owns leases, revocation and interjection.
 */

export const ROUTING_SCHEMA_VERSION = '1.0.0'
export const ROUTING_DECISION_SCHEMA_VERSION = '1.0.0'
export const DETERMINISTIC_POLICY_VERSION = 'm3a-routing-policy-v1'

export const routingTopologySchema = z.enum(['central_selection', 'persona_requests'])
export type RoutingTopology = z.infer<typeof routingTopologySchema>

export const routingJudgmentSourceSchema = z.enum(['deterministic', 'jev'])
export type RoutingJudgmentSource = z.infer<typeof routingJudgmentSourceSchema>

const decisionIdSchema = z.string().min(1)
const entityIdSchema = z.string().min(1)
const textSchema = z.string().min(1)

export const routingUserSpeakerSchema = z.strictObject({
  kind: z.literal('user'),
})

export const routingPersonaSpeakerSchema = z.strictObject({
  kind: z.literal('persona'),
  personaId: entityIdSchema,
})

export const routingSpeakerSchema = z.discriminatedUnion('kind', [
  routingUserSpeakerSchema,
  routingPersonaSpeakerSchema,
])

export type RoutingSpeaker = z.infer<typeof routingSpeakerSchema>

export const routingTranscriptTurnSchema = z.strictObject({
  speaker: routingSpeakerSchema,
  text: textSchema,
})

export type RoutingTranscriptTurn = z.infer<typeof routingTranscriptTurnSchema>

export const routingObjectiveSchema = z.strictObject({
  id: entityIdSchema,
  description: textSchema,
  /** Concrete lexical cues used by the deterministic public-feature policy. */
  keywords: z.array(textSchema).min(1),
})

export type RoutingObjective = z.infer<typeof routingObjectiveSchema>

export const routingPersonaSchema = z.strictObject({
  id: entityIdSchema,
  displayName: textSchema,
  /** Other names the learner may use when addressing this persona. */
  aliases: z.array(textSchema),
  role: textSchema,
  objectives: z.array(routingObjectiveSchema).min(1),
})

export type RoutingPersona = z.infer<typeof routingPersonaSchema>

export const routingContextSchema = z
  .strictObject({
    decisionId: decisionIdSchema,
    turnId: entityIdSchema,
    lang: sessionLanguageSchema,
    transcript: z.array(routingTranscriptTurnSchema).min(1),
    personas: z.array(routingPersonaSchema).min(2).max(3),
    /** Objectives already covered by earlier persona turns, according to public state. */
    coveredObjectiveIds: z.array(entityIdSchema),
  })
  .superRefine((context, ctx) => {
    const personaIds = new Set<string>()
    const spokenNames = new Set<string>()
    const objectiveIds = new Set<string>()

    for (const [index, persona] of context.personas.entries()) {
      if (personaIds.has(persona.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['personas', index, 'id'],
          message: `duplicate persona id "${persona.id}"`,
        })
      }
      personaIds.add(persona.id)

      for (const name of [persona.displayName, ...persona.aliases]) {
        const normalized = name.normalize('NFKC').toLocaleLowerCase(context.lang)
        if (spokenNames.has(normalized)) {
          ctx.addIssue({
            code: 'custom',
            path: ['personas', index, 'displayName'],
            message: `persona name "${name}" is ambiguous`,
          })
        }
        spokenNames.add(normalized)
      }

      for (const [objectiveIndex, objective] of persona.objectives.entries()) {
        if (objectiveIds.has(objective.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['personas', index, 'objectives', objectiveIndex, 'id'],
            message: `duplicate objective id "${objective.id}"`,
          })
        }
        objectiveIds.add(objective.id)
      }
    }

    for (const [index, objectiveId] of context.coveredObjectiveIds.entries()) {
      if (!objectiveIds.has(objectiveId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['coveredObjectiveIds', index],
          message: `covered objective "${objectiveId}" is not declared by an eligible persona`,
        })
      }
    }

    const lastTurn = context.transcript.at(-1)
    if (lastTurn?.speaker.kind !== 'user') {
      ctx.addIssue({
        code: 'custom',
        path: ['transcript'],
        message: 'a routing decision must follow a committed user utterance',
      })
    }

    for (const [index, turn] of context.transcript.entries()) {
      if (turn.speaker.kind === 'persona' && !personaIds.has(turn.speaker.personaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['transcript', index, 'speaker', 'personaId'],
          message: `unknown transcript persona "${turn.speaker.personaId}"`,
        })
      }
    }
  })

export type RoutingContext = z.infer<typeof routingContextSchema>

export const routingJudgmentsSchema = z.strictObject({
  directlyAddressed: z.number().min(0).max(1),
  hasRelevantContribution: z.number().min(0).max(1),
  addsUncoveredInformation: z.number().min(0).max(1),
  hasUnmetRelevantObjective: z.number().min(0).max(1),
  pauseWouldBenefitUser: z.number().min(0).max(1),
})

export type RoutingJudgments = z.infer<typeof routingJudgmentsSchema>

export const routingDeclineReasonSchema = z.enum(['no_contribution', 'pause_would_benefit_user'])
export type RoutingDeclineReason = z.infer<typeof routingDeclineReasonSchema>

export const routingYieldReasonSchema = z.enum(['all_declined', 'policy_timeout', 'unsettled'])
export type RoutingYieldReason = z.infer<typeof routingYieldReasonSchema>

export const routingFallbackSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('deterministic'),
    cause: z.enum(['timeout', 'unsettled']),
  }),
])

export type RoutingFallback = z.infer<typeof routingFallbackSchema>

export const routingDeclineSchema = z.strictObject({
  personaId: entityIdSchema,
  reason: routingDeclineReasonSchema,
})

export type RoutingDecline = z.infer<typeof routingDeclineSchema>

export const routingSpeakOutcomeSchema = z.strictObject({
  kind: z.literal('speak'),
  personaId: entityIdSchema,
  request: turnRequestSchema,
})

export const routingYieldOutcomeSchema = z.strictObject({
  kind: z.literal('user_yield'),
  reason: routingYieldReasonSchema,
})

export const routingOutcomeSchema = z.discriminatedUnion('kind', [
  routingSpeakOutcomeSchema,
  routingYieldOutcomeSchema,
])

export type RoutingOutcome = z.infer<typeof routingOutcomeSchema>

export const routingDecisionSchema = z
  .strictObject({
    schemaVersion: z.literal(ROUTING_DECISION_SCHEMA_VERSION),
    decisionId: decisionIdSchema,
    turnId: entityIdSchema,
    lang: sessionLanguageSchema,
    topology: routingTopologySchema,
    judgmentSource: routingJudgmentSourceSchema,
    policyVersion: z.string().min(1),
    eligiblePersonaIds: z.array(entityIdSchema).min(2).max(3),
    outcome: routingOutcomeSchema,
    requests: z.array(turnRequestSchema),
    declines: z.array(routingDeclineSchema),
    /** Eligible personas whose required judgment landed inside the unsettled band. */
    unsettledPersonas: z.array(entityIdSchema),
    judgments: z.record(entityIdSchema, routingJudgmentsSchema),
    fallback: routingFallbackSchema,
  })
  .superRefine((decision, ctx) => {
    const eligible = new Set(decision.eligiblePersonaIds)
    if (eligible.size !== decision.eligiblePersonaIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['eligiblePersonaIds'],
        message: 'eligible persona ids must be unique',
      })
    }

    const judgmentIds = Object.keys(decision.judgments)
    if (
      judgmentIds.length !== eligible.size ||
      judgmentIds.some((personaId) => !eligible.has(personaId))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['judgments'],
        message: 'judgments must cover exactly the eligible personas',
      })
    }

    const requestIds = new Set<string>()
    for (const [index, request] of decision.requests.entries()) {
      if (!eligible.has(request.personaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['requests', index, 'personaId'],
          message: `request persona "${request.personaId}" is not eligible`,
        })
      }
      if (requestIds.has(request.personaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['requests', index, 'personaId'],
          message: `duplicate request for "${request.personaId}"`,
        })
      }
      if (request.action !== 'speak') {
        ctx.addIssue({
          code: 'custom',
          path: ['requests', index, 'action'],
          message: 'M3a derives speak requests only; interjection is M3b',
        })
      }
      if (request.turnId !== decision.turnId) {
        ctx.addIssue({
          code: 'custom',
          path: ['requests', index, 'turnId'],
          message: 'request turnId does not match the decision',
        })
      }
      requestIds.add(request.personaId)
    }

    const declineIds = new Set<string>()
    for (const [index, decline] of decision.declines.entries()) {
      if (!eligible.has(decline.personaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['declines', index, 'personaId'],
          message: `decline persona "${decline.personaId}" is not eligible`,
        })
      }
      if (declineIds.has(decline.personaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['declines', index, 'personaId'],
          message: `duplicate decline for "${decline.personaId}"`,
        })
      }
      if (requestIds.has(decline.personaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['declines', index, 'personaId'],
          message: `persona "${decline.personaId}" cannot both request and decline`,
        })
      }
      declineIds.add(decline.personaId)
    }

    const unsettledIds = new Set<string>()
    for (const [index, personaId] of decision.unsettledPersonas.entries()) {
      if (!eligible.has(personaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['unsettledPersonas', index],
          message: `unsettled persona "${personaId}" is not eligible`,
        })
      }
      if (unsettledIds.has(personaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['unsettledPersonas', index],
          message: `duplicate unsettled persona "${personaId}"`,
        })
      }
      if (requestIds.has(personaId) || declineIds.has(personaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['unsettledPersonas', index],
          message: `persona "${personaId}" cannot be settled and unsettled at once`,
        })
      }
      unsettledIds.add(personaId)
    }

    for (const personaId of eligible) {
      if (
        !requestIds.has(personaId) &&
        !declineIds.has(personaId) &&
        !unsettledIds.has(personaId)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['eligiblePersonaIds'],
          message: `persona "${personaId}" has no request, decline or unsettled marker`,
        })
      }
    }

    if (decision.outcome.kind === 'speak') {
      if (!requestIds.has(decision.outcome.personaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['outcome', 'personaId'],
          message: 'the selected speaker has no derived request',
        })
      }
      if (decision.outcome.request.personaId !== decision.outcome.personaId) {
        ctx.addIssue({
          code: 'custom',
          path: ['outcome', 'request', 'personaId'],
          message: 'the selected outcome request names a different persona',
        })
      }
    } else if (requestIds.size > 0 && decision.outcome.reason === 'all_declined') {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome', 'reason'],
        message: 'a learner yield cannot be "all_declined" when requests exist',
      })
    }

    if (decision.fallback.kind === 'none' && decision.outcome.kind === 'user_yield') {
      if (decision.outcome.reason !== 'all_declined') {
        ctx.addIssue({
          code: 'custom',
          path: ['fallback'],
          message: 'a timeout or unsettled yield must declare a deterministic fallback',
        })
      }
    }

    if (decision.fallback.kind === 'deterministic' && decision.outcome.kind === 'user_yield') {
      const expectedReason = decision.fallback.cause === 'timeout' ? 'policy_timeout' : 'unsettled'
      if (decision.outcome.reason !== expectedReason) {
        ctx.addIssue({
          code: 'custom',
          path: ['fallback'],
          message: `a deterministic ${decision.fallback.cause} fallback must yield with "${expectedReason}" if it yields`,
        })
      }
    }
  })

export type RoutingDecision = z.infer<typeof routingDecisionSchema>

/** Parse a routing context at a runner or task boundary. */
export function parseRoutingContext(input: unknown): RoutingContext {
  return routingContextSchema.parse(input)
}

/** Parse a routing decision before it is persisted. */
export function parseRoutingDecision(input: unknown): RoutingDecision {
  return routingDecisionSchema.parse(input)
}
