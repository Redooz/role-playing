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
})
