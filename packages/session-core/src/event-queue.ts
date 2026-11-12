/**
 * Bounded async event queue shared by both session drivers.
 *
 * `emit` never blocks, and a consumer sees each event as soon as it is
 * appended. Closing ends the iterator; a stored error rejects it.
 *
 * The queue is bounded so a consumer that stops draining (a slow log write) can
 * fail the session instead of growing memory for its whole length. The limit is
 * deliberately high: a normal session never reaches it.
 */

import { SessionDriverError } from './errors.js'

export const DEFAULT_MAX_QUEUED_EVENTS = 100_000

export class AsyncEventQueue<T> implements AsyncIterableIterator<T> {
  readonly #items: T[] = []
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  readonly #maxItems: number | undefined
  #closed = false
  #failure: unknown

  constructor(maxItems?: number) {
    if (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems < 1)) {
      throw new SessionDriverError('maxQueuedEvents must be a positive integer')
    }
    this.#maxItems = maxItems
  }

  push(item: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ value: item, done: false })
      return
    }
    if (this.#maxItems !== undefined && this.#items.length >= this.#maxItems) {
      this.fail(
        new SessionDriverError(
          `event queue exceeded ${this.#maxItems} undelivered events; the consumer is not keeping up`,
        ),
      )
      return
    }
    this.#items.push(item)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: unknown): void {
    if (this.#closed) return
    this.#failure = error
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error)
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift()
    if (item !== undefined) return Promise.resolve({ value: item, done: false })
    if (this.#closed) {
      if (this.#failure !== undefined) return Promise.reject(this.#failure)
      return Promise.resolve({ value: undefined, done: true })
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
    })
  }

  return(): Promise<IteratorResult<T>> {
    this.close()
    return Promise.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }
}
