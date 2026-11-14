import { describe, expect, it } from 'vitest'
import { runExitCode } from './run-command.js'

describe('runExitCode', () => {
  it('reports a rejected verdict before an export failure', () => {
    expect(runExitCode('rejected', 'failed', true)).toBe(1)
    expect(runExitCode('inconclusive', 'failed', true)).toBe(1)
  })

  it('turns a failed required export into exit 3 only for an accepted run', () => {
    expect(runExitCode('accepted', 'failed', true)).toBe(3)
    expect(runExitCode('accepted', 'disabled', true)).toBe(3)
    expect(runExitCode('accepted', 'exported', true)).toBe(0)
    expect(runExitCode('accepted', 'failed', false)).toBe(0)
  })
})
