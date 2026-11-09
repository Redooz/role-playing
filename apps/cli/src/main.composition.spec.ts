import type * as PipelineModule from '@rp/pipeline'
import type * as SessionCoreModule from '@rp/session-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  runCli: vi.fn(async () => undefined),
  createFileSessionLog: vi.fn(),
  createDriver: vi.fn(),
  createPersonaTextModel: vi.fn(),
  createLiveKit: vi.fn(),
  createCanned: vi.fn(),
  closeInterface: vi.fn(),
  lastLogOptions: undefined as unknown,
}))

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    close: state.closeInterface,
    async *[Symbol.asyncIterator]() {
      // runCli is mocked; the loop never runs.
    },
  })),
}))

vi.mock('./cli-main.js', () => ({ runCli: state.runCli }))

vi.mock('./session-log.adapter.js', () => ({
  createFileSessionLog: state.createFileSessionLog,
}))

vi.mock('./canned-demo.adapter.js', () => ({
  createCannedDemoModel: state.createCanned,
}))

vi.mock('@rp/session-core', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionCoreModule>()
  return { ...actual, createTextSessionDriver: state.createDriver }
})

vi.mock('@rp/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof PipelineModule>()
  return {
    ...actual,
    createPersonaTextModel: state.createPersonaTextModel,
    createLiveKitInferenceTextModel: state.createLiveKit,
    createCannedDemoModel: state.createCanned,
  }
})

const { main, resolveSessionLogPath } = await import('./main.js')

const savedEnv = {
  key: process.env['LIVEKIT_API_KEY'],
  secret: process.env['LIVEKIT_API_SECRET'],
  url: process.env['LIVEKIT_INFERENCE_URL'],
}

function restoreEnv(): void {
  for (const [name, value] of [
    ['LIVEKIT_API_KEY', savedEnv.key],
    ['LIVEKIT_API_SECRET', savedEnv.secret],
    ['LIVEKIT_INFERENCE_URL', savedEnv.url],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

afterEach(() => {
  restoreEnv()
  vi.clearAllMocks()
})

function captureStreams() {
  const out: string[] = []
  const err: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk))
    return true
  })
  return {
    out: () => out.join(''),
    err: () => err.join(''),
    restore: () => {
      outSpy.mockRestore()
      errSpy.mockRestore()
    },
  }
}

function configureMocks(): void {
  state.createCanned.mockReturnValue({
    kind: 'canned',
    label: 'canned/demo',
    async *complete() {
      yield { text: '', done: true }
    },
    dispose: vi.fn(async () => undefined),
  })
  state.createLiveKit.mockImplementation((options: { model: string }) => ({
    kind: 'live',
    label: `livekit/${options.model}`,
    async *complete() {
      yield { text: '', done: true }
    },
    dispose: vi.fn(async () => undefined),
  }))
  state.createPersonaTextModel.mockImplementation((inner: unknown) => inner)
  state.createDriver.mockImplementation((options: { sessionId: string }) => ({
    sessionId: options.sessionId,
    events: (async function* () {
      yield* []
    })(),
    start: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }))
  state.createFileSessionLog.mockImplementation(async (options: unknown) => {
    state.lastLogOptions = options
    return { path: (options as { path: string }).path, append: vi.fn(async () => undefined) }
  })
}

