import { FakeClock, hashValue } from '@rp/shared'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  expectedContentClass,
  normalizedTranscriptJsonl,
  type SessionEventName,
} from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import type { CompletionProvider } from './canned-provider.js'
import { ProviderUnavailableError, createCannedProvider } from './canned-provider.js'
import {
  PlainTextPolicyError,
  buildSessionCannedEntries,
  runSessionTask,
} from './session-runner.js'
import { resolveSessionPrompt } from './session-prompt.js'
import {
  DATE,
  multiPersonaTask,
  run,
  sessionTask,
  shadowJudge,
  textProvider,
} from './session.fixtures.js'

describe('session runner', () => {
  it('greets first, then sends every scripted learner turn', async () => {
    const requests: string[][] = []
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'capture',
      async *complete(request) {
        requests.push(request.messages.map((message) => `${message.role}:${message.content}`))
        yield { text: 'Okay.', done: false }
        yield { text: '', done: true }
      },
    }

    const result = await run(sessionTask(), provider)

    expect(requests).toHaveLength(3)
    expect(requests[0]?.[0]).toContain('## Opening')
    expect(requests[0]?.[0]).not.toContain('## Goals')
    expect(requests[1]?.[0]).toContain('## Goals')
    expect(requests[1]?.[1]).toBe('assistant:Okay.')
    expect(requests[1]?.[2]).toBe('user:I need two more days.')

    const committed = result.records
      .filter((record) => record.kind === 'persona.response.committed')
      .map((record) => (record.payload as { text: string }).text)
    expect(committed).toEqual(['Okay.', 'Okay.', 'Okay.'])
    expect(result.records.at(-1)?.kind).toBe('session.completed')
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('cleans Markdown and emoji before the transcript sees them', async () => {
    const result = await run(sessionTask(), textProvider('**Hello** there 😀. Next.'))
    const committed = result.records
      .filter((record) => record.kind === 'persona.response.committed')
      .map((record) => (record.payload as { text: string }).text)

    expect(committed).toEqual(['Hello there. Next.', 'Hello there. Next.', 'Hello there. Next.'])
  })

  it('rejects an empty reply after filtering', async () => {
    await expect(run(sessionTask(), textProvider('😀🎉'))).rejects.toBeInstanceOf(
      PlainTextPolicyError,
    )
  })

  it('turns a provider failure into an infrastructure error, not a pass', async () => {
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'failing',
      complete() {
        throw new Error('provider down')
      },
    }
    await expect(run(sessionTask(), provider)).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
    })
  })

  it('replays a canned session by the full request hash', async () => {
    const task = sessionTask()
    const entries = buildSessionCannedEntries(task, DATE)
    const provider = createCannedProvider(entries, 'canned-session')
    const result = await run(task, provider)

    const committed = result.records
      .filter((record) => record.kind === 'persona.response.committed')
      .map((record) => (record.payload as { text: string }).text)
    expect(committed).toEqual(task.session?.recordedPersonaTurns)
  })

  it('replays a canned generic session by the full request hash', async () => {
    const task = sessionTask()
    const entries = buildSessionCannedEntries(task, DATE, 'harmony', 'generic')
    const provider = createCannedProvider(entries, 'canned-session')
    const result = await run(task, provider, 'generic')

    const committed = result.records
      .filter((record) => record.kind === 'persona.response.committed')
      .map((record) => (record.payload as { text: string }).text)
    expect(committed).toEqual(task.session?.recordedPersonaTurns)
  })

  it('rejects a persona recording when the run asks for generic', async () => {
    const task = sessionTask()
    const entries = buildSessionCannedEntries(task, DATE)
    const provider = createCannedProvider(entries, 'canned-session')

    await expect(run(task, provider, 'generic')).rejects.toBeInstanceOf(Error)
  })

  it('invalidates a canned recording when the locale changes', async () => {
    const entries = buildSessionCannedEntries(sessionTask(), DATE)
    const localised = sessionTask({ locale: 'en-GB', id: 'en-gb-session-deadline-001' })
    const provider = createCannedProvider(entries, 'canned-session')

    await expect(run(localised, provider)).rejects.toBeInstanceOf(Error)
  })

  it('builds the Gemma pack when the run asks for it', async () => {
    const requests: string[] = []
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'capture',
      async *complete(request) {
        requests.push(request.messages[0]?.content ?? '')
        yield { text: 'Okay.', done: false }
        yield { text: '', done: true }
      },
    }

    const result = await runSessionTask({
      runId: 'm2-session',
      executionId: 'exec-1',
      task: sessionTask(),
      clock: new FakeClock(0),
      provider,
      wallNow: () => 0,
      currentDate: DATE,
      promptStyle: 'gemma',
    })

    expect(requests[0]).toContain('HOW TO REPLY')
    expect(requests[0]).not.toContain('You are ChatGPT')
    expect(result.promptVersion).toBe('m2-prompt-gemma-v2')
  })
})

