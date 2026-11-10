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
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

const cases = jsonFiles(tasksRoot).map((file) =>
  annotatorCase(JSON.parse(readFileSync(file, 'utf8'))),
)
cases.sort((a, b) => a.lang.localeCompare(b.lang) || a.taskId.localeCompare(b.taskId))

mkdirSync(out, { recursive: true })
writeFileSync(
  join(out, 'cases.jsonl'),
  cases.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
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
        taskId: 'string',
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
console.log(`wrote ${cases.length} routing cases to ${out}/cases.jsonl`)
