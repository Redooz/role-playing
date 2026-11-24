import type {
  RoutingContext,
  RoutingMoveJudgments,
  RoutingPersona,
  RoutingPersonaMoveJudgments,
} from '@rp/routing-policy'
import {
  isPersonaAddressed,
  lastUserUtterance,
  selectOwner,
  type OwnerSelection,
} from '@rp/routing-policy'
import type { JevClient } from './client.js'
import { JevInvalidResponseError, type JevError } from './errors.js'
import { declareJevBatchJudgment } from './questions.js'
import type {
  JevBatchJudgment,
  JevBatchSuccess,
  JevChoiceAnswer,
  JevChoiceQuestion,
  JevNoulAnswer,
  JevNoulQuestion,
  JevQuestionSet,
} from './types.js'

/** Frozen routing rubric v2. Any wording change creates a new version. */
export const M3D_ROUTING_RUBRIC_VERSION = 'm3d-routing-rubric-v2'

export const CENTRAL_SPEAKER_QUESTION_ID = 'best_speaker'

export const MOVE_QUESTION_IDS = {
  closingMove: 'closing_move',
  selfAnswer: 'self_answer',
  thinkingAloud: 'thinking_aloud',
  sideComment: 'side_comment',
} as const

export const DIRECTLY_ADDRESSED_QUESTION_ID = 'directly_addressed'

export interface RoutingCentralJudgment {
  /** The four atomic self-directed move answers. */
  readonly move: RoutingMoveJudgments
  /** Choice winner, only when the turn has one declared pair of owners. */
  readonly selectedPersonaId?: string
}

export interface RoutingCentralObservation {
  readonly judgment: RoutingCentralJudgment
  readonly exact: JevBatchSuccess
}

export interface RoutingPersonaObservation {
  readonly judgments: RoutingPersonaMoveJudgments
  readonly exact: JevBatchSuccess
}

export type RoutingJevResult<T> =
  | { readonly ok: true; readonly observation: T }
  | { readonly ok: false; readonly error: JevError; readonly questionIds: readonly string[] }

export interface JevRoutingJudge {
  judgeCentral(context: RoutingContext): Promise<RoutingJevResult<RoutingCentralObservation>>
  judgePersona(
    context: RoutingContext,
    persona: RoutingPersona,
  ): Promise<RoutingJevResult<RoutingPersonaObservation>>
}

interface ConversationTurn {
  readonly speaker: string
  readonly role: 'learner' | 'persona'
  readonly text: string
}

/** The public conversation shape shared by routing and turn-taking judgments. */
export function conversationFor(context: RoutingContext): ConversationTurn[] {
  const names = new Map(context.personas.map((persona) => [persona.id, persona.displayName]))
  return context.transcript.map((turn) =>
    turn.speaker.kind === 'user'
      ? { speaker: 'Learner', role: 'learner', text: turn.text }
      : {
          speaker: names.get(turn.speaker.personaId) ?? turn.speaker.personaId,
          role: 'persona',
          text: turn.text,
        },
  )
}

/** Public ownership state: topic, persona ids and the audit trail. */
function publicOwners(context: RoutingContext): Record<string, unknown>[] {
  return context.owners.map((owner) => ({
    topic: owner.topic,
    persona_ids: [...owner.personaIds],
    source: owner.source,
    ...(owner.sourceFactIndex === undefined ? {} : { source_fact_index: owner.sourceFactIndex }),
    ...(owner.objectiveId === undefined ? {} : { objective_id: owner.objectiveId }),
  }))
}

function publicPersona(persona: RoutingPersona): Record<string, unknown> {
  return {
    id: persona.id,
    name: persona.displayName,
    role: persona.role,
    responsibilities: persona.objectives.map((objective) => objective.description),
  }
}

function addressedPersonaIds(context: RoutingContext): readonly string[] {
  return context.personas
    .filter((persona) => isPersonaAddressed(context, persona))
    .map((persona) => persona.id)
}

function ownerSelection(context: RoutingContext): OwnerSelection {
  return selectOwner(context, addressedPersonaIds(context))
}

function noulQuestion(instructions: string, trueCase: string, falseCase: string): JevNoulQuestion {
  return {
    type: 'noul',
    instructions,
    criteria: { true: trueCase, false: falseCase },
  }
}

