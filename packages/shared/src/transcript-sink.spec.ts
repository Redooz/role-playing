import { describe, expect, it } from 'vitest'
import { MemoryTranscriptSink, type TranscriptSink } from './transcript-sink.js'

describe('MemoryTranscriptSink', () => {
  it('keeps records in append order', () => {
    const sink = new MemoryTranscriptSink<{ seq: number }>()
    sink.append({ seq: 1 })
    sink.append({ seq: 2 })
    expect(sink.records).toEqual([{ seq: 1 }, { seq: 2 }])
    expect(sink.length).toBe(2)
  })

  it('satisfies the sink contract', async () => {
    const sink: TranscriptSink<string> = new MemoryTranscriptSink<string>()
    await sink.append('hello')
    expect((sink as MemoryTranscriptSink<string>).records).toEqual(['hello'])
  })
})
