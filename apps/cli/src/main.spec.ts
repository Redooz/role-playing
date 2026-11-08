import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isValidSessionId, main, resolveSessionLogPath } from './main.js'

const LOG_DIR = resolve('/tmp/role-playing-logs')

describe('session id validation', () => {
  it('accepts the UUID default and other path-safe ids', () => {
    expect(isValidSessionId('1e5b5f6e-9b3a-4f9c-8c1f-5b6d6f6a0f00')).toBe(true)
    expect(isValidSessionId('session_1')).toBe(true)
    expect(isValidSessionId('ABC123')).toBe(true)
  })

  it.each(['', '../escape', 'a/b', 'a\\b', 'has space', '.hidden', '-leading-dash'])(
    'rejects the path-unsafe id %j',
    (value) => {
      expect(isValidSessionId(value)).toBe(false)
    },
  )

  it('resolves a valid id inside the log directory', () => {
    expect(resolveSessionLogPath(LOG_DIR, 'session-1')).toBe(resolve(LOG_DIR, 'session-1.jsonl'))
  })

  it('refuses to resolve a path outside the log directory', () => {
    expect(() => resolveSessionLogPath(LOG_DIR, '../authorized_keys')).toThrow(/invalid session id/)
    expect(() => resolveSessionLogPath(LOG_DIR, 'a/b')).toThrow(/invalid session id/)
  })
})

describe('main session id argument', () => {
  it('rejects a traversal attempt with exit code 2 before writing anything', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      await expect(main(['--session-id', '../../.ssh/authorized_keys'])).resolves.toBe(2)
      expect(err).toHaveBeenCalled()
    } finally {
      err.mockRestore()
    }
  })

  it('rejects a slash in the session id with exit code 2', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      await expect(main(['--session-id', 'nested/session'])).resolves.toBe(2)
    } finally {
      err.mockRestore()
    }
  })
})
