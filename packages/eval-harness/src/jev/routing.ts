import type { RoutingContext, RoutingJudgments, RoutingPersona } from '@rp/routing-policy'
import { interpretCentralJudgmentForContext, lastUserUtterance } from '@rp/routing-policy'
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

/** Frozen routing rubric. Any wording change creates a new version. */
export const M3A_ROUTING_RUBRIC_VERSION = 'm3a-routing-rubric-v1'

export const CENTRAL_CONTRIBUTION_QUESTION_ID = 'anyone_should_contribute'
export const CENTRAL_SPEAKER_QUESTION_ID = 'best_next_speaker'
export const PERSONA_JUDGMENT_QUESTION_IDS = {
  directlyAddressed: 'directly_addressed',
  hasRelevantContribution: 'has_relevant_contribution',
  addsUncoveredInformation: 'adds_uncovered_information',
  hasUnmetRelevantObjective: 'has_unmet_relevant_objective',
  pauseWouldBenefitUser: 'pause_would_benefit_user',
} as const

export interface RoutingCentralJudgment {
  /** Probability that at least one eligible persona has a relevant contribution. */
  readonly anyoneWarranted: number
  /** Choice's top option, mapped back to an eligible persona id. */
  readonly selectedPersonaId: string
}

export interface RoutingCentralObservation {
  readonly judgment: RoutingCentralJudgment
  readonly exact: JevBatchSuccess
}

