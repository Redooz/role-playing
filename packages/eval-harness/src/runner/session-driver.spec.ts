import { FakeClock } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import { buildSessionCannedEntries, runSessionTask } from './session-runner.js'
import {
  DATE,
  multiPersonaTask,
  personaAwareProvider,
  run,
  sessionTask,
  shadowJudge,
  textProvider,
} from './session.fixtures.js'

describe('multi-persona session runner', () => {
  it('runs two personas with one prompt each and labels the grants', async () => {
    const requests: string[][] = []
    const result = await run(multiPersonaTask(), personaAwareProvider(requests))

    expect(result.personaPrompts.map((entry) => entry.personaId)).toEqual(['manager', 'peer'])
    expect(new Set(result.personaPrompts.map((entry) => entry.promptHash)).size).toBe(2)
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/)

    const grants = result.records
      .filter((record) => record.kind === 'turn.granted')
      .map((record) => (record.payload as { grant: { personaId: string } }).grant.personaId)
    expect(grants[0]).toBe('manager')
    expect(grants).toContain('peer')
    expect(grants).toContain('manager')

    const committed = result.records.filter(
      (record) => record.kind === 'persona.response.committed',
    )
    expect(committed.length).toBeGreaterThanOrEqual(2)
    expect(
      result.records.filter((record) => record.kind === 'user.utterance.committed'),
    ).toHaveLength(2)
    expect(requests.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses the generic baseline for a multi-persona task', async () => {
    await expect(run(multiPersonaTask(), textProvider('Okay.'), 'generic')).rejects.toThrow(
      /generic baseline supports one/u,
    )
  })

  it('refuses a canned replay for a multi-persona task', () => {
    expect(() => buildSessionCannedEntries(multiPersonaTask(), DATE)).toThrow(
      /does not support multi-persona/u,
    )
  })
})

describe('multi-persona shadow switch', () => {
  it('records every non-live arm after each scripted turn without changing events', async () => {
    const requests: string[][] = []
    const result = await runSessionTask({
      runId: 'm3b-shadow',
      executionId: 'exec-shadow',
      task: multiPersonaTask(),
      clock: new FakeClock(0),
      provider: personaAwareProvider(requests),
      wallNow: () => 0,
      currentDate: DATE,
      shadow: { judge: shadowJudge(), seed: 7, deadlineMs: 1000 },
    })

    expect(result.shadow?.records).toHaveLength(6)
    expect(result.shadow?.summary).toMatchObject({
      kind: 'routing.shadow.summary',
      taskId: 'en-multi-scope-001',
      records: 6,
    })
    expect(result.records.filter((record) => record.kind === 'session.started')).toHaveLength(1)
  })

  it('refuses shadow on a single-persona task', async () => {
    await expect(
      runSessionTask({
        runId: 'm3b-shadow',
        executionId: 'exec-shadow',
        task: sessionTask(),
        clock: new FakeClock(0),
        provider: textProvider('Okay.'),
        wallNow: () => 0,
        currentDate: DATE,
        shadow: { judge: shadowJudge(), seed: 7, deadlineMs: 1000 },
      }),
    ).rejects.toThrow(/requires two/u)
  })
})
