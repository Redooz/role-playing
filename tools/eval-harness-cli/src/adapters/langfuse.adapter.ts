import { LangfuseClient } from '@langfuse/client'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { startObservation, type LangfuseGeneration, type LangfuseSpan } from '@langfuse/tracing'
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  context,
  propagation,
  type Context,
} from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import type {
  EvaluationObserver,
  ObservationItem,
  ObservationPlan,
  ObservationReceipt,
  ObserverConfig,
} from '@rp/eval-harness'

/**
 * Langfuse adapter (M0.1 D4).
 *
 * The harness hands over a pure plan; this module is the only place that knows
 * about Langfuse and OpenTelemetry. It is imported dynamically by the CLI, so an
 * offline run never loads these packages.
 *
 * Mapping:
 * - one trace per trial, root span `trial`;
 * - a span per user/persona turn, a generation per provider call;
 * - grant/revocation/cancellation events as event observations;
 * - one score per grade on the root observation.
 */

/** Copies experiment/item baggage onto every span (Langfuse needs it on children). */
class BaggageSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const baggage = propagation.getBaggage(parentContext)
    if (baggage === undefined) return

    for (const [key, entry] of baggage.getAllEntries()) {
      if (key.startsWith('langfuse.')) span.setAttribute(key, entry.value)
    }
  }

  onEnd(): void {
    // nothing to do
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
}

class LangfuseObserver implements EvaluationObserver {
  private readonly config: ObserverConfig
  private readonly sdk: NodeSDK
  private readonly client: LangfuseClient

  constructor(config: ObserverConfig, sdk: NodeSDK, client: LangfuseClient) {
    this.config = config
    this.sdk = sdk
    this.client = client
  }

  async observe(plan: ObservationPlan): Promise<ObservationReceipt> {
    const traceIds: Record<string, string> = {}

    for (const item of plan.items) {
      traceIds[item.itemId] = await this.exportItem(plan, item)
    }

    await this.client.flush()

    return {
      experimentId: plan.experiment.id,
      ...(this.config.projectId === undefined
        ? {}
        : { experimentUrl: experimentUrl(this.config, plan.experiment.id) }),
      traceIds,
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.client.flush()
    } finally {
      await this.sdk.shutdown()
    }
  }

