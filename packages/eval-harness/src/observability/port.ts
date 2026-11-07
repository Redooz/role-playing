import type { ObservationPlan } from './plan.js'

/**
 * Observation port (M0.1 D2).
 *
 * The evaluation harness produces a pure {@link ObservationPlan}; an adapter
 * (currently Langfuse) ships it to a review platform. The harness never imports
 * the adapter, and export failures never change a verdict.
 */

export interface ObservationReceipt {
  /** Platform experiment identity; equals the plan's execution id for Langfuse. */
  readonly experimentId: string
  readonly experimentUrl?: string
  /** Item id (`round:lang:taskId`) → platform trace id. */
  readonly traceIds: Readonly<Record<string, string>>
}

export interface EvaluationObserver {
  observe(plan: ObservationPlan): Promise<ObservationReceipt>
  /** Flush pending events and release the transport. Always called in `finally`. */
  shutdown(): Promise<void>
}

export interface ObserverConfig {
  readonly baseUrl: string
  readonly publicKey: string
  readonly secretKey: string
  /** Project id, used only to build a clickable experiment URL. */
  readonly projectId?: string
}

/** Factory injected by the CLI and replaced by a fake in tests. */
export type ObserverFactory = (config: ObserverConfig) => Promise<EvaluationObserver>
