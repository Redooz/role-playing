/**
 * Minimal trace sink contract.
 *
 * The record type lives in `session-core` (it needs `contentClass` and the
 * event payloads); `shared` only owns the sink shape so tests and tools can
 * capture traces without importing the session model.
 */
export interface TraceSink<Record> {
  append(record: Record): void | Promise<void>
}

export class MemoryTraceSink<Record> implements TraceSink<Record> {
  readonly records: Record[] = []

  append(record: Record): void {
    this.records.push(record)
  }

  get length(): number {
    return this.records.length
  }
}
