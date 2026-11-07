#!/usr/bin/env node
/**
 * Verify exported Langfuse experiments against their run artifacts (M0.1 P3).
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/langfuse-verify.mjs [run-dir ...]
 *
 * Defaults to `evals/results/m0-canned-replay`. Reads each run's `langfuse.json`
 * and queries the self-hosted Langfuse public API. With two run directories it
 * also checks that both experiments expose the same item ids, which is what
 * makes side-by-side comparison work.
 *
 * Read-only: it never writes to Langfuse and never prints credentials.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const baseUrl = required('LANGFUSE_BASE_URL').replace(/\/+$/, '')
const publicKey = required('LANGFUSE_PUBLIC_KEY')
const secretKey = required('LANGFUSE_SECRET_KEY')
const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`

const dirs = process.argv.slice(2)
if (dirs.length === 0) dirs.push('evals/results/m0-canned-replay')

const summaries = []

for (const dir of dirs) {
  const runDir = resolve(dir)
  const artifact = JSON.parse(await readFile(`${runDir}/langfuse.json`, 'utf8'))

  assert(artifact.status === 'exported', `${dir}: export status is ${artifact.status}`)
  assert(
    typeof artifact.experimentId === 'string' && artifact.experimentId.length > 0,
    `${dir}: no experimentId`,
  )

  const traceIds = artifact.traceIds ?? {}
  const itemIds = Object.keys(traceIds).sort()
  assert(itemIds.length > 0, `${dir}: no trace ids recorded`)

  const window = timeWindow(artifact.exportedAt)
  const experiments = await api('/api/public/experiments', window)
  const experiment = experiments.data.find((entry) => entry.id === artifact.experimentId)
  assert(experiment !== undefined, `${dir}: experiment ${artifact.experimentId} not found`)
  assert(
    experiment.itemCount === itemIds.length,
    `${dir}: experiment has ${experiment.itemCount} item(s), artifact records ${itemIds.length}`,
  )

  const items = await api('/api/public/experiment-items', {
    ...window,
    experimentId: artifact.experimentId,
    limit: '100',
    fields: 'core,io,metadata,scores',
  })
  assert(
    items.data.length === itemIds.length,
    `${dir}: ${items.data.length} experiment item(s), expected ${itemIds.length}`,
  )

  const seen = new Set()
  for (const item of items.data) {
    const id = item.experimentItemId
    seen.add(id)
    assert(id in traceIds, `${dir}: unexpected item ${id}`)
    assert(item.traceId === traceIds[id], `${dir}: trace id mismatch for ${id}`)
    assert(
      item.metadata?.lang === 'en' || item.metadata?.lang === 'fr',
      `${dir}: ${id} has no lang`,
    )
    assert(typeof item.metadata?.taskId === 'string', `${dir}: ${id} has no taskId`)
    assert(item.input != null, `${dir}: ${id} has no input`)
    assert(item.output != null, `${dir}: ${id} has no output`)

    const names = new Set((item.scores ?? []).map((score) => score.name))
    for (const required of ['trial.status', 'trial.ok', 'transcript.guard_violations']) {
      assert(names.has(required), `${dir}: ${id} is missing score ${required}`)
    }
    for (const forbidden of ['score', 'overall', 'composite']) {
      assert(!names.has(forbidden), `${dir}: ${id} has a composite score "${forbidden}"`)
    }
  }

  assert(seen.size === itemIds.length, `${dir}: item id set differs from the artifact`)

  summaries.push({ dir, experimentId: artifact.experimentId, itemIds, experiment })
  console.log(
    `ok ${dir}: ${itemIds.length} item(s), experiment ${artifact.experimentId}, ${items.data.length} trace(s)`,
  )
}

if (summaries.length > 1) {
  const first = summaries[0].itemIds.join('\n')
  for (const summary of summaries.slice(1)) {
    assert(
      summary.itemIds.join('\n') === first,
      `experiment ${summary.experimentId} has a different item set`,
    )
  }
  console.log(`ok comparison: ${summaries.length} experiments share the same item ids`)
}

function required(name) {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    console.error(`missing ${name}; run with --env-file-if-exists=.env`)
    process.exit(2)
  }
  return value.trim()
}

function timeWindow(exportedAt) {
  const center = exportedAt === undefined ? Date.now() : Date.parse(exportedAt)
  const day = 24 * 60 * 60 * 1000
  return {
    fromStartTime: new Date(center - day).toISOString(),
    toStartTime: new Date(center + day).toISOString(),
  }
}

async function api(path, query) {
  const url = new URL(`${baseUrl}${path}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await fetch(url, { headers: { Authorization: auth } })
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`)
  }
  return response.json()
}

function assert(condition, message) {
  if (condition) return
  console.error(`FAIL ${message}`)
  process.exit(1)
}
