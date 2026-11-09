/**
 * Plain-text speech policy (M2 D3b).
 *
 * Persona speech must contain no Markdown and no emoji. A prompt instruction is
 * a request, not a guarantee, so this module is the deterministic enforcement
 * layer: the pipeline decorator applies it to every streamed chunk before the
 * driver, transcript or history sees the text.
 *
 * The sanitizer is intentionally conservative about false positives. Ordinary
 * prose may contain `*`, `_`, `#`, `>` or `|`; only constructs that are
 * unambiguously Markdown are removed. Emoji are removed as grapheme-like
 * clusters (ZWJ sequences, flags, keycaps and modifiers), never as lone code
 * units, so a family emoji cannot be split into visible pieces.
 */

/** Counts observed while filtering one response. */
export interface SpeechTextStats {
  /** Markdown constructs removed. */
  readonly markdownCount: number
  /** Emoji clusters removed. */
  readonly emojiCount: number
  /** True when filtering left no text at all. */
  readonly emptyAfterFilter: boolean
}

/** Result of analysing one complete string. */
export interface SpeechTextAnalysis extends SpeechTextStats {
  readonly text: string
}

/**
 * Emoji clusters:
 * - a regional-indicator pair (a flag);
 * - a keycap sequence (`1️⃣`, `#️⃣`, `*️⃣`);
 * - an extended pictographic, with an optional variation selector, skin-tone
 *   modifier and any number of ZWJ-joined pictographics.
 *
 * Digits, `#` and `*` are matched only as part of a keycap sequence, so plain
 * numbers and punctuation survive.
 */
const EMOJI_PATTERN =
  /(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?)*)/gu

/** Presentation selectors and joiners left behind after cluster removal. */
const EMOJI_RESIDUE_PATTERN = /[\uFE0E\uFE0F\u200D]/gu

interface ReplaceResult {
  readonly text: string
  readonly count: number
}

function replaceAll(text: string, pattern: RegExp, replacement: string): ReplaceResult {
  let count = 0
  const next = text.replace(pattern, () => {
    count += 1
    return replacement
  })
  return { text: next, count }
}

function replaceWithGroups(text: string, pattern: RegExp): ReplaceResult {
  let count = 0
  const next = text.replace(pattern, (...args: unknown[]) => {
    count += 1
    const groups = args.slice(0, -2) as string[]
    return groups[1] ?? ''
  })
  return { text: next, count }
}

/**
 * Remove Markdown constructs while preserving legitimate punctuation.
 *
 * Returns the cleaned text and how many constructs were removed, so a caller
 * can report `response.markdown_count` without re-parsing the original.
 */
