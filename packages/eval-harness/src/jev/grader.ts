import { canonicalizeLocale } from '@rp/shared'
import { personaById, personaVariant } from '@rp/persona-kit'
import { scenarioById, scenarioVariant } from '@rp/scenario-kit'
import { JEV_GRADER_VERSION, JEV_MODEL } from './constants.js'
import { declareJevJudgment } from './questions.js'
import type { JevGrader, JevJudgment, JevLang, JevQuestion } from './types.js'
import type { GraderContext, Grader, SemanticGrade, TrialRecord } from '../runner/grader.js'

/**
 * Jev semantic grader for M2 persona/scenario axes (M2 D8).
 *
 * One atomic yes/no judgment per axis per trial. The raw probability is stored;
 * there is no composite score. One line applies to every axis and both
 * languages, and it is recorded on every grade row.
 *
 * A failed Jev call throws: the harness turns that into an incomplete run, never
 * a "no" or a zero.
 */

export const M2_JEV_GRADER_ID = 'jev'
export const M2_JEV_RUBRIC_VERSION = 'm2-persona-rubric-v2'

/**
 * M2 semantic line, moved from 0.50 to 0.75 on 2026-11-09.
 *
 * The M2 annotation review found the 0.50 line accepted every baseline
 * task-help trace, while two independent annotation passes accepted roughly
 * half to two-thirds. A single line at 0.75 matched the held-out rounds and
 * kept candidate scores high. The decision-model notes require one frozen line
 * per grader version, not a line per axis: five 30–58-label samples would
 * overfit and break comparability. Revalidate on human labels before treating
 * the line as permanent.
 */
export const M2_JEV_THRESHOLD = 0.75

export const M2_AXES = [
  'persona.consistency',
  'language.quality',
  'register.fit',
  'response.clarity',
  'objective.completion',
  'locale.fit',
] as const

export type M2Axis = (typeof M2_AXES)[number]

export interface JevAxisGraderOptions {
  readonly client: JevGrader
  readonly rubricVersion?: string
}

interface AxisSpec {
  readonly axis: M2Axis
  readonly metric: M2Axis
  readonly en: { readonly instructions: string; readonly yes: string; readonly no: string }
  readonly fr: { readonly instructions: string; readonly yes: string; readonly no: string }
}

const AXES: readonly AxisSpec[] = [
  {
    axis: 'persona.consistency',
    metric: 'persona.consistency',
    en: {
      instructions: 'Do all persona replies stay in the same professional role and voice?',
      yes: 'Every reply is consistent with one role, tone and set of boundaries.',
      no: 'A reply breaks role, changes voice, or behaves like a generic assistant.',
    },
    fr: {
      instructions:
        'Toutes les réponses de la personne restent-elles dans le même rôle professionnel et la même voix ?',
      yes: 'Chaque réponse est cohérente avec un rôle, un ton et des limites stables.',
      no: 'Une réponse sort du rôle, change de voix ou se comporte comme un assistant générique.',
    },
  },
  {
    axis: 'language.quality',
    metric: 'language.quality',
    en: {
      instructions:
        'Are the persona replies written in correct English with appropriate grammar and vocabulary?',
      yes: 'The replies are fluent English with no distracting grammar or vocabulary error.',
      no: 'The replies contain a serious grammar, vocabulary or language error.',
    },
    fr: {
      instructions:
        'Les réponses de la personne sont-elles rédigées dans un français correct, avec une grammaire, une orthographe (accents et traits d’union compris) et un vocabulaire adaptés ?',
      yes: 'Les réponses sont fluides ; les accents, traits d’union, accords et choix de vocabulaire sont corrects, sans erreur gênante.',
      no: 'Les réponses contiennent une erreur importante de grammaire, d’orthographe (accent ou trait d’union manquant ou incorrect), de vocabulaire ou de langue.',
    },
  },
  {
    axis: 'register.fit',
    metric: 'register.fit',
    en: {
      instructions:
        'Is the register appropriate for the workplace relationship described in the scenario?',
      yes: 'The replies match the expected formality and diplomacy for this relationship.',
      no: 'The replies are too casual, too formal, or impolite for this relationship.',
    },
    fr: {
      instructions:
        'Le registre est-il adapté à la relation professionnelle décrite dans le scénario, y compris l’emploi cohérent de « tu » ou « vous » avec l’apprenant ?',
      yes: 'Les réponses correspondent au niveau de formalité et de diplomatie attendu et gardent un choix cohérent entre « tu » et « vous ».',
      no: 'Les réponses sont trop familières, trop formelles ou impolies, ou alternent entre « tu » et « vous » de façon incohérente pour cette relation.',
    },
  },
  {
    axis: 'response.clarity',
    metric: 'response.clarity',
    en: {
      instructions: 'Are the persona replies clear and concise rather than rambling?',
      yes: 'The replies are understandable and reasonably concise.',
      no: 'The replies are confusing, repetitive or long-winded.',
    },
    fr: {
      instructions:
        'Les réponses de la personne sont-elles claires et concises plutôt que décousues ?',
      yes: 'Les réponses sont compréhensibles et raisonnablement concises.',
      no: 'Les réponses sont confuses, répétitives ou trop longues.',
    },
  },
  {
    axis: 'objective.completion',
    metric: 'objective.completion',
    en: {
      instructions: 'Do the persona replies help the learner complete the scenario objective?',
      yes: 'The replies create a realistic opening and respond to the learner in a way that lets the objective be met.',
      no: 'The replies block the objective, ignore the learner, or invent facts that make it impossible.',
    },
    fr: {
      instructions:
        'Les réponses de la personne aident-elles l’apprenant à atteindre l’objectif du scénario ?',
      yes: 'Les réponses créent une ouverture réaliste et permettent d’atteindre l’objectif.',
      no: 'Les réponses bloquent l’objectif, ignorent l’apprenant ou inventent des faits qui le rendent impossible.',
    },
  },
  {
    axis: 'locale.fit',
    metric: 'locale.fit',
    en: {
      instructions:
        'Do the persona replies use the spelling, vocabulary and workplace norms of the stated locale?',
      yes: 'The replies consistently match the stated locale rather than a different regional variant.',
      no: 'The replies use another locale’s spelling, vocabulary or workplace norms.',
    },
    fr: {
      instructions:
        'Les réponses de la personne utilisent-elles l’orthographe, le vocabulaire et les usages professionnels de la région indiquée ?',
      yes: 'Les réponses correspondent à la région indiquée et non à une autre variante régionale.',
      no: 'Les réponses utilisent l’orthographe, le vocabulaire ou les usages d’une autre région.',
    },
  },
]

