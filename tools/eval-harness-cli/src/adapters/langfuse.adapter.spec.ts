import { ROOT_CONTEXT, SpanStatusCode, propagation, type Context } from '@opentelemetry/api'
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EvaluationObserver,
  ObservationItem,
  ObservationPlan,
  ObserverConfig,
} from '@rp/eval-harness'
import { createLangfuseObserver } from './langfuse.adapter.js'

/**
 * The Langfuse adapter maps a pure observation plan onto Langfuse/OpenTelemetry
 * spans. These tests replace the transport packages with fakes — no socket is
 * opened — and assert the exact mapping: which span is a generation, where each
 * event hangs, which attributes carry the experiment, and the score payloads.
 */

interface FakeStatus {
  code?: number
  message?: string
}

interface FakeObservation {
  readonly id: string
  readonly traceId: string
  readonly attributes: Record<string, unknown>
  status: FakeStatus | undefined
  endedAt: Date | undefined
  readonly otelSpan: {
    setAttributes(attributes: Record<string, unknown>): void
    setStatus(status: FakeStatus): void
    spanContext(): { traceId: string; spanId: string }
  }
  end(at?: Date): void
}

interface ObservationRecord {
  readonly name: string
  readonly attributes: Record<string, unknown> | undefined
  readonly options: Record<string, unknown> | undefined
  readonly observation: FakeObservation
}

const state = vi.hoisted(() => {
  const s = {
    counter: 0,
    sequence: [] as string[],
    observations: [] as ObservationRecord[],
    sdkOptions: [] as Record<string, unknown>[],
    spanProcessorOptions: [] as Record<string, unknown>[],
    spanProcessors: [] as unknown[],
    clientOptions: [] as Record<string, unknown>[],
    scores: [] as Record<string, unknown>[],
    resourceAttributes: undefined as Record<string, unknown> | undefined,
    lastContext: undefined as unknown,
    flushCount: 0,
    flushFailure: undefined as Error | undefined,
    sdkStarts: 0,
    sdkShutdowns: 0,
    reset(): void {
      s.counter = 0
      s.sequence.length = 0
      s.observations.length = 0
      s.sdkOptions.length = 0
      s.spanProcessorOptions.length = 0
      s.spanProcessors.length = 0
      s.clientOptions.length = 0
      s.scores.length = 0
      s.resourceAttributes = undefined
      s.lastContext = undefined
      s.flushCount = 0
      s.flushFailure = undefined
      s.sdkStarts = 0
      s.sdkShutdowns = 0
    },
    makeObservation(name: string): FakeObservation {
      s.counter += 1
      const id = `obs-${s.counter}`
      const traceId = `trace-${s.counter}`
      const observation: FakeObservation = {
        id,
        traceId,
        attributes: {},
        status: undefined,
        endedAt: undefined,
        otelSpan: {
          setAttributes(attributes) {
            Object.assign(observation.attributes, attributes)
          },
          setStatus(status) {
            observation.status = status
          },
          spanContext() {
            return { traceId, spanId: id }
          },
        },
        end(at) {
          observation.endedAt = at
          s.sequence.push(`end:${name}`)
        },
      }
      return observation
    },
  }
  return s
})

vi.mock('@langfuse/client', () => ({
  LangfuseClient: class FakeLangfuseClient {
    readonly score = {
      create: (score: Record<string, unknown>) => {
        state.scores.push(score)
        state.sequence.push(`score:${String(score['name'])}`)
      },
    }

    constructor(options: Record<string, unknown>) {
      state.clientOptions.push(options)
    }

    async flush(): Promise<void> {
      state.flushCount += 1
      state.sequence.push('flush')
      if (state.flushFailure !== undefined) throw state.flushFailure
    }
  },
}))

vi.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: class FakeLangfuseSpanProcessor {
    constructor(options: Record<string, unknown>) {
      state.spanProcessorOptions.push(options)
      state.spanProcessors.push(this)
    }
  },
}))

vi.mock('@langfuse/tracing', () => ({
  startObservation: (
    name: string,
    attributes?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    const observation = state.makeObservation(name)
    state.observations.push({ name, attributes, options, observation })
    state.sequence.push(`obs:${name}`)
    return observation
  },
}))

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class FakeNodeSdk {
    constructor(options: Record<string, unknown>) {
      state.sdkOptions.push(options)
    }

    start(): void {
      state.sdkStarts += 1
      state.sequence.push('sdk.start')
    }

    async shutdown(): Promise<void> {
      state.sdkShutdowns += 1
      state.sequence.push('sdk.shutdown')
    }
  },
}))

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: (attributes: Record<string, unknown>) => {
    state.resourceAttributes = attributes
    return { attributes }
  },
}))

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    context: {
      with<T>(ctx: Context, fn: () => T): T {
        state.lastContext = ctx
        return fn()
      },
    },
  }
})