describe('session runner transcript envelope', () => {
  it('writes exact records with one seq per event and the injected clock', async () => {
    const task = sessionTask()
    let wall = 0
    const result = await runSessionTask({
      runId: 'run-exact',
      executionId: 'exec-exact',
      task,
      clock: new FakeClock(5),
      provider: textProvider('Okay.'),
      wallNow: () => (wall += 1),
      currentDate: DATE,
    })

    expect(result.records[0]).toStrictEqual({
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      runId: 'run-exact',
      executionId: 'exec-exact',
      seq: 0,
      tSim: 5,
      tWall: 1,
      kind: 'session.started',
      payload: { sessionId: task.id, clockMode: 'simulated', lang: 'en' },
      contentClass: 'contentFree',
    })
    expect(result.records.map((record) => record.seq)).toStrictEqual(
      result.records.map((_record, index) => index),
    )
    expect(result.records.every((record) => record.tSim === 5)).toBe(true)
    expect(result.records.every((record) => record.tWall > 0)).toBe(true)
    result.records.forEach((record, index) => {
      expect(record.tWall).toBe(index + 1)
      expect(record.contentClass).toBe(expectedContentClass(record.kind as SessionEventName))
    })
    expect(result.records.at(-1)?.kind).toBe('session.completed')
  })

  it('serializes exactly the records it returns as normalized JSONL', async () => {
    const result = await run(sessionTask(), textProvider('Okay.'))

    expect(result.jsonl).toBe(normalizedTranscriptJsonl(result.records))
    const lines = result.jsonl.trimEnd().split('\n')
    expect(lines).toHaveLength(result.records.length)
    expect(lines.map((line) => JSON.parse(line).seq)).toStrictEqual(
      result.records.map((record) => record.seq),
    )
  })

  it('uses the fixed transcript schema version for every record', async () => {
    const result = await run(sessionTask(), textProvider('Okay.'))

    expect(
      result.records.every((record) => record.schemaVersion === TRANSCRIPT_SCHEMA_VERSION),
    ).toBe(true)
  })
})

