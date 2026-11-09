import { describe, expect, it } from 'vitest'
import {
  SpeechTextFilter,
  analyzeSpeechText,
  countEmoji,
  countMarkdown,
  sanitizeSpeechText,
} from './plain-text.js'

describe('plain-text speech policy', () => {
  it('removes Markdown constructs and keeps the words', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['**Hello** there', 'Hello there'],
      ['__Hello__ there', 'Hello there'],
      ['*Hello* there', 'Hello there'],
      ['_Hello_ there', 'Hello there'],
      ['~~Hello~~ there', 'Hello there'],
      ['## Heading\ntext', 'Heading\ntext'],
      ['> quoted text', 'quoted text'],
      ['- first item', 'first item'],
      ['1. first item', 'first item'],
      ['`inline code` here', 'inline code here'],
      ['```ts\nconst x = 1\n```', ''],
      ['[label](https://example.com)', 'label'],
      ['![alt text](image.png)', 'alt text'],
      ['<b>bold</b> text', 'bold text'],
      ['| a | b |\n| --- | --- |\n| 1 | 2 |', ''],
    ]

    for (const [input, expected] of cases) {
      expect(sanitizeSpeechText(input)).toBe(expected)
    }
  })

  it('preserves legitimate punctuation that resembles Markdown', () => {
    expect(sanitizeSpeechText('It is a follow-up, not a re-do.')).toBe(
      'It is a follow-up, not a re-do.',
    )
    expect(sanitizeSpeechText('The Q&A starts at 3 > 2.')).toBe('The Q&A starts at 3 > 2.')
    expect(sanitizeSpeechText('Use snake_case for the field.')).toBe(
      'Use snake_case for the field.',
    )
    expect(sanitizeSpeechText('The value is 3 * 4, roughly.')).toBe('The value is 3 * 4, roughly.')
    expect(sanitizeSpeechText('One choice | another choice.')).toBe('One choice | another choice.')
    expect(sanitizeSpeechText('The #1 priority is clarity.')).toBe('The #1 priority is clarity.')
    expect(sanitizeSpeechText('Add the key to .env and restart.')).toBe(
      'Add the key to .env and restart.',
    )
  })

  it('removes emoji clusters but not digits, # or *', () => {
    expect(sanitizeSpeechText('Great work 😀')).toBe('Great work')
    expect(sanitizeSpeechText('Team 👍🏽 effort')).toBe('Team effort')
    expect(sanitizeSpeechText('Family 👨‍👩‍👧‍👦 time')).toBe('Family time')
    expect(sanitizeSpeechText('Flags 🇬🇧 and 🇫🇷')).toBe('Flags and')
    expect(countEmoji('🇬🇧 🇫🇷')).toBe(2)
    expect(sanitizeSpeechText('Keycap 1️⃣ and #️⃣ and *️⃣')).toBe('Keycap and and')
    expect(sanitizeSpeechText('Cost is 5 # and *')).toBe('Cost is 5 # and *')
  })

  it('reports counts for the code invariant', () => {
    const analysis = analyzeSpeechText('**Hi** 😀 [there](x)')
    expect(analysis.text).toBe('Hi there')
    expect(analysis.markdownCount).toBeGreaterThanOrEqual(2)
    expect(analysis.emojiCount).toBe(1)
    expect(analysis.emptyAfterFilter).toBe(false)
    expect(countEmoji('a 😀 b 🎉')).toBe(2)
    expect(countMarkdown('**a** and *b*')).toBe(2)
  })

  it('flags text that is only Markdown or emoji as empty after filtering', () => {
    expect(analyzeSpeechText('😀🎉').emptyAfterFilter).toBe(true)
    expect(analyzeSpeechText('   ').emptyAfterFilter).toBe(true)
  })

  it('is idempotent', () => {
    for (const input of ['**Hi** 😀', 'plain text', '| a | b |', '`code` and ~~old~~']) {
      const once = sanitizeSpeechText(input)
      expect(sanitizeSpeechText(once)).toBe(once)
    }
  })

  it('removes tilde-fenced code blocks', () => {
    expect(sanitizeSpeechText('~~~ts\nconst x = 1\n~~~')).toBe('')
    expect(sanitizeSpeechText('~~~\ncode\n~~~')).toBe('')
    expect(sanitizeSpeechText('before ~~~x~~~ after')).toBe('before after')
    expect(countMarkdown('~~~a~~~')).toBe(1)
  })

  it('handles every reference-link shape', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['[a][r]', 'a'],
      ['[label][ref]', 'label'],
      ['[label][]', 'label'],
      ['[short][a long reference]', 'short'],
    ]
    for (const [input, expected] of cases) {
      expect(sanitizeSpeechText(input)).toBe(expected)
    }
    expect(countMarkdown('[label][ref]')).toBe(1)
  })

  it('only strips line-leading heading, quote and list markers', () => {
    const stripped: ReadonlyArray<readonly [string, string]> = [
      ['#Heading', '#Heading'],
      ['#  Heading', 'Heading'],
      ['   ### Heading', 'Heading'],
      ['>quote', 'quote'],
      ['>  quote', 'quote'],
      ['-  item', 'item'],
      ['10. item', 'item'],
      ['123) item', 'item'],
    ]
    for (const [input, expected] of stripped) {
      expect(sanitizeSpeechText(input)).toBe(expected)
    }

    // A marker that is not at the start of a line is prose, not Markdown.
    for (const prose of ['abc# title', 'abc> quote', 'abc- item', 'abc. item']) {
      expect(sanitizeSpeechText(prose)).toBe(prose)
    }
  })

  it('removes single-pipe table delimiter rows with every spacing variant', () => {
    const rows = [
      '---|---',
      '--- | ---',
      '---   |   ---',
      '---- | ----',
      '--- | :---',
      '--- | ---:',
      '--- | :---:',
      '--- | ---   ',
      '   --- | ---',
      ':--- | ---',
      '---|---:',
    ]
    for (const row of rows) {
      expect(sanitizeSpeechText(row)).toBe('')
      expect(countMarkdown(row)).toBe(1)
    }
    for (const row of [
      '---',
      '--- |',
      '-- | --',
      'prefix --- | ---',
      '--- | --- trailing',
      '--- | ---x',
    ]) {
      expect(sanitizeSpeechText(row)).toBe(row)
      expect(countMarkdown(row)).toBe(0)
    }
    // Two separator cells without outer pipes still count as one delimiter row.
    expect(countMarkdown('--- | --- | ---')).toBe(1)
  })

  it('removes tags with attributes and escaped punctuation only', () => {
    expect(sanitizeSpeechText('<span class="x">hi</span>')).toBe('hi')
    expect(sanitizeSpeechText('<a href="https://x.test">link</a>')).toBe('link')
    expect(sanitizeSpeechText('\\*')).toBe('*')
    expect(sanitizeSpeechText('\\q stays escaped')).toBe('\\q stays escaped')
    expect(sanitizeSpeechText('\\# and \\_')).toBe('# and _')
  })

  it('normalises line endings, whitespace runs and blank lines', () => {
    expect(sanitizeSpeechText('a\r\nb')).toBe('a\nb')
    expect(sanitizeSpeechText('a\rb')).toBe('a\nb')
    expect(sanitizeSpeechText('a   \n   b')).toBe('a\nb')
    expect(sanitizeSpeechText('a\n   b')).toBe('a\nb')
    expect(sanitizeSpeechText('a   \nb')).toBe('a\nb')
    expect(sanitizeSpeechText('a\n\n\n\nb')).toBe('a\n\nb')
    expect(sanitizeSpeechText('one . two')).toBe('one. two')
    expect(sanitizeSpeechText('done .')).toBe('done.')
  })

  it('removes lone presentation residue and leaves plain numbers alone', () => {
    expect(sanitizeSpeechText('\uFE0F')).toBe('')
    expect(sanitizeSpeechText('a\u200Db')).toBe('ab')
    expect(countEmoji('\uFE0F')).toBe(0)
    expect(sanitizeSpeechText('2026 #1 2 * 3')).toBe('2026 #1 2 * 3')
  })

  it('handles keycaps without a variation selector and ZWJ boundaries', () => {
    // A keycap does not need U+FE0F before the enclosing keycap.
    expect(sanitizeSpeechText('1\u20E3')).toBe('')
    expect(countEmoji('1\u20E3')).toBe(1)
    // A joiner followed by a non-pictograph ends the emoji cluster, so only the
    // joiner is residue and the following text survives.
    expect(sanitizeSpeechText('😀\u200Dx')).toBe('x')
    // A skin-tone modifier after a ZWJ is not itself an emoji base.
    expect(sanitizeSpeechText('😀\u200D🏽')).toBe('🏽')
  })

  it('handles compound emoji clusters with and without variation selectors', () => {
    expect(sanitizeSpeechText('👨\u200D👩')).toBe('')
    expect(sanitizeSpeechText('👩\uFE0F')).toBe('')
    expect(sanitizeSpeechText('👩\uFE0E')).toBe('')
    expect(countEmoji('👨\u200D👩\u200D👧')).toBe(1)
  })

  it('removes emphasis only at valid boundaries', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['**two words**', 'two words'],
      ['**a** **b**', 'a b'],
      ['__a__ __b__', 'a b'],
      ['~~old~~ new', 'old new'],
      ['a *b* c', 'a b c'],
      ['a _b_ c', 'a b c'],
    ]
    for (const [input, expected] of cases) {
      expect(sanitizeSpeechText(input)).toBe(expected)
    }
    // Underscores inside identifiers are not emphasis.
    expect(sanitizeSpeechText('snake_case_name')).toBe('snake_case_name')
    expect(sanitizeSpeechText('a*b*c')).toBe('a*b*c')
  })
})