function moveQuestions(context: RoutingContext): JevQuestionSet {
  const french = context.lang === 'fr'
  return {
    [MOVE_QUESTION_IDS.closingMove]: french
      ? noulQuestion(
          'L’apprenant termine-t-il l’échange avec `learner_utterance` ?',
          'L’apprenant clôt l’échange ou le conclut.',
          'L’apprenant poursuit l’échange.',
        )
      : noulQuestion(
          'Is the learner ending the exchange with `learner_utterance`?',
          'The learner closes, wraps up or concludes the exchange.',
          'The learner is still continuing the exchange.',
        ),
    [MOVE_QUESTION_IDS.selfAnswer]: french
      ? noulQuestion(
          'L’apprenant répond-il à sa propre question avec `learner_utterance` ?',
          'L’apprenant répond lui-même à une question qu’il vient de poser.',
          'L’apprenant ne répond pas à sa propre question.',
        )
      : noulQuestion(
          'Is the learner answering their own question with `learner_utterance`?',
          'The learner answers a question they just asked themselves.',
          'The learner is not answering their own question.',
        ),
    [MOVE_QUESTION_IDS.thinkingAloud]: french
      ? noulQuestion(
          'L’apprenant réfléchit-il à voix haute sans s’adresser à une personne de `eligible_personas` ?',
          'L’apprenant raisonne à voix haute pour lui-même, sans destinataire.',
          'L’apprenant s’adresse à une personne ou poursuit la conversation.',
        )
      : noulQuestion(
          'Is the learner thinking aloud without addressing a persona in `eligible_personas`?',
          'The learner reasons aloud for themselves, with no addressee.',
          'The learner addresses a persona or continues the conversation.',
        ),
    [MOVE_QUESTION_IDS.sideComment]: french
      ? noulQuestion(
          'L’apprenant fait-il une remarque à côté de l’échange plutôt que de le poursuivre ?',
          'L’apprenant commente en marge, sans attendre de réponse.',
          'L’apprenant poursuit l’échange et attend une réponse.',
        )
      : noulQuestion(
          'Is the learner making a side comment beside the exchange rather than continuing it?',
          'The learner remarks in passing, without expecting a reply.',
          'The learner continues the exchange and expects a reply.',
        ),
  }
}

function ownerChoice(context: RoutingContext, personaIds: readonly string[]): JevChoiceQuestion {
  const byId = new Map(context.personas.map((persona) => [persona.id, persona]))
  return {
    type: 'choice',
    instructions:
      context.lang === 'fr'
        ? 'Parmi les propriétaires déclarés, qui doit répondre après `learner_utterance` ?'
        : 'Among the declared owners, who should reply after `learner_utterance`?',
    criteria: Object.fromEntries(
      personaIds.map((personaId) => {
        const persona = byId.get(personaId)
        return [
          personaId,
          persona === undefined
            ? personaId
            : `${persona.displayName}, ${persona.role}. ${persona.objectives
                .map((objective) => objective.description)
                .join(' ')}`,
        ]
      }),
    ),
  }
}

function centralQuestions(context: RoutingContext): JevQuestionSet {
  const questions: JevQuestionSet = moveQuestions(context)
  const selection = ownerSelection(context)
  return selection.kind === 'pair'
    ? { ...questions, [CENTRAL_SPEAKER_QUESTION_ID]: ownerChoice(context, selection.personaIds) }
    : questions
}

function personaQuestions(context: RoutingContext): JevQuestionSet {
  return {
    ...moveQuestions(context),
    [DIRECTLY_ADDRESSED_QUESTION_ID]:
      context.lang === 'fr'
        ? noulQuestion(
            'Est-ce que `learner_utterance` s’adresse directement à `persona` en utilisant son nom ou son rôle ?',
            'L’apprenant nomme la personne ou son rôle et lui parle directement.',
            'L’apprenant ne nomme pas la personne et ne lui parle pas directement.',
          )
        : noulQuestion(
            'Does `learner_utterance` directly address `persona` by name or role?',
            'The learner names the persona or their role and speaks to them directly.',
            'The learner does not name or directly address the persona.',
          ),
  }
}

/** Build the public central state and its move Nouls, plus the pair Choice. */
export function buildCentralRoutingJudgment(context: RoutingContext): JevBatchJudgment {
  return declareJevBatchJudgment({
    metadata: {
      id: 'm3d-routing-central-v2',
      lang: context.lang,
      rubricVersion: M3D_ROUTING_RUBRIC_VERSION,
    },
    state: {
      conversation: conversationFor(context),
      learner_utterance: lastUserUtterance(context),
      eligible_personas: context.personas.map(publicPersona),
      owners: publicOwners(context),
    },
    questions: centralQuestions(context),
  })
}

