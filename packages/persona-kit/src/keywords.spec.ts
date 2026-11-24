import { describe, expect, it } from 'vitest'
import { normalizeKeywordText, tokens, unique } from './keywords.js'

describe('normalizeKeywordText', () => {
  it('lower-cases and normalises for the session language', () => {
    expect(normalizeKeywordText('  The Café  ', 'en')).toBe('  the café  ')
    expect(normalizeKeywordText('ÉTÉ', 'fr')).toBe('été')
  })

  it('applies NFKC so composed and decomposed forms match', () => {
    expect(normalizeKeywordText('cafe\u0301', 'en')).toBe('café')
  })
})

describe('tokens', () => {
  it('drops stop words and short tokens', () => {
    expect(tokens('Sam owns the action list', 'en')).toEqual(['sam', 'owns', 'action', 'list'])
    expect(tokens('La liste des actions est prête', 'fr')).toEqual(['liste', 'actions', 'prête'])
  })

  it('splits on punctuation and keeps accented letters', () => {
    expect(tokens('démo, notes; suivi', 'fr')).toEqual(['démo', 'notes', 'suivi'])
  })

  it('returns no tokens for an empty or stop-word-only phrase', () => {
    expect(tokens('   ', 'en')).toEqual([])
    expect(tokens('the and for with', 'en')).toEqual([])
  })
})

describe('unique', () => {
  it('keeps first-seen order and removes duplicates', () => {
    expect(unique(['notes', 'action', 'notes', 'list'])).toEqual(['notes', 'action', 'list'])
  })

  it('removes blank values after trimming', () => {
    expect(unique(['notes', '   ', '', 'action'])).toEqual(['notes', 'action'])
  })
})
