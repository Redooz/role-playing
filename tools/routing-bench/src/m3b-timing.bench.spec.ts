import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeDurations } from '@rp/agent-harness-bench'
import {
  INITIAL_ARBITER_STATE,
  parseTurnArbiterConfig,
  reduce,
  type ArbiterState,
} from '@rp/turn-arbiter'
import { parseRoutingContext } from '@rp/routing-policy'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const REPORT_PATH = join(REPO_ROOT, 'evals/results/m3b-timing/timing.json')
const ITERATIONS = 500
const config = parseTurnArbiterConfig()

export const RUN_M3B_TIMING_ENV = 'RUN_M3B_TIMING'

function duration(run: () => void): number {
  const start = performance.now()
  run()
  return performance.now() - start
}

function makeTurnContext(turnId: string) {
  return parseRoutingContext({
    decisionId: `decision-${turnId}`,
    turnId,
    lang: 'en',
    transcript: [{ speaker: { kind: 'user' }, text: 'Sam, what is the deadline?' }],
    coveredObjectiveIds: [],
    personas: [
      {
        id: 'manager',
        displayName: 'Katherine Brooks',
        aliases: ['Katherine'],
        role: 'manager',
        objectives: [{ id: 'deadline', description: 'Agree a deadline.', keywords: ['deadline'] }],
      },
      {
        id: 'peer',
        displayName: 'Sam Carter',
        aliases: ['Sam'],
        role: 'peer',
        objectives: [{ id: 'scope', description: 'Clarify scope.', keywords: ['scope'] }],
      },
    ],
  })
}

describe('M3b control-arm timing', () => {
  it.skipIf(process.env[RUN_M3B_TIMING_ENV] !== '1')(
    'measures grant, interject and partial transitions',
    async () => {
      const grantSamples: number[] = []
      const interjectSamples: number[] = []
      const partialSamples: number[] = []

      for (let index = 0; index < ITERATIONS; index += 1) {
        const turnId = `turn-${index}`
        const context = makeTurnContext(turnId)
        let state: ArbiterState = INITIAL_ARBITER_STATE
        grantSamples.push(
          duration(() => {
            state = reduce(
              state,
              {
                kind: 'user_committed',
                turnId,
                nowMs: 0,
                seed: index,
                context,
                eligiblePersonaIds: ['manager', 'peer'],
              },
              config,
            ).state
            state = reduce(
              state,
              {
                kind: 'request',
                request: {
                  turnId,
                  personaId: 'manager',
                  action: 'speak',
                  urgency: 1,
                  confidence: 1,
                  addressedByUser: true,
                  objectiveRelevance: 1,
                },
                nowMs: 1,
              },
              config,
            ).state
            state = reduce(state, { kind: 'tick', nowMs: config.requestWindowMs }, config).state
          }),
        )

        if (state.phase !== 'grant_active') throw new Error('expected an active grant')
        const grantId = state.grant.grantId
        partialSamples.push(
          duration(() => {
            for (let sequence = 0; sequence < 32; sequence += 1) {
              state = reduce(
                state,
                {
                  kind: 'partial',
                  grantId,
                  text: 'partial',
                  sequence,
                  nowMs: config.minHoldMs + sequence,
                },
                config,
              ).state
            }
          }),
        )
        interjectSamples.push(
          duration(() => {
            state = reduce(
              state,
              {
                kind: 'request',
                request: {
                  turnId,
                  personaId: 'peer',
                  action: 'interject',
                  urgency: 1,
                  confidence: 1,
                  addressedByUser: true,
                  objectiveRelevance: 1,
                  targetGrantId: grantId,
                },
                nowMs: config.minHoldMs + 40,
              },
              config,
            ).state
            state = reduce(
              state,
              { kind: 'tick', nowMs: config.minHoldMs + config.interjectExpiryMs },
              config,
            ).state
          }),
        )
      }

      const report = {
        schemaVersion: 1,
        suite: 'm3b-timing',
        note: 'Calibration-only reducer timing. No provider call, no wall-clock assertion in test:unit.',
        iterations: ITERATIONS,
        config,
        metrics: {
          userCommitToGrant: summarizeDurations(grantSamples),
          partialSequence32: summarizeDurations(partialSamples),
          interjectRequestToNewGrant: summarizeDurations(interjectSamples),
        },
        generatedAt: new Date().toISOString(),
      }
      await mkdir(join(REPO_ROOT, 'evals/results/m3b-timing'), { recursive: true })
      await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      console.log(`m3b timing report: ${REPORT_PATH}`)
      expect(grantSamples).toHaveLength(ITERATIONS)
    },
    120_000,
  )
})
