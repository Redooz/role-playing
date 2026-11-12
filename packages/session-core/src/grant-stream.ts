import type { Clock } from '@rp/shared'
import type { ConversationMessage, PersonaSession, SessionArbiterInput } from './arbiter-port.js'
import type {
  EventPayloadFor,
  ResponseCancellationReason,
  SessionEventName,
  SessionLanguage,
  TextModelUsage,
} from './events.js'
import type { TextModelChunk } from './model-port.js'
import { MAX_ITERATOR_CLOSE_MS, describeModelError, settleWithin } from './stream-utils.js'

/**
 * One grant's streamed response.
 *
 * The stream emits `persona.response.started` and `persona.response.chunk`, and
 * nothing else: the driver owns the terminal event and the arbiter bookkeeping.
 * Every chunk is published before the arbiter sees the matching partial, so a
 * chunk is never attributed to a grant that was revoked a moment earlier.
 */

export interface GrantStreamRequest {
  readonly grantId: string
  readonly personaId: string
  readonly turnId: string
  readonly expiresAtMs: number
  readonly greeting: boolean
  /** False for the driver-minted greeting, which the arbiter never sees. */
  readonly tracked: boolean
  readonly controller: AbortController
  /** Current cancellation cause, set by a `cancel_generation` effect. */
  readonly cancellationReason: () => ResponseCancellationReason
}

export interface GrantStreamHost<Context> {
  readonly clock: Clock
  readonly lang: SessionLanguage
  readonly locale: string | undefined
  readonly history: readonly ConversationMessage[]
  emit<Name extends SessionEventName>(type: Name, payload: EventPayloadFor<Name>): void
  reduce(input: SessionArbiterInput<Context>): Promise<void>
  /** Ask the other personas whether they want to interject. */
  collectInterjections(): Promise<void>
}

export interface GrantStreamOutcome {
  readonly outcome: 'committed' | 'cancelled' | 'failed'
  readonly text: string
  readonly usage?: TextModelUsage
  readonly detail?: string
  readonly cancellationReason: ResponseCancellationReason
}

export async function streamGrant<Context>(
  request: GrantStreamRequest,
  persona: PersonaSession,
  host: GrantStreamHost<Context>,
): Promise<GrantStreamOutcome> {
  const { controller } = request
  const instructions = request.greeting
    ? (persona.greetingInstructions ?? persona.instructions ?? [])
    : (persona.instructions ?? [])

  let text = ''
  let sequence = 0
  let sawDone = false
  let usage: TextModelUsage | undefined
  let outcome: 'committed' | 'cancelled' | 'failed' = 'committed'
  let failureDetail: string | undefined
  let iterator: AsyncIterator<TextModelChunk> | undefined
  let deadlineTimer: NodeJS.Timeout | undefined

  host.emit('persona.response.started', { grantId: request.grantId })

  const stopForDeadline = async (): Promise<void> => {
    if (request.tracked) {
      await host.reduce({ kind: 'tick', nowMs: request.expiresAtMs })
    }
    controller.abort()
  }

  try {
    iterator = persona.model
      .complete(
        {
          messages: [
            ...instructions,
            ...host.history.map((message) => ({ role: message.role, content: message.content })),
          ],
          metadata: {
            lang: host.lang,
            personaId: request.personaId,
            ...(host.locale === undefined ? {} : { locale: host.locale }),
          },
          requestId: request.turnId,
        },
        { signal: controller.signal },
      )
      [Symbol.asyncIterator]()

    // A grant is a real deadline, not only a boundary check. The timer ends a
    // silent provider; the abort promise ends an in-flight read even when the
    // provider ignores the abort signal.
    const remainingMs = Math.max(0, request.expiresAtMs - host.clock.now())
    const deadline = new Promise<'deadline'>((resolve) => {
      deadlineTimer = setTimeout(() => resolve('deadline'), remainingMs)
    })
    const aborted = new Promise<'aborted'>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })

    while (true) {
      if (controller.signal.aborted) {
        outcome = 'cancelled'
        break
      }
      if (host.clock.now() >= request.expiresAtMs) {
        await stopForDeadline()
        outcome = 'cancelled'
        break
      }

      const next = await Promise.race([
        iterator.next().then((value) => ({ kind: 'next' as const, value })),
        deadline.then(() => ({ kind: 'deadline' as const })),
        aborted.then(() => ({ kind: 'aborted' as const })),
      ])

      if (next.kind === 'deadline') {
        await stopForDeadline()
        outcome = 'cancelled'
        break
      }
      if (next.kind === 'aborted') {
        outcome = 'cancelled'
        break
      }
      if (next.value.done === true) break

      const chunk = next.value.value
      if (controller.signal.aborted) {
        outcome = 'cancelled'
        break
      }
      if (sawDone) {
        outcome = 'failed'
        failureDetail = 'provider yielded a chunk after the final chunk'
        break
      }
      if (typeof chunk.text !== 'string') {
        outcome = 'failed'
        failureDetail = 'provider yielded a non-string chunk'
        break
      }

      if (chunk.text.length > 0) {
        host.emit('persona.response.chunk', {
          grantId: request.grantId,
          text: chunk.text,
          sequence,
        })
        text += chunk.text

        if (request.tracked) {
          // The arbiter owns partial sequencing and the interject opportunity.
          await host.reduce({
            kind: 'partial',
            grantId: request.grantId,
            text: chunk.text,
            sequence,
            nowMs: host.clock.now(),
          })
          await host.collectInterjections()
          await host.reduce({ kind: 'tick', nowMs: host.clock.now() })
        }
        sequence += 1
      }
      if (chunk.usage !== undefined) usage = chunk.usage
      if (chunk.done) sawDone = true
    }

    if (outcome === 'committed' && !sawDone) {
      outcome = 'failed'
      failureDetail = 'stream ended without a final chunk'
    }
  } catch (error) {
    if (controller.signal.aborted) {
      outcome = 'cancelled'
    } else {
      outcome = 'failed'
      failureDetail = describeModelError(error)
    }
  } finally {
    clearTimeout(deadlineTimer)
    const closeIterator = iterator
    const close = (async () => {
      try {
        await closeIterator?.return?.()
      } catch {
        // A failing close after a failed stream must not mask the outcome.
      }
    })()
    await settleWithin(close, MAX_ITERATOR_CLOSE_MS)
  }

  return {
    outcome,
    text,
    ...(usage === undefined ? {} : { usage }),
    ...(failureDetail === undefined ? {} : { detail: failureDetail }),
    cancellationReason: outcome === 'failed' ? 'provider_failure' : request.cancellationReason(),
  }
}