/** Build one persona's private-view state and its four moves plus direct address. */
export function buildPersonaRoutingJudgment(
  context: RoutingContext,
  persona: RoutingPersona,
): JevBatchJudgment {
  return declareJevBatchJudgment({
    metadata: {
      id: `m3d-routing-persona-${persona.id}-v2`,
      lang: context.lang,
      rubricVersion: M3D_ROUTING_RUBRIC_VERSION,
    },
    state: {
      conversation: conversationFor(context),
      learner_utterance: lastUserUtterance(context),
      persona: {
        id: persona.id,
        name: persona.displayName,
        role: persona.role,
      },
      objectives: persona.objectives.map((objective) => ({
        id: objective.id,
        description: objective.description,
      })),
      owners: publicOwners(context),
    },
    questions: personaQuestions(context),
  })
}

function noulAnswer(result: JevBatchSuccess, questionId: string): number {
  const answer = result.answers[questionId]
  if (answer === undefined || answer.type !== 'noul') {
    throw new JevInvalidResponseError(
      `Jev did not return a Noul answer for ${JSON.stringify(questionId)}.`,
    )
  }
  return (answer as JevNoulAnswer).noul
}

function choiceAnswer(result: JevBatchSuccess, questionId: string): JevChoiceAnswer {
  const answer = result.answers[questionId]
  if (answer === undefined || answer.type !== 'choice') {
    throw new JevInvalidResponseError(
      `Jev did not return a Choice answer for ${JSON.stringify(questionId)}.`,
    )
  }
  return answer as JevChoiceAnswer
}

function readMove(result: JevBatchSuccess): RoutingMoveJudgments {
  return {
    closingMove: noulAnswer(result, MOVE_QUESTION_IDS.closingMove),
    selfAnswer: noulAnswer(result, MOVE_QUESTION_IDS.selfAnswer),
    thinkingAloud: noulAnswer(result, MOVE_QUESTION_IDS.thinkingAloud),
    sideComment: noulAnswer(result, MOVE_QUESTION_IDS.sideComment),
  }
}

function failureOf(error: unknown, fallback: string, questionIds: readonly string[]) {
  return {
    ok: false as const,
    error:
      error instanceof Error && 'code' in error
        ? (error as JevError)
        : new JevInvalidResponseError(fallback, { cause: error }),
    questionIds,
  }
}

/** Jev-backed routing judge. The caller owns deadlines and fallback. */
export function createJevRoutingJudge(jev: Pick<JevClient, 'decideMany'>): JevRoutingJudge {
  return {
    async judgeCentral(context) {
      const judgment = buildCentralRoutingJudgment(context)
      const result = await jev.decideMany(judgment)
      if (!result.ok) {
        return { ok: false, error: result.error, questionIds: result.questionIds }
      }

      try {
        const move = readMove(result)
        const selection = ownerSelection(context)
        let selectedPersonaId: string | undefined
        if (selection.kind === 'pair') {
          const choice = choiceAnswer(result, CENTRAL_SPEAKER_QUESTION_ID).choice
          if (!selection.personaIds.includes(choice)) {
            throw new JevInvalidResponseError(
              `Jev chose "${choice}", who is not a declared owner for this turn.`,
            )
          }
          selectedPersonaId = choice
        }

        return {
          ok: true,
          observation: {
            judgment: {
              move,
              ...(selectedPersonaId === undefined ? {} : { selectedPersonaId }),
            },
            exact: result,
          },
        }
      } catch (error) {
        return failureOf(error, 'Could not read the central Jev judgment.', result.questionIds)
      }
    },

    async judgePersona(context, persona) {
      const judgment = buildPersonaRoutingJudgment(context, persona)
      const result = await jev.decideMany(judgment)
      if (!result.ok) {
        return { ok: false, error: result.error, questionIds: result.questionIds }
      }

      try {
        return {
          ok: true,
          observation: {
            judgments: {
              ...readMove(result),
              directlyAddressed: noulAnswer(result, DIRECTLY_ADDRESSED_QUESTION_ID),
            },
            exact: result,
          },
        }
      } catch (error) {
        return failureOf(error, 'Could not read the persona Jev judgments.', result.questionIds)
      }
    },
  }
}
