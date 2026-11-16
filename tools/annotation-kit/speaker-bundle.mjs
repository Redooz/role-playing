#!/usr/bin/env node
/**
 * Build a context-free speaker annotation bundle from committed session tasks.
 *
 * Example:
 *   node tools/annotation-kit/speaker-bundle.mjs \
 *     --tasks evals/tasks/synthetic-multi-persona-session/m3b-v2 \
 *     --out /tmp/m3c-p5-bundle \
 *     --guideline m3b-speaker-label-guideline-v1
 *
 * The bundle has one case per learner turn. It contains no split, task id,
 * authored label, score, arm or run identity. The real task, turn and expected
 * class go to the operator-only manifest next to it.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { annotatorCase, labelClass, manifestRow } from './speaker-cases.mjs'

// Node 26 strips types but does not rewrite `.js` to `.ts` inside a workspace
// package. The bundle reads scenario and persona data from source, so it uses
// the same resolve hook as the CLI entrypoints.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!specifier.endsWith('.js')) throw error
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw error
      if (context.parentURL === undefined) throw error
      return nextResolve(new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL).href, context)
    }
  },
})

const { personaById, personaVariant } = await import('@rp/persona-kit')
const { scenarioById, scenarioVariant } = await import('@rp/scenario-kit')

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) {
    if (fallback !== undefined) return fallback
    throw new Error(`${name} is required`)
  }
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function jsonFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...jsonFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'composition.json') {
      files.push(path)
    }
  }
  return files
}

function goldenFor(goldensRoot, lang, version, taskId) {
  for (const name of [`${taskId}.json`, `golden-${taskId}.json`]) {
    try {
      return JSON.parse(readFileSync(join(goldensRoot, lang, version, name), 'utf8'))
    } catch {
      // Try the other committed naming convention.
    }
  }
  throw new Error(`no golden for ${lang}/${version}/${taskId}`)
}

const repo = resolve(arg('--repo', process.cwd()))
const tasksRoot = resolve(
  repo,
  arg('--tasks', 'evals/tasks/synthetic-multi-persona-session/m3b-v2'),
)
const out = resolve(repo, arg('--out', 'evals/results/annotation-kit-m3c-speakers'))
const version = arg('--version', basename(tasksRoot))
const goldensRoot = resolve(repo, arg('--goldens', 'evals/golden'))
const rubric = arg('--rubric', 'm3b-turn-taking-rubric-v1')
const guideline = arg('--guideline', 'm3b-speaker-label-guideline-v1')

if (!statSync(tasksRoot).isDirectory()) throw new Error(`${tasksRoot} is not a directory`)

const cases = []
const manifest = []
for (const file of jsonFiles(tasksRoot)) {
  const task = JSON.parse(readFileSync(file, 'utf8'))
  if (task.session === undefined) throw new Error(`${file} is not a session task`)
  const scenario = scenarioById(task.session.scenarioId)
  const variant = scenarioVariant(scenario, task.locale)
  const personas = task.session.personaIds.map((id) => {
    const persona = personaById(id)
    return { id, displayName: personaVariant(persona, task.locale).displayName }
  })
  const golden = goldenFor(goldensRoot, task.lang, version, task.id)
  task.session.scriptedUserTurns.forEach((_turn, turnIndex) => {
    const label = golden.speakerLabels.find((entry) => entry.turnIndex === turnIndex)
    if (label === undefined) throw new Error(`golden ${task.id} has no label for turn ${turnIndex}`)
    cases.push(annotatorCase(task, variant, personas, turnIndex))
    manifest.push(manifestRow(task, turnIndex, labelClass(label)))
  })
}

cases.sort(
  (a, b) =>
    a.lang.localeCompare(b.lang) ||
    a.locale.localeCompare(b.locale) ||
    a.caseId.localeCompare(b.caseId),
)

const operatorManifest = resolve(`${out}-operator`, 'manifest.json')
mkdirSync(out, { recursive: true })
mkdirSync(dirname(operatorManifest), { recursive: true })
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
      rubric,
      annotationGuideline: guideline,
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
writeFileSync(operatorManifest, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`wrote ${cases.length} speaker cases to ${join(out, 'cases.jsonl')}`)
console.log(`operator manifest: ${operatorManifest}`)