describe('main composition root', () => {
  it('prints usage and exits without touching a provider', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(main(['--help'])).resolves.toBe(0)
      expect(io.out()).toContain('Usage:')
      expect(io.out()).toContain('--provider <canned|live>')
      expect(state.createCanned).not.toHaveBeenCalled()
    } finally {
      io.restore()
    }
  })

  it('runs the canned default path end-to-end', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(
        main(['--session-id', 'session-1', '--prompt-date', '2026-11-08']),
      ).resolves.toBe(0)
      expect(state.createCanned).toHaveBeenCalledTimes(1)
      expect(state.createLiveKit).not.toHaveBeenCalled()
      expect(state.createDriver).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          lang: 'en',
          locale: 'en',
          clockMode: 'simulated',
          personaId: 'manager',
        }),
      )
      expect(state.runCli).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: { kind: 'canned', label: 'canned/demo' },
          selection: {
            personaId: 'manager',
            personaName: 'Katherine Brooks',
            scenarioId: 'request-deadline-extension',
            locale: 'en',
          },
        }),
      )
      const header = (state.lastLogOptions as { header: Record<string, unknown> }).header
      expect(header).toMatchObject({
        type: 'session.header',
        sessionId: 'session-1',
        clockMode: 'simulated',
        lang: 'en',
        provider: 'canned/demo',
        personaId: 'manager',
        scenarioId: 'request-deadline-extension',
        locale: 'en',
      })
      expect(header).not.toHaveProperty('taskId')
      expect(header['promptVersion']).toBe('m2-prompt-gemma-v1')
      const logOptions = state.lastLogOptions as {
        path: string
        wallClock: () => number
      }
      expect(logOptions.path.endsWith('/sessions/session-1.jsonl')).toBe(true)
      expect(typeof logOptions.wallClock()).toBe('number')
      expect(state.createDriver).toHaveBeenCalledWith(
        expect.not.objectContaining({ taskId: expect.anything() }),
      )
      expect(io.err()).toBe('')
    } finally {
      io.restore()
    }
  })

  it('records a task id in the driver and log header', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(
        main(['--session-id', 's1', '--task', 'task-1', '--prompt-date', '2026-11-08']),
      ).resolves.toBe(0)
      expect(state.createDriver).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' }))
      const header = (state.lastLogOptions as { header: Record<string, unknown> }).header
      expect(header['taskId']).toBe('task-1')
    } finally {
      io.restore()
    }
  })

  it('canonicalizes locale variants and rejects a language mismatch', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(
        main([
          '--session-id',
          's1',
          '--locale',
          ' FR-ca ',
          '--lang',
          'fr',
          '--persona',
          'manager',
          '--scenario',
          'request-deadline-extension',
          '--prompt-date',
          '2026-11-08',
        ]),
      ).resolves.toBe(0)
      expect(state.createDriver).toHaveBeenCalledWith(
        expect.objectContaining({ locale: 'fr-CA', lang: 'fr' }),
      )

      await expect(main(['--session-id', 's1', '--locale', 'fr-CA', '--lang', 'en'])).resolves.toBe(
        2,
      )
      expect(io.err()).toContain('does not match --lang')
    } finally {
      io.restore()
    }
  })

  it('rejects an unsupported provider and language', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(main(['--provider', 'cloud'])).resolves.toBe(2)
      expect(io.err()).toContain('--provider must be "canned" or "live"')
      await expect(main(['--lang', 'de'])).resolves.toBe(2)
      expect(io.err()).toContain('--lang must be "en" or "fr"')
    } finally {
      io.restore()
    }
  })

  it('rejects unknown personas and scenarios', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(main(['--persona', 'unknown'])).resolves.toBe(2)
      expect(io.err()).toContain('unknown persona')
      await expect(main(['--scenario', 'unknown'])).resolves.toBe(2)
      expect(io.err()).toContain('unknown scenario')
    } finally {
      io.restore()
    }
  })

  it('validates prompt dates at both ends of the string', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      for (const date of ['2026-11-8', '2026-11-08x', 'x2026-11-08', 'today']) {
        await expect(main(['--prompt-date', date])).resolves.toBe(2)
      }
      expect(io.err()).toContain('--prompt-date must be YYYY-MM-DD')
    } finally {
      io.restore()
    }
  })

  it('rejects an empty task id and an invalid session id', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(main(['--task', '   '])).resolves.toBe(2)
      expect(io.err()).toContain('--task must not be empty')
      await expect(main(['--session-id', 'a'.repeat(129)])).resolves.toBe(2)
      expect(io.err()).toContain('--session-id must match')
    } finally {
      io.restore()
    }
  })

  it('only ellipsizes an invalid id beyond the printable bound', async () => {
    configureMocks()
    const short = captureStreams()
    try {
      await expect(main(['--session-id', '\u001b[31mevil'])).resolves.toBe(2)
      expect(short.err()).not.toContain('...')
      expect(short.err()).toContain('evil')
    } finally {
      short.restore()
    }

    const exact = captureStreams()
    try {
      const identifier = `-${'a'.repeat(79)}`
      expect(identifier).toHaveLength(80)
      await expect(main([`--session-id=${identifier}`])).resolves.toBe(2)
      expect(exact.err()).not.toContain('...')
      expect(exact.err()).toContain(identifier)
    } finally {
      exact.restore()
    }

    const long = captureStreams()
    try {
      await expect(main([`--session-id=-${'x'.repeat(100)}`])).resolves.toBe(2)
      expect(long.err()).toContain('...')
      expect(long.err()).not.toContain('x'.repeat(80))
    } finally {
      long.restore()
    }
  })

  it('reports the prompt-date error before building a prompt', async () => {
    configureMocks()
    for (const date of ['2026-11-8', '2026-11-08x', 'x2026-11-08']) {
      const io = captureStreams()
      try {
        await expect(main(['--prompt-date', date])).resolves.toBe(2)
        expect(io.err()).toContain('--prompt-date must be YYYY-MM-DD')
        expect(io.err()).not.toContain('currentDate must be a pinned')
      } finally {
        io.restore()
      }
    }
  })

  it('reports a prompt variant error from an incompatible selection', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(
        main(['--persona', 'client', '--session-id', 's1', '--prompt-date', '2026-11-08']),
      ).resolves.toBe(2)
      expect(io.err()).toContain('does not include persona "client"')
    } finally {
      io.restore()
    }
  })

  it('escapes and truncates a long rejected session id', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(main(['--session-id', `\u001b[31m${'x'.repeat(100)}`])).resolves.toBe(2)
      expect(io.err()).toContain('\\u001b')
      expect(io.err()).toContain('...')
      expect(io.err()).not.toContain('\u001b')
    } finally {
      io.restore()
    }
  })

  it('reports parse errors and bad positionals', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(main(['--unknown'])).resolves.toBe(2)
      expect(io.err()).toContain('run with --help for usage')
      expect(io.err().startsWith('error: ')).toBe(true)
      await expect(main(['positional'])).resolves.toBe(2)
    } finally {
      io.restore()
    }
  })

  it('exposes the real stdout writer to the REPL', async () => {
    configureMocks()
    state.runCli.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[0] as { io: { write(text: string): void } }
      options.io.write('streamed')
    })
    const io = captureStreams()
    try {
      await expect(main(['--session-id', 's1'])).resolves.toBe(0)
      expect(io.out()).toContain('streamed')
    } finally {
      io.restore()
    }
  })

  it('prefixes locale errors with the CLI error marker', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(main(['--locale', 'de-DE'])).resolves.toBe(2)
      expect(io.err().startsWith('error: ')).toBe(true)
    } finally {
      io.restore()
    }
  })

  it('omits the task id property entirely when no task is given', async () => {
    configureMocks()
    const io = captureStreams()
    try {
      await expect(main(['--session-id', 's1'])).resolves.toBe(0)
      const options = state.createDriver.mock.calls.at(-1)?.[0] as Record<string, unknown>
      expect(options).not.toHaveProperty('taskId')
    } finally {
      io.restore()
    }
  })

  it('rejects a session log creation failure and still disposes the model', async () => {
    configureMocks()
    state.createFileSessionLog.mockRejectedValueOnce(new Error('disk full'))
    const io = captureStreams()
    try {
      await expect(main(['--session-id', 's1'])).resolves.toBe(2)
      expect(io.err()).toContain('could not create the session log: disk full')
      expect(state.createCanned).toHaveBeenCalled()
    } finally {
      io.restore()
    }
  })

  it('returns 1 when the REPL throws and disposes the model once', async () => {
    configureMocks()
    state.runCli.mockRejectedValueOnce(new Error('repl failed'))
    const io = captureStreams()
    try {
      await expect(main(['--session-id', 's1'])).resolves.toBe(1)
      expect(io.err()).toContain('repl failed')
      expect(state.closeInterface).toHaveBeenCalled()
    } finally {
      io.restore()
    }
  })

  it('reports a model dispose failure without turning it into a crash', async () => {
    configureMocks()
    state.createCanned.mockReturnValueOnce({
      kind: 'canned',
      label: 'canned/demo',
      async *complete() {
        yield { text: '', done: true }
      },
      dispose: vi.fn(async () => {
        throw new Error('release failed')
      }),
    })
    const io = captureStreams()
    try {
      await expect(main(['--session-id', 's1'])).resolves.toBe(0)
      expect(io.err()).toContain('could not release the model: release failed')
    } finally {
      io.restore()
    }
  })

  it('supports a model without a dispose method', async () => {
    configureMocks()
    state.createCanned.mockReturnValueOnce({
      kind: 'canned',
      label: 'canned/demo',
      async *complete() {
        yield { text: '', done: true }
      },
    })
    const io = captureStreams()
    try {
      await expect(main(['--session-id', 's1'])).resolves.toBe(0)
      expect(io.err()).toBe('')
    } finally {
      io.restore()
    }
  })

  it('starts live mode with the default base URL', async () => {
    configureMocks()
    process.env['LIVEKIT_API_KEY'] = 'key'
    process.env['LIVEKIT_API_SECRET'] = 'secret'
    delete process.env['LIVEKIT_INFERENCE_URL']
    const io = captureStreams()
    try {
      await expect(
        main([
          '--provider',
          'live',
          '--session-id',
          's1',
          '--persona',
          'client',
          '--scenario',
          'decline-meeting-invitation',
          '--prompt-date',
          '2026-11-08',
        ]),
      ).resolves.toBe(0)
      expect(state.createLiveKit).toHaveBeenCalledWith({
        apiKey: 'key',
        apiSecret: 'secret',
        model: 'google/gemma-4-31b-it',
        baseUrl: 'https://agent-gateway.livekit.cloud/v1',
      })
      expect(state.createDriver).toHaveBeenCalledWith(
        expect.objectContaining({ clockMode: 'wall' }),
      )
      expect(state.runCli).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: { kind: 'live', label: 'livekit/google/gemma-4-31b-it' },
        }),
      )
    } finally {
      io.restore()
    }
  })

  it('uses a trimmed LIVEKIT_INFERENCE_URL when it is set', async () => {
    configureMocks()
    process.env['LIVEKIT_API_KEY'] = 'key'
    process.env['LIVEKIT_API_SECRET'] = 'secret'
    process.env['LIVEKIT_INFERENCE_URL'] = '  https://proxy.test/v1  '
    const io = captureStreams()
    try {
      await expect(
        main([
          '--provider',
          'live',
          '--session-id',
          's1',
          '--persona',
          'manager',
          '--scenario',
          'request-deadline-extension',
          '--prompt-date',
          '2026-11-08',
        ]),
      ).resolves.toBe(0)
      expect(state.createLiveKit).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://proxy.test/v1' }),
      )
    } finally {
      io.restore()
    }
  })

  it('treats an empty or whitespace inference URL as unset', async () => {
    configureMocks()
    process.env['LIVEKIT_API_KEY'] = 'key'
    process.env['LIVEKIT_API_SECRET'] = 'secret'
    for (const url of ['', '   ']) {
      process.env['LIVEKIT_INFERENCE_URL'] = url
      state.createLiveKit.mockClear()
      const io = captureStreams()
      try {
        await expect(
          main([
            '--provider',
            'live',
            '--session-id',
            's1',
            '--persona',
            'manager',
            '--scenario',
            'request-deadline-extension',
            '--prompt-date',
            '2026-11-08',
          ]),
        ).resolves.toBe(0)
        expect(state.createLiveKit).toHaveBeenCalledWith({
          apiKey: 'key',
          apiSecret: 'secret',
          model: 'google/gemma-4-31b-it',
          baseUrl: 'https://agent-gateway.livekit.cloud/v1',
        })
      } finally {
        io.restore()
      }
    }
  })

  it.each([
    ['missing key', undefined, 'secret'],
    ['empty key', '', 'secret'],
    ['blank key', '   ', 'secret'],
    ['missing secret', 'key', undefined],
    ['empty secret', 'key', ''],
    ['blank secret', 'key', '   '],
  ])('rejects live mode with %s', async (_name, key, secret) => {
    configureMocks()
    if (key === undefined) delete process.env['LIVEKIT_API_KEY']
    else process.env['LIVEKIT_API_KEY'] = key
    if (secret === undefined) delete process.env['LIVEKIT_API_SECRET']
    else process.env['LIVEKIT_API_SECRET'] = secret
    const io = captureStreams()
    try {
      await expect(
        main([
          '--provider',
          'live',
          '--session-id',
          's1',
          '--persona',
          'manager',
          '--scenario',
          'request-deadline-extension',
          '--prompt-date',
          '2026-11-08',
        ]),
      ).resolves.toBe(2)
      expect(io.err()).toContain('LIVEKIT_API_KEY and LIVEKIT_API_SECRET')
    } finally {
      io.restore()
    }
  })

  it('requires explicit persona and scenario in live mode', async () => {
    configureMocks()
    process.env['LIVEKIT_API_KEY'] = 'key'
    process.env['LIVEKIT_API_SECRET'] = 'secret'
    const io = captureStreams()
    try {
      await expect(main(['--provider', 'live', '--session-id', 's1'])).resolves.toBe(2)
      expect(io.err()).toContain('live mode requires --persona')
      await expect(
        main(['--provider', 'live', '--session-id', 's1', '--persona', 'manager']),
      ).resolves.toBe(2)
      expect(io.err()).toContain('live mode requires --scenario')
    } finally {
      io.restore()
    }
  })

  it('makes the interface terminal flag follow process.stdin', async () => {
    configureMocks()
    const { createInterface } = await import('node:readline/promises')
    const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const io = captureStreams()
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
      await main(['--session-id', 's1'])
      expect(createInterface).toHaveBeenCalledWith(expect.objectContaining({ terminal: true }))
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined })
      await main(['--session-id', 's1'])
      expect(createInterface).toHaveBeenLastCalledWith(expect.objectContaining({ terminal: false }))
    } finally {
      if (original === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY
      else Object.defineProperty(process.stdin, 'isTTY', original)
      io.restore()
    }
  })

  it('resolves a log path inside the log directory', () => {
    expect(resolveSessionLogPath('/tmp/sessions', 's1')).toBe('/tmp/sessions/s1.jsonl')
    expect(() => resolveSessionLogPath('/tmp/sessions', '../escape')).toThrow(/invalid session/)
  })
})