describe('session runner prompt identity', () => {
  it('returns the single prompt hash unchanged for a one-persona task', async () => {
    const result = await run(sessionTask(), textProvider('Okay.'))

    expect(result.personaPrompts).toHaveLength(1)
    expect(result.promptHash).toBe(result.personaPrompts[0]?.promptHash)
    expect(result.promptVersion).toBe('m2-prompt-v2')
  })

  it('combines both persona hashes for a multi-persona task', async () => {
    const result = await run(multiPersonaTask(), textProvider('Okay.'))

    const hashes = result.personaPrompts.map((entry) => entry.promptHash)
    expect(new Set(hashes).size).toBe(2)
    expect(result.promptHash).toBe(hashValue(hashes))
    expect(result.promptHash).not.toBe(hashes[0])
  })

  it('labels every provider request with the task and, for two personas, the persona', async () => {
    const requests: Array<Readonly<Record<string, string>> | undefined> = []
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'capture',
      async *complete(request) {
        requests.push(request.metadata)
        yield { text: 'Okay. ', done: false }
        yield { text: '', done: true }
      },
    }

    await run(multiPersonaTask(), provider)

    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests.filter((metadata) => metadata?.personaId === 'peer').length).toBeGreaterThan(0)
    expect(requests.map((metadata) => metadata?.taskId)).toSatisfy((ids: string[]) =>
      ids.every((id) => id === 'en-multi-scope-001'),
    )
    const personaIds = requests.map((metadata) => metadata?.personaId)
    expect(personaIds).toContain('manager')
    expect(personaIds).toContain('peer')
    expect(requests.every((metadata) => metadata?.lang === 'en')).toBe(true)
    expect(requests.every((metadata) => metadata?.locale === 'en')).toBe(true)
  })

  it('does not label a single-persona request with a persona id', async () => {
    const requests: Array<Readonly<Record<string, string>> | undefined> = []
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'capture',
      async *complete(request) {
        requests.push(request.metadata)
        yield { text: 'Okay. ', done: false }
        yield { text: '', done: true }
      },
    }

    await run(sessionTask(), provider)

    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((metadata) => metadata?.taskId === 'en-session-deadline-001')).toBe(true)
    expect(requests.every((metadata) => metadata?.personaId === undefined)).toBe(true)
  })

  it('names the task persona on a single-persona grant', async () => {
    const result = await run(sessionTask(), textProvider('Okay.'))

    const personaIds = result.records
      .filter((record) => record.kind === 'turn.granted')
      .map((record) => (record.payload as { grant: { personaId: string } }).grant.personaId)
    expect(new Set(personaIds)).toStrictEqual(new Set(['manager']))
  })
})

describe('session runner failure policy', () => {
  it('reports a provider failure with its label, reason and sanitized detail', async () => {
    const task = sessionTask()
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'failing',
      complete() {
        throw new Error('provider down')
      },
    }

    await expect(run(task, provider)).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      providerLabel: 'failing',
      message: `session ${task.id} ended a turn with "provider_failure": Error: provider down; a failed model call is never a pass`,
    })
  })

  it('fails an empty plain-text reply with the policy error name and message', async () => {
    const task = sessionTask()

    await expect(run(task, textProvider('😀🎉'))).rejects.toMatchObject({
      name: 'PlainTextPolicyError',
      message: `session ${task.id} produced an empty reply after plain-text filtering`,
    })
  })

  it('refuses the fixed-rotation baseline for a single-persona task', async () => {
    const task = sessionTask()

    await expect(
      runSessionTask({
        runId: 'm3b-baseline',
        executionId: 'exec-baseline',
        task,
        clock: new FakeClock(0),
        provider: textProvider('Okay.'),
        wallNow: () => 0,
        currentDate: DATE,
        policy: 'fixed-rotation',
      }),
    ).rejects.toThrow(
      `task ${task.id} has one persona; a multi-persona policy or shadow requires two`,
    )
  })

  it('aborts before greeting when the signal is already aborted', async () => {
    let calls = 0
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'capture',
      async *complete() {
        calls += 1
        yield { text: 'Okay.', done: false }
        yield { text: '', done: true }
      },
    }
    const controller = new AbortController()
    controller.abort()

    await expect(
      runSessionTask({
        runId: 'run-abort',
        executionId: 'exec-abort',
        task: sessionTask(),
        clock: new FakeClock(0),
        provider,
        wallNow: () => 0,
        currentDate: DATE,
        signal: controller.signal,
      }),
    ).rejects.toThrow('session run was aborted')
    expect(calls).toBe(0)
  })

  it('aborts between scripted turns without sending the next utterance', async () => {
    let calls = 0
    const controller = new AbortController()
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'capture',
      async *complete() {
        calls += 1
        if (calls === 2) controller.abort()
        yield { text: 'Okay.', done: false }
        yield { text: '', done: true }
      },
    }

    await expect(
      runSessionTask({
        runId: 'run-abort',
        executionId: 'exec-abort',
        task: sessionTask(),
        clock: new FakeClock(0),
        provider,
        wallNow: () => 0,
        currentDate: DATE,
        signal: controller.signal,
      }),
    ).rejects.toThrow('session run was aborted')
    expect(calls).toBe(2)
  })
})

