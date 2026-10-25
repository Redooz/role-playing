import { describe, expect, it } from 'vitest'
import { FakeClock } from './clock.js'

describe('FakeClock', () => {
  it('only moves when advanced', async () => {
    const clock = new FakeClock(1000)
    expect(clock.now()).toBe(1000)
    await clock.advance(250)
    expect(clock.now()).toBe(1250)
  })

  it('resolves a sleeper at its deadline', async () => {
    const clock = new FakeClock()
    const order: string[] = []

    const sleeper = clock.sleep(100).then(() => order.push('slept'))
    order.push('sync')
    await Promise.resolve()
    expect(order).toEqual(['sync'])

    await clock.advance(100)
    await sleeper
    expect(order).toEqual(['sync', 'slept'])
    expect(clock.now()).toBe(100)
  })

  it('resolves due sleepers in deadline order', async () => {
    const clock = new FakeClock()
    const order: string[] = []

    const late = clock.sleep(30).then(() => order.push('late'))
    const early = clock.sleep(10).then(() => order.push('early'))

    await clock.advance(100)
    await Promise.all([late, early])
    expect(order).toEqual(['early', 'late'])
  })

  it('does not fire sleepers scheduled after the advance target', async () => {
    const clock = new FakeClock()
    let fired = false
    void clock.sleep(50).then(() => {
      fired = true
    })

    await clock.advance(49)
    await Promise.resolve()
    expect(fired).toBe(false)
    expect(clock.pendingSleepers()).toBe(1)

    await clock.advance(1)
    await Promise.resolve()
    expect(fired).toBe(true)
    expect(clock.pendingSleepers()).toBe(0)
  })

  it('fires a sleeper registered by a sleeper that already woke', async () => {
    const clock = new FakeClock()
    const order: string[] = []

    void clock.sleep(10).then(async () => {
      order.push('first')
      await clock.sleep(10)
      order.push('second')
    })

    await clock.advance(20)
    await Promise.resolve()
    expect(order).toEqual(['first', 'second'])
  })

  it('rejects negative durations', async () => {
    const clock = new FakeClock()
    expect(() => clock.sleep(-1)).toThrow(RangeError)
    await expect(clock.advance(-1)).rejects.toThrow(RangeError)
  })
})
