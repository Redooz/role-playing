/**
 * One turn's lifetime: a serialized start, a token that cancels a turn before
 * it generates, and the promise the caller awaits.
 *
 * The start gate releases as soon as the turn exists, not when the reply
 * finishes, so a later input can still barge in. Without the gate, two inputs
 * that arrive together both await the same turn and both open one afterwards.
 */

export interface OpenedTurn<T> {
  readonly turn: Promise<T>
}

export class TurnLifecycle {
  #gate: Promise<void> = Promise.resolve()
  #current: { readonly abort: AbortController; readonly done: Promise<unknown> } | undefined

  /** The current turn's completion, or `undefined` when no turn is open. */
  get done(): Promise<unknown> | undefined {
    return this.#current?.done
  }

  /** Cancel the current turn before it reaches its generation. */
  cancel(): void {
    this.#current?.abort.abort()
  }

  /** Wait for a start that is in flight, so an interrupt cannot miss it. */
  async started(): Promise<void> {
    await this.#gate
  }

  /**
   * Run one start step at a time.
   *
   * The callback returns the turn inside a box. Returning the promise directly
   * would make an async callback adopt it and hold the gate for the reply.
   */
  async open<T>(create: (signal: AbortSignal) => Promise<OpenedTurn<T>>): Promise<OpenedTurn<T>> {
    const gate = this.#gate
    let release: () => void = () => undefined
    const created = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#gate = gate.then(() => created)
    await gate

    try {
      const abort = new AbortController()
      const { turn } = await create(abort.signal)
      const tracked = turn.finally(() => {
        if (this.#current?.abort === abort) this.#current = undefined
      })
      this.#current = { abort, done: tracked }
      return { turn: tracked }
    } finally {
      release()
    }
  }
}
