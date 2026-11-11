import type { RoutingContext } from '@rp/routing-policy'

/**
 * Public routing context for live arbiter tests.
 *
 * The shape is the M3a `RoutingContext`, so the live path and an offline
 * replay rank the same requests with the same comparator. It never contains
 * labels.
 */
export function makeTurnContext(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    decisionId: 'decision-1',
    turnId: 'turn-1',
    lang: 'en',
    transcript: [{ speaker: { kind: 'user' }, text: 'Sam, can you take the standup?' }],
    personas: [
      {
        id: 'manager',
        displayName: 'Katherine Brooks',
        aliases: ['Katherine', 'Kate'],
        role: 'manager',
        objectives: [
          {
            id: 'deadline',
            description: 'Agree a delivery deadline.',
            keywords: ['deadline', 'delivery date'],
          },
        ],
      },
      {
        id: 'peer',
        displayName: 'Sam Carter',
        aliases: ['Sam'],
        role: 'peer colleague',
        objectives: [
          {
            id: 'handoff',
            description: 'Confirm the handoff before the standup.',
            keywords: ['handoff', 'standup'],
          },
        ],
      },
    ],
    coveredObjectiveIds: [],
    ...overrides,
  }
}