describe('session shadow wiring', () => {
  function slowJudge(ms: number) {
    const base = shadowJudge()
    return {
      async judgeCentral(context: Parameters<typeof base.judgeCentral>[0]) {
        await new Promise((resolve) => setTimeout(resolve, ms))
        return base.judgeCentral(context)
      },
      async judgePersona(
        context: Parameters<typeof base.judgePersona>[0],
        persona: Parameters<typeof base.judgePersona>[1],
      ) {
        await new Promise((resolve) => setTimeout(resolve, ms))
        return base.judgePersona(context, persona)
      },
    }
  }

  it('records shadow arms without a deadline using the documented default', async () => {
    const result = await runSessionTask({
      runId: 'm3b-shadow',
      executionId: 'exec-shadow',
      task: multiPersonaTask(),
      clock: new FakeClock(0),
      provider: textProvider('Okay.'),
      wallNow: () => 0,
      currentDate: DATE,
      shadow: { judge: shadowJudge(), seed: 7 },
    })

    expect(result.shadow?.records).toHaveLength(6)
    expect(result.shadow?.records.every((record) => record.error === undefined)).toBe(true)
  })

  it('applies the requested deadline and records a timeout instead of a decision', async () => {
    const result = await runSessionTask({
      runId: 'm3b-shadow',
      executionId: 'exec-shadow',
      task: multiPersonaTask(),
      clock: new FakeClock(0),
      provider: textProvider('Okay.'),
      wallNow: () => 0,
      currentDate: DATE,
      shadow: { judge: slowJudge(40), seed: 7, deadlineMs: 1 },
    })

    const jevRecords = result.shadow?.records.filter((record) => record.arm !== 'det-central') ?? []
    expect(jevRecords.length).toBeGreaterThan(0)
    expect(
      jevRecords.every(
        (record) => (record.observation as { readonly kind?: unknown }).kind === 'timeout',
      ),
    ).toBe(true)
    expect(jevRecords.every((record) => record.agreement === null)).toBe(true)
    expect(
      jevRecords.every(
        (record) =>
          record.error ===
          'shadow policy timed out; deterministic fallback recorded for audit only',
      ),
    ).toBe(true)
  })
})