const CONFIG: ObserverConfig = {
  baseUrl: 'http://langfuse.test:3000',
  publicKey: 'pk-lf-test',
  secretKey: 'sk-lf-test',
  projectId: 'project-1',
}

const RICH_ITEM: ObservationItem = {
  itemId: '1:en:greeting',
  trialId: '1:en:greeting',
  round: 1,
  lang: 'en',
  taskId: 'greeting',
  input: { scenarioBrief: 'standup', turns: [{ index: 0, role: 'user', text: 'hi' }] },
  expectedOutput: { greeting: 'hello' },
  output: { status: 'completed', finalText: 'hello', transcript: 'Persona: hello' },
  metadata: { cefrBand: 'B1', score: 2 },
  trace: {
    name: '1:en:greeting',
    events: [{ name: 'session.completed', atMs: 90, attributes: { ok: true } }],
    spans: [
      {
        id: 'turn-0-user',
        name: 'turn 0 user',
        type: 'span',
        startMs: 10,
        endMs: 10,
        input: 'hi',
        output: 'hi',
        events: [],
      },
      {
        id: 'turn-1-persona',
        name: 'turn 1 persona',
        type: 'span',
        startMs: 20,
        endMs: 40,
        metadata: { personaId: 'manager' },
        events: [{ name: 'turn.granted', atMs: 20, attributes: { grantId: 'g1' } }],
      },
      {
        id: 'generation-1',
        parentId: 'turn-1-persona',
        name: 'persona response 1',
        type: 'generation',
        startMs: 25,
        endMs: 40,
        input: [{ role: 'user', content: 'hi' }],
        output: 'hello',
        model: 'google/gemma-4-31b-it',
        metadata: { cancelled: false },
        events: [],
      },
    ],
  },
  scores: [
    {
      name: 'persona.semantic_match',
      value: 0.9,
      dataType: 'NUMERIC',
      comment: 'matches the reference reply',
      metadata: { status: 'graded' },
    },
  ],
}

const FAILED_ITEM: ObservationItem = {
  itemId: '1:fr:deadline',
  trialId: '1:fr:deadline',
  round: 1,
  lang: 'fr',
  taskId: 'deadline',
  input: { turns: [] },
  output: { status: 'failed' },
  metadata: {},
  trace: { name: '1:fr:deadline', events: [], spans: [] },
  scores: [
    {
      name: 'transcript.guard_clean',
      value: 1,
      dataType: 'BOOLEAN',
      metadata: {},
    },
  ],
}

function plan(
  items: readonly ObservationItem[],
  experiment: Partial<ObservationPlan['experiment']> = {},
): ObservationPlan {
  return {
    schemaVersion: '1.0.0',
    executionId: 'exec-1',
    runId: 'run-1',
    suite: 'suite',
    environment: 'experiment',
    dataset: { name: 'tasks', version: 'v1' },
    experiment: {
      id: 'exec-1',
      name: 'suite 2026-11-14',
      description: 'nightly run',
      metadata: { 'dataset/version': 'v1', rounds: 2, probe: true },
      ...experiment,
    },
    items,
  }
}

function recorded(name: string): ObservationRecord {
  const record = state.observations.find((entry) => entry.name === name)
  if (record === undefined) throw new Error(`no observation named "${name}"`)
  return record
}

function startTimeOf(record: ObservationRecord): Date {
  return record.options?.['startTime'] as Date
}

function offsetMs(from: Date, to: Date | undefined): number {
  return (to?.getTime() ?? Number.NaN) - from.getTime()
}

function sdkSpanProcessors(): SpanProcessor[] {
  const options = state.sdkOptions[0]
  return (options?.['spanProcessors'] ?? []) as SpanProcessor[]
}

