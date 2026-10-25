/**
 * The only time source the engine is allowed to read.
 *
 * `session-core` and `eval-engine` must never call `Date.now()` directly: the
 * eval runner injects a `FakeClock` so that runs are reproducible. `advance`
 * is meaningful for simulated clocks and is a plain sleep for the real one.
 */
export interface Clock {
  /** Current time in milliseconds since the Unix epoch. */
  now(): number
  /** Resolves once `ms` of clock time have passed. */
  sleep(ms: number): Promise<void>
  /** Moves the clock forward by `ms`, resolving due sleepers in order. */
  advance(ms: number): Promise<void>
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
  }

  advance(ms: number): Promise<void> {
    return this.sleep(ms)
  }
}

interface Sleeper {
  readonly at: number
  readonly seq: number
  readonly resolve: () => void
}

/**
 * Deterministic clock for tests and the eval runner.
 *
 * Time only moves when `advance` is called. Sleepers resolve at their exact
 * deadline, in registration order on ties, which keeps replay byte-identical.
 */
export class FakeClock implements Clock {
  #current: number
  #seq = 0
  #sleepers: Sleeper[] = []

  constructor(start = 0) {
    this.#current = start
  }

  now(): number {
    return this.#current
  }

  sleep(ms: number): Promise<void> {
    if (ms < 0) throw new RangeError(`Cannot sleep for a negative duration: ${ms}`)
    if (ms === 0) return Promise.resolve()

    return new Promise<void>((resolve) => {
      this.#sleepers.push({ at: this.#current + ms, seq: this.#seq++, resolve })
    })
  }

  async advance(ms: number): Promise<void> {
    if (ms < 0) throw new RangeError(`Cannot advance by a negative duration: ${ms}`)
    const target = this.#current + ms

    for (;;) {
      const next = this.#nextDue(target)
      if (next === undefined) break

      this.#sleepers = this.#sleepers.filter((sleeper) => sleeper !== next)
      this.#current = Math.max(this.#current, next.at)
      next.resolve()
      // Let the woken continuation run before the clock moves again.
      await Promise.resolve()
    }

    this.#current = target
  }

  /** Number of sleepers that have not fired yet. */
  pendingSleepers(): number {
    return this.#sleepers.length
  }

  #nextDue(target: number): Sleeper | undefined {
    let due: Sleeper | undefined
    for (const sleeper of this.#sleepers) {
      if (sleeper.at > target) continue
      if (
        due === undefined ||
        sleeper.at < due.at ||
        (sleeper.at === due.at && sleeper.seq < due.seq)
      ) {
        due = sleeper
      }
    }
    return due
  }
}
