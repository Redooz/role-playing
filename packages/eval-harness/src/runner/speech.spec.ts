import { TRANSCRIPT_SCHEMA_VERSION, type TranscriptRecord } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { speechMetricsFromRecords } from './speech.js'

function record(seq: number, kind: string, payload: Record<string, unknown>): TranscriptRecord {
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    runId: 'run-1',
    executionId: 'exec-1',
    seq,
    tSim: seq,
    tWall: 0,
    kind,
    payload,
    contentClass: kind === 'persona.response.chunk' ? 'restricted' : 'contentFree',
  } as TranscriptRecord
}

function committed(seq: number, text: unknown): TranscriptRecord {
  return record(seq, 'persona.response.committed', { grantId: `grant-${seq}`, text })
}

describe('speechMetricsFromRecords', () => {
  it('returns zero rates for an empty transcript', () => {
    expect(speechMetricsFromRecords([])).toStrictEqual({
      plainTextRate: 0,
      emojiCount: 0,
      markdownCount: 0,
      emptyResponses: 0,
    })
  })

  it('ignores every record that is not a committed persona reply', () => {
    const records = [
      record(0, 'session.started', { sessionId: 's', clockMode: 'simulated', lang: 'en' }),
      record(1, 'persona.response.chunk', { grantId: 'g', text: '**bold** 😀', sequence: 0 }),
      record(2, 'persona.response.cancelled', {
        grantId: 'g',
        reason: 'provider_failure',
        partialText: '**bold** 😀',
      }),
      record(3, 'session.completed', {}),
    ]

    expect(speechMetricsFromRecords(records)).toStrictEqual({
      plainTextRate: 0,
      emojiCount: 0,
      markdownCount: 0,
      emptyResponses: 0,
    })
  })

  it('scores one clean reply as fully plain text', () => {
    expect(
      speechMetricsFromRecords([committed(1, 'Morning. How is the report going?')]),
    ).toStrictEqual({
      plainTextRate: 1,
      emojiCount: 0,
      markdownCount: 0,
      emptyResponses: 0,
    })
  })

  it('counts Markdown constructs and refuses to call the reply clean', () => {
    expect(
      speechMetricsFromRecords([committed(1, '**Morning.** How is the *report* going?')]),
    ).toStrictEqual({
      plainTextRate: 0,
      emojiCount: 0,
      markdownCount: 2,
      emptyResponses: 0,
    })
  })

  it('counts an emoji-only reply as empty after filtering', () => {
    expect(speechMetricsFromRecords([committed(1, '😀🎉')])).toStrictEqual({
      plainTextRate: 0,
      emojiCount: 2,
      markdownCount: 0,
      emptyResponses: 1,
    })
  })

  it('treats a whitespace-only reply as empty after filtering', () => {
    expect(speechMetricsFromRecords([committed(1, '   \n\t')])).toStrictEqual({
      plainTextRate: 0,
      emojiCount: 0,
      markdownCount: 0,
      emptyResponses: 1,
    })
  })

  it('treats the empty string as an empty reply, not a clean one', () => {
    expect(speechMetricsFromRecords([committed(1, '')])).toStrictEqual({
      plainTextRate: 0,
      emojiCount: 0,
      markdownCount: 0,
      emptyResponses: 1,
    })
  })

  it('aggregates clean, Markdown and emoji replies into one rate', () => {
    const records = [committed(0, 'Morning.'), committed(1, '**Bold** reply.'), committed(2, '🎉')]

    expect(speechMetricsFromRecords(records)).toStrictEqual({
      plainTextRate: 1 / 3,
      emojiCount: 1,
      markdownCount: 1,
      emptyResponses: 1,
    })
  })

  it('sums every emoji cluster and Markdown construct', () => {
    const records = [committed(0, 'Hi 😀 👋🏽'), committed(1, '## Heading\n- item one\n- item two')]

    const metrics = speechMetricsFromRecords(records)

    expect(metrics.emojiCount).toBe(2)
    expect(metrics.markdownCount).toBe(3)
    expect(metrics.plainTextRate).toBe(0)
    expect(metrics.emptyResponses).toBe(0)
  })

  it('counts a reply with no string text but analyses nothing', () => {
    expect(speechMetricsFromRecords([committed(1, undefined)])).toStrictEqual({
      plainTextRate: 0,
      emojiCount: 0,
      markdownCount: 0,
      emptyResponses: 0,
    })
  })

  it('keeps a non-string text reply in the denominator', () => {
    const metrics = speechMetricsFromRecords([
      committed(0, 'Clean reply.'),
      committed(1, 42),
      committed(2, null),
    ])

    expect(metrics).toStrictEqual({
      plainTextRate: 1 / 3,
      emojiCount: 0,
      markdownCount: 0,
      emptyResponses: 0,
    })
  })
})
