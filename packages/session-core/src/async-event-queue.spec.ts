import { describe, expect, it } from 'vitest'
import { AsyncEventQueue } from './driver.js'

describe('AsyncEventQueue', () => {
  it('delivers queued items before reporting done', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.push(1)
    queue.push(2)
    queue.close()

    await expect(queue.next()).resolves.toEqual({ value: 1, done: false })
    await expect(queue.next()).resolves.toEqual({ value: 2, done: false })
    await expect(queue.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it('resolves a pending waiter when the queue closes', async () => {
    const queue = new AsyncEventQueue<number>()
    const pending = queue.next()
    queue.close()

    await expect(pending).resolves.toEqual({ value: undefined, done: true })
  })

  it('ignores a push after close', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.close()
    queue.push(1)

    await expect(queue.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it('rejects pending and later reads after a failure', async () => {
    const queue = new AsyncEventQueue<number>()
    const error = new Error('queue failed')
    const pending = queue.next()
    queue.fail(error)

    await expect(pending).rejects.toBe(error)
    await expect(queue.next()).rejects.toBe(error)
  })

  it('fails instead of growing past its limit', async () => {
    const queue = new AsyncEventQueue<number>(2)
    queue.push(1)
    queue.push(2)
    queue.push(3)

    await expect(queue.next()).resolves.toEqual({ value: 1, done: false })
    await expect(queue.next()).resolves.toEqual({ value: 2, done: false })
    await expect(queue.next()).rejects.toThrow(/consumer is not keeping up/)
  })

  it('delivers a pushed item to a pending reader', async () => {
    const queue = new AsyncEventQueue<number>()
    const pending = queue.next()
    queue.push(7)

    await expect(pending).resolves.toEqual({ value: 7, done: false })
  })

  it('accepts a limit of one event', async () => {
    const queue = new AsyncEventQueue<number>(1)
    queue.push(1)

    await expect(queue.next()).resolves.toEqual({ value: 1, done: false })
    queue.close()
    await expect(queue.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it('rejects a non-positive limit', () => {
    expect(() => new AsyncEventQueue<number>(0)).toThrow(/positive integer/)
    expect(() => new AsyncEventQueue<number>(1.5)).toThrow(/positive integer/)
  })

  it('treats return() as a close', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.push(1)

    await expect(queue.return()).resolves.toEqual({ value: undefined, done: true })
    await expect(queue.next()).resolves.toEqual({ value: 1, done: false })
    await expect(queue.next()).resolves.toEqual({ value: undefined, done: true })
  })
})
