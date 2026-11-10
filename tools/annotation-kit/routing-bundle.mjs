#!/usr/bin/env node
/**
 * Build a context-free routing annotation bundle from committed task files.
 *
 * Example:
 *   node tools/annotation-kit/routing-bundle.mjs \
 *     --tasks evals/tasks/synthetic-routing/1.0.0 \
 *     --out evals/results/annotation-kit-m3a
 *
 * The bundle contains no labels, split, arm, score or run identity.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { annotatorCase } from './routing-labels.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

const repo = resolve(arg('--repo', process.cwd()))
const tasksRoot = resolve(repo, arg('--tasks', 'evals/tasks/synthetic-routing/1.0.0'))
const out = resolve(repo, arg('--out', 'evals/results/annotation-kit-m3a'))

function jsonFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...jsonFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path)
  }
  return files
}

if (!statSync(tasksRoot).isDirectory()) throw new Error(`${tasksRoot} is not a directory`)

function opaqueCaseId(taskId) {
  return `case-${createHash('sha256').update(taskId).digest('hex').slice(0, 16)}`
}

const rows = jsonFiles(tasksRoot)
  .map((file) => JSON.parse(readFileSync(file, 'utf8')))
  .map((task) => {
    const caseId = opaqueCaseId(task.id)
    return { task, caseId, caseData: annotatorCase(task, caseId) }
  })
rows.sort(
  (a, b) =>
    a.caseData.lang.localeCompare(b.caseData.lang) ||
    a.caseData.caseId.localeCompare(b.caseData.caseId),
)

const operatorManifest = resolve(`${out}-operator`, 'manifest.json')
mkdirSync(out, { recursive: true })
mkdirSync(dirname(operatorManifest), { recursive: true })
writeFileSync(
  join(out, 'cases.jsonl'),
  rows.map((row) => JSON.stringify(row.caseData)).join('\n') + '\n',
)
writeFileSync(
  join(out, 'config.json'),
  `${JSON.stringify(
    {
      defaultPass: 'p1',
      labelsDir: 'labels',
      rubric: 'm3a-routing-rubric-v1',
      annotationGuideline: 'm3a-routing-label-v1',
      labelShape: {
        caseId: 'opaque case id from cases.jsonl',
        lang: 'en | fr',
        intent: 'short string',
        acceptablePersonaIds: ['persona ids'],
        allowUserYield: 'boolean',
      },
    },
    null,
    2,
  )}\n`,
)
writeFileSync(
  operatorManifest,
  `${JSON.stringify(
    rows.map((row) => ({
      caseId: row.caseId,
      taskId: row.task.id,
      lang: row.task.lang,
      split: row.task.split,
    })),
    null,
    2,
  )}\n`,
)
console.log(`wrote ${rows.length} routing cases to ${out}/cases.jsonl`)
console.log(`operator manifest: ${operatorManifest}`)
