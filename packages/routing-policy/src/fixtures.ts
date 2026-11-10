import { parseRoutingContext, type RoutingContext } from './schemas.js'

const PERSONAS: RoutingContext['personas'] = [
  {
    id: 'manager',
    displayName: 'Katherine Brooks',
    aliases: ['Katherine', 'Kate'],
    role: 'manager',
    objectives: [
      {
        id: 'deadline',
        description: 'Agree a delivery deadline.',
        keywords: ['deadline', 'timeline', 'delivery date'],
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
        keywords: ['handoff', 'hand over', 'standup'],
      },
      {
        id: 'coverage',
        description: 'Find cover for tomorrow.',
        keywords: ['cover', 'tomorrow'],
      },
    ],
  },
  {
    id: 'client',
    displayName: 'Julian Moore',
    aliases: ['Julian', 'Mr Moore'],
    role: 'external client',
    objectives: [
      {
        id: 'contract',
        description: 'Resolve the contract renewal question.',
        keywords: ['contract', 'signature', 'renewal'],
      },
    ],
  },
]

export interface ContextOptions {
  readonly decisionId?: string
  readonly turnId?: string
  readonly lang?: 'en' | 'fr'
  readonly lastUser?: string
  readonly coveredObjectiveIds?: readonly string[]
  readonly personas?: RoutingContext['personas']
  readonly transcript?: RoutingContext['transcript']
}

/** Parse a realistic two/three-persona context for D1 unit and mutation tests. */
export function makeContext(options: ContextOptions = {}): RoutingContext {
  return parseRoutingContext({
    decisionId: options.decisionId ?? 'decision-1',
    turnId: options.turnId ?? 'turn-1',
    lang: options.lang ?? 'en',
    personas: options.personas ?? PERSONAS,
    coveredObjectiveIds: options.coveredObjectiveIds ?? [],
    transcript: options.transcript ?? [
      {
        speaker: { kind: 'persona', personaId: 'manager' },
        text: 'The client needs a date for the contract renewal.',
      },
      {
        speaker: { kind: 'user' },
        text: options.lastUser ?? "Sam, can you confirm the handoff for tomorrow's standup?",
      },
    ],
  })
}

export const fixturePersonas = PERSONAS
