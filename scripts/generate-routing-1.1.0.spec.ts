import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { goldenEntrySchema, taskEntrySchema } from '@rp/eval-harness'
import { describe, expect, it } from 'vitest'
import { buildDataset, DISTRIBUTION, familyMatrix } from './generate-routing-1.1.0.mjs'

/**
 * The committed `1.1.0` tree must equal what the generator produces, and the
 * generator must satisfy the pre-registered shape (M3c P4).
 *
 * `validate:tasks` checks the composition over the whole tree; this spec checks
 * the authoring rules that the composition cannot express: no duplicate surface
 * form, every speak label cites an owner, and every covered-question silence
 * cites the visible answer.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VERSION = '1.1.0'
const LANGS = ['en', 'fr'] as const
const SPLITS = ['calibration', 'holdout'] as const

interface Turn {
  readonly speaker: { readonly kind: string; readonly personaId?: string }
  readonly text: string
}

interface Task {
  readonly id: string
  readonly lang: string
  readonly split: string
  readonly speakerId: string
  readonly routing: {
    readonly context: {
      readonly transcript: readonly Turn[]
      readonly coveredObjectiveIds: readonly string[]
    }
  }
}

interface Label {
  readonly acceptablePersonaIds: readonly string[]
  readonly allowUserYield: boolean
  readonly family: string
  readonly distractor?: boolean
  readonly note?: string
}

interface Golden {
  readonly lang: string
  readonly split: string
  readonly taskId: string
  readonly routingOutcome: Label
  readonly evidenceSpans: readonly { readonly turnIndex: number; readonly textRef: string }[]
}

interface Composition {
  readonly splits: Record<
    string,
    Record<
      string,
      {
        readonly classes: Record<string, number>
        readonly minFamilies: number
        readonly maxPerFamily: number
        readonly minDistractors: number
      }
    >
  >
}

const dataset = buildDataset()
const tasks = dataset.tasks as unknown as readonly Task[]
const goldens = dataset.goldens as unknown as readonly Golden[]
const matrix = familyMatrix(goldens) as Record<string, Record<string, Record<string, number>>>

function labelClass(label: Label): string {
  if (label.acceptablePersonaIds.length === 0) return 'silence'
  return label.allowUserYield ? 'mixed' : 'speak'
}

function utteranceOf(task: Task): string {
  return task.routing.context.transcript.at(-1)?.text ?? ''
}

function taskFor(golden: Golden): Task {
  return tasks.find((task) => task.id === golden.taskId)!
}

function sliceTasks(lang: string, split: string): readonly Task[] {
  return tasks.filter((task) => task.lang === lang && task.split === split)
}

function sliceGoldens(lang: string, split: string): readonly Golden[] {
  return goldens.filter((golden) => golden.lang === lang && golden.split === split)
}

function committed(path: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8'))
}

describe('routing 1.1.0 dataset', () => {
  it('builds 160 tasks and 160 goldens', () => {
    expect(tasks).toHaveLength(160)
    expect(goldens).toHaveLength(160)
  })

  it('parses every task and golden with the committed schemas', () => {
    for (const task of tasks) expect(() => taskEntrySchema.parse(task)).not.toThrow()
    for (const golden of goldens) expect(() => goldenEntrySchema.parse(golden)).not.toThrow()
  })

  it('matches the committed task and golden files exactly', () => {
    for (const task of tasks) {
      const path = `evals/tasks/synthetic-routing/${VERSION}/${task.lang}/${task.id}.json`
      expect(committed(path), path).toEqual(task)
    }
    for (const golden of goldens) {
      const path = `evals/golden/${golden.lang}/${VERSION}/${golden.taskId}.json`
      expect(committed(path), path).toEqual(golden)
    }
  })

  it.each(LANGS.flatMap((lang) => SPLITS.map((split) => [lang, split] as const)))(
    'is two-sided in %s/%s',
    (lang, split) => {
      const classes: Record<string, number> = { speak: 0, silence: 0, mixed: 0 }
      for (const golden of sliceGoldens(lang, split)) {
        classes[labelClass(golden.routingOutcome)] += 1
      }
      expect(classes).toEqual({ speak: 22, silence: 14, mixed: 4 })
    },
  )

  it('uses every frozen family in every slice, with no family above six', () => {
    for (const lang of LANGS) {
      for (const split of SPLITS) {
        const counts = matrix[lang]![split]!
        expect(Object.keys(counts).sort()).toEqual(
          Object.keys(DISTRIBUTION[split] as Record<string, number>).sort(),
        )
        expect(Object.values(counts).every((count) => count <= 6)).toBe(true)
      }
    }
  })

  it('never repeats a learner utterance within a language', () => {
    for (const lang of LANGS) {
      const utterances = tasks.filter((task) => task.lang === lang).map(utteranceOf)
      expect(new Set(utterances).size, lang).toBe(utterances.length)
    }
  })

  it('ends every transcript with the committed user turn', () => {
    for (const task of tasks) {
      expect(task.routing.context.transcript.at(-1)?.speaker.kind, task.id).toBe('user')
    }
  })

  it('cites the scenario owner on every speak-required label', () => {
    for (const golden of goldens) {
      if (labelClass(golden.routingOutcome) !== 'speak') continue
      expect(golden.routingOutcome.note, golden.taskId).toMatch(/^owner: /)
    }
  })

  it('marks every named non-owner as a distractor and accepts the owner', () => {
    const names: Record<string, RegExp> = {
      manager: /\b(Katherine|Kate)\b/,
      peer: /\bSam\b/,
      client: /\bJulian\b/,
    }
    for (const lang of LANGS) {
      for (const split of SPLITS) {
        const distractors = sliceGoldens(lang, split).filter(
          (golden) => golden.routingOutcome.family === 'RT-D1',
        )
        expect(distractors.length).toBe(DISTRIBUTION[split]['RT-D1'])
        for (const golden of distractors) {
          expect(golden.routingOutcome.distractor).toBe(true)
          const utterance = utteranceOf(taskFor(golden))
          const named = Object.entries(names).find(([, pattern]) => pattern.test(utterance))?.[0]
          expect(named, golden.taskId).toBeDefined()
          expect(golden.routingOutcome.acceptablePersonaIds).not.toContain(named)
        }
      }
    }
  })

  it('labels a closing move with a name inside it as silence', () => {
    const namedClosings = goldens.filter((golden) => {
      return (
        golden.routingOutcome.family === 'RT-Q1' &&
        /\b(Katherine|Kate|Sam|Julian)\b/.test(utteranceOf(taskFor(golden)))
      )
    })
    expect(namedClosings.length).toBeGreaterThan(0)
    for (const golden of namedClosings) {
      expect(labelClass(golden.routingOutcome)).toBe('silence')
    }
  })

  it('shows the answer before every covered-question silence', () => {
    const covered = goldens.filter((golden) => golden.routingOutcome.family === 'RT-Q2')
    expect(covered).toHaveLength(16)
    for (const golden of covered) {
      const context = taskFor(golden).routing.context
      expect(context.coveredObjectiveIds).toHaveLength(1)
      const answerTurn = context.transcript.at(-2)
      expect(answerTurn?.speaker.kind).toBe('persona')
      expect(golden.routingOutcome.note).toContain(answerTurn?.text)
      expect(golden.evidenceSpans).toHaveLength(2)
    }
  })

  it('keeps calibration and holdout speaker ids disjoint per language', () => {
    for (const lang of LANGS) {
      const calibration = new Set(sliceTasks(lang, 'calibration').map((task) => task.speakerId))
      const holdout = new Set(sliceTasks(lang, 'holdout').map((task) => task.speakerId))
      expect([...calibration].some((id) => holdout.has(id))).toBe(false)
    }
  })

  it('matches the declared composition', () => {
    const composition = committed(
      `evals/tasks/synthetic-routing/${VERSION}/composition.json`,
    ) as Composition
    for (const lang of LANGS) {
      for (const split of SPLITS) {
        const slice = composition.splits[split]![lang]!
        const counts = matrix[lang]![split]!
        const labels = sliceGoldens(lang, split)
        expect(slice.classes).toEqual({
          speak: labels.filter((golden) => labelClass(golden.routingOutcome) === 'speak').length,
          silence: labels.filter((golden) => labelClass(golden.routingOutcome) === 'silence')
            .length,
          mixed: labels.filter((golden) => labelClass(golden.routingOutcome) === 'mixed').length,
        })
        expect(Object.keys(counts)).toHaveLength(slice.minFamilies)
        expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(slice.maxPerFamily)
        expect(
          labels.filter((golden) => golden.routingOutcome.distractor === true).length,
        ).toBeGreaterThanOrEqual(slice.minDistractors)
      }
    }
  })
})
