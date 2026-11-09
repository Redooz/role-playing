import { analyzeSpeechText } from '@rp/shared'
import type { TranscriptRecord } from '@rp/session-core'

/** Code-based plain-text reading for one trial (M2 D3b/D9). */
export interface TrialSpeechMetrics {
  /** Share of committed persona replies that are plain text. 1 is the only passing value. */
  readonly plainTextRate: number
  readonly emojiCount: number
  readonly markdownCount: number
  readonly emptyResponses: number
}

/** Read every committed persona reply in a transcript. */
export function speechMetricsFromRecords(records: readonly TranscriptRecord[]): TrialSpeechMetrics {
  let replies = 0
  let clean = 0
  let emojiCount = 0
  let markdownCount = 0
  let emptyResponses = 0

  for (const record of records) {
    if (record.kind !== 'persona.response.committed') continue
    replies += 1
    const text = (record.payload as { readonly text?: unknown }).text
    if (typeof text !== 'string') continue

    const analysis = analyzeSpeechText(text)
    emojiCount += analysis.emojiCount
    markdownCount += analysis.markdownCount
    if (analysis.text.length === 0) emptyResponses += 1
    if (analysis.text === text && analysis.text.length > 0) clean += 1
  }

  return {
    plainTextRate: replies === 0 ? 0 : clean / replies,
    emojiCount,
    markdownCount,
    emptyResponses,
  }
}
