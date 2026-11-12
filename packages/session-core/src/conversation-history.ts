import type { ConversationMessage } from './arbiter-port.js'
import { SessionDriverError } from './errors.js'

/**
 * Bounded rolling conversation history for one session.
 *
 * All personas hear the same conversation, and assistant messages keep their
 * speaker so a routing context can be rebuilt without adding a transcript
 * field. The opening greeting is part of the session's identity and is never
 * trimmed; trimming starts after it.
 */
export class ConversationHistory {
  readonly #messages: ConversationMessage[] = []
  readonly #maxMessages: number
  #greetingCommitted = false

  constructor(maxMessages: number) {
    if (!Number.isInteger(maxMessages) || maxMessages < 1) {
      throw new SessionDriverError('maxHistoryMessages must be a positive integer')
    }
    this.#maxMessages = maxMessages
  }

  get messages(): readonly ConversationMessage[] {
    return this.#messages
  }

  get length(): number {
    return this.#messages.length
  }

  append(message: ConversationMessage): void {
    this.#messages.push(message)
    const overflow = this.#messages.length - this.#maxMessages
    if (overflow <= 0) return

    const protectedCount = this.#greetingCommitted ? 1 : 0
    this.#messages.splice(protectedCount, overflow)

    // Keep the retained context starting with a user turn after the greeting.
    while (this.#messages[protectedCount]?.role === 'assistant') {
      this.#messages.splice(protectedCount, 1)
    }
  }

  markGreetingCommitted(): void {
    this.#greetingCommitted = true
  }
}
