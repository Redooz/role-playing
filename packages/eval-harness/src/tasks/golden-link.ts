/**
 * Golden-entry rules (M0 D5, gate G3).
 *
 * A golden entry must be backed by measured agreement before it can claim
 * `stable`, and it must resolve to its task in the same language, version,
 * locale and split, with speaker and routing labels that the task can honour.
 * The task index it reads is built by the tree walker.
 */
import { baseLanguageOfLocale } from '@rp/shared'
import { hasMeasuredAgreement, type GoldenEntry, type Split, type TaskEntry } from './schema.js'
import type { GoldenLocation, TaskLocation } from './layout.js'
import type { TaskViolation } from './violations.js'

export interface TaskLinkRecord {
  readonly split: Split
  readonly path: string
  readonly routing?: { readonly eligiblePersonaIds: readonly string[] }
  readonly session?: { readonly personaIds: readonly string[]; readonly turns: number }
}

export function taskLinkKey(lang: string, version: string, locale: string, taskId: string): string {
  return `${lang}\u0000${version}\u0000${locale}\u0000${taskId}`
}

/**
 * Report the stable-without-agreement rule under its own code.
 *
 * The caller suppresses the duplicate schema issue for the same field so CI
 * output stays readable; the returned flag says whether that suppression
 * applies.
 */
export function checkGoldenAgreement(
  raw: unknown,
  path: string,
  violations: TaskViolation[],
): boolean {
  const agreementMissing =
    isRecord(raw) && raw['status'] === 'stable' && !hasMeasuredAgreement(raw['annotatorAgreement'])
  if (agreementMissing) {
    violations.push({
      path,
      code: 'GOLDEN_AGREEMENT_MISSING',
      message:
        "status 'stable' requires annotatorAgreement measured with at least 2 distinct annotators, a metric, and a value",
    })
  }
  return agreementMissing
}

export function registerTaskForGolden(
  tasks: Map<string, TaskLinkRecord[]>,
  location: TaskLocation,
  entry: TaskEntry,
  path: string,
): void {
  const key = taskLinkKey(entry.lang, location.version, entry.locale ?? entry.lang, entry.id)
  const record: TaskLinkRecord = {
    split: entry.split,
    path,
    ...(entry.routing === undefined
      ? {}
      : {
          routing: {
            eligiblePersonaIds: entry.routing.context.personas.map((persona) => persona.id),
          },
        }),
    ...(entry.session === undefined
      ? {}
      : {
          session: {
            personaIds: entry.session.personaIds ?? [entry.session.personaId],
            turns: entry.session.scriptedUserTurns.length,
          },
        }),
  }
  const records = tasks.get(key)
  if (records === undefined) {
    tasks.set(key, [record])
  } else {
    records.push(record)
  }
}

/** A golden link must resolve to a task in the same language/version/locale and split. */
export function checkGoldenTaskLink(
  entry: GoldenEntry,
  location: GoldenLocation,
  path: string,
  tasks: Map<string, TaskLinkRecord[]>,
  violations: TaskViolation[],
): void {
  if (entry.locale !== undefined && baseLanguageOfLocale(entry.locale) !== location.lang) {
    violations.push({
      path,
      code: 'GOLDEN_LOCALE_MISMATCH',
      message: `entry locale "${entry.locale}" does not match path language "${location.lang}"`,
    })
  }

  if (entry.routingOutcome !== undefined && entry.taskId === undefined) {
    violations.push({
      path,
      code: 'ROUTING_LABEL_INVALID',
      message: 'a routingOutcome label must name the routing taskId it labels',
    })
  }
  if (entry.speakerLabels !== undefined && entry.taskId === undefined) {
    violations.push({
      path,
      code: 'SPEAKER_LABEL_INVALID',
      message: 'a speakerLabels entry must name the session taskId it labels',
    })
  }

  if (entry.taskId === undefined) return

  const locale = entry.locale ?? location.lang
  const records = tasks.get(taskLinkKey(location.lang, location.version, locale, entry.taskId))
  if (records === undefined || records.length === 0) {
    violations.push({
      path,
      code: 'GOLDEN_TASK_MISSING',
      message: `taskId "${entry.taskId}" does not resolve to a task with lang "${location.lang}", locale "${locale}" and version "${location.version}"`,
    })
    return
  }

  if (!records.some((record) => record.split === entry.split)) {
    const splits = [...new Set(records.map((record) => record.split))].join(', ')
    violations.push({
      path,
      code: 'GOLDEN_TASK_SPLIT_MISMATCH',
      message: `golden entry split "${entry.split}" does not match task "${entry.taskId}" split (${splits})`,
    })
  }

  if (entry.speakerLabels !== undefined) {
    const record = records.find((candidate) => candidate.split === entry.split)
    if (record?.session === undefined) {
      violations.push({
        path,
        code: 'SPEAKER_LABEL_INVALID',
        message: `speakerLabels point at task "${entry.taskId}", which is not a session task`,
      })
    } else {
      const { personaIds, turns } = record.session
      if (entry.speakerLabels.length !== turns) {
        violations.push({
          path,
          code: 'SPEAKER_LABEL_INVALID',
          message: `speakerLabels cover ${entry.speakerLabels.length} turn(s), but task "${entry.taskId}" has ${turns} scripted user turn(s)`,
        })
      }
      const eligible = new Set(personaIds)
      for (const label of entry.speakerLabels) {
        if (label.turnIndex >= turns) {
          violations.push({
            path,
            code: 'SPEAKER_LABEL_INVALID',
            message: `speakerLabels turnIndex ${label.turnIndex} is outside task "${entry.taskId}"`,
          })
        }
        for (const personaId of label.acceptablePersonaIds) {
          if (!eligible.has(personaId)) {
            violations.push({
              path,
              code: 'SPEAKER_LABEL_INVALID',
              message: `acceptable persona "${personaId}" is not eligible in session task "${entry.taskId}"`,
            })
          }
        }
      }
    }
  }

  if (entry.routingOutcome === undefined) return
  const record = records.find((candidate) => candidate.split === entry.split)
  if (record?.routing === undefined) {
    violations.push({
      path,
      code: 'ROUTING_LABEL_INVALID',
      message: `routingOutcome label points at task "${entry.taskId}", which is not a routing task`,
    })
    return
  }

  const eligible = new Set(record.routing.eligiblePersonaIds)
  for (const personaId of entry.routingOutcome.acceptablePersonaIds) {
    if (!eligible.has(personaId)) {
      violations.push({
        path,
        code: 'ROUTING_LABEL_INVALID',
        message: `acceptable persona "${personaId}" is not eligible in task "${entry.taskId}"`,
      })
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
