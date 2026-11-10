import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeDurations } from '@rp/agent-harness-bench'
import type { RoutingContext } from '@rp/routing-policy'
import {
  createJevRoutingJudge,
  createJevClient,
  taskEntrySchema,
  runJevRoutingReplay,
} from '@rp/eval-harness'
import { describe, expect, it } from 'vitest'
import { ROUTING_TIMING_ENV } from './index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TASKS_ROOT = join(REPO_ROOT, 'evals/tasks/synthetic-routing/1.0.0')
const REPORT_PATH = join(REPO_ROOT, 'evals/results/m3a-routing-timing/timing.json')
const DEADLINE_MS = 15_000

interface Sample {
  readonly topology: 'central_selection' | 'persona_requests'
  readonly lang: 'en' | 'fr'
  readonly taskId: string
  readonly latencyMs: number
  readonly fallback: boolean
  readonly fallbackCause: 'timeout' | 'unsettled' | null
  readonly failed: boolean
  readonly costUsd: number | null
}

function fallbackCause(
  result: Awaited<ReturnType<typeof runJevRoutingReplay>>,
): Sample['fallbackCause'] {
  if (!result.ok || result.decision.fallback.kind !== 'deterministic') return null
  return result.decision.fallback.cause
}

function usageCost(result: Awaited<ReturnType<typeof runJevRoutingReplay>>): number | null {
  if (!result.ok) return null
  const observation = result.observation as {
    central?: { exact?: { usage?: { cost?: number } } }
    personas?: Record<string, { exact?: { usage?: { cost?: number } } }>
  }
  const batches = [
    ...(observation.central?.exact === undefined ? [] : [observation.central.exact]),
    ...Object.values(observation.personas ?? {}).map((entry) => entry.exact),
  ].filter((batch): batch is { usage?: { cost?: number } } => batch !== undefined)
  if (batches.length === 0) return null
  let total = 0
  for (const batch of batches) {
    if (batch.usage?.cost === undefined) return null
    total += batch.usage.cost
  }
  return total
}

async function loadCalibration(lang: 'en' | 'fr', limit: number): Promise<RoutingContext[]> {
  const directory = join(TASKS_ROOT, lang)
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()
  const contexts: RoutingContext[] = []
  for (const file of files) {
    const task = taskEntrySchema.parse(JSON.parse(await readFile(join(directory, file), 'utf8')))
    if (task.mode !== 'routing' || task.split !== 'calibration' || task.routing === undefined)
      continue
    contexts.push(task.routing.context)
    if (contexts.length === limit) break
  }
  return contexts
}

describe('M3a routing timing', () => {
  it.skipIf(process.env[ROUTING_TIMING_ENV] !== '1')(
    'measures complete central and per-persona decisions at the policy boundary',
    async () => {
      const apiKey = process.env.OPENROUTER_API_KEY
      if (apiKey === undefined || apiKey.trim() === '') {
        throw new Error(`OPENROUTER_API_KEY is required when ${ROUTING_TIMING_ENV}=1`)
      }

      const client = createJevClient({ apiKey, cache: false })
      const judge = createJevRoutingJudge(client)
      const samples: Sample[] = []
      let costUsd = 0

      for (const lang of ['en', 'fr'] as const) {
        for (const context of await loadCalibration(lang, 3)) {
          for (const topology of ['central_selection', 'persona_requests'] as const) {
            if (costUsd >= 5) break
            const result = await runJevRoutingReplay(context, topology, judge, {
              seed: 20261109,
              deadlineMs: DEADLINE_MS,
            })
            const cost = usageCost(result)
            if (cost !== null) costUsd += cost
            samples.push({
              topology,
              lang,
              taskId: context.decisionId,
              latencyMs: result.policyLatencyMs,
              fallback: fallbackCause(result) !== null,
              fallbackCause: fallbackCause(result),
              failed: !result.ok,
              costUsd: cost,
            })
          }
        }
      }

      const groups = new Map<string, Sample[]>()
      for (const sample of samples) {
        const key = `${sample.topology}:${sample.lang}`
        const group = groups.get(key)
        if (group === undefined) groups.set(key, [sample])
        else group.push(sample)
      }

      const metrics = [...groups.entries()]
        .map(([key, group]) => {
          const [topology, lang] = key.split(':') as [Sample['topology'], Sample['lang']]
          return {
            topology,
            lang,
            n: group.length,
            failures: group.filter((sample) => sample.failed).length,
            fallbacks: group.filter((sample) => sample.fallback).length,
            timeoutFallbacks: group.filter((sample) => sample.fallbackCause === 'timeout').length,
            unsettledFallbacks: group.filter((sample) => sample.fallbackCause === 'unsettled')
              .length,
            latencyMs: summarizeDurations(group.map((sample) => sample.latencyMs)),
            costUsd: group.every((sample) => sample.costUsd !== null)
              ? group.reduce((total, sample) => total + (sample.costUsd ?? 0), 0)
              : null,
          }
        })
        .sort(
          (left, right) =>
            left.topology.localeCompare(right.topology) || left.lang.localeCompare(right.lang),
        )

      const report = {
        schemaVersion: 1,
        suite: 'm3a-routing-timing',
        note: 'Live Jev timing on calibration-only synthetic tasks. One complete policy decision per sample; no cache.',
        deadlineMs: DEADLINE_MS,
        costCapUsd: 5,
        samples: samples.length,
        totalCostUsd: costUsd,
        metrics,
        generatedAt: new Date().toISOString(),
      }
      await mkdir(join(REPO_ROOT, 'evals/results/m3a-routing-timing'), { recursive: true })
      await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      console.table(
        metrics.map((entry) => ({
          topology: entry.topology,
          lang: entry.lang,
          n: entry.n,
          p50: entry.latencyMs.p50.toFixed(1),
          p95: entry.latencyMs.p95.toFixed(1),
          p99: entry.latencyMs.p99.toFixed(1),
          failures: entry.failures,
          fallbacks: entry.fallbacks,
          timeouts: entry.timeoutFallbacks,
          unsettled: entry.unsettledFallbacks,
          costUsd: entry.costUsd,
        })),
      )
      console.log(`routing timing report: ${REPORT_PATH}`)
      expect(samples.length).toBeGreaterThan(0)
    },
    300_000,
  )
})