describe('streaming speech filter', () => {
  it('produces the same text for every chunk split', () => {
    const text = '**Hello** there 😀. This is a plain sentence. And another one!'
    const expected = sanitizeSpeechText(text)

    for (let split = 0; split <= text.length; split += 1) {
      const filter = new SpeechTextFilter()
      let output = filter.push(text.slice(0, split))
      output += filter.push(text.slice(split))
      output += filter.flush()
      expect(output).toBe(expected)
    }
  })

  it('is chunk-boundary independent for one-character chunks', () => {
    const text = 'First sentence with *emphasis* and 👍🏽 emoji. Second sentence.'
    const filter = new SpeechTextFilter()
    let output = ''
    for (const character of text) output += filter.push(character)
    output += filter.flush()
    expect(output).toBe(sanitizeSpeechText(text))
  })

  it('flushes a long sentence at a bounded boundary without losing text', () => {
    const text = `${'word '.repeat(200)}end`
    const filter = new SpeechTextFilter()
    let output = filter.push(text)
    output += filter.flush()
    expect(output).toBe(sanitizeSpeechText(text))
  })

  it('reports emoji and Markdown counts across chunks', () => {
    const filter = new SpeechTextFilter()
    let output = filter.push('**Hi** 😀. ')
    output += filter.push('More 🎉.')
    output += filter.flush()
    expect(output).toBe('Hi. More.')
    expect(filter.stats().emojiCount).toBe(2)
    expect(filter.stats().markdownCount).toBeGreaterThanOrEqual(1)
    expect(filter.stats().emptyAfterFilter).toBe(false)
  })

  it('reports an empty result when only emoji was produced', () => {
    const filter = new SpeechTextFilter()
    const output = filter.push('😀') + filter.flush()
    expect(output).toBe('')
    expect(filter.stats().emptyAfterFilter).toBe(true)
  })

  it('emits a complete sentence before the stream ends', () => {
    const filter = new SpeechTextFilter()
    expect(filter.push('Hello. ')).toBe('Hello.')
    expect(filter.flush()).toBe('')
  })

  it('emits at the furthest boundary even when a newline match is earlier', () => {
    const filter = new SpeechTextFilter()
    expect(filter.push('\nHello. ')).toBe('Hello.')
    expect(filter.flush()).toBe('')
  })

  it('emits a newline boundary when there is no sentence boundary', () => {
    const filter = new SpeechTextFilter()
    expect(filter.push('first line\n')).toBe('first line')
    expect(filter.flush()).toBe('')
  })

  it('flushes a long unpunctuated buffer at a whitespace boundary', () => {
    const filter = new SpeechTextFilter()
    const text = `${'word '.repeat(100)}end`
    const first = filter.push(text)
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThan(text.length)
    expect(first + filter.flush()).toBe(sanitizeSpeechText(text))
  })

  it('returns an empty string when flushed twice', () => {
    const filter = new SpeechTextFilter()
    expect(filter.push('only')).toBe('')
    expect(filter.flush()).toBe('only')
    expect(filter.flush()).toBe('')
  })

  it('keeps a short sentence boundary when the buffer starts with a space', () => {
    const filter = new SpeechTextFilter()
    expect(filter.push(' Hi. ')).toBe('Hi.')
    expect(filter.flush()).toBe('')
  })

  it('re-flushes a long buffer at the tail guard even after an early boundary', () => {
    const filter = new SpeechTextFilter()
    const text = `End. ${'word '.repeat(80)}`
    const first = filter.push(text)
    // A boundary before the buffer limit wins; the length fallback only fires
    // when the buffer has no boundary at all.
    expect(first).toBe('End.')
    expect(first + filter.flush()).toBe(sanitizeSpeechText(text))
  })

  it('keeps a tail guard when the early flush is forced by length', () => {
    const filter = new SpeechTextFilter()
    const text = `${'word '.repeat(100)}end`
    const first = filter.push(text)
    const tail = filter.flush()
    expect(tail.length).toBeGreaterThanOrEqual(40)
    expect(first + tail).toBe(sanitizeSpeechText(text))
  })

  it('does not force an early flush at exactly the buffer bound', () => {
    const filter = new SpeechTextFilter()
    const text = `${'a'.repeat(200)} ${'a'.repeat(119)}`
    expect(text).toHaveLength(320)
    expect(filter.push(text)).toBe('')
    expect(filter.flush()).toBe(sanitizeSpeechText(text))
  })

  it('does not emit a padding space for a segment that filters to nothing', () => {
    const filter = new SpeechTextFilter()
    expect(filter.push('Hi. ')).toBe('Hi.')
    expect(filter.push('😀\n')).toBe('')
    expect(filter.flush()).toBe('')
  })

  it('does not add a separator when the next segment starts with a newline', () => {
    const filter = new SpeechTextFilter()
    expect(filter.push('Hi. ')).toBe('Hi.')
    expect(filter.push('\nThere. ')).toBe('There.')
    expect(filter.flush()).toBe('')
  })

  it('treats a quote before whitespace as a sentence boundary', () => {
    const filter = new SpeechTextFilter()
    expect(filter.push('He said "hello." ')).toBe('He said "hello."')
    expect(filter.flush()).toBe('')
  })

  it('consumes every whitespace character after a sentence boundary', () => {
    const filter = new SpeechTextFilter()
    expect(filter.push('Hi.  ')).toBe('Hi.')
    expect(filter.push('\nNext. ')).toBe('Next.')
    expect(filter.flush()).toBe('')
  })

  it('consumes all newlines at a newline boundary', () => {
    const filter = new SpeechTextFilter()
    expect(filter.push('line\n\n')).toBe('line')
    expect(filter.push('Next. ')).toBe(' Next.')
    expect(filter.flush()).toBe('')
  })
})