interface TrialText {
  readonly trialId: string
  readonly lang: JevLang
  readonly locale: string
  readonly learner: readonly string[]
  readonly replies: readonly string[]
  readonly state: Record<string, unknown>
}

/** Build the semantic grader. The caller supplies the pinned Jev client. */
export function createJevAxisGrader(options: JevAxisGraderOptions): Grader {
  let lastDetails: readonly SemanticGrade[] = []

  return {
    id: M2_JEV_GRADER_ID,
    kind: 'system-one-model',
    version: JEV_MODEL,
    model: JEV_MODEL,

    async score(context: GraderContext): Promise<Readonly<Record<string, number>>> {
      const { metrics, details } = await evaluate(context, options)
      lastDetails = details
      return metrics
    },

    async details(): Promise<readonly SemanticGrade[]> {
      return lastDetails
    },
  }
}

interface EvaluateResult {
  readonly metrics: Readonly<Record<string, number>>
  readonly details: readonly SemanticGrade[]
}

async function evaluate(
  context: GraderContext,
  options: JevAxisGraderOptions,
): Promise<EvaluateResult> {
  const completed = context.trials.filter(
    (trial) => trial.ok && trial.task?.mode === 'session' && trial.task.session !== undefined,
  )
  if (completed.length === 0) {
    throw new Error('no completed session trial to grade; a semantic run has no evidence')
  }

  const sums = new Map<string, { total: number; count: number }>()
  const details: SemanticGrade[] = []

  for (const trial of completed) {
    const text = readTrialText(trial)
    const specs = axisSpecsFor(trial)
    for (const spec of specs) {
      const judgment = buildJudgment(trial, text, spec, options)
      const result = await options.client.grade(judgment)
      if (!result.ok) {
        throw new Error(
          `Jev call failed for ${text.trialId}/${spec.axis}: ${result.error.message}; a failed call is not a "no"`,
        )
      }

      const probability = probabilityYes(result.distribution)
      const entry = sums.get(spec.metric) ?? { total: 0, count: 0 }
      entry.total += probability
      entry.count += 1
      sums.set(spec.metric, entry)

      details.push({
        trialId: text.trialId,
        axis: spec.axis,
        metric: spec.metric,
        question: questionText(judgment),
        probability,
        threshold: M2_JEV_THRESHOLD,
        distribution: distributionMap(result.distribution),
        ...(judgment.metadata.locale === undefined ? {} : { locale: judgment.metadata.locale }),
        servedModel: result.servedModel,
        cacheHit: result.cache.hit,
      })
    }
  }

  const metrics: Record<string, number> = {}
  for (const [metric, value] of sums) metrics[metric] = value.total / value.count

  // Code guardrails travel with the semantic grader so a live manifest can
  // register one grader and still gate on plain-text and failure-rate axes.
  const allCompleted = context.trials.filter((trial) => trial.ok)
  const speech = allCompleted
    .map((trial) => trial.speech)
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
  metrics['response.plain_text_rate'] =
    speech.length === 0
      ? 0
      : speech.filter((value) => value.plainTextRate === 1).length / speech.length
  metrics['response.emoji_count'] = speech.reduce((total, value) => total + value.emojiCount, 0)
  metrics['response.markdown_count'] = speech.reduce(
    (total, value) => total + value.markdownCount,
    0,
  )
  metrics['run.failure_rate'] =
    context.trials.length === 0
      ? 1
      : (context.trials.length - allCompleted.length) / context.trials.length

  return { metrics, details }
}

