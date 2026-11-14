import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from '@rp/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildGrades, type TrialGrade } from './grades.js'
import {
  ObservationPlanError,
  buildObservationPlan,
  toObservationScores,
  type ObservationPlan,
} from './plan.js'
import { loadGoldenEntries, goldenIndexByTask } from '../tasks/golden.js'
import { executeRun, type EvaluationRun } from '../runner/runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

const fixedWallClock = (): number => 1_700_000_000_000
const targetTask = 'en-b1-report-deadline-001'

function loadManifestRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
}

describe('buildObservationPlan', () => {
  let execution: EvaluationRun
  let grades: TrialGrade[]
  let plan: ObservationPlan

  beforeEach(async () => {
    execution = await executeRun({
      repoRoot,
      manifest: loadManifestRaw(),
      wallClock: fixedWallClock,
    })
    grades = [...buildGrades({ execution }).records]
    plan = buildObservationPlan({ execution, grades })
  })

  it('maps one execution to one experiment and 12 items', () => {
    expect(plan.schemaVersion).toBe('1.0.0')
    expect(plan.executionId).toBe(grades[0]?.executionId)
    expect(plan.environment).toBe('experiment')
    expect(plan.dataset).toEqual({ name: 'synthetic-workplace', version: 'v1' })
    expect(plan.experiment.id).toBe(plan.executionId)
    expect(plan.experiment.metadata).toMatchObject({
      runId: 'm0-canned-replay',
      verdict: 'accepted',
      seed: 20261025,
      rounds: 2,
    })
    expect(plan.items).toHaveLength(12)
  })

  it('uses a stable item id per round, language and task', () => {
    const ids = plan.items.map((item) => item.itemId).sort()
    expect(ids).toContain(`0:en:${targetTask}`)
    expect(ids).toContain('0:fr:fr-b1-rapport-delai-001')
    expect(new Set(ids).size).toBe(12)
    for (const item of plan.items) {
      expect(item.itemId).toBe(`${item.round}:${item.lang}:${item.taskId}`)
    }
  })

  it('turns grades into platform scores without a composite score', () => {
    const item = plan.items.find((candidate) => candidate.itemId === `0:en:${targetTask}`)
    const scores = item?.scores ?? []
    const names = scores.map((score) => score.name)

    expect(names).toContain('trial.status')
    expect(names).toContain('trial.ok')
    expect(names).toContain('transcript.guard_violations')
    expect(names).not.toContain('score')
    expect(scores.every((score) => score.metadata['graderVersion'] === '1.0.0')).toBe(true)

    const status = scores.find((score) => score.name === 'trial.status')
    expect(status).toMatchObject({ value: 'graded', dataType: 'CATEGORICAL' })

    const ok = scores.find((score) => score.name === 'trial.ok')
    expect(ok).toMatchObject({ value: 1, dataType: 'BOOLEAN' })

    const guard = scores.find((score) => score.name === 'transcript.guard_violations')
    expect(guard).toMatchObject({ value: 0, dataType: 'NUMERIC' })
  })

  it('keeps the raw model answer and distribution in score metadata', () => {
    const [grade] = grades
    expect(grade).toBeDefined()
    const withRaw: TrialGrade = {
      ...(grade as TrialGrade),
      scores: (grade as TrialGrade).scores.map((score) =>
        score.metric === 'transcript.guard_violations'
          ? {
              ...score,
              explanation: 'one review question',
              raw: {
                question: 'Does the reply stay inside its grant?',
                answer: 'yes',
                probability: 0.87,
                distribution: { yes: 0.87, no: 0.13 },
              },
            }
          : score,
      ),
    }

    const scores = toObservationScores(withRaw)
    const guard = scores.find((score) => score.name === 'transcript.guard_violations')
    expect(guard?.metadata['raw']).toEqual({
      question: 'Does the reply stay inside its grant?',
      answer: 'yes',
      probability: 0.87,
      distribution: { yes: 0.87, no: 0.13 },
    })
    expect(guard?.comment).toBe('one review question')
  })

  it('attaches the golden reference when one exists for the task', async () => {
    const golden = await loadGoldenEntries(repoRoot, { version: 'v1', languages: ['en', 'fr'] })
    const expectedOutputs = goldenIndexByTask(golden)
    const withGolden = buildObservationPlan({ execution, grades, expectedOutputs })

    const item = withGolden.items.find((candidate) => candidate.itemId === `0:en:${targetTask}`)
    expect(item?.expectedOutput).toMatchObject({
      taskId: targetTask,
      status: 'draft',
    })

    const without = withGolden.items.find(
      (candidate) => candidate.itemId === '0:en:en-b2-standup-clarify-002',
    )
    expect(without?.expectedOutput).toBeUndefined()
  })

  it('is deterministic for the same run and grades', () => {
    const second = buildObservationPlan({ execution, grades })
    expect(canonicalJson(second)).toBe(canonicalJson(plan))
  })

  it('rejects a missing grade or a grade from another execution', () => {
    expect(() => buildObservationPlan({ execution, grades: grades.slice(1) })).toThrow(
      ObservationPlanError,
    )

    const foreign = grades.map((grade, index) =>
      index === 0 ? { ...grade, executionId: 'another-execution' } : grade,
    )
    expect(() => buildObservationPlan({ execution, grades: foreign })).toThrow(
      /belongs to execution another-execution/,
    )
  })

  it('marks a failed trial as failed, with no turn spans and no zero scores', async () => {
    const { ProviderUnavailableError } = await import('../runner/canned-provider.js')
    const failedExecution = await executeRun({
      repoRoot,
      manifest: loadManifestRaw(),
      wallClock: fixedWallClock,
      providerFactory: () => ({
        kind: 'live',
        label: 'test-outage',
        complete() {
          throw new ProviderUnavailableError('provider is down', 'test-outage')
        },
      }),
    })
    const failedGrades = buildGrades({ execution: failedExecution }).records
    const failedPlan = buildObservationPlan({
      execution: failedExecution,
      grades: [...failedGrades],
    })

    const item = failedPlan.items[0]
    expect(item?.output.status).toBe('failed')
    expect(item?.output.error).toContain('provider is down')
    expect(item?.trace.spans).toEqual([])
    expect(item?.scores.map((score) => score.name).sort()).toEqual([
      'trial.provider_outage',
      'trial.status',
    ])
    expect(item?.scores.find((score) => score.name === 'trial.status')?.value).toBe('inconclusive')
    expect(item?.scores.some((score) => score.name === 'trial.ok')).toBe(false)
    expect(item?.scores.every((score) => score.value !== 0)).toBe(true)
  })
})
