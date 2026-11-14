import { describe, expect, it } from 'vitest'
import { TurnLifecycle } from './turn-lifecycle.js'

function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('turn lifecycle', () => {
  it('runs one start at a time and releases the gate before the turn settles', async () => {
    const lifecycle = new TurnLifecycle()
    const order: string[] = []
    const reply = deferred()

    const first = lifecycle.open(async () => {
      order.push('first')
      return { turn: reply.promise }
    })
    const second = lifecycle.open(async () => {
      order.push('second')
      return { turn: Promise.resolve() }
    })

    const openedFirst = await first
    expect(order).toEqual(['first'])

    // The first reply is still streaming, yet the second start already runs.
    const openedSecond = await second
    expect(order).toEqual(['first', 'second'])

    reply.resolve()
    await openedFirst.turn
    await openedSecond.turn
  })

  it('waits for a start that is in flight', async () => {
    const lifecycle = new TurnLifecycle()
    let release: () => void = () => undefined
    const opening = lifecycle.open(async () => {
      await new Promise<void>((settle) => {
        release = settle
      })
      return { turn: Promise.resolve() }
    })

    let started = false
    const waiter = lifecycle.started().then(() => {
      started = true
    })
    await Promise.resolve()
    expect(started).toBe(false)

    release()
    await opening
    await waiter
    expect(started).toBe(true)
  })

  it('aborts the current turn token and gives the next turn a fresh one', async () => {
    const lifecycle = new TurnLifecycle()
    const firstReply = deferred()
    let firstSignal: AbortSignal | undefined
    const first = await lifecycle.open(async (signal) => {
      firstSignal = signal
      return { turn: firstReply.promise }
    })

    lifecycle.cancel()
    expect(firstSignal?.aborted).toBe(true)

    firstReply.resolve()
    await first.turn

    let secondSignal: AbortSignal | undefined
    const second = await lifecycle.open(async (signal) => {
      secondSignal = signal
      return { turn: Promise.resolve() }
    })
    expect(secondSignal?.aborted).toBe(false)
    await second.turn
  })

  it('tracks the latest turn and clears it when that turn settles', async () => {
    const lifecycle = new TurnLifecycle()
    const reply = deferred()
    const opened = await lifecycle.open(async () => ({ turn: reply.promise }))
    expect(lifecycle.done).toBe(opened.turn)

    reply.resolve()
    await opened.turn
    expect(lifecycle.done).toBeUndefined()
  })

  it('releases the gate when a start throws', async () => {
    const lifecycle = new TurnLifecycle()
    await expect(
      lifecycle.open(async () => {
        throw new Error('start failed')
      }),
    ).rejects.toThrow('start failed')

    let ran = false
    const opened = await lifecycle.open(async () => {
      ran = true
      return { turn: Promise.resolve() }
    })
    expect(ran).toBe(true)
    await opened.turn
  })
})
