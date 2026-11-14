import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildGrades } from './grades.js'
import { buildObservationPlan, type ObservationPlan } from './plan.js'
import { executeRun, type EvaluationRun } from '../runner/runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

const fixedWallClock = (): number => 1_700_000_000_000
const targetTask = 'en-b1-report-deadline-001'

function loadManifestRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
}

function loadTask(id: string, lang: 'en' | 'fr'): { content: { turns: { text: string }[] } } {
  return JSON.parse(
    readFileSync(join(repoRoot, `evals/tasks/synthetic-workplace/v1/${lang}/${id}.json`), 'utf8'),
  ) as { content: { turns: { text: string }[] } }
}

describe('buildTrace', () => {
  let execution: EvaluationRun
  let plan: ObservationPlan

  beforeEach(async () => {
    execution = await executeRun({
      repoRoot,
      manifest: loadManifestRaw(),
      wallClock: fixedWallClock,
    })
    const grades = [...buildGrades({ execution }).records]
    plan = buildObservationPlan({ execution, grades })
  })

  it('maps a session transcript without replay turns', async () => {
    const sessionManifest = JSON.parse(
      readFileSync(join(repoRoot, 'evals/manifests/m2-persona-replay-v2.json'), 'utf8'),
    ) as Record<string, unknown>
    const sessionExecution = await executeRun({
      repoRoot,
      manifest: sessionManifest,
      wallClock: fixedWallClock,
    })
    const sessionGrades = buildGrades({ execution: sessionExecution }).records
    const sessionPlan = buildObservationPlan({
      execution: sessionExecution,
      grades: sessionGrades,
    })

    expect(sessionPlan.items).toHaveLength(12)
    const item = sessionPlan.items[0]
    expect(item?.itemId).toMatch(/^0:(en|fr):/)
    expect(item?.input.turns.length).toBeGreaterThan(0)
    expect(item?.input.turns.every((turn) => turn.role === 'user')).toBe(true)
    expect(item?.output.conversation).toBeDefined()
    expect(item?.output.conversation?.length).toBeGreaterThan(1)
    expect(item?.output.conversation?.[0]?.role).toBe('persona')
    expect(item?.output.transcript).toContain('Persona:')
    expect(item?.output.transcript).toContain('Learner:')
    const personaSpans = item?.trace.spans.filter((span) => span.name.includes(' persona')) ?? []
    const userSpans = item?.trace.spans.filter((span) => span.name.includes(' user')) ?? []
    expect(personaSpans).toHaveLength(userSpans.length + 1)
    expect(
      item?.trace.spans
        .filter((span) => span.type === 'generation')
        .every((span) => span.model === 'm2-persona-canned-v1'),
    ).toBe(true)
  })

  it('builds turn spans and provider generations from the transcript', () => {
    const item = plan.items.find((candidate) => candidate.itemId === `0:en:${targetTask}`)
    expect(item).toBeDefined()

    expect(item?.input.scenarioBrief).toContain('junior analyst')
    expect(item?.input.turns).toHaveLength(5)

    const spans = item?.trace.spans ?? []
    expect(spans.filter((span) => span.type === 'generation')).toHaveLength(3)
    expect(spans.filter((span) => span.name.includes(' user'))).toHaveLength(2)
    expect(spans.filter((span) => span.name.includes(' persona'))).toHaveLength(3)
    expect(spans).toHaveLength(8)

    const generations = spans.filter((span) => span.type === 'generation')
    expect(generations.map((span) => span.parentId)).toEqual([
      'turn-0-persona',
      'turn-2-persona',
      'turn-4-persona',
    ])
    expect(generations.map((span) => span.model)).toEqual([
      'canned/persona-v1',
      'canned/persona-v1',
      'canned/persona-v1',
    ])

    const task = loadTask(targetTask, 'en')
    expect(generations.at(-1)?.output).toBe(task.content.turns.at(-1)?.text)
    expect(item?.output.status).toBe('completed')
    expect(item?.output.finalText).toBe(task.content.turns.at(-1)?.text)

    // First persona turn has no prior messages; the last has four.
    const inputSizes = generations.map((span) =>
      Array.isArray(span.input) ? span.input.length : -1,
    )
    expect(inputSizes).toEqual([0, 2, 4])
  })

  it('records grants and closes persona spans on a committed response', () => {
    const item = plan.items.find((candidate) => candidate.itemId === `0:en:${targetTask}`)
    const personaSpans = (item?.trace.spans ?? []).filter((span) => span.name.includes(' persona'))
    expect(personaSpans).toHaveLength(3)

    for (const span of personaSpans) {
      expect(span.events.map((event) => event.name)).toEqual(['turn.granted'])
      expect(span.endMs).toBeGreaterThanOrEqual(span.startMs)
    }

    expect(item?.trace.events.map((event) => event.name)).toEqual(['session.completed'])
  })
})
