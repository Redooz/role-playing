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
import type { TaskEntry } from '../tasks/schema.js'
import type { TrialOutcome } from '../runner/results.js'
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

  function targetItem(candidate: ObservationPlan): ObservationPlan['items'][number] {
    const item = candidate.items.find((entry) => entry.itemId === `0:en:${targetTask}`)
    if (item === undefined) throw new Error('missing target item')
    return item
  }

  function withoutTargetTranscript(run: EvaluationRun): EvaluationRun {
    return {
      ...run,
      transcripts: run.transcripts.filter(
        (transcript) =>
          !(transcript.round === 0 && transcript.lang === 'en' && transcript.taskId === targetTask),
      ),
    }
  }

  function withTargetTrial(run: EvaluationRun, trial: TrialOutcome): EvaluationRun {
    return {
      ...run,
      result: {
        ...run.result,
        trials: run.result.trials.map((candidate) =>
          candidate.round === 0 && candidate.lang === 'en' && candidate.taskId === targetTask
            ? trial
            : candidate,
        ),
      },
    }
  }

  function withTargetTask(run: EvaluationRun, task: TaskEntry): EvaluationRun {
    return {
      ...run,
      tasks: run.tasks.map((loaded) =>
        loaded.task.id === targetTask && loaded.task.lang === 'en' ? { ...loaded, task } : loaded,
      ),
    }
  }

  function targetTaskEntry(run: EvaluationRun): TaskEntry {
    const loaded = run.tasks.find(
      (candidate) => candidate.task.id === targetTask && candidate.task.lang === 'en',
    )
    if (loaded === undefined) throw new Error('missing target task')
    return loaded.task
  }

  function bareTrial(ok: boolean): TrialOutcome {
    return {
      round: 0,
      taskId: targetTask,
      lang: 'en',
      ok,
      records: 0,
      providerOutage: false,
    }
  }

  it('keeps the exact item contract for a replay task', () => {
    const item = targetItem(plan)

    expect(Object.keys(item).sort()).toEqual([
      'input',
      'itemId',
      'lang',
      'metadata',
      'output',
      'round',
      'scores',
      'taskId',
      'trace',
      'trialId',
    ])
    expect(item.input).toStrictEqual({
      scenarioBrief:
        'A junior analyst asks their manager for a two-day extension on a quarterly report that is due on Friday.',
      turns: [
        {
          index: 0,
          role: 'persona',
          text: 'Morning. Before we start, how is the quarterly report coming along?',
        },
        {
          index: 1,
          role: 'user',
          text: 'It is going well, but I am a bit worried about the time. Could I have two more days to finish the analysis?',
        },
        {
          index: 2,
          role: 'persona',
          text: 'Two days is more than I expected. What is still missing?',
        },
        {
          index: 3,
          role: 'user',
          text: 'I need to check the figures from the sales team and write the summary. If I send the first draft on Monday, would that be acceptable?',
        },
        {
          index: 4,
          role: 'persona',
          text: 'That works if you send me the headline numbers on Friday. Let us agree on that.',
        },
      ],
    })
    expect(item.output).toStrictEqual({
      status: 'completed',
      finalText: 'That works if you send me the headline numbers on Friday. Let us agree on that.',
      conversation: [
        {
          index: 0,
          role: 'persona',
          text: 'Morning. Before we start, how is the quarterly report coming along?',
        },
        {
          index: 1,
          role: 'user',
          text: 'It is going well, but I am a bit worried about the time. Could I have two more days to finish the analysis?',
        },
        {
          index: 2,
          role: 'persona',
          text: 'Two days is more than I expected. What is still missing?',
        },
        {
          index: 3,
          role: 'user',
          text: 'I need to check the figures from the sales team and write the summary. If I send the first draft on Monday, would that be acceptable?',
        },
        {
          index: 4,
          role: 'persona',
          text: 'That works if you send me the headline numbers on Friday. Let us agree on that.',
        },
      ],
      transcript: [
        'Persona: Morning. Before we start, how is the quarterly report coming along?',
        'Learner: It is going well, but I am a bit worried about the time. Could I have two more days to finish the analysis?',
        'Persona: Two days is more than I expected. What is still missing?',
        'Learner: I need to check the figures from the sales team and write the summary. If I send the first draft on Monday, would that be acceptable?',
        'Persona: That works if you send me the headline numbers on Friday. Let us agree on that.',
      ].join('\n'),
    })
    expect(item.metadata).toStrictEqual({
      round: 0,
      lang: 'en',
      taskId: targetTask,
      cefrBand: 'B1',
      domain: 'workplace',
      scenarioType: 'request-deadline-extension',
      split: 'calibration',
      providerMode: 'canned',
      providerLabel: 'm0-task-persona-v1',
      graderId: 'deterministic-invariants',
      graderVersion: '1.0.0',
      rubricVersion: 'm0-harness-v1',
      verdict: 'accepted',
      transcriptPath: `transcripts/round-0/en/${targetTask}.jsonl`,
      transcriptSha256: '512cd7cf07e328e50a233744ca9e8abaf30b1d5d10966e21dc6f88e1713bdff2',
    })
    expect('expectedOutput' in item).toBe(false)
  })

  it('omits optional output and metadata keys when the data is absent', () => {
    const stripped = withoutTargetTranscript(withTargetTrial(execution, bareTrial(true)))
    const item = targetItem(buildObservationPlan({ execution: stripped, grades }))

    expect(item.output).toStrictEqual({ status: 'completed' })
    expect('finalText' in item.output).toBe(false)
    expect('conversation' in item.output).toBe(false)
    expect('transcript' in item.output).toBe(false)
    expect('transcriptPath' in item.metadata).toBe(false)
    expect('transcriptSha256' in item.metadata).toBe(false)
  })

  it('keeps only the status on a failed trial with no error and no transcript', () => {
    const stripped = withoutTargetTranscript(withTargetTrial(execution, bareTrial(false)))
    const item = targetItem(buildObservationPlan({ execution: stripped, grades }))

    expect(item.output).toStrictEqual({ status: 'failed' })
  })

  it('keeps the partial conversation on a failed trial without an error', () => {
    const item = targetItem(
      buildObservationPlan({
        execution: withTargetTrial(execution, bareTrial(false)),
        grades,
      }),
    )

    expect(Object.keys(item.output).sort()).toEqual(['conversation', 'status', 'transcript'])
    expect(item.output.status).toBe('failed')
    expect(item.output.transcript?.split('\n')).toHaveLength(5)
  })

  it('uses scripted user turns for a session task', () => {
    const task = targetTaskEntry(execution)
    const sessionTask: TaskEntry = {
      ...task,
      mode: 'session',
      content: { ...task.content, turns: [] },
      session: {
        personaId: 'manager',
        personaVersion: 'v1',
        scenarioId: 'standup-scope-change',
        scenarioVersion: 'v1',
        scriptedUserTurns: ['First learner turn.', 'Second learner turn.'],
      },
    }
    const item = targetItem(
      buildObservationPlan({ execution: withTargetTask(execution, sessionTask), grades }),
    )

    expect(item.input.turns).toStrictEqual([
      { index: 0, role: 'user', text: 'First learner turn.' },
      { index: 1, role: 'user', text: 'Second learner turn.' },
    ])
  })

  it('omits the scenario brief when the task has none', () => {
    const task = targetTaskEntry(execution)
    const noBrief: TaskEntry = {
      ...task,
      content: { turns: task.content.turns },
    }
    const item = targetItem(
      buildObservationPlan({ execution: withTargetTask(execution, noBrief), grades }),
    )

    expect('scenarioBrief' in item.input).toBe(false)
    expect(item.input.turns).toHaveLength(task.content.turns.length)
  })

  it('drops every score for a blind export', () => {
    const blind = buildObservationPlan({ execution, grades, includeScores: false })
    expect(blind.items.every((item) => item.scores.length === 0)).toBe(true)
    expect(plan.items.every((item) => item.scores.length > 0)).toBe(true)
  })

  it('pins the experiment identity and metadata', () => {
    const { result } = execution
    expect(plan.experiment.name).toBe('m0-canned-replay 2023-11-14T22:13:20.000Z')
    expect(plan.experiment.description).toBe(result.manifest.run.description)
    expect(plan.experiment.metadata).toStrictEqual({
      runId: result.runId,
      suite: result.suite,
      purpose: result.manifest.run.purpose,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      manifestHash: result.manifestHash,
      verdict: result.verdict.status,
      seed: result.manifest.seeds.master,
      rounds: result.manifest.limits.rounds,
    })
    expect('codeSha' in plan.experiment.metadata).toBe(false)
  })

  it('carries the code SHA when the run recorded one', () => {
    const { result } = execution
    const withSha: EvaluationRun = {
      ...execution,
      result: {
        ...result,
        versions: { ...result.versions, codeSha: 'abc1234' },
      },
    }
    const shaPlan = buildObservationPlan({ execution: withSha, grades })
    expect(shaPlan.experiment.metadata.codeSha).toBe('abc1234')
  })

  it('omits the optional experiment description and code SHA when absent', () => {
    const { result } = execution
    const bare: EvaluationRun = {
      ...execution,
      result: {
        ...result,
        manifest: {
          ...result.manifest,
          run: { ...result.manifest.run, description: undefined },
        },
        versions: { ...result.versions, codeSha: undefined },
      },
    }
    const barePlan = buildObservationPlan({ execution: bare, grades })

    expect('description' in barePlan.experiment).toBe(false)
    expect('codeSha' in barePlan.experiment.metadata).toBe(false)
  })

  it('maps every score kind to the exact platform score', () => {
    const base = grades[0] as TrialGrade
    const grade: TrialGrade = {
      ...base,
      grader: { ...base.grader, model: 'typesafe/jev-1.14' },
      scores: [
        {
          metric: 'answer.explained',
          kind: 'boolean',
          value: true,
          status: 'graded',
          explanation: 'explained',
          evidence: 'evidenced',
          raw: { answer: 'yes', probability: 0.9 },
        },
        { metric: 'answer.numeric', kind: 'numeric', value: 0.5, status: 'graded' },
        {
          metric: 'answer.categorical',
          kind: 'categorical',
          value: 'ship',
          status: 'graded',
          evidence: 'because',
        },
        {
          metric: 'answer.rejected',
          kind: 'boolean',
          value: false,
          status: 'inconclusive',
          explanation: 'because',
        },
      ],
    }

    const scores = toObservationScores(grade)
    const withoutModel = toObservationScores(base)
    expect('graderModel' in (withoutModel[0]?.metadata ?? {})).toBe(false)
    const common = {
      graderId: base.grader.id,
      graderKind: base.grader.kind,
      graderVersion: base.grader.version,
      rubricVersion: base.rubricVersion,
      graderModel: 'typesafe/jev-1.14',
    }
    expect(scores).toStrictEqual([
      {
        name: 'answer.explained',
        value: 1,
        dataType: 'BOOLEAN',
        comment: 'explained',
        metadata: {
          ...common,
          status: 'graded',
          kind: 'boolean',
          evidence: 'evidenced',
          explanation: 'explained',
          raw: { answer: 'yes', probability: 0.9 },
        },
      },
      {
        name: 'answer.numeric',
        value: 0.5,
        dataType: 'NUMERIC',
        metadata: { ...common, status: 'graded', kind: 'numeric' },
      },
      {
        name: 'answer.categorical',
        value: 'ship',
        dataType: 'CATEGORICAL',
        comment: 'because',
        metadata: {
          ...common,
          status: 'graded',
          kind: 'categorical',
          evidence: 'because',
        },
      },
      {
        name: 'answer.rejected',
        value: 0,
        dataType: 'BOOLEAN',
        comment: 'because',
        metadata: {
          ...common,
          status: 'inconclusive',
          kind: 'boolean',
          explanation: 'because',
        },
      },
    ])
  })

  it('names the trial with no grade record', () => {
    const firstTrial = execution.result.trials[0] as TrialOutcome
    expect(() => buildObservationPlan({ execution, grades: grades.slice(1) })).toThrow(
      new ObservationPlanError(
        `no grade record for trial ${firstTrial.round}:${firstTrial.lang}:${firstTrial.taskId}`,
      ),
    )
  })

  it('names the trial whose task is not loaded', () => {
    const withoutTask: EvaluationRun = {
      ...execution,
      tasks: execution.tasks.filter(
        (loaded) => !(loaded.task.id === targetTask && loaded.task.lang === 'en'),
      ),
    }
    expect(() => buildObservationPlan({ execution: withoutTask, grades })).toThrow(
      new ObservationPlanError(`no loaded task matches trial 0:en:${targetTask}`),
    )
  })
})
