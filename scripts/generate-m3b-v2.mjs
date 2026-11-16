#!/usr/bin/env node
/**
 * Author `m3b-v2` (M3c P5).
 *
 * The dataset is two-sided by construction: every language and split carries
 * 28/10/2 (calibration) or 34/12/2 (holdout) speaker-required, silence-required
 * and mixed labels. Four turns per task, two two-persona scenarios, and a
 * pre-registered family pattern for every task.
 *
 * Run it with `node scripts/generate-m3b-v2.mjs`. It is deterministic: no
 * clock, no RNG, and it never rewrites `m3b-v1`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'prettier'
import {
  DATASET,
  DISTRIBUTION,
  FAMILY_DISTRIBUTION,
  LANGS,
  LOCALE_ORDER,
  PATTERNS,
  SCENARIOS,
  VERSION,
} from './m3b-v2-content.mjs'

const SPLITS = ['calibration', 'holdout']
const BASE_LOCALE = { en: 'en', fr: 'fr' }
const OTHER_LOCALE = { en: 'en-GB', fr: 'fr-CA' }

/** The class of one label, by who may speak next. */
export function labelClass(label) {
  if (label.acceptablePersonaIds.length === 0) return 'silence'
  return label.allowUserYield ? 'mixed' : 'speak'
}

function localeFor(lang, index) {
  return LOCALE_ORDER[index] === BASE_LOCALE[lang] ? BASE_LOCALE[lang] : OTHER_LOCALE[lang]
}

function localeSlug(locale) {
  return locale.toLowerCase()
}

function briefFor(scenario, lang) {
  return scenario.brief[lang]
}

function factText(scenario, locale, index) {
  const fact = scenario.facts[locale]?.[index]
  if (fact === undefined) {
    throw new Error(`scenario ${scenario.id} has no fact ${index} for ${locale}`)
  }
  return fact
}

function objectiveNote(evidence) {
  return `owner: objectives[${evidence.id}].personaIds=[${evidence.personaIds.join(',')}]`
}

function evidenceNote(scenario, locale, evidence) {
  if (evidence.kind === 'fact') {
    return `owner: facts[${evidence.index}] "${factText(scenario, locale, evidence.index)}"`
  }
  return objectiveNote(evidence)
}

/** One speaker label from one authored form. */
function labelFrom(family, form, scenario, locale) {
  if (form.reason !== undefined) {
    return {
      acceptablePersonaIds: [],
      allowUserYield: true,
      family,
      labelSource: 'agent',
      note: `${form.reason}; no owner`,
    }
  }

  const acceptablePersonaIds = typeof form.owner === 'string' ? [form.owner] : [...form.owner]
  const base = evidenceNote(scenario, locale, form.evidence)
  const note = form.named === undefined ? base : `${base}; named: ${form.named}`
  if (family === 'mixed') {
    return {
      acceptablePersonaIds,
      allowUserYield: true,
      family,
      labelSource: 'agent',
      note: `${note}; learner may proceed`,
    }
  }
  return {
    acceptablePersonaIds,
    allowUserYield: false,
    family,
    labelSource: 'agent',
    note,
    ...(form.named === undefined ? {} : { distractor: true }),
  }
}

/** Consume the next surface form for a family, in authored order. */
function nextForm(forms, cursors, lang, scenarioId, family) {
  const list = forms[lang]?.[family]
  if (list === undefined) throw new Error(`no ${family} forms for ${lang}`)
  const key = `${scenarioId}:${family}`
  const index = cursors[lang][key] ?? 0
  const form = list[index]
  if (form === undefined) throw new Error(`ran out of ${family} forms for ${lang}`)
  cursors[lang][key] = index + 1
  return form
}

function taskIdOf(lang, scenario, locale, split, index) {
  const splitPart = split === 'calibration' ? 'cal' : 'hold'
  return `${lang}-b2-${scenario.slug}-${localeSlug(locale)}-v2-${splitPart}-${String(index + 1).padStart(3, '0')}`
}

