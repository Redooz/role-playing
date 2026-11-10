import { routingDecisionSchema } from '@rp/routing-policy'
import { routingOutcomeLabelSchema } from '../tasks/schema.js'
import type { RoutingDecisionArtifact } from './routing.js'

/**
 * Pure routing-matrix aggregation for M3a D5/D6.
 *
 * No arm is selected here. The report keeps every metric per arm and per
 * language, treats incomplete infrastructure as its own count, and never turns a
 * missing cost into zero.
 */

export interface RoutingMatrixEntry {
  readonly armId: string
  readonly lang: 'en' | 'fr'
  readonly artifact: RoutingDecisionArtifact
  readonly label: unknown
}

interface LatencySummary {
  readonly count: number
  readonly min: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
}

export interface RoutingArmLanguageReport {
  readonly armId: string
  readonly lang: 'en' | 'fr'
  readonly n: number
  readonly completed: number
  readonly incomplete: number
  readonly acceptable: number
  readonly acceptableOutcomeRate: number | null
  readonly falseSpeak: number
  readonly falseSpeakRate: number | null
  readonly falseYield: number
  readonly falseYieldRate: number | null
  readonly timeoutFallbacks: number
  readonly unsettledFallbacks: number
  readonly timeoutFallbackRate: number | null
  readonly unsettledFallbackRate: number | null
  readonly fallbackRate: number | null
  readonly latencyMs: LatencySummary | null
  readonly usage: {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly costUsd: number | null
  }
}

export interface RoutingMatrixReport {
  readonly schemaVersion: 1
  readonly arms: readonly RoutingArmLanguageReport[]
}

function percentile(sorted: readonly number[], point: number): number {
  if (sorted.length === 0) throw new Error('cannot compute a percentile of an empty sample')
  const rank = (sorted.length - 1) * point
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  const a = sorted[lower]!
  const b = sorted[upper]!
  return a + (b - a) * (rank - lower)
}

function latencySummary(values: readonly number[]): LatencySummary | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1]!,
  }
}

function rate(count: number, denominator: number): number | null {
  return denominator === 0 ? null : count / denominator
}

interface Usage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly costUsd?: number
}

function usageOfObservation(artifact: RoutingDecisionArtifact): Usage | undefined {
  const observation = artifact.observation as {
    central?: {
      exact?: { usage?: { input_tokens?: number; output_tokens?: number; cost?: number } }
    }
    personas?: Record<
      string,
      { exact?: { usage?: { input_tokens?: number; output_tokens?: number; cost?: number } } }
    >
  }

  const batches = [
    ...(observation.central?.exact === undefined ? [] : [observation.central.exact]),
    ...Object.values(observation.personas ?? {}).map((entry) => entry.exact),
  ]
  if (batches.length === 0) return undefined
  if (
    batches.some(
      (batch) =>
        batch === undefined ||
        batch.usage === undefined ||
        batch.usage.input_tokens === undefined ||
        batch.usage.output_tokens === undefined ||
        batch.usage.cost === undefined,
    )
  ) {
    // If any contributing call is incomplete, no total is known. Returning
    // partial tokens or zero cost would imply measured data we do not have.
    return {}
  }

  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  for (const batch of batches) {
    inputTokens += batch!.usage!.input_tokens!
    outputTokens += batch!.usage!.output_tokens!
    costUsd += batch!.usage!.cost!
  }

  return { inputTokens, outputTokens, costUsd }
}

function sumKnown(values: readonly (number | undefined)[]): number | null {
  if (values.length === 0) return null
  let total = 0
  for (const value of values) {
    if (value === undefined) return null
    total += value
  }
  return total
}

function summarizeGroup(
  armId: string,
  lang: 'en' | 'fr',
  entries: readonly RoutingMatrixEntry[],
): RoutingArmLanguageReport {
  let completed = 0
  let incomplete = 0
  let acceptable = 0
  let falseSpeak = 0
  let falseYield = 0
  let timeoutFallbacks = 0
  const usages: Usage[] = []
  const latencies: number[] = []

  for (const entry of entries) {
    latencies.push(entry.artifact.policyLatencyMs)
    const timedOut = entry.artifact.observation.kind === 'timeout'
    if (entry.artifact.outcome === 'infrastructure_incomplete' || timedOut) {
      incomplete += 1
      if (timedOut) timeoutFallbacks += 1
      continue
    }

    completed += 1
    const decision = routingDecisionSchema.parse(entry.artifact.decision)
    const label = routingOutcomeLabelSchema.parse(entry.label)
    const accepted =
      decision.outcome.kind === 'speak'
        ? label.acceptablePersonaIds.includes(decision.outcome.personaId)
        : label.allowUserYield

    if (accepted) acceptable += 1
    if (decision.outcome.kind === 'speak' && !accepted) falseSpeak += 1
    if (decision.outcome.kind === 'user_yield' && !accepted) falseYield += 1
    const usage = usageOfObservation(entry.artifact)
    if (usage !== undefined) usages.push(usage)
  }

  const unsettledFallbacks = entries.filter((entry) => {
    if (entry.artifact.outcome !== 'completed' || entry.artifact.decision === undefined)
      return false
    const decision = routingDecisionSchema.parse(entry.artifact.decision)
    return decision.fallback.kind === 'deterministic' && decision.fallback.cause === 'unsettled'
  }).length
  const deterministicFallbacks = entries.filter((entry) => {
    if (
      entry.artifact.outcome !== 'completed' ||
      entry.artifact.decision === undefined ||
      entry.artifact.observation.kind === 'timeout'
    ) {
      return false
    }
    const decision = routingDecisionSchema.parse(entry.artifact.decision)
    return decision.fallback.kind === 'deterministic'
  }).length

  return {
    armId,
    lang,
    n: entries.length,
    completed,
    incomplete,
    acceptable,
    acceptableOutcomeRate: rate(acceptable, completed),
    falseSpeak,
    falseSpeakRate: rate(falseSpeak, completed),
    falseYield,
    falseYieldRate: rate(falseYield, completed),
    timeoutFallbacks,
    unsettledFallbacks,
    timeoutFallbackRate: rate(timeoutFallbacks, entries.length),
    unsettledFallbackRate: rate(unsettledFallbacks, entries.length),
    fallbackRate: rate(timeoutFallbacks + deterministicFallbacks, entries.length),
    latencyMs: latencySummary(latencies),
    usage: {
      inputTokens: sumKnown(usages.map((usage) => usage.inputTokens)),
      outputTokens: sumKnown(usages.map((usage) => usage.outputTokens)),
      costUsd: sumKnown(usages.map((usage) => usage.costUsd)),
    },
  }
}

/** Build the per-arm/per-language report. Input order never changes the output order. */
export function buildRoutingMatrix(entries: readonly RoutingMatrixEntry[]): RoutingMatrixReport {
  const groups = new Map<string, RoutingMatrixEntry[]>()
  for (const entry of entries) {
    const key = `${entry.armId}\u0000${entry.lang}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [entry])
    else group.push(entry)
  }

  const arms = [...groups.entries()]
    .map(([key, group]) => {
      const [armId, lang] = key.split('\u0000') as [string, 'en' | 'fr']
      return summarizeGroup(armId, lang, group)
    })
    .sort(
      (left, right) => left.armId.localeCompare(right.armId) || left.lang.localeCompare(right.lang),
    )

  return { schemaVersion: 1, arms }
}
