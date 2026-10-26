/**
 * Minimal transcript sink contract.
 *
 * The record type lives in `session-core` (it needs `contentClass` and the
 * event payloads); `shared` only owns the sink shape so tests and tools can
 * capture transcripts without importing the session model.
 */
export interface TranscriptSink<Record> {
  append(record: Record): void | Promise<void>
}

export class MemoryTranscriptSink<Record> implements TranscriptSink<Record> {
  readonly records: Record[] = []

  append(record: Record): void {
    this.records.push(record)
  }

  get length(): number {
    return this.records.length
  }
}