/** Build one task and its golden. */
function buildTask(lang, split, scenario, pattern, index, cursors) {
  const locale = localeFor(lang, index)
  const taskId = taskIdOf(lang, scenario, locale, split, index)
  const turns = pattern.map((family) => {
    const form = nextForm(scenario.forms, cursors, lang, scenario.id, family)
    return { text: form.text, label: labelFrom(family, form, scenario, locale) }
  })
  const labels = turns.map((turn) => turn.label)
  const task = {
    id: taskId,
    lang,
    locale,
    mode: 'session',
    domain: 'workplace',
    scenarioType: scenario.id,
    cefrBand: 'B2',
    speakerId: `syn-v2-${lang}-${scenario.slug}-${localeSlug(locale)}-${split}-${String(index + 1).padStart(3, '0')}`,
    split,
    provenance: { source: 'synthetic', note: 'M3c two-persona speaker-label decision points' },
    consentScope: 'synthetic-no-consent-required',
    annotationVersions: {
      rubric: 'm3b-turn-taking-rubric-v1',
      annotationGuideline: 'm3b-speaker-label-guideline-v1',
    },
    content: {
      scenarioBrief: briefFor(scenario, lang),
      turns: [],
    },
    session: {
      personaId: 'manager',
      personaIds: ['manager', 'peer'],
      personaVersion: '1.0.0',
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      scriptedUserTurns: turns.map((turn) => turn.text),
    },
  }
  const golden = {
    id: `golden-${taskId}`,
    lang,
    locale,
    split,
    taskId,
    speakerLabels: labels.map((label, turnIndex) => ({ turnIndex, ...label })),
    evidenceSpans: [],
    pairwisePreferences: [],
    status: 'draft',
    notes:
      'Agent labels authored against m3b-speaker-label-guideline-v1. Provisional, not human ground truth.',
  }
  return { task, golden }
}

/** Build the whole dataset in memory. */
export function buildDataset() {
  const tasks = []
  const goldens = []
  const cursors = { en: {}, fr: {} }
  for (const lang of LANGS) {
    for (const split of SPLITS) {
      for (const scenario of Object.values(SCENARIOS)) {
        const patterns = PATTERNS[split][scenario.id]
        patterns.forEach((pattern, index) => {
          const { task, golden } = buildTask(lang, split, scenario, pattern, index, cursors)
          tasks.push(task)
          goldens.push(golden)
        })
      }
    }
  }
  return { tasks, goldens }
}

/** Per-language, per-split, per-family label counts. */
export function familyMatrix(goldens) {
  const matrix = {}
  for (const lang of LANGS) {
    matrix[lang] = {}
    for (const split of SPLITS) {
      const counts = {}
      for (const golden of goldens) {
        if (golden.lang !== lang || golden.split !== split) continue
        for (const label of golden.speakerLabels) {
          counts[label.family] = (counts[label.family] ?? 0) + 1
        }
      }
      matrix[lang][split] = counts
    }
  }
  return matrix
}

function classCounts(goldens) {
  const counts = { speak: 0, silence: 0, mixed: 0 }
  for (const golden of goldens) {
    for (const label of golden.speakerLabels) counts[labelClass(label)] += 1
  }
  return counts
}

/** The pre-registered composition file. */
export function composition() {
  const splits = {}
  for (const split of SPLITS) {
    splits[split] = {}
    for (const lang of LANGS) {
      splits[split][lang] = {
        classes: { ...DISTRIBUTION[split] },
        minFamilies: Object.keys(FAMILY_DISTRIBUTION[split]).length,
        maxPerFamily: split === 'holdout' ? 8 : 6,
        minDistractors: split === 'holdout' ? 8 : 4,
      }
    }
  }
  return {
    schemaVersion: 1,
    dataset: DATASET,
    version: VERSION,
    unit: 'speaker_label',
    splits,
  }
}

