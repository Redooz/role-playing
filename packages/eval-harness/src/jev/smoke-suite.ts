import { JEV_MODEL, JEV_SMOKE_SUITE_ID, isPinnedServedModel } from './constants.js'
import {
  buildEnglishSmokeJudgment,
  buildFrenchSmokeJudgment,
  buildUnsettledSmokeJudgment,
} from './questions.js'
import type {
  JevDistribution,
  JevGrader,
  JevJudgment,
  JevJudgmentSuccess,
  JevLang,
  JevResult,
} from './types.js'

export type JevSmokeRole = 'english' | 'french' | 'unsettled'

export interface JevSmokeCase {
  readonly id: string
  readonly role: JevSmokeRole
  readonly lang: JevLang
  readonly judgment: JevJudgment
}

function smokeCase(role: JevSmokeRole, judgment: JevJudgment): JevSmokeCase {
  return {
    id: judgment.metadata.id,
    role,
    lang: judgment.metadata.lang,
    judgment,
  }
}

/** The pre-registered 3-question canary from M0 gate G4. */
export const JEV_SMOKE_CASES: readonly JevSmokeCase[] = [
  smokeCase('english', buildEnglishSmokeJudgment()),
  smokeCase('french', buildFrenchSmokeJudgment()),
  smokeCase('unsettled', buildUnsettledSmokeJudgment()),
]

export interface JevSmokeObservation {
  readonly caseId: string
  readonly role: JevSmokeRole
  readonly lang: JevLang
  readonly ok: boolean
  readonly servedModel: string | null
  readonly distribution: JevDistribution | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly cacheHit: boolean
  readonly costUsd: number
}

export interface JevSmokeReport {
  readonly suiteId: typeof JEV_SMOKE_SUITE_ID
  readonly pinnedModel: typeof JEV_MODEL
  readonly passed: boolean
  readonly failures: readonly string[]
  readonly observations: readonly JevSmokeObservation[]
  readonly totalCostUsd: number
}

/**
 * Run the canary and evaluate gate G4.
 *
 * Pass requires:
 * - English and French answers from the pinned model with a complete,
 *   in-range distribution;
 * - the unsettled answer to complete without throwing and to keep both sides
 *   strictly inside (0, 1), i.e. not forced to a side.
 *
 * Any failure code is reported explicitly. Nothing is coerced to a label.
 */
export async function runJevSmokeSuite(grader: JevGrader): Promise<JevSmokeReport> {
  const observations: JevSmokeObservation[] = []
  const failures: string[] = []
  let totalCostUsd = 0

  for (const smoke of JEV_SMOKE_CASES) {
    let result: JevResult
    try {
      result = await grader.grade(smoke.judgment)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${caseLabel(smoke)}: grader threw: ${message}`)
      observations.push({
        caseId: smoke.id,
        role: smoke.role,
        lang: smoke.lang,
        ok: false,
        servedModel: null,
        distribution: null,
        errorCode: 'jev_threw',
        errorMessage: message,
        cacheHit: false,
        costUsd: 0,
      })
      continue
    }

    if (!result.ok) {
      failures.push(`${caseLabel(smoke)}: ${result.error.code}: ${result.error.message}`)
      observations.push({
        caseId: smoke.id,
        role: smoke.role,
        lang: smoke.lang,
        ok: false,
        servedModel: null,
        distribution: null,
        errorCode: result.error.code,
        errorMessage: result.error.message,
        cacheHit: result.cache.hit,
        costUsd: 0,
      })
      continue
    }

    const costUsd = result.usage.cost ?? 0
    totalCostUsd += costUsd
    const caseFailures = checkSuccessfulCase(smoke, result)
    failures.push(...caseFailures)
    observations.push({
      caseId: smoke.id,
      role: smoke.role,
      lang: smoke.lang,
      ok: caseFailures.length === 0,
      servedModel: result.servedModel,
      distribution: result.distribution,
      errorCode: null,
      errorMessage: null,
      cacheHit: result.cache.hit,
      costUsd,
    })
  }

  return {
    suiteId: JEV_SMOKE_SUITE_ID,
    pinnedModel: JEV_MODEL,
    passed: failures.length === 0,
    failures,
    observations,
    totalCostUsd,
  }
}

/** Throw a readable error when the canary report does not satisfy G4. */
export function assertJevSmokeSuite(report: JevSmokeReport): void {
  if (report.passed) return
  throw new Error(`Jev smoke suite ${report.suiteId} failed:\n- ${report.failures.join('\n- ')}`)
}

function checkSuccessfulCase(smoke: JevSmokeCase, result: JevJudgmentSuccess): string[] {
  const failures: string[] = []

  if (!isPinnedServedModel(result.servedModel)) {
    failures.push(
      `${caseLabel(smoke)}: served model ${JSON.stringify(result.servedModel)} is not pinned to ${JEV_MODEL}`,
    )
  }

  if (result.distribution.kind !== smoke.judgment.question.type) {
    failures.push(
      `${caseLabel(smoke)}: ${result.distribution.kind} distribution does not match ${smoke.judgment.question.type} question`,
    )
  }

  const probabilities = distributionEntries(result.distribution)
  if (probabilities.length === 0) {
    failures.push(`${caseLabel(smoke)}: distribution is empty`)
  }
  for (const [label, probability] of probabilities) {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      failures.push(`${caseLabel(smoke)}: invalid probability ${label}=${String(probability)}`)
    }
  }

  if (smoke.role === 'unsettled') {
    if (result.distribution.kind !== 'noul') {
      failures.push(`${caseLabel(smoke)}: unsettled case must return a two-sided noul distribution`)
    } else {
      const yes = result.distribution.probabilityYes
      const no = result.distribution.probabilityNo
      if (!(yes > 0 && yes < 1)) {
        failures.push(`${caseLabel(smoke)}: unsettled case forced to a side (yes=${yes})`)
      }
      if (!(no > 0 && no < 1)) {
        failures.push(`${caseLabel(smoke)}: unsettled case forced to a side (no=${no})`)
      }
    }
  }

  return failures
}

function distributionEntries(distribution: JevDistribution): Array<[string, number]> {
  switch (distribution.kind) {
    case 'noul':
      return [
        ['yes', distribution.probabilityYes],
        ['no', distribution.probabilityNo],
      ]
    case 'choice':
    case 'score':
      return Object.entries(distribution.probabilities)
    default:
      return assertNever(distribution)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Jev distribution: ${JSON.stringify(value)}`)
}

function caseLabel(smoke: JevSmokeCase): string {
  return `${smoke.role} (${smoke.id})`
}