export function stripMarkdown(input: string): ReplaceResult {
  let text = input
  let count = 0

  const apply = (result: ReplaceResult): void => {
    text = result.text
    count += result.count
  }

  // Fenced code blocks are removed whole: their content is not speech.
  apply(replaceAll(text, /```[\s\S]*?```/g, ''))
  apply(replaceAll(text, /~~~[\s\S]*?~~~/g, ''))
  // Inline code keeps its content and loses the backticks.
  apply(replaceWithGroups(text, /`([^`\n]+)`/g))

  apply(replaceWithGroups(text, /!\[([^\]]*)\]\([^)]*\)/g))
  apply(replaceWithGroups(text, /\[([^\]]+)\]\([^)]*\)/g))
  apply(replaceWithGroups(text, /\[([^\]]+)\]\[[^\]]*\]/g))

  // Line-leading constructs only; `3 > 2` and mid-line `#` are untouched.
  apply(replaceAll(text, /^[ \t]{0,3}#{1,6}[ \t]+/gm, ''))
  apply(replaceAll(text, /^[ \t]{0,3}>[ \t]?/gm, ''))
  apply(replaceAll(text, /^[ \t]{0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, ''))

  // Table delimiter rows disappear; a row with at least two pipes becomes
  // space-separated prose. A single `|` in a sentence is preserved.
  apply(
    replaceAll(text, /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, ''),
  )
  apply(replaceAll(text, /^[ \t]*.*\|.*\|.*$/gm, ''))

  apply(replaceWithGroups(text, /\*\*(?=\S)([\s\S]*?\S)\*\*/g))
  apply(replaceWithGroups(text, /__(?=\S)([\s\S]*?\S)__/g))
  apply(replaceWithGroups(text, /~~(?=\S)([\s\S]*?\S)~~/g))
  apply(replaceWithGroups(text, /(?<![*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g))
  apply(replaceWithGroups(text, /(?<![\w])_(?=\S)([^_\n]*?\S)_(?![\w])/g))

  apply(replaceAll(text, /<\/?[A-Za-z][^>]*>/g, ''))
  apply(replaceWithGroups(text, /\\([\\`*_{}[\]()#+\-.!>|~])/g))

  return { text: normalizeWhitespace(text), count }
}

/** Remove emoji clusters and any presentation residue. */
export function stripEmoji(input: string): ReplaceResult {
  const removed = replaceAll(input, EMOJI_PATTERN, '')
  const residue = replaceAll(removed.text, EMOJI_RESIDUE_PATTERN, '')
  return { text: residue.text, count: removed.count }
}

function normalizeWhitespace(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      // Removing an emoji can leave a space before a full stop or comma. French
      // typography keeps its space before `?`, `!`, `:` and `;`, so only the
      // languages that never use one are normalised here.
      .replace(/ +([.,])(?=\s|$)/g, '$1')
      .trim()
  )
}

/** Analyse one complete response. The returned `text` is safe to speak. */
export function analyzeSpeechText(input: string): SpeechTextAnalysis {
  const markdown = stripMarkdown(input)
  const emoji = stripEmoji(markdown.text)
  const text = normalizeWhitespace(emoji.text)
  return {
    text,
    markdownCount: markdown.count,
    emojiCount: emoji.count,
    emptyAfterFilter: text.length === 0,
  }
}

/** Remove Markdown and emoji from one complete string. */
export function sanitizeSpeechText(input: string): string {
  return analyzeSpeechText(input).text
}

/** Number of emoji clusters in `input`. */
export function countEmoji(input: string): number {
  return [...input.matchAll(EMOJI_PATTERN)].length
}

/** Number of Markdown constructs in `input`. */
export function countMarkdown(input: string): number {
  return stripMarkdown(input).count
}

/** Fixed accumulation bound before a stream is flushed at a safe boundary. */
const MAX_BUFFER_CHARS = 320
/** Characters kept back when the buffer bound forces an early flush. */
const TAIL_GUARD_CHARS = 48

const SENTENCE_BOUNDARY = /[.!?…](?:["'”’)\]]*)\s+/g
const NEWLINE_BOUNDARY = /\n+/g

function lastBoundary(buffer: string): number {
  let end = 0
  for (const pattern of [SENTENCE_BOUNDARY, NEWLINE_BOUNDARY]) {
    pattern.lastIndex = 0
    for (const match of buffer.matchAll(pattern)) {
      const candidate = (match.index ?? 0) + match[0].length
      if (candidate > end) end = candidate
    }
  }
  return end
}

/**
 * Streaming plain-text filter.
 *
 * `push` returns the part of the buffer that is safe to emit now. `flush`
 * returns the remainder and must be called once at the end of the stream.
 *
 * Boundaries are derived from the accumulated text only: sentence ends and
 * newlines when present, otherwise a bounded early flush at whitespace. Two
 * streams whose chunks concatenate to the same text therefore produce the same
 * output regardless of how the input was split.
 */
export class SpeechTextFilter {
  #buffer = ''
  #markdownCount = 0
  #emojiCount = 0
  #emitted = ''

  push(chunk: string): string {
    if (chunk.length === 0) return ''
    this.#buffer += chunk

    let cut = lastBoundary(this.#buffer)
    if (cut === 0 && this.#buffer.length > MAX_BUFFER_CHARS) {
      const limit = this.#buffer.length - TAIL_GUARD_CHARS
      const whitespace = this.#buffer.lastIndexOf(' ', limit)
      cut = whitespace > 0 ? whitespace + 1 : 0
    }

    if (cut === 0) return ''
    return this.#emit(this.#buffer.slice(0, cut), false)
  }

  flush(): string {
    if (this.#buffer.length === 0) return ''
    return this.#emit(this.#buffer, true)
  }

  stats(): SpeechTextStats {
    return {
      markdownCount: this.#markdownCount,
      emojiCount: this.#emojiCount,
      emptyAfterFilter: this.#emitted.trim().length === 0,
    }
  }

  #emit(segment: string, last: boolean): string {
    const analysis = analyzeSpeechText(segment)
    this.#markdownCount += analysis.markdownCount
    this.#emojiCount += analysis.emojiCount
    this.#buffer = last ? '' : this.#buffer.slice(segment.length)

    if (analysis.text.length === 0) return ''
    // Preserve the spoken separator between segments; `push` output is a stream.
    const requiresSpace =
      this.#emitted.length > 0 && !/\s$/.test(this.#emitted) && !segment.startsWith('\n')
    const output = requiresSpace ? ` ${analysis.text}` : analysis.text
    this.#emitted += output
    return output
  }
}