export interface RoutingPersonaObservation {
  readonly judgments: RoutingJudgments
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

function conversationFor(context: RoutingContext): ConversationTurn[] {
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

function publicPersona(persona: RoutingPersona): Record<string, unknown> {
  return {
    id: persona.id,
    name: persona.displayName,
    role: persona.role,
    responsibilities: persona.objectives.map((objective) => objective.description),
  }
}

function noulQuestion(instructions: string, trueCase: string, falseCase: string): JevNoulQuestion {
  return {
    type: 'noul',
    instructions,
    criteria: { true: trueCase, false: falseCase },
  }
}

function centralQuestions(context: RoutingContext): JevQuestionSet {
  const choice: JevChoiceQuestion = {
    type: 'choice',
    instructions:
      context.lang === 'fr'
        ? 'Quelle personne éligible doit parler ensuite après `learner_utterance` ?'
        : 'Which eligible persona should speak next after `learner_utterance`?',
    criteria: Object.fromEntries(
      context.personas.map((persona) => [
        persona.id,
        `${persona.displayName}, ${persona.role}. ${persona.objectives
          .map((objective) => objective.description)
          .join(' ')}`,
      ]),
    ),
  }

  return {
    [CENTRAL_CONTRIBUTION_QUESTION_ID]:
      context.lang === 'fr'
        ? noulQuestion(
            'Au moins une personne de `eligible_personas` a-t-elle une contribution pertinente qui fait avancer le jeu de rôle après `learner_utterance` ?',
            'Une personne éligible peut apporter une information utile et pertinente à ce moment.',
            "Aucune personne éligible n'a de contribution utile et pertinente à ce moment.",
          )
        : noulQuestion(
            'Does at least one persona in `eligible_personas` have a relevant contribution that moves the workplace role-play forward after `learner_utterance`?',
            'At least one eligible persona can add useful, relevant information now.',
            'No eligible persona has a useful, relevant contribution now.',
          ),
    [CENTRAL_SPEAKER_QUESTION_ID]: choice,
  }
}

function personaQuestions(context: RoutingContext): JevQuestionSet {
  const french = context.lang === 'fr'
  return {
    [PERSONA_JUDGMENT_QUESTION_IDS.directlyAddressed]: french
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
    [PERSONA_JUDGMENT_QUESTION_IDS.hasRelevantContribution]: french
      ? noulQuestion(
          'Est-ce que `persona` a une contribution pertinente par rapport à `learner_utterance` ?',
          'La personne peut répondre de façon utile et liée à ce que vient de dire l’apprenant.',
          'La personne n’a pas de réponse utile et liée à ce que vient de dire l’apprenant.',
        )
      : noulQuestion(
          'Does `persona` have a contribution that is relevant to `learner_utterance`?',
          'The persona can respond usefully and relate to what the learner just said.',
          'The persona has no useful contribution related to what the learner just said.',
        ),
    [PERSONA_JUDGMENT_QUESTION_IDS.addsUncoveredInformation]: french
      ? noulQuestion(
          'Est-ce que `persona` apporterait une information qui n’est pas déjà couverte dans `conversation` ou dans les objectifs de `objectives` marqués `covered: true` ?',
          'La personne ajouterait une information nouvelle qui n’a pas encore été dite.',
          'La personne répéterait une information déjà couverte.',
        )
      : noulQuestion(
          'Would `persona` add information that is not already covered in `conversation` or in an objective in `objectives` marked `covered: true`?',
          'The persona would add new information that has not already been said.',
          'The persona would repeat information that is already covered.',
        ),
    [PERSONA_JUDGMENT_QUESTION_IDS.hasUnmetRelevantObjective]: french
      ? noulQuestion(
          'Est-ce que `persona` a un objectif non satisfait dans `objectives` qui est pertinent pour `learner_utterance` ?',
          'Un objectif de la personne est encore ouvert et se rapporte à ce que dit l’apprenant.',
          'Aucun objectif encore ouvert de la personne ne se rapporte à ce que dit l’apprenant.',
        )
      : noulQuestion(
          'Does `persona` have an unmet objective in `objectives` that is relevant to `learner_utterance`?',
          'One of the persona’s open objectives relates to what the learner is saying.',
          'None of the persona’s open objectives relates to what the learner is saying.',
        ),
    [PERSONA_JUDGMENT_QUESTION_IDS.pauseWouldBenefitUser]: french
      ? noulQuestion(
          'Est-ce que l’apprenant bénéficierait d’une pause plutôt que d’une réponse de `persona` maintenant ?',
          'Laisser l’apprenant réfléchir ou continuer seul serait plus utile qu’une réponse.',
          'Une réponse de la personne serait plus utile qu’une pause.',
        )
      : noulQuestion(
          'Would the learner benefit from a pause instead of a reply from `persona` right now?',
          'Leaving the learner to think or continue alone would be more useful than a reply.',
          'A reply from the persona would be more useful than a pause.',
        ),
  }
}

/** Build the public central judgment state and its Noul + Choice questions. */
export function buildCentralRoutingJudgment(context: RoutingContext): JevBatchJudgment {
  return declareJevBatchJudgment({
    metadata: {
      id: 'm3a-routing-central-v1',
      lang: context.lang,
      rubricVersion: M3A_ROUTING_RUBRIC_VERSION,
    },
    state: {
      conversation: conversationFor(context),
      learner_utterance: lastUserUtterance(context),
      eligible_personas: context.personas.map(publicPersona),
    },
    questions: centralQuestions(context),
  })
}

/** Build one persona's private-view state and its five atomic Noul questions. */
export function buildPersonaRoutingJudgment(
  context: RoutingContext,
  persona: RoutingPersona,
): JevBatchJudgment {
  const covered = new Set(context.coveredObjectiveIds)
  return declareJevBatchJudgment({
    metadata: {
      id: `m3a-routing-persona-${persona.id}-v1`,
      lang: context.lang,
      rubricVersion: M3A_ROUTING_RUBRIC_VERSION,
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
        covered: covered.has(objective.id),
      })),
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
        const selectedPersonaId = choiceAnswer(result, CENTRAL_SPEAKER_QUESTION_ID).choice
        const interpreted = interpretCentralJudgmentForContext(context, {
          anyoneWarranted: noulAnswer(result, CENTRAL_CONTRIBUTION_QUESTION_ID),
          selectedPersonaId,
        })
        if (!interpreted.ok) {
          throw new JevInvalidResponseError(
            `Jev central judgment was invalid: ${interpreted.reason}.`,
          )
        }
        return {
          ok: true,
          observation: {
            judgment: {
              anyoneWarranted: interpreted.anyoneWarranted,
              selectedPersonaId: interpreted.selectedPersonaId,
            },
            exact: result,
          },
        }
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error && 'code' in error
              ? (error as JevError)
              : new JevInvalidResponseError('Could not read the central Jev judgment.', {
                  cause: error,
                }),
          questionIds: result.questionIds,
        }
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
              directlyAddressed: noulAnswer(
                result,
                PERSONA_JUDGMENT_QUESTION_IDS.directlyAddressed,
              ),
              hasRelevantContribution: noulAnswer(
                result,
                PERSONA_JUDGMENT_QUESTION_IDS.hasRelevantContribution,
              ),
              addsUncoveredInformation: noulAnswer(
                result,
                PERSONA_JUDGMENT_QUESTION_IDS.addsUncoveredInformation,
              ),
              hasUnmetRelevantObjective: noulAnswer(
                result,
                PERSONA_JUDGMENT_QUESTION_IDS.hasUnmetRelevantObjective,
              ),
              pauseWouldBenefitUser: noulAnswer(
                result,
                PERSONA_JUDGMENT_QUESTION_IDS.pauseWouldBenefitUser,
              ),
            },
            exact: result,
          },
        }
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error && 'code' in error
              ? (error as JevError)
              : new JevInvalidResponseError('Could not read the persona Jev judgments.', {
                  cause: error,
                }),
          questionIds: result.questionIds,
        }
      }
    },
  }
}