beforeEach(() => {
  state.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createLangfuseObserver', () => {
  it('starts one SDK with the minimal resource and both span processors', async () => {
    const observer = await createLangfuseObserver(CONFIG)

    expect(typeof observer.observe).toBe('function')
    expect(typeof observer.shutdown).toBe('function')
    expect(state.sdkStarts).toBe(1)
    expect(state.sequence).toStrictEqual(['sdk.start'])
    expect(state.resourceAttributes).toStrictEqual({ 'service.name': 'role-playing-evals' })
    expect(state.sdkOptions).toHaveLength(1)
    const options = state.sdkOptions[0]
    expect(options?.['autoDetectResources']).toBe(false)
    expect(options?.['resource']).toStrictEqual({
      attributes: { 'service.name': 'role-playing-evals' },
    })

    const processors = sdkSpanProcessors()
    expect(processors).toHaveLength(2)
    expect(processors[1]).toBe(state.spanProcessors[0])
    const baggageProcessor = processors[0]
    expect(typeof baggageProcessor?.onStart).toBe('function')
    expect(typeof baggageProcessor?.onEnd).toBe('function')
    expect(typeof baggageProcessor?.shutdown).toBe('function')
    expect(typeof baggageProcessor?.forceFlush).toBe('function')
  })

  it('configures the Langfuse span processor and client from the observer config', async () => {
    await createLangfuseObserver(CONFIG)

    expect(state.spanProcessorOptions).toStrictEqual([
      {
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'http://langfuse.test:3000',
        environment: 'experiment',
        exportMode: 'batched',
      },
    ])
    expect(state.clientOptions).toStrictEqual([
      {
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'http://langfuse.test:3000',
      },
    ])
  })
})