describe('buildSessionCannedEntries', () => {
  it('returns no entries for a task that is not a session task', () => {
    expect(buildSessionCannedEntries(sessionTask({ mode: 'replay' } as never), DATE)).toStrictEqual(
      [],
    )
  })

  it('returns no entries for a session task without a session block', () => {
    expect(
      buildSessionCannedEntries(sessionTask({ session: undefined } as never), DATE),
    ).toStrictEqual([])
  })

  it('refuses to fabricate a multi-persona canned replay', () => {
    const task = multiPersonaTask()

    expect(() => buildSessionCannedEntries(task, DATE)).toThrow(
      `canned session replay does not support multi-persona task ${task.id}; use the live runner`,
    )
  })

  it('refuses a session without recorded persona turns', () => {
    const base = sessionTask()
    const task = {
      ...base,
      session: { ...base.session, recordedPersonaTurns: undefined },
    } as ReturnType<typeof sessionTask>

    expect(() => buildSessionCannedEntries(task, DATE)).toThrow(
      `canned session replay for ${task.id} needs recordedPersonaTurns; refusing to fabricate persona output`,
    )
  })

  it('rejects a reply count that is too short or too long', () => {
    const base = sessionTask()
    const short = {
      ...base,
      session: { ...base.session, recordedPersonaTurns: ['one', 'two'] },
    } as ReturnType<typeof sessionTask>
    const long = {
      ...base,
      session: { ...base.session, recordedPersonaTurns: ['one', 'two', 'three', 'four'] },
    } as ReturnType<typeof sessionTask>

    expect(() => buildSessionCannedEntries(short, DATE)).toThrow(
      `task ${short.id} has 2 recorded persona replies, expected 3`,
    )
    expect(() => buildSessionCannedEntries(long, DATE)).toThrow(
      `task ${long.id} has 4 recorded persona replies, expected 3`,
    )
  })

  it('builds the greeting request and one request per scripted turn in order', () => {
    const task = sessionTask()
    const session = task.session as NonNullable<typeof task.session>
    const replies = session.recordedPersonaTurns as string[]
    const prompt = resolveSessionPrompt(task, DATE).prompt
    const metadata = { lang: 'en', locale: 'en', taskId: task.id }

    const entries = buildSessionCannedEntries(task, DATE)

    expect(entries).toHaveLength(3)
    expect(entries[0]?.request).toStrictEqual({
      provider: 'persona',
      model: 'canned/persona-v1',
      messages: [{ role: 'system', content: prompt.greetingSystemPrompt }],
      metadata,
    })
    expect(entries[0]?.chunks.join('')).toBe(replies[0])
    expect(entries[1]?.request.messages).toStrictEqual([
      { role: 'system', content: prompt.sessionSystemPrompt },
      { role: 'assistant', content: replies[0] },
      { role: 'user', content: session.scriptedUserTurns[0] },
    ])
    expect(entries[1]?.chunks.join('')).toBe(replies[1])
    expect(entries[2]?.request.messages).toStrictEqual([
      { role: 'system', content: prompt.sessionSystemPrompt },
      { role: 'assistant', content: replies[0] },
      { role: 'user', content: session.scriptedUserTurns[0] },
      { role: 'assistant', content: replies[1] },
      { role: 'user', content: session.scriptedUserTurns[1] },
    ])
    expect(entries[2]?.chunks.join('')).toBe(replies[2])
  })

  it('uses the resolved generic locale and language in a canned baseline', () => {
    const task = sessionTask({ lang: 'fr', locale: 'fr-CA', id: 'fr-ca-session-deadline-001' })

    const entries = buildSessionCannedEntries(task, DATE, 'gemma', 'generic')

    expect(entries[0]?.request.metadata).toStrictEqual({
      lang: 'fr',
      locale: 'fr-CA',
      taskId: task.id,
    })
    expect(entries[0]?.request.messages[0]?.content).toContain('Reply in French (locale fr-CA).')
  })

  it('accepts an explicit single-persona list and defaults to persona/harmony', () => {
    const base = sessionTask()
    const task = {
      ...base,
      session: { ...base.session, personaIds: ['manager'] },
    } as ReturnType<typeof sessionTask>

    expect(buildSessionCannedEntries(task, DATE)).toStrictEqual(
      buildSessionCannedEntries(task, DATE, 'harmony', 'persona'),
    )
  })
})

describe('session runner defaults and cancellation detail', () => {
  it('defaults to the Harmony prompt family for the session prompt hash', async () => {
    const defaults = await run(sessionTask(), textProvider('Okay.'))
    const explicit = await runSessionTask({
      runId: 'm2-session',
      executionId: 'exec-1',
      task: sessionTask(),
      clock: new FakeClock(0),
      provider: textProvider('Okay.'),
      wallNow: () => 0,
      currentDate: DATE,
      promptMode: 'persona',
      promptStyle: 'harmony',
    })

    expect(defaults.personaPrompts).toStrictEqual(explicit.personaPrompts)
    expect(defaults.promptHash).toBe(explicit.promptHash)
  })

  it('omits the shadow block entirely when shadow is disabled', async () => {
    const result = await run(sessionTask(), textProvider('Okay.'))

    expect('shadow' in result).toBe(false)
  })

  it('reports a timeout cancellation without a fabricated detail', async () => {
    const task = sessionTask()
    const clock = new FakeClock(0)
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'slow',
      async *complete() {
        yield { text: 'Partial', done: false }
        await clock.advance(60_001)
        yield { text: ' text. Next', done: false }
      },
    }

    const error = await runSessionTask({
      runId: 'run-timeout',
      executionId: 'exec-timeout',
      task,
      clock,
      provider,
      wallNow: () => 0,
      currentDate: DATE,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderUnavailableError)
    expect((error as Error).message).toBe(
      `session ${task.id} ended a turn with "timeout"; a failed model call is never a pass`,
    )
  })
})