function readTrialText(trial: TrialRecord): TrialText {
  const task = trial.task
  if (task === undefined || task.session === undefined) {
    throw new Error(`trial ${trial.round}:${trial.lang}:${trial.taskId} has no session task`)
  }

  const locale = canonicalizeLocale(task.locale ?? task.lang)
  const learner: string[] = []
  const replies: string[] = []

  for (const record of trial.records) {
    if (record.kind === 'user.utterance.committed') {
      const text = (record.payload as { readonly text?: unknown }).text
      if (typeof text === 'string') learner.push(text)
    } else if (record.kind === 'persona.response.committed') {
      const text = (record.payload as { readonly text?: unknown }).text
      if (typeof text === 'string') replies.push(text)
    }
  }

  const persona = personaById(task.session.personaId)
  const personaCopy = personaVariant(persona, locale)
  const scenario = scenarioById(task.session.scenarioId)
  const scenarioCopy = scenarioVariant(scenario, locale)

  return {
    trialId: `${trial.round}:${trial.lang}:${task.id}`,
    lang: task.lang,
    locale,
    learner,
    replies,
    state: {
      persona: {
        id: persona.id,
        role: persona.role,
        displayName: personaCopy.displayName,
        voice: personaCopy.voice,
      },
      scenario: {
        id: scenario.id,
        type: scenario.scenarioType,
        setting: scenarioCopy.setting,
        learnerRole: scenarioCopy.learnerRole,
        objectives: scenarioCopy.objectives.map((objective) => ({
          id: objective.id,
          description: objective.description,
          successCriteria: objective.successCriteria,
        })),
      },
      lang: task.lang,
      locale,
      learnerUtterances: learner,
      personaReplies: replies,
    },
  }
}

function axisSpecsFor(trial: TrialRecord): readonly AxisSpec[] {
  const task = trial.task
  if (task === undefined) return []
  const locale = canonicalizeLocale(task.locale ?? task.lang)
  const base = locale === task.lang
  return base ? AXES.filter((spec) => spec.axis !== 'locale.fit') : AXES
}

function buildJudgment(
  trial: TrialRecord,
  text: TrialText,
  spec: AxisSpec,
  options: JevAxisGraderOptions,
): JevJudgment {
  const copy = text.lang === 'fr' ? spec.fr : spec.en
  const question: JevQuestion = {
    type: 'noul',
    instructions: copy.instructions,
    criteria: { true: copy.yes, false: copy.no },
  }

  return declareJevJudgment({
    metadata: {
      id: `m2-${text.trialId}-${spec.axis}`,
      lang: text.lang,
      locale: text.locale,
      rubricVersion: options.rubricVersion ?? M2_JEV_RUBRIC_VERSION,
      graderVersion: JEV_GRADER_VERSION,
    },
    state: text.state,
    question,
  })
}

function probabilityYes(distribution: { readonly kind: string }): number {
  if (distribution.kind !== 'noul') {
    throw new Error('Jev returned a non-boolean answer for a noul question')
  }
  const value = (distribution as { readonly probabilityYes?: unknown }).probabilityYes
  if (typeof value !== 'number') throw new Error('Jev response has no yes probability')
  return value
}

function distributionMap(distribution: {
  readonly kind: string
  readonly probabilityYes?: number
  readonly probabilityNo?: number
}): Readonly<Record<string, number>> {
  return {
    yes: distribution.probabilityYes ?? 0,
    no: distribution.probabilityNo ?? 0,
  }
}

function questionText(judgment: JevJudgment): string {
  return judgment.question.instructions
}
