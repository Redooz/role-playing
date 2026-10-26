/**
 * M0 D8 — isolated LiveKit soak spike.
 *
 * Runs N publish/subscribe/dispose cycles against a local livekit-server and
 * records crash/handle-leak behaviour, memory slope and reconnect counts.
 *
 * This is a compatibility probe only. It is deliberately isolated: it imports
 * nothing from session-core, eval-harness or the app packages. No production
 * audio path exists in M0.
 *
 * Usage:
 *   SOAK_CYCLES=10 SOAK_CYCLE_MINUTES=20 node infra/livekit-soak/soak.ts
 *
 * Environment:
 *   LIVEKIT_URL            default ws://127.0.0.1:7880
 *   LIVEKIT_API_KEY        default devkey  (livekit-server --dev placeholder)
 *   LIVEKIT_API_SECRET     default secret
 *   SOAK_CYCLES            default 10
 *   SOAK_CYCLE_MINUTES     default 20
 *   SOAK_SAMPLE_SECONDS    default 30
 *   SOAK_OUTPUT_DIR        default evals/results/m0-livekit-soak
 */
import { createHmac } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  dispose,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackSource,
} from '@livekit/rtc-node'

/** Set by SIGINT/SIGTERM so a 200-minute run can stop between cycles. */
let stopRequested = false

const SAMPLE_RATE = 48_000
const FRAME_MS = 10
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000

interface Config {
  url: string
  apiKey: string
  apiSecret: string
  cycles: number
  cycleMs: number
  sampleMs: number
  outputDir: string
}

interface Sample {
  atMs: number
  rssBytes: number
  heapUsedBytes: number
  externalBytes: number
  activeHandles: number
  activeResources: Record<string, number>
}

interface CycleResult {
  cycle: number
  roomName: string
  startedAt: string
  durationMs: number
  published: boolean
  subscribed: boolean
  framesPublished: number
  framesReceived: number
  reconnects: number
  disconnectReasons: string[]
  doubleDisconnects: number
  error: string | null
  samples: Sample[]
  rssStartBytes: number
  rssEndBytes: number
  rssSlopeBytesPerMinute: number | null
  activeHandlesStart: number
  activeHandlesEnd: number
  lastDisposeMs: number | null
}

