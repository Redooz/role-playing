#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Export a static annotation sheet from accepted eval runs.
 *
 * This is a labelling aid, not a viewer or dashboard: it renders one section per
 * trial with the dialogue and blank 1–5 axis fields. The output belongs under
 * `evals/results/`, which is git-ignored.
 *
 * Usage:
 *   npm run label:export -- --lang en \
 *     --run evals/results/m2-persona-scenarios-lk \
 *     --run evals/results/m2-persona-baseline-lk \
 *     --out evals/results/labeling/m2-gemma-label-set-en-v1.md
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const AXES = [
  'persona.consistency',
  'language.quality',
  'register.fit',
  'response.clarity',
  'objective.completion',
]
const LOCALE_AXIS = 'locale.fit'

const args = process.argv.slice(2)

function argValue(name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

function argValues(name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} requires a value`)
    }
    values.push(value)
  }
  return values
}

const lang = argValue('--lang', 'en')
if (lang !== 'en' && lang !== 'fr') throw new Error('--lang must be "en" or "fr"')

const runDirs = argValues('--run')
if (runDirs.length === 0) {
  throw new Error('provide at least one --run <evals/results/...> directory')
}

const outPath = resolve(
  REPO_ROOT,
  argValue('--out', `evals/results/labeling/m2-gemma-label-set-${lang}-v1.md`),
)

const runIdOf = (runDir) => runDir.replace(/\/+$/u, '').split('/').at(-1)

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function transcriptLines(records) {
  const lines = []
  for (const record of records) {
    if (record.kind === 'user.utterance.committed') {
      const text = record.payload?.text
      if (typeof text === 'string' && text.length > 0) lines.push(`**Learner:** ${text}`)
    } else if (record.kind === 'persona.response.committed') {
      const text = record.payload?.text
      if (typeof text === 'string' && text.length > 0) lines.push(`**Persona:** ${text}`)
    }
  }
  return lines
}

function labelId(runId, round, taskId) {
  return `golden-${lang}-v1-${runId}-r${round}-${taskId}`
}

function axisRows(task) {
  const axes = [...AXES]
  if ((task.locale ?? task.lang) !== task.lang) axes.push(LOCALE_AXIS)
  return [
    '| Axis | 1–5 | Rationale | Evidence |',
    '| --- | --- | --- | --- |',
    ...axes.map((axis) => `| \`${axis}\` | | | |`),
  ]
}

const sections = []
let trialCount = 0

for (const runDir of runDirs) {
  const absoluteRunDir = resolve(REPO_ROOT, runDir)
  const runId = runIdOf(absoluteRunDir)
  const result = await readJson(join(absoluteRunDir, 'result.json'))
  const dataset = result.manifest.tasks.dataset
  const version = result.manifest.tasks.version
  const trials = result.trials
    .filter((trial) => trial.lang === lang)
    .sort((left, right) =>
      left.round === right.round
        ? left.taskId.localeCompare(right.taskId)
        : left.round - right.round,
    )

  sections.push(`# Run \`${runId}\` (${trials.length} ${lang} trials)`, '')

  for (const trial of trials) {
    trialCount += 1
    const taskPath = join(REPO_ROOT, 'evals/tasks', dataset, version, lang, `${trial.taskId}.json`)
    const task = await readJson(taskPath)
    const transcriptPath = join(absoluteRunDir, trial.transcriptPath)
    const raw = (await readFile(transcriptPath, 'utf8')).trim()
    const records = raw === '' ? [] : raw.split('\n').map((line) => JSON.parse(line))
    const lines = transcriptLines(records)
    const trialId = `${trial.round}:${lang}:${trial.taskId}`

    sections.push(
      `## ${trialId}`,
      '',
      `- runId: \`${runId}\``,
      `- round: \`${trial.round}\``,
      `- taskId: \`${trial.taskId}\``,
      `- lang / locale: \`${task.lang}\` / \`${task.locale ?? task.lang}\``,
      `- persona / scenario: \`${task.session?.personaId ?? 'unknown'}\` / \`${task.session?.scenarioId ?? 'unknown'}\``,
      `- CEFR: \`${task.cefrBand}\`; split: \`${task.split}\``,
      `- transcript: \`${trial.transcriptPath}\``,
      `- suggested golden id: \`${labelId(runId, trial.round, trial.taskId)}\``,
      '',
      ...lines,
      '',
      ...axisRows(task),
      '',
    )
  }
}

const header = [
  `# M2 Gemma label set — ${lang}`,
  '',
  '- Label set: `m2-gemma-label-set-v1`',
  '- Rubric: `m2-persona-rubric-v1`',
  '- Guideline: `m2-annotation-guideline-v1`',
  `- Runs: ${runDirs.map((run) => `\`${runIdOf(resolve(REPO_ROOT, run))}\``).join(', ')}`,
  `- Trials in this sheet: ${trialCount}`,
  '',
  'Label blind: do not read Jev scores, `grades.jsonl`, or another annotator’s',
  'labels. Score every axis 1–5; map 4–5 to `yes` and 1–3 to `no` for Jev',
  'agreement. Quote evidence for any score of 1–3. Keep the golden entry `draft`',
  'until the double-labelled subset has a measured agreement block.',
  '',
  '---',
  '',
]

await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, `${[...header, ...sections].join('\n')}\n`, 'utf8')
console.log(`wrote ${outPath} (${trialCount} ${lang} trials)`)
