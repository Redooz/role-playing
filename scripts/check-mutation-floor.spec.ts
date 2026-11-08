import { describe, expect, it } from 'vitest'
import { readJson } from './check-mutation-floor.mjs'

describe('mutation floor report loading', () => {
  it('reports a missing report as a gate message instead of a raw ENOENT', async () => {
    await expect(readJson('/tmp/definitely-missing-mutation-report.json')).rejects.toThrow(
      /cannot read .*ENOENT/,
    )
  })
})
