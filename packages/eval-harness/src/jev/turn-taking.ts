import type { RoutingContext, RoutingPersona } from '@rp/routing-policy'
import { lastUserUtterance } from '@rp/routing-policy'
import type { JevClient } from './client.js'
import { JevInvalidResponseError, type JevError } from './errors.js'
import { declareJevJudgment } from './questions.js'
import { conversationFor } from './routing.js'
import type { JevJudgment, JevJudgmentSuccess, JevNoulAnswer, JevQuestion } from './types.js'

/**
 * M3b turn-taking rubric and the `interruptionWarranted` judgment.
 *
 * This answers one atomic question about a proposed interjection. It never
 * grants a turn and never changes a session; the eval runner records the raw
 * answer and probability. English and French are separate judgments with
 * separate copy.
 */
export const M3B_TURN_TAKING_RUBRIC_VERSION = 'm3b-turn-taking-rubric-v1'
export const INTERRUPTION_WARRANTED_QUESTION_ID = 'interruption_warranted'

export interface InterruptionWarrantedInput {
  readonly context: RoutingContext
  readonly activePersonaId: string
  readonly partialText: string
  readonly interjectingPersonaId: string
}

export interface InterruptionWarrantedObservation {
  /** Probability that the interjection is clearly warranted. */
  readonly probability: number
  readonly exact: JevJudgmentSuccess
}

export type InterruptionJevResult =
  | { readonly ok: true; readonly observation: InterruptionWarrantedObservation }
  | { readonly ok: false; readonly error: JevError; readonly questionIds: readonly string[] }

export interface JevInterruptionJudge {
  judgeInterruption(input: InterruptionWarrantedInput): Promise<InterruptionJevResult>
}

function personaFor(context: RoutingContext, personaId: string): RoutingPersona {
  const persona = context.personas.find((candidate) => candidate.id === personaId)
  if (persona === undefined) {
    throw new Error(`interruption judgment names unknown persona "${personaId}"`)
  }
  return persona
}

function publicPersona(persona: RoutingPersona): Record<string, unknown> {
  return { id: persona.id, name: persona.displayName, role: persona.role }
}

function interruptionQuestion(context: RoutingContext) {
  if (context.lang === 'fr') {
    return {
      type: 'noul' as const,
      instructions:
        'Est-ce qu’une interjection de `interjecting_persona` serait clairement justifiée maintenant, pendant la réponse de `active_speaker` ?',
      criteria: {
        true: 'La personne qui veut intervenir apporte un élément précis et urgent : elle corrige un malentendu, répond à une adresse directe ou évite une erreur concrète, et attendre la prochaine réplique nuirait au jeu de rôle.',
        false:
          'L’interjection répéterait, distrairait ou n’apporterait rien qui ne puisse attendre la prochaine réplique.',
      },
    }
  }

  return {
    type: 'noul' as const,
    instructions:
      'Would an interjection by `interjecting_persona` be clearly warranted now, while `active_speaker` is replying?',
    criteria: {
      true: 'The interjecting persona has a specific, urgent contribution: it corrects a misunderstanding, answers a direct address, or prevents a concrete error, and waiting for the next turn would harm the role-play.',
      false:
        'The interjection would repeat, distract, or add nothing that cannot wait for the next turn.',
    },
  }
}

/** Build one atomic `interruptionWarranted` judgment with public state only. */
export function buildInterruptionWarrantedJudgment(input: InterruptionWarrantedInput): JevJudgment {
  if (input.partialText.trim() === '') {
    throw new Error('an interruption judgment needs the active partial reply')
  }
  if (input.activePersonaId === input.interjectingPersonaId) {
    throw new Error('a persona cannot interject against its own grant')
  }

  const context = input.context
  const active = personaFor(context, input.activePersonaId)
  const interjecting = personaFor(context, input.interjectingPersonaId)
  const question: JevQuestion = interruptionQuestion(context)

  return declareJevJudgment({
    metadata: {
      id: 'm3b-interruption-warranted-v1',
      lang: context.lang,
      rubricVersion: M3B_TURN_TAKING_RUBRIC_VERSION,
    },
    state: {
      conversation: conversationFor(context),
      learner_utterance: lastUserUtterance(context),
      active_speaker: publicPersona(active),
      active_partial_reply: input.partialText,
      interjecting_persona: publicPersona(interjecting),
    },
    question,
  })
}

function noulAnswer(result: JevJudgmentSuccess): number {
  const answer = result.response.answers[INTERRUPTION_WARRANTED_QUESTION_ID]
  if (result.distribution.kind !== 'noul' || answer === undefined || answer.type !== 'noul') {
    throw new JevInvalidResponseError(
      `Jev did not return a Noul answer for ${JSON.stringify(INTERRUPTION_WARRANTED_QUESTION_ID)}.`,
    )
  }
  return (answer as JevNoulAnswer).noul
}

/** Jev-backed interruption judge; the caller owns deadlines and recording. */
export function createJevInterruptionJudge(jev: Pick<JevClient, 'grade'>): JevInterruptionJudge {
  return {
    async judgeInterruption(input) {
      const judgment = buildInterruptionWarrantedJudgment(input)
      const result = await jev.grade(judgment)
      if (!result.ok) {
        return { ok: false, error: result.error, questionIds: [result.questionId] }
      }

      try {
        return {
          ok: true,
          observation: { probability: noulAnswer(result), exact: result },
        }
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error && 'code' in error
              ? (error as JevError)
              : new JevInvalidResponseError('Could not read the interruption Jev judgment.', {
                  cause: error,
                }),
          questionIds: [result.questionId],
        }
      }
    },
  }
}