interface SoakReport {
  runId: string
  kind: 'm0-livekit-soak'
  startedAt: string
  finishedAt: string | null
  config: Omit<Config, 'outputDir' | 'apiSecret'>
  livekitVersion: string | null
  nodeVersion: string
  platform: string
  arch: string
  cycles: CycleResult[]
  interrupted: boolean
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${raw}`)
  }
  return value
}

function readConfig(): Config {
  return {
    url: process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:7880',
    apiKey: process.env.LIVEKIT_API_KEY ?? 'devkey',
    apiSecret: process.env.LIVEKIT_API_SECRET ?? 'secret',
    cycles: Math.floor(envNumber('SOAK_CYCLES', 10)),
    cycleMs: envNumber('SOAK_CYCLE_MINUTES', 20) * 60_000,
    sampleMs: envNumber('SOAK_SAMPLE_SECONDS', 30) * 1000,
    outputDir: resolve(process.env.SOAK_OUTPUT_DIR ?? 'evals/results/m0-livekit-soak'),
  }
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Minimal HS256 access token, so the spike needs no extra dependency. */
function signAccessToken(options: {
  apiKey: string
  apiSecret: string
  identity: string
  room: string
  canPublish: boolean
  canSubscribe: boolean
  ttlSeconds?: number
}): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    iss: options.apiKey,
    sub: options.identity,
    nbf: now - 5,
    exp: now + (options.ttlSeconds ?? 60 * 60 * 12),
    video: {
      room: options.room,
      roomJoin: true,
      canPublish: options.canPublish,
      canSubscribe: options.canSubscribe,
    },
  }
  const body = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`
  const signature = createHmac('sha256', options.apiSecret).update(body).digest('base64url')
  return `${body}.${signature}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function takeSample(startedAt: number): Sample {
  const memory = process.memoryUsage()
  const resources: Record<string, number> = {}
  for (const name of process.getActiveResourcesInfo()) {
    resources[name] = (resources[name] ?? 0) + 1
  }
  return {
    atMs: Math.round(performance.now() - startedAt),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    activeHandles: process._getActiveHandles().length,
    activeResources: resources,
  }
}

/** Least-squares slope of RSS over time, in bytes per minute. */
function rssSlope(samples: Sample[]): number | null {
  if (samples.length < 3) return null
  const xs = samples.map((sample) => sample.atMs / 60_000)
  const ys = samples.map((sample) => sample.rssBytes)
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < xs.length; index += 1) {
    const dx = (xs[index] ?? 0) - meanX
    numerator += dx * ((ys[index] ?? 0) - meanY)
    denominator += dx * dx
  }
  return denominator === 0 ? null : numerator / denominator
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function runCycle(config: Config, cycle: number, runId: string): Promise<CycleResult> {
  const roomName = `${runId}-c${String(cycle).padStart(2, '0')}`
  const startedAtWall = new Date().toISOString()
  const startedAt = performance.now()
  const samples: Sample[] = []
  let error: string | null = null
  let framesPublished = 0
  let framesReceived = 0
  let reconnects = 0
  let doubleDisconnects = 0
  const disconnectReasons: string[] = []
  let published = false
  let subscribed = false

  const publisher = new Room()
  const subscriber = new Room()
  const source = new AudioSource(SAMPLE_RATE, 1)
  const track = LocalAudioTrack.createAudioTrack('soak-audio', source)
  const readers: ReadableStreamDefaultReader<AudioFrame>[] = []
  let pumpTimer: NodeJS.Timeout | undefined
  let sampleTimer: NodeJS.Timeout | undefined

  publisher.on(RoomEvent.Reconnecting, () => {
    reconnects += 1
  })
  subscriber.on(RoomEvent.Reconnecting, () => {
    reconnects += 1
  })
  subscriber.on(RoomEvent.Disconnected, (reason) => {
    doubleDisconnects += 1
    disconnectReasons.push(String(reason))
  })

  subscriber.on(RoomEvent.TrackSubscribed, (remoteTrack) => {
    subscribed = true
    try {
      const reader = new AudioStream(remoteTrack).getReader()
      readers.push(reader)
      void (async () => {
        for (;;) {
          const { done } = await reader.read()
          if (done) break
          framesReceived += 1
        }
      })().catch(() => undefined)
    } catch {
      // A stream that cannot attach shows up as framesReceived === 0.
    }
  })

  try {
    const tokenOptions = { apiKey: config.apiKey, apiSecret: config.apiSecret, room: roomName }
    await withTimeout(
      subscriber.connect(
        config.url,
        signAccessToken({
          ...tokenOptions,
          identity: `soak-sub-${cycle}`,
          canPublish: false,
          canSubscribe: true,
        }),
      ),
      20_000,
      'subscriber connect',
    )
    await withTimeout(
      publisher.connect(
        config.url,
        signAccessToken({
          ...tokenOptions,
          identity: `soak-pub-${cycle}`,
          canPublish: true,
          canSubscribe: false,
        }),
      ),
      20_000,
      'publisher connect',
    )

    await withTimeout(
      publisher.localParticipant!.publishTrack(track, {
        source: TrackSource.SOURCE_MICROPHONE,
      }),
      20_000,
      'publishTrack',
    )
    published = true

    const frame = AudioFrame.create(SAMPLE_RATE, 1, SAMPLES_PER_FRAME)
    pumpTimer = setInterval(() => {
      void source.captureFrame(frame).catch(() => undefined)
      framesPublished += 1
    }, FRAME_MS)

    samples.push(takeSample(startedAt))
    sampleTimer = setInterval(() => {
      samples.push(takeSample(startedAt))
    }, config.sampleMs)

    const deadline = startedAt + config.cycleMs
    while (!stopRequested && performance.now() < deadline) {
      await sleep(Math.min(1000, Math.max(0, deadline - performance.now())))
    }
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
  }

  if (pumpTimer !== undefined) clearInterval(pumpTimer)
  if (sampleTimer !== undefined) clearInterval(sampleTimer)

  const disposeStarted = performance.now()
  for (const reader of readers) {
    try {
      await withTimeout(reader.cancel(), 2000, 'reader cancel')
    } catch {
      // Cancelling a closed stream is fine.
    }
  }
  try {
    await withTimeout(track.close(), 5000, 'track.close')
  } catch {
    // Closing an already-closed track is not a soak failure.
  }
  for (const room of [publisher, subscriber]) {
    try {
      await withTimeout(room.disconnect(), 5000, 'room.disconnect')
    } catch {
      // A failed disconnect is recorded through the room events instead.
    }
  }
  const lastDisposeMs = Math.round(performance.now() - disposeStarted)
  samples.push(takeSample(startedAt))

  const first = samples[0]
  const last = samples[samples.length - 1]
  return {
    cycle,
    roomName,
    startedAt: startedAtWall,
    durationMs: Math.round(performance.now() - startedAt),
    published,
    subscribed,
    framesPublished,
    framesReceived,
    reconnects,
    disconnectReasons,
    doubleDisconnects,
    error,
    samples,
    rssStartBytes: first?.rssBytes ?? 0,
    rssEndBytes: last?.rssBytes ?? 0,
    rssSlopeBytesPerMinute: rssSlope(samples),
    activeHandlesStart: first?.activeHandles ?? 0,
    activeHandlesEnd: last?.activeHandles ?? 0,
    lastDisposeMs,
  }
}

/**
 * Server version is supplied by the operator (the container has no version
 * endpoint): e.g. SOAK_SERVER_VERSION="$(docker exec rp-livekit-soak livekit-server --version)".
 */
function readServerVersion(): string | null {
  const version = process.env.SOAK_SERVER_VERSION
  return version === undefined || version === '' ? null : version.trim()
}

async function writeReport(config: Config, report: SoakReport): Promise<string> {
  await mkdir(config.outputDir, { recursive: true })
  const path = join(config.outputDir, `${report.runId}.json`)
  await writeFile(path, JSON.stringify(report, null, 2), 'utf8')
  return path
}

function summarize(report: SoakReport): string {
  const lines = report.cycles.map((cycle) => {
    const slope = cycle.rssSlopeBytesPerMinute
    const slopeMb = slope === null ? 'n/a' : `${(slope / 1024 / 1024).toFixed(2)} MB/min`
    return [
      `cycle ${cycle.cycle}:`,
      `pub=${cycle.published}`,
      `sub=${cycle.subscribed}`,
      `frames=${cycle.framesPublished}/${cycle.framesReceived}`,
      `rss=${(cycle.rssStartBytes / 1024 / 1024).toFixed(1)}→${(cycle.rssEndBytes / 1024 / 1024).toFixed(1)} MB`,
      `slope=${slopeMb}`,
      `handles=${cycle.activeHandlesStart}→${cycle.activeHandlesEnd}`,
      `dispose=${cycle.lastDisposeMs ?? 'n/a'}ms`,
      cycle.error === null ? 'ok' : `ERROR ${cycle.error}`,
    ].join(' ')
  })
  return lines.join('\n')
}

async function main(): Promise<void> {
  const config = readConfig()
  const runId = `soak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const report: SoakReport = {
    runId,
    kind: 'm0-livekit-soak',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    config: {
      url: config.url,
      apiKey: config.apiKey,
      cycles: config.cycles,
      cycleMs: config.cycleMs,
      sampleMs: config.sampleMs,
    },
    livekitVersion: readServerVersion(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cycles: [],
    interrupted: false,
  }

  const onSignal = (): void => {
    if (stopRequested) {
      // Second signal: give up writing cleanly and leave.
      process.exit(130)
    }
    stopRequested = true
    report.interrupted = true
    console.log('\ninterrupt received, finishing the current cycle and writing partial metrics')
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  console.log(
    `soak ${runId}: ${config.cycles} cycles x ${(config.cycleMs / 60_000).toFixed(1)} min, livekit ${report.livekitVersion ?? 'unknown'} at ${config.url}`,
  )

  for (let cycle = 1; cycle <= config.cycles; cycle += 1) {
    if (stopRequested) break
    process.stdout.write(`cycle ${cycle}/${config.cycles} … `)
    const result = await runCycle(config, cycle, runId)
    report.cycles.push(result)
    report.finishedAt = new Date().toISOString()
    const path = await writeReport(config, report)
    console.log(`done in ${(result.durationMs / 1000).toFixed(0)}s, writing ${path}`)
    if (stopRequested) break
    await sleep(2000)
  }

  report.finishedAt = new Date().toISOString()
  const path = await writeReport(config, report)
  console.log('\n--- summary ---')
  console.log(summarize(report))
  console.log(`\nraw metrics: ${path}`)

  // Release the rtc FFI so the process can exit after an interrupted run.
  try {
    await dispose()
  } catch {
    // Nothing left to release.
  }
}

await main()
