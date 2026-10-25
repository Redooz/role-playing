import { describe, expect, it } from 'vitest'
import { createJevClient } from './client.js'
import { JEV_MODEL, isPinnedServedModel } from './constants.js'
import { assertJevSmokeSuite, runJevSmokeSuite } from './smoke-suite.js'

const apiKey = process.env.OPENROUTER_API_KEY

/**
 * Live canary for M0 gate G4.
 *
 * Skipped unless OPENROUTER_API_KEY is present. It proves the integration
 * against the real Decisions API; it does not gate behavior (no behavior
 * exists at M0).
 */
describe.runIf(apiKey !== undefined && apiKey.trim() !== '')(
  'Jev canary (M0 gate G4, live OpenRouter Decisions API)',
  () => {
    it(
      'returns valid pinned-model distributions for EN, FR, and an unsettled question',
      { timeout: 90_000 },
      async () => {
        const key = process.env.OPENROUTER_API_KEY
        if (key === undefined || key.trim() === '') {
          throw new Error('OPENROUTER_API_KEY must be set to run the Jev canary')
        }

        // Bypass the cache: a canary that replays a cached response does not
        // prove the live endpoint still works.
        const client = createJevClient({
          apiKey: key,
          cache: false,
          timeoutMs: 30_000,
        })
        const report = await runJevSmokeSuite(client)

        console.log(
          `[${report.suiteId}] observations:\n${JSON.stringify(report.observations, null, 2)}`,
        )
        console.log(`[${report.suiteId}] total cost USD: ${report.totalCostUsd}`)

        assertJevSmokeSuite(report)
        expect(report.passed).toBe(true)
        expect(report.pinnedModel).toBe(JEV_MODEL)
        expect(report.observations).toHaveLength(3)
        expect(report.observations.every((observation) => observation.ok)).toBe(true)
        expect(
          report.observations.every(
            (observation) =>
              observation.servedModel !== null && isPinnedServedModel(observation.servedModel),
          ),
        ).toBe(true)
        expect(report.totalCostUsd).toBeLessThan(0.01)
      },
    )
  },
)
