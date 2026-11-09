/**
 * `@rp/scenario-kit` — versioned scenario and scripted-user data (M2 D2).
 *
 * Data plus pure lookup. No clock, environment, file or provider access.
 */

export * from './scenario.js'
export * from './lookup.js'
export { deadlineExtensionScenario } from './scenarios/deadline-extension.js'
export { standupClarifyScenario } from './scenarios/standup-clarify.js'
export { declineMeetingScenario } from './scenarios/decline-meeting.js'

import { deadlineExtensionScenario } from './scenarios/deadline-extension.js'
import { standupClarifyScenario } from './scenarios/standup-clarify.js'
import { declineMeetingScenario } from './scenarios/decline-meeting.js'
import type { ScenarioSpec } from './scenario.js'

/** Every scenario shipped by M2. */
export const SCENARIOS: readonly ScenarioSpec[] = [
  deadlineExtensionScenario,
  standupClarifyScenario,
  declineMeetingScenario,
]

/** Every scenario keyed by id. */
export const SCENARIOS_BY_ID: ReadonlyMap<string, ScenarioSpec> = new Map(
  SCENARIOS.map((scenario) => [scenario.id, scenario]),
)

export class UnknownScenarioError extends Error {
  constructor(id: string) {
    super(`unknown scenario "${id}"`)
    this.name = 'UnknownScenarioError'
  }
}

/** Look up a scenario by id. Unknown ids are a hard error. */
export function scenarioById(id: string): ScenarioSpec {
  const scenario = SCENARIOS_BY_ID.get(id)
  if (scenario === undefined) throw new UnknownScenarioError(id)
  return scenario
}