function invariant(name, condition) {
  if (!condition) throw new Error(`m3b-v2 invariant failed: ${name}`)
}

/** Compare two count maps without depending on insertion order. */
function sameCounts(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].every((key) => left[key] === right[key])
}

/** Fail before writing if the generated tree cannot satisfy the contract. */
export function checkDataset(tasks, goldens) {
  invariant('44 tasks', tasks.length === 44)
  invariant(
    '176 labels',
    goldens.reduce((sum, golden) => sum + golden.speakerLabels.length, 0) === 176,
  )

  const seen = { en: new Set(), fr: new Set() }
  for (const task of tasks) {
    for (const turn of task.session.scriptedUserTurns) {
      invariant(`unique ${task.lang} utterance "${turn}"`, !seen[task.lang].has(turn))
      seen[task.lang].add(turn)
    }
  }

  for (const lang of LANGS) {
    for (const split of SPLITS) {
      const slice = goldens.filter((golden) => golden.lang === lang && golden.split === split)
      const counts = classCounts(slice)
      invariant(`${lang}/${split} classes`, sameCounts(counts, DISTRIBUTION[split]))
      const families = familyMatrix(goldens)[lang][split]
      invariant(`${lang}/${split} families`, sameCounts(families, FAMILY_DISTRIBUTION[split]))
      for (const [family, count] of Object.entries(families)) {
        const max = split === 'holdout' ? 8 : 6
        invariant(`${lang}/${split} ${family} <= ${max}`, count <= max)
      }
    }
  }

  for (const golden of goldens) {
    invariant(`speaker labels ${golden.taskId}`, golden.speakerLabels.length === 4)
    golden.speakerLabels.forEach((label, index) => {
      invariant(`turn order ${golden.taskId}`, label.turnIndex === index)
      if (labelClass(label) === 'speak') {
        invariant(`speak note ${golden.taskId}/${index}`, label.note.startsWith('owner: '))
      }
    })
  }

  const distractors = goldens.flatMap((golden) =>
    golden.speakerLabels.filter((label) => label.distractor === true),
  )
  invariant('24 distractors', distractors.length === 24)
  for (const lang of LANGS) {
    for (const split of SPLITS) {
      const count = goldens
        .filter((golden) => golden.lang === lang && golden.split === split)
        .flatMap((golden) => golden.speakerLabels)
        .filter((label) => label.distractor === true).length
      invariant(`${lang}/${split} distractors`, count === (split === 'holdout' ? 8 : 4))
    }
  }
}

/** Write the tasks, goldens and composition. Existing files are replaced. */
export async function writeDataset(repoRoot) {
  const { tasks, goldens } = buildDataset()
  checkDataset(tasks, goldens)
  const taskRoot = join(repoRoot, 'evals/tasks', DATASET, VERSION)
  const goldenRoot = join(repoRoot, 'evals/golden')
  for (const task of tasks) {
    const path = join(taskRoot, task.lang, `${task.id}.json`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, await format(JSON.stringify(task, null, 2), { parser: 'json' }))
  }
  for (const golden of goldens) {
    const path = join(goldenRoot, golden.lang, VERSION, `${golden.taskId}.json`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, await format(JSON.stringify(golden, null, 2), { parser: 'json' }))
  }
  const compositionPath = join(taskRoot, 'composition.json')
  writeFileSync(
    compositionPath,
    await format(JSON.stringify(composition(), null, 2), { parser: 'json' }),
  )
  return { tasks: tasks.length, goldens: goldens.length }
}

const entry = fileURLToPath(import.meta.url)
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === entry

if (invokedDirectly) {
  const repoRoot = resolve(dirname(entry), '..')
  const { tasks, goldens } = await writeDataset(repoRoot)
  console.log(`wrote ${tasks} tasks and ${goldens} goldens for ${VERSION}`)
}