describe('observe', () => {
  it('maps one item to a root span, turn spans, a generation, events and a score', async () => {
    const observer = await createLangfuseObserver(CONFIG)

    const receipt = await observer.observe(plan([RICH_ITEM]))

    expect(receipt).toStrictEqual({
      experimentId: 'exec-1',
      experimentUrl:
        'http://langfuse.test:3000/project/project-1/experiments/results?baseline=exec-1',
      traceIds: { '1:en:greeting': 'trace-1' },
    })

    const root = recorded('1:en:greeting')
    const rootStart = startTimeOf(root)
    expect(root.attributes).toStrictEqual({
      input: RICH_ITEM.input,
      output: RICH_ITEM.output,
      metadata: { cefrBand: 'B1', score: 2, itemId: '1:en:greeting' },
    })
    expect(root.options?.['asType']).toBe('span')
    expect(root.observation.attributes).toStrictEqual({
      'langfuse.experiment.item.id': '1:en:greeting',
      'langfuse.experiment.item.root_observation_id': 'obs-1',
      'langfuse.experiment.description': 'nightly run',
      'langfuse.experiment.item.expected_output': '{"greeting":"hello"}',
      'langfuse.experiment.item.metadata.cefrBand': 'B1',
      'langfuse.experiment.item.metadata.score': 2,
    })
    expect(root.observation.status).toBeUndefined()
    expect(offsetMs(rootStart, root.observation.endedAt)).toBe(90)

    const userTurn = recorded('turn 0 user')
    expect(userTurn.attributes).toStrictEqual({ input: 'hi', output: 'hi', metadata: undefined })
    expect(userTurn.options?.['asType']).toBe('span')
    expect(offsetMs(rootStart, startTimeOf(userTurn))).toBe(10)
    expect(offsetMs(rootStart, userTurn.observation.endedAt)).toBe(10)

    const personaTurn = recorded('turn 1 persona')
    expect(personaTurn.attributes).toStrictEqual({
      input: undefined,
      output: undefined,
      metadata: { personaId: 'manager' },
    })
    expect(offsetMs(rootStart, startTimeOf(personaTurn))).toBe(20)
    expect(offsetMs(rootStart, personaTurn.observation.endedAt)).toBe(40)

    const generation = recorded('persona response 1')
    expect(generation.attributes).toStrictEqual({
      input: [{ role: 'user', content: 'hi' }],
      output: 'hello',
      model: 'google/gemma-4-31b-it',
      metadata: { cancelled: false },
    })
    expect(generation.options?.['asType']).toBe('generation')
    expect(generation.options?.['parentSpanContext']).toStrictEqual(
      personaTurn.observation.otelSpan.spanContext(),
    )
    expect(offsetMs(rootStart, startTimeOf(generation))).toBe(25)
    expect(offsetMs(rootStart, generation.observation.endedAt)).toBe(40)

    const spanEvent = recorded('turn.granted')
    expect(spanEvent.attributes).toStrictEqual({
      input: { grantId: 'g1' },
      metadata: { atMs: 20 },
    })
    expect(spanEvent.options?.['asType']).toBe('event')
    // The plan nests an event inside its span, so the event's parent is the
    // span itself rather than the root.
    expect(spanEvent.options?.['parentSpanContext']).toStrictEqual(
      personaTurn.observation.otelSpan.spanContext(),
    )
    expect(offsetMs(rootStart, startTimeOf(spanEvent))).toBe(20)

    const trialEvent = recorded('session.completed')
    expect(trialEvent.attributes).toStrictEqual({
      input: { ok: true },
      metadata: { atMs: 90 },
    })
    expect(trialEvent.options?.['asType']).toBe('event')
    expect(trialEvent.options?.['parentSpanContext']).toStrictEqual(
      root.observation.otelSpan.spanContext(),
    )
    expect(offsetMs(rootStart, startTimeOf(trialEvent))).toBe(90)

    expect(state.scores).toStrictEqual([
      {
        name: 'persona.semantic_match',
        value: 0.9,
        dataType: 'NUMERIC',
        traceId: 'trace-1',
        observationId: 'obs-1',
        environment: 'experiment',
        comment: 'matches the reference reply',
        metadata: { status: 'graded' },
      },
    ])
    expect(state.sequence).toStrictEqual([
      'sdk.start',
      'obs:1:en:greeting',
      'obs:turn 0 user',
      'end:turn 0 user',
      'obs:turn 1 persona',
      'end:turn 1 persona',
      'obs:turn.granted',
      'obs:persona response 1',
      'end:persona response 1',
      'obs:session.completed',
      'score:persona.semantic_match',
      'end:1:en:greeting',
      'flush',
    ])
    expect(state.flushCount).toBe(1)
  })

  it('marks a failed trial with an error status and no optional attributes', async () => {
    const observer = await createLangfuseObserver(CONFIG)

    await observer.observe(plan([FAILED_ITEM], { description: undefined }))

    const root = recorded('1:fr:deadline')
    expect(root.observation.attributes).toStrictEqual({
      'langfuse.experiment.item.id': '1:fr:deadline',
      'langfuse.experiment.item.root_observation_id': 'obs-1',
    })
    expect(root.observation.status).toStrictEqual({
      code: SpanStatusCode.ERROR,
      message: 'trial failed',
    })
    expect(root.observation.endedAt?.getTime()).toBe(startTimeOf(root).getTime())
    expect(state.scores).toStrictEqual([
      {
        name: 'transcript.guard_clean',
        value: 1,
        dataType: 'BOOLEAN',
        traceId: 'trace-1',
        observationId: 'obs-1',
        environment: 'experiment',
        metadata: {},
      },
    ])
  })

  it('reports the trial error as the root status message', async () => {
    const observer = await createLangfuseObserver(CONFIG)

    await observer.observe(
      plan([
        {
          ...FAILED_ITEM,
          output: { status: 'failed', error: 'provider timeout' },
        },
      ]),
    )

    expect(recorded('1:fr:deadline').observation.status).toStrictEqual({
      code: SpanStatusCode.ERROR,
      message: 'provider timeout',
    })
  })

  it('anchors the simulated timeline to the current wall clock', async () => {
    const now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const observer = await createLangfuseObserver(CONFIG)

    await observer.observe(plan([RICH_ITEM]))

    const rootStart = startTimeOf(recorded('1:en:greeting'))
    expect(rootStart.getTime()).toBe(now - 90)
    expect(startTimeOf(recorded('turn 0 user')).getTime()).toBe(now - 80)
    expect(startTimeOf(recorded('session.completed')).getTime()).toBe(now)
  })

  it('encodes an expected output that cannot be serialised as null', async () => {
    const observer = await createLangfuseObserver(CONFIG)
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    await observer.observe(plan([{ ...FAILED_ITEM, expectedOutput: circular }]))

    expect(
      recorded('1:fr:deadline').observation.attributes['langfuse.experiment.item.expected_output'],
    ).toBe('null')
  })

  it('maps every item and returns one trace id per item', async () => {
    const observer = await createLangfuseObserver(CONFIG)

    const receipt = await observer.observe(plan([RICH_ITEM, FAILED_ITEM]))

    expect(receipt.traceIds).toStrictEqual({
      '1:en:greeting': 'trace-1',
      '1:fr:deadline': 'trace-7',
    })
    expect(state.flushCount).toBe(1)
    expect(state.sequence.at(-1)).toBe('flush')
  })

  it('omits the experiment URL when no project id is configured', async () => {
    const observer = await createLangfuseObserver({ ...CONFIG, projectId: undefined })

    const receipt = await observer.observe(plan([FAILED_ITEM]))

    expect(receipt).toStrictEqual({
      experimentId: 'exec-1',
      traceIds: { '1:fr:deadline': 'trace-1' },
    })
    expect(Object.hasOwn(receipt, 'experimentUrl')).toBe(false)
  })

  it('builds an encoded experiment URL from a base URL without trailing slashes', async () => {
    const observer = await createLangfuseObserver({
      ...CONFIG,
      baseUrl: 'https://langfuse.test:3000///',
      projectId: 'pro ject',
    })

    const receipt = await observer.observe(plan([FAILED_ITEM], { id: 'exec/1' }))

    expect(receipt.experimentUrl).toBe(
      'https://langfuse.test:3000/project/pro%20ject/experiments/results?baseline=exec%2F1',
    )
  })

  it('puts the experiment and item identity on the observation baggage', async () => {
    const observer = await createLangfuseObserver(CONFIG)

    await observer.observe(plan([RICH_ITEM]))

    const baggage = propagation.getBaggage(state.lastContext as Context)
    const entries = Object.fromEntries(
      (baggage?.getAllEntries() ?? []).map(([key, entry]) => [key, entry.value]),
    )
    expect(entries).toStrictEqual({
      'langfuse.experiment.id': 'exec-1',
      'langfuse.experiment.name': 'suite 2026-11-14',
      'langfuse.experiment.dataset.id': 'tasks@v1',
      'langfuse.experiment.metadata.dataset_version': 'v1',
      'langfuse.experiment.metadata.rounds': '2',
      'langfuse.experiment.metadata.probe': 'true',
      'langfuse.experiment.item.id': '1:en:greeting',
      'langfuse.environment': 'experiment',
    })
  })

  it('rejects a span that names an unknown parent before flushing', async () => {
    const observer = await createLangfuseObserver(CONFIG)
    const broken: ObservationItem = {
      ...FAILED_ITEM,
      trace: {
        name: '1:fr:deadline',
        events: [],
        spans: [
          {
            id: 'generation-1',
            parentId: 'missing-parent',
            name: 'persona response 1',
            type: 'generation',
            startMs: 0,
            endMs: 10,
            events: [],
          },
        ],
      },
    }

    await expect(observer.observe(plan([broken]))).rejects.toThrow(
      'observation plan is inconsistent: span generation-1 names unknown parent missing-parent',
    )
    expect(state.flushCount).toBe(0)
    expect(state.scores).toStrictEqual([])
  })
})

