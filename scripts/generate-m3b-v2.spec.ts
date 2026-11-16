import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { goldenEntrySchema, taskEntrySchema } from '@rp/eval-harness'
import { scenarioById, scenarioVariant } from '@rp/scenario-kit'
import { describe, expect, it } from 'vitest'
import { buildDataset, composition, familyMatrix } from './generate-m3b-v2.mjs'
import { DISTRIBUTION, FAMILY_DISTRIBUTION, VERSION } from './m3b-v2-content.mjs'

/**
 * The committed `m3b-v2` tree must equal what the generator produces, and the
 * generator must satisfy the pre-registered shape (M3c P5).
 *
 * `validate:tasks` checks the composition over the whole tree; this spec adds
 * the authoring rules the composition cannot express: no duplicate learner
 * utterance, every speak label cites a real scenario field, and every named
 * non-owner is the distractor rather than the accepted persona.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LANGS = ['en', 'fr'] as const
const SPLITS = ['calibration', 'holdout'] as const

interface Label {
  readonly turnIndex: number
  readonly acceptablePersonaIds: readonly string[]
  readonly allowUserYield: boolean
  readonly family: string
  readonly distractor?: boolean
  readonly note?: string
}

interface Task {
  readonly id: string
  readonly lang: string
  readonly locale: string
  readonly split: string
  readonly scenarioType: string
  readonly session: {
    readonly personaIds: readonly string[]
    readonly scenarioId: string
    readonly scenarioVersion: string
    readonly scriptedUserTurns: readonly string[]
  }
}

interface Golden {
  readonly lang: string
  readonly locale: string
  readonly split: string
  readonly taskId: string
  readonly speakerLabels: readonly Label[]
}

const dataset = buildDataset()
const tasks = dataset.tasks as unknown as readonly Task[]
const goldens = dataset.goldens as unknown as readonly Golden[]
const matrix = familyMatrix(goldens) as Record<string, Record<string, Record<string, number>>>

function labelClass(label: Label): string {
  if (label.acceptablePersonaIds.length === 0) return 'silence'
  return label.allowUserYield ? 'mixed' : 'speak'
}

function taskFor(golden: Golden): Task {
  return tasks.find((task) => task.id === golden.taskId)!
}

function sliceGoldens(lang: string, split: string): readonly Golden[] {
  return goldens.filter((golden) => golden.lang === lang && golden.split === split)
}

function committed(path: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8'))
}

describe('m3b-v2 dataset', () => {
  it('builds 44 tasks and 44 goldens', () => {
    expect(tasks).toHaveLength(44)
    expect(goldens).toHaveLength(44)
  })

  it('parses every task and golden with the committed schemas', () => {
    for (const task of tasks) expect(() => taskEntrySchema.parse(task)).not.toThrow()
    for (const golden of goldens) expect(() => goldenEntrySchema.parse(golden)).not.toThrow()
  })

  it('matches the committed task and golden files exactly', () => {
    for (const task of tasks) {
      const path = `evals/tasks/synthetic-multi-persona-session/${VERSION}/${task.lang}/${task.id}.json`
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
        for (const label of golden.speakerLabels) classes[labelClass(label)] += 1
      }
      expect(classes).toEqual(DISTRIBUTION[split])
    },
  )

  it('uses every frozen family in every slice, with no family above six or eight', () => {
    for (const lang of LANGS) {
      for (const split of SPLITS) {
        const counts = matrix[lang]![split]!
        expect(Object.keys(counts).sort()).toEqual(
          Object.keys(FAMILY_DISTRIBUTION[split] as Record<string, number>).sort(),
        )
        expect(Object.values(counts).every((count) => count <= (split === 'holdout' ? 8 : 6))).toBe(
          true,
        )
      }
    }
  })

  it('never repeats a learner utterance within a language', () => {
    for (const lang of LANGS) {
      const utterances = tasks
        .filter((task) => task.lang === lang)
        .flatMap((task) => task.session.scriptedUserTurns)
      expect(new Set(utterances).size, lang).toBe(utterances.length)
    }
  })

  it('points every task at a registered two-persona scenario and locale', () => {
    for (const task of tasks) {
      const scenario = scenarioById(task.session.scenarioId)
      expect(scenario.version).toBe(task.session.scenarioVersion)
      const variant = scenarioVariant(scenario, task.locale)
      expect(variant.personaIds).toEqual(['manager', 'peer'])
      expect(task.session.personaIds).toEqual(['manager', 'peer'])
      expect(task.scenarioType).toBe(scenario.id)
    }
  })

  it('cites a real scenario field on every speak and mixed label', () => {
    for (const golden of goldens) {
      const task = taskFor(golden)
      const variant = scenarioVariant(scenarioById(task.session.scenarioId), golden.locale)
      for (const label of golden.speakerLabels) {
        if (labelClass(label) === 'silence') continue
        expect(label.note, `${golden.taskId}/${label.turnIndex}`).toMatch(/^owner: /)
        if (label.note?.startsWith('owner: facts[')) {
          const match =
            /^owner: facts\[(\d+)\] "(.*)"(?:; named: \w+)?(?:; learner may proceed)?$/.exec(
              label.note,
            )
          expect(match, label.note).not.toBeNull()
          expect(variant.facts[Number(match![1])]).toBe(match![2])
        } else {
          const match =
            /^owner: objectives\[([^\]]+)\]\.personaIds=\[([^\]]+)\](?:; named: \w+)?$/.exec(
              label.note ?? '',
            )
          expect(match, label.note).not.toBeNull()
          const objective = variant.objectives.find((entry) => entry.id === match![1])
          expect(objective, label.note).toBeDefined()
          expect((objective?.personaIds ?? variant.personaIds).slice().sort()).toEqual(
            match![2]!.split(',').sort(),
          )
        }
      }
    }
  })

  it('marks every named non-owner as a distractor and accepts the owner', () => {
    const named = goldens.flatMap((golden) =>
      golden.speakerLabels
        .filter((label) => label.family === 'TT-D1')
        .map((label) => ({ golden, label })),
    )
    expect(named).toHaveLength(24)
    for (const { golden, label } of named) {
      expect(label.distractor, golden.taskId).toBe(true)
      const note = /; named: (manager|peer)$/.exec(label.note ?? '')
      expect(note, label.note).not.toBeNull()
      expect(label.acceptablePersonaIds).not.toContain(note![1])
    }
  })

  it('matches the declared composition', () => {
    const declared = committed(
      `evals/tasks/synthetic-multi-persona-session/${VERSION}/composition.json`,
    )
    expect(declared).toEqual(composition())
  })
})
