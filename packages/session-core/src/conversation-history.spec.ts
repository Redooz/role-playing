import { describe, expect, it } from 'vitest'
import { ConversationHistory } from './conversation-history.js'
import type { ConversationMessage } from './arbiter-port.js'

/**
 * Bounded history, including the two rules a long session depends on: the
 * greeting survives trimming, and the retained context starts with a user turn.
 */

function message(
  role: 'user' | 'assistant',
  content: string,
  personaId?: string,
): ConversationMessage {
  return { role, content, ...(personaId === undefined ? {} : { personaId }) }
}

describe('conversation history', () => {
  it('rejects an unusable bound', () => {
    expect(() => new ConversationHistory(0)).toThrow(/positive integer/)
    expect(() => new ConversationHistory(1.5)).toThrow(/positive integer/)
  })

  it('accepts a bound of one', () => {
    const history = new ConversationHistory(1)
    history.append(message('user', 'one'))
    expect(history.messages).toEqual([{ role: 'user', content: 'one' }])
  })

  it('keeps an assistant message when the history exactly fits', () => {
    const history = new ConversationHistory(2)
    history.markGreetingCommitted()
    history.append(message('assistant', 'welcome', 'manager'))
    history.append(message('assistant', 'a1', 'peer'))

    expect(history.messages).toEqual([
      { role: 'assistant', content: 'welcome', personaId: 'manager' },
      { role: 'assistant', content: 'a1', personaId: 'peer' },
    ])
  })

  it('keeps every message while it fits exactly', () => {
    const history = new ConversationHistory(2)
    history.append(message('user', 'one'))
    history.append(message('assistant', 'answer', 'manager'))

    expect(history.length).toBe(2)
    expect(history.messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'answer', personaId: 'manager' },
    ])
  })

  it('trims the oldest exchange and keeps a user turn first', () => {
    const history = new ConversationHistory(2)
    history.append(message('user', 'one'))
    history.append(message('assistant', 'a1', 'manager'))
    history.append(message('user', 'two'))

    expect(history.messages).toEqual([{ role: 'user', content: 'two' }])
  })

  it('never trims the committed greeting', () => {
    const history = new ConversationHistory(2)
    history.markGreetingCommitted()
    history.append(message('assistant', 'welcome', 'manager'))
    history.append(message('user', 'one'))
    history.append(message('assistant', 'a1', 'peer'))

    expect(history.messages).toEqual([
      { role: 'assistant', content: 'welcome', personaId: 'manager' },
    ])
  })

  it('drops a leading assistant after trimming and keeps the next user turn', () => {
    const history = new ConversationHistory(3)
    history.markGreetingCommitted()
    history.append(message('assistant', 'welcome', 'manager'))
    history.append(message('user', 'one'))
    history.append(message('assistant', 'a1', 'peer'))
    history.append(message('user', 'two'))

    expect(history.messages).toEqual([
      { role: 'assistant', content: 'welcome', personaId: 'manager' },
      { role: 'user', content: 'two' },
    ])
  })
})
