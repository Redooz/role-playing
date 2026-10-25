import { describe, expect, it } from 'vitest'
import { MemoryTraceSink, type TraceSink } from './trace-sink.js'

describe('MemoryTraceSink', () => {
  it('keeps records in append order', () => {
    const sink = new MemoryTraceSink<{ seq: number }>()
    sink.append({ seq: 1 })
    sink.append({ seq: 2 })
    expect(sink.records).toEqual([{ seq: 1 }, { seq: 2 }])
    expect(sink.length).toBe(2)
  })

  it('satisfies the sink contract', async () => {
    const sink: TraceSink<string> = new MemoryTraceSink<string>()
    await sink.append('hello')
    expect((sink as MemoryTraceSink<string>).records).toEqual(['hello'])
  })
})