  private async exportItem(plan: ObservationPlan, item: ObservationItem): Promise<string> {
    const experimentBaggage = propagation.createBaggage({
      'langfuse.experiment.id': { value: plan.experiment.id },
      'langfuse.experiment.name': { value: plan.experiment.name },
      'langfuse.experiment.dataset.id': {
        value: `${plan.dataset.name}@${plan.dataset.version}`,
      },
      'langfuse.environment': { value: 'experiment' },
      ...baggageEntries('langfuse.experiment.metadata', plan.experiment.metadata),
    })

    const itemBaggage = experimentBaggage.setEntry('langfuse.experiment.item.id', {
      value: item.itemId,
    })
    const itemContext = propagation.setBaggage(ROOT_CONTEXT, itemBaggage)

    return context.with(itemContext, async () => {
      const maxMs = Math.max(
        0,
        ...item.trace.spans.map((span) => span.endMs),
        ...item.trace.events.map((event) => event.atMs),
      )
      const origin = Date.now() - maxMs
      const at = (offsetMs: number): Date => new Date(origin + offsetMs)

      const root = startObservation(
        item.trace.name,
        {
          input: item.input,
          output: item.output,
          metadata: { ...item.metadata, itemId: item.itemId },
        },
        { asType: 'span', startTime: at(0) },
      )

      root.otelSpan.setAttributes({
        'langfuse.experiment.item.id': item.itemId,
        'langfuse.experiment.item.root_observation_id': root.id,
        ...(plan.experiment.description === undefined
          ? {}
          : { 'langfuse.experiment.description': plan.experiment.description }),
        ...(item.expectedOutput === undefined
          ? {}
          : {
              'langfuse.experiment.item.expected_output': safeJson(item.expectedOutput),
            }),
        ...itemMetadata(item),
      })

      if (item.output.status === 'failed') {
        root.otelSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: item.output.error ?? 'trial failed',
        })
      }

      const spanById = new Map<string, LangfuseSpan | LangfuseGeneration>()

      for (const span of item.trace.spans) {
        const parent = span.parentId === undefined ? root : spanById.get(span.parentId)
        if (parent === undefined) {
          throw new Error(
            `observation plan is inconsistent: span ${span.id} names unknown parent ${span.parentId}`,
          )
        }

        const parentSpanContext = parent.otelSpan.spanContext()
        const observation =
          span.type === 'generation'
            ? startObservation(
                span.name,
                {
                  input: span.input,
                  output: span.output,
                  model: span.model,
                  metadata: span.metadata,
                },
                { asType: 'generation', parentSpanContext, startTime: at(span.startMs) },
              )
            : startObservation(
                span.name,
                {
                  input: span.input,
                  output: span.output,
                  metadata: span.metadata,
                },
                { asType: 'span', parentSpanContext, startTime: at(span.startMs) },
              )

        observation.end(at(span.endMs))
        spanById.set(span.id, observation)

        for (const event of span.events) {
          startObservation(
            event.name,
            { input: event.attributes, metadata: { atMs: event.atMs } },
            { asType: 'event', parentSpanContext, startTime: at(event.atMs) },
          )
        }
      }

      for (const event of item.trace.events) {
        startObservation(
          event.name,
          { input: event.attributes, metadata: { atMs: event.atMs } },
          {
            asType: 'event',
            parentSpanContext: root.otelSpan.spanContext(),
            startTime: at(event.atMs),
          },
        )
      }

      for (const score of item.scores) {
        this.client.score.create({
          name: score.name,
          value: score.value,
          dataType: score.dataType,
          traceId: root.traceId,
          observationId: root.id,
          environment: 'experiment',
          ...(score.comment === undefined ? {} : { comment: score.comment }),
          metadata: score.metadata,
        })
      }

      root.end(at(maxMs))
      return root.traceId
    })
  }
}

/** Build the Langfuse observer and start the OpenTelemetry SDK. */
export async function createLangfuseObserver(config: ObserverConfig): Promise<EvaluationObserver> {
  const sdk = new NodeSDK({
    // A minimal resource keeps host, PID and command line out of the trace
    // metadata; only the service identity is useful for review. Automatic
    // detection must stay off or NodeSDK merges the host/process detectors
    // back into this resource.
    resource: resourceFromAttributes({ 'service.name': 'role-playing-evals' }),
    autoDetectResources: false,
    spanProcessors: [
      new BaggageSpanProcessor(),
      new LangfuseSpanProcessor({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        environment: 'experiment',
        // Batched export; `shutdown()` flushes the queue before the CLI exits.
        exportMode: 'batched',
      }),
    ],
  })
  sdk.start()

  const client = new LangfuseClient({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  })

  return new LangfuseObserver(config, sdk, client)
}

function baggageEntries(
  prefix: string,
  values: Readonly<Record<string, string | number | boolean>>,
): Record<string, { value: string }> {
  const entries: Record<string, { value: string }> = {}
  for (const [key, value] of Object.entries(values)) {
    const safeKey = key.replace(/[^A-Za-z0-9_.-]/g, '_')
    entries[`${prefix}.${safeKey}`] = { value: String(value) }
  }
  return entries
}

function itemMetadata(item: ObservationItem): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(item.metadata)) {
    attributes[`langfuse.experiment.item.metadata.${key}`] = value
  }
  return attributes
}

function experimentUrl(config: ObserverConfig, experimentId: string): string {
  const base = config.baseUrl.replace(/\/+$/, '')
  const projectId = encodeURIComponent(config.projectId ?? '')
  return `${base}/project/${projectId}/experiments/results?baseline=${encodeURIComponent(experimentId)}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return 'null'
  }
}