describe('shutdown', () => {
  it('flushes the client before shutting the SDK down', async () => {
    const observer = await createLangfuseObserver(CONFIG)

    await observer.shutdown()

    expect(state.sequence).toStrictEqual(['sdk.start', 'flush', 'sdk.shutdown'])
    expect(state.sdkShutdowns).toBe(1)
  })

  it('shuts the SDK down even when the flush fails', async () => {
    const observer: EvaluationObserver = await createLangfuseObserver(CONFIG)
    state.flushFailure = new Error('flush failed')

    await expect(observer.shutdown()).rejects.toThrow('flush failed')
    expect(state.sdkShutdowns).toBe(1)
  })
})

describe('BaggageSpanProcessor', () => {
  async function baggageProcessor(): Promise<SpanProcessor> {
    await createLangfuseObserver(CONFIG)
    const processor = sdkSpanProcessors()[0]
    if (processor === undefined) throw new Error('the SDK was created without a span processor')
    return processor
  }

  function fakeSpan(): Span & { readonly setAttribute: ReturnType<typeof vi.fn> } {
    return { setAttribute: vi.fn() } as unknown as Span & {
      readonly setAttribute: ReturnType<typeof vi.fn>
    }
  }

  it('copies only langfuse baggage entries onto a new span', async () => {
    const processor = await baggageProcessor()
    const span = fakeSpan()
    const parentContext = propagation.setBaggage(
      ROOT_CONTEXT,
      propagation.createBaggage({
        'langfuse.experiment.id': { value: 'exec-1' },
        'langfuse.experiment.item.id': { value: '1:en:greeting' },
        'session.id': { value: 'session-1' },
      }),
    )

    processor.onStart(span, parentContext)

    expect(span.setAttribute.mock.calls).toStrictEqual([
      ['langfuse.experiment.id', 'exec-1'],
      ['langfuse.experiment.item.id', '1:en:greeting'],
    ])
  })

  it('leaves a span untouched when the context carries no baggage', async () => {
    const processor = await baggageProcessor()
    const span = fakeSpan()

    processor.onStart(span, ROOT_CONTEXT)

    expect(span.setAttribute).not.toHaveBeenCalled()
  })

  it('does nothing on end and resolves shutdown and flush', async () => {
    const processor = await baggageProcessor()

    expect(processor.onEnd(fakeSpan())).toBeUndefined()
    await expect(processor.shutdown()).resolves.toBeUndefined()
    await expect(processor.forceFlush()).resolves.toBeUndefined()
  })
})
