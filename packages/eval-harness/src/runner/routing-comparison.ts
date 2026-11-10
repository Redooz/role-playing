import type { RoutingContext } from '@rp/routing-policy'
import {
  buildRoutingMatrix,
  type RoutingMatrixEntry,
  type RoutingMatrixReport,
} from './routing-matrix.js'
import {
  routingArtifact,
  type RoutingDecisionArtifact,
  type RoutingReplayResult,
  type RoutingArm,
} from './routing.js'

export interface RoutingComparisonTask {
  readonly taskId: string
  readonly lang: 'en' | 'fr'
  readonly context: RoutingContext
  readonly label: unknown
}

export interface RoutingComparisonArm {
  readonly armId: string
  readonly arm: RoutingArm
  readonly run: (context: RoutingContext) => Promise<RoutingReplayResult>
}

export interface RoutingComparisonRun {
  readonly entries: readonly RoutingMatrixEntry[]
  readonly matrix: RoutingMatrixReport
  readonly artifactsByArm: Readonly<Record<string, readonly RoutingDecisionArtifact[]>>
}

/** Run every registered arm against the same tasks and build exact artifacts. */
export async function runRoutingComparison(
  tasks: readonly RoutingComparisonTask[],
  arms: readonly RoutingComparisonArm[],
): Promise<RoutingComparisonRun> {
  if (arms.length === 0) throw new Error('a routing comparison needs at least one arm')
  if (new Set(arms.map((arm) => arm.armId)).size !== arms.length) {
    throw new Error('routing comparison arm ids must be unique')
  }

  const entries: RoutingMatrixEntry[] = []
  const artifactsByArm: Record<string, RoutingDecisionArtifact[]> = {}
  for (const arm of arms) {
    artifactsByArm[arm.armId] = []
  }

  for (const arm of arms) {
    for (const task of tasks) {
      const result = await arm.run(task.context)
      const artifact = routingArtifact(task.context, result, {
        trialId: `${arm.armId}:0:${task.lang}:${task.taskId}`,
        taskId: task.taskId,
        arm: arm.arm,
      })
      artifactsByArm[arm.armId]!.push(artifact)
      entries.push({
        armId: arm.armId,
        lang: task.lang,
        artifact,
        label: task.label,
      })
    }
  }

  return {
    entries,
    matrix: buildRoutingMatrix(entries),
    artifactsByArm,
  }
}

export interface RoutingArmVerdict {
  readonly armId: string
  readonly lang: 'en' | 'fr'
  readonly baselineArmId: string
  readonly metric: 'routing.acceptable_outcome_rate'
  readonly baseline: number | null
  readonly candidate: number | null
  readonly delta: number | null
  readonly minimumDetectableEffect: number
  readonly incomplete: number
  readonly verdict: 'baseline' | 'target_met' | 'target_missed' | 'incomplete'
}

/**
 * Compare each non-baseline arm with the reference arm per language.
 *
 * A target met is not a policy selection. Incomplete trial data cannot pass, and
 * no composite score is formed.
 */
export function computeRoutingArmVerdicts(
  matrix: RoutingMatrixReport,
  baselineArmId: string,
  minimumDetectableEffect: number,
): RoutingArmVerdict[] {
  if (!Number.isFinite(minimumDetectableEffect) || minimumDetectableEffect <= 0) {
    throw new Error('minimum detectable effect must be positive')
  }
  const baseline = new Map(
    matrix.arms.filter((arm) => arm.armId === baselineArmId).map((arm) => [arm.lang, arm] as const),
  )
  if (baseline.size === 0)
    throw new Error(`baseline arm ${JSON.stringify(baselineArmId)} is missing`)

  for (const arm of matrix.arms) {
    for (const lang of baseline.keys()) {
      if (
        !matrix.arms.some((candidate) => candidate.armId === arm.armId && candidate.lang === lang)
      ) {
        throw new Error(`arm ${JSON.stringify(arm.armId)} is missing language ${lang}`)
      }
    }
  }

  const verdicts: RoutingArmVerdict[] = []
  for (const arm of matrix.arms) {
    const reference = baseline.get(arm.lang)
    if (reference === undefined) {
      throw new Error(
        `baseline arm ${JSON.stringify(baselineArmId)} is missing language ${arm.lang}`,
      )
    }
    if (arm.armId === baselineArmId) {
      verdicts.push({
        armId: arm.armId,
        lang: arm.lang,
        baselineArmId,
        metric: 'routing.acceptable_outcome_rate',
        baseline: reference.acceptableOutcomeRate,
        candidate: arm.acceptableOutcomeRate,
        delta: 0,
        minimumDetectableEffect,
        incomplete: arm.incomplete,
        verdict: 'baseline',
      })
      continue
    }

    if (
      arm.incomplete > 0 ||
      reference.incomplete > 0 ||
      arm.acceptableOutcomeRate === null ||
      reference.acceptableOutcomeRate === null
    ) {
      verdicts.push({
        armId: arm.armId,
        lang: arm.lang,
        baselineArmId,
        metric: 'routing.acceptable_outcome_rate',
        baseline: reference.acceptableOutcomeRate,
        candidate: arm.acceptableOutcomeRate,
        delta: null,
        minimumDetectableEffect,
        incomplete: arm.incomplete,
        verdict: 'incomplete',
      })
      continue
    }

    const delta = arm.acceptableOutcomeRate - reference.acceptableOutcomeRate
    verdicts.push({
      armId: arm.armId,
      lang: arm.lang,
      baselineArmId,
      metric: 'routing.acceptable_outcome_rate',
      baseline: reference.acceptableOutcomeRate,
      candidate: arm.acceptableOutcomeRate,
      delta,
      minimumDetectableEffect,
      incomplete: 0,
      verdict: delta >= minimumDetectableEffect ? 'target_met' : 'target_missed',
    })
  }

  return verdicts.sort(
    (left, right) => left.armId.localeCompare(right.armId) || left.lang.localeCompare(right.lang),
  )
}
