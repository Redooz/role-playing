import { TRANSCRIPT_SCHEMA_VERSION } from '@rp/session-core'
import { FakeClock, MemoryTranscriptSink } from '@rp/shared'
import type * as SharedModule from '@rp/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_FAKE_CLOCK_SLEEPERS,
  createEventSerializationWorkload,
  createFakeClockDispatchWorkload,
  createTranscriptAppendWorkload,
  createTranscriptRecord,
} from './workloads.js'

const sharedState = vi.hoisted(() => ({
  canonicalJson: undefined as undefined | ((value: unknown) => string),
}))

vi.mock('@rp/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedModule>()
  return {
    ...actual,
    canonicalJson: (value: unknown): string => sharedState.canonicalJson?.(value) ?? '',
  }
})

afterEach(() => {
  sharedState.canonicalJson = undefined
  vi.restoreAllMocks()
})

describe('createFakeClockDispatchWorkload', () => {
  it('registers the default sleeper count on a fresh clock in preparation', async () => {
    const sleep = vi.spyOn(FakeClock.prototype, 'sleep')
    const workload = createFakeClockDispatchWorkload()

    workload.beforeEach?.()

    expect(workload.name).toBe('fake-clock dispatch')
    expect(sleep).toHaveBeenCalledTimes(DEFAULT_FAKE_CLOCK_SLEEPERS)
    expect(DEFAULT_FAKE_CLOCK_SLEEPERS).toBe(100)
    await workload.run()
  })

  it('advances the clock exactly once by one second and wakes every sleeper', async () => {
    const sleep = vi.spyOn(FakeClock.prototype, 'sleep')
    const advance = vi.spyOn(FakeClock.prototype, 'advance')
    const workload = createFakeClockDispatchWorkload(3)

    workload.beforeEach?.()
    await workload.run()

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1, 2, 3])
    expect(advance).toHaveBeenCalledTimes(1)
    expect(advance).toHaveBeenCalledWith(1_000)
    const clock = advance.mock.instances[0] as FakeClock
    expect(clock.now()).toBe(1_000)
    expect(clock.pendingSleepers()).toBe(0)
  })

  it('cycles the sleeper deadlines through fifty values', async () => {
    const sleep = vi.spyOn(FakeClock.prototype, 'sleep')
    const workload = createFakeClockDispatchWorkload(51)

    workload.beforeEach?.()

    const delays = sleep.mock.calls.map((call) => call[0])
    expect(delays.slice(0, 50)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
    expect(delays[50]).toBe(1)
  })

  it('creates a fresh clock for every iteration', async () => {
    const sleep = vi.spyOn(FakeClock.prototype, 'sleep')
    const advance = vi.spyOn(FakeClock.prototype, 'advance')
    const workload = createFakeClockDispatchWorkload(2)

    workload.beforeEach?.()
    await workload.run()
    workload.beforeEach?.()
    await workload.run()

    expect(advance.mock.instances).toHaveLength(2)
    expect(advance.mock.instances[0]).not.toBe(advance.mock.instances[1])
    const second = advance.mock.instances[1] as FakeClock
    expect(second.now()).toBe(1_000)
    expect(second.pendingSleepers()).toBe(0)
    expect(sleep).toHaveBeenCalledTimes(4)
  })

  it.each([
    [0, 'Sleeper count must be a positive integer: 0'],
    [-2, 'Sleeper count must be a positive integer: -2'],
    [1.5, 'Sleeper count must be a positive integer: 1.5'],
    [Number.NaN, 'Sleeper count must be a positive integer: NaN'],
    [Number.POSITIVE_INFINITY, 'Sleeper count must be a positive integer: Infinity'],
  ])('rejects sleeperCount=%s with the exact message', (sleeperCount, message) => {
    expect(() => createFakeClockDispatchWorkload(sleeperCount)).toThrow(new RangeError(message))
  })

  it('accepts a single sleeper', async () => {
    const workload = createFakeClockDispatchWorkload(1)

    workload.beforeEach?.()

    await expect(workload.run()).resolves.toBeUndefined()
  })
})

describe('createTranscriptRecord', () => {
  it('builds the exact representative record with sequence one by default', () => {
    expect(createTranscriptRecord()).toStrictEqual({
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      runId: 'm0-harness-overhead',
      executionId: 'm0-harness-overhead-bench',
      seq: 1,
      tSim: 1_234.5,
      tWall: 1_700_000_000_000,
      kind: 'persona.response.chunk',
      payload: {
        grantId: 'grant-0001',
        text: 'I appreciate you raising that — let us compare the timeline and the budget before we commit.',
        sequence: 1,
      },
      contentClass: 'restricted',
    })
  })

  it('stamps a custom sequence into both places and returns a fresh object', () => {
    const record = createTranscriptRecord(7)

    expect(record.seq).toBe(7)
    expect(record.payload).toStrictEqual({
      grantId: 'grant-0001',
      text: 'I appreciate you raising that — let us compare the timeline and the budget before we commit.',
      sequence: 7,
    })
    expect(createTranscriptRecord(7)).not.toBe(record)
  })
})

describe('createEventSerializationWorkload', () => {
  it('serializes the representative record on every run', () => {
    const canonicalJson = vi.fn(() => '{"serialized":true}')
    sharedState.canonicalJson = canonicalJson
    const workload = createEventSerializationWorkload()

    expect(workload.name).toBe('event serialization')
    expect(workload.beforeEach).toBeUndefined()
    expect(workload.run()).toBeUndefined()
    expect(workload.run()).toBeUndefined()

    expect(canonicalJson).toHaveBeenCalledTimes(2)
    expect(canonicalJson).toHaveBeenNthCalledWith(1, createTranscriptRecord())
    expect(canonicalJson).toHaveBeenNthCalledWith(2, createTranscriptRecord())
  })
})

describe('createTranscriptAppendWorkload', () => {
  it('appends the sixty-four prepared records in order and wraps around', () => {
    const append = vi.spyOn(MemoryTranscriptSink.prototype, 'append')
    const workload = createTranscriptAppendWorkload()

    expect(workload.name).toBe('transcript append')
    expect(workload.beforeEach).toBeUndefined()
    for (let iteration = 0; iteration < 65; iteration += 1) {
      expect(workload.run()).toBeUndefined()
    }

    expect(append).toHaveBeenCalledTimes(65)
    const appended = append.mock.calls.map((call) => call[0] as { seq: number })
    expect(appended.map((record) => record.seq)).toEqual([
      ...Array.from({ length: 64 }, (_, index) => index + 1),
      1,
    ])
    const sink = append.mock.instances[0] as MemoryTranscriptSink<{ seq: number }>
    expect(sink.length).toBe(65)
  })
})
