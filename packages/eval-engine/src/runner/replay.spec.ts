import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeClock } from '@rp/shared'
import { isSessionEventName, parseTraceRecord } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { fixtureEntrySchema, type FixtureEntry } from '../fixtures/schema.js'
import { createCannedProvider } from './canned-provider.js'
import {
  ReplayError,
  buildCannedEntriesForFixture,
  chunkText,
  expectedContentClass,
  replayFixture,
} from './replay.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')

const fixturePaths = [
  'evals/fixtures/synthetic-workplace/v1/en/en-b1-report-deadline-001.json',
  'evals/fixtures/synthetic-workplace/v1/fr/fr-b1-rapport-delai-001.json',
] as const

function loadFixture(relativePath: string): FixtureEntry {
  const raw = JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as unknown
  return fixtureEntrySchema.parse(raw)
}

function cannedProviderFor(fixture: FixtureEntry) {
  return createCannedProvider(buildCannedEntriesForFixture(fixture))
}

const fixedWallNow = (): number => 1_700_000_000_000

describe('deterministic replay harness', () => {
  it.each(fixturePaths)('emits the required event sequence for %s', async (relativePath) => {
    const fixture = loadFixture(relativePath)
    const result = await replayFixture({
      runId: 'replay-test',
      fixture,
      clock: new FakeClock(0),
      provider: cannedProviderFor(fixture),
      wallNow: fixedWallNow,
    })

    for (const record of result.records) expect(() => parseTraceRecord(record)).not.toThrow()

    expect(result.records.map((record) => record.seq)).toEqual(
      result.records.map((_record, index) => index),
    )
    expect(result.records[0]?.kind).toBe('turn.granted')
    expect(result.records.at(-1)?.kind).toBe('session.completed')

    const personaTurns = fixture.content.turns.filter((turn) => turn.role === 'persona')
    const kinds = result.records.map((record) => record.kind)

    expect(kinds.filter((kind) => kind === 'turn.granted')).toHaveLength(personaTurns.length)
    expect(kinds.filter((kind) => kind === 'persona.response.started')).toHaveLength(
      personaTurns.length,
    )
    expect(kinds.filter((kind) => kind === 'persona.response.committed')).toHaveLength(
      personaTurns.length,
    )
    expect(kinds.filter((kind) => kind === 'turn.revoked')).toHaveLength(personaTurns.length)
    expect(result.providerRequests).toBe(personaTurns.length)

    const committedTexts = result.records
      .filter((record) => record.kind === 'persona.response.committed')
      .map((record) => (record.payload as { text: string }).text)
    expect(committedTexts).toEqual(personaTurns.map((turn) => turn.text))

    // Streamed chunks concatenate back to the committed response, in order.
    const chunksByGrant = new Map<string, string>()
    for (const record of result.records) {
      if (record.kind !== 'persona.response.chunk') continue
      const payload = record.payload as { grantId: string; text: string }
      chunksByGrant.set(
        payload.grantId,
        `${chunksByGrant.get(payload.grantId) ?? ''}${payload.text}`,
      )
    }
    const committedByGrant = new Map<string, string>()
    for (const record of result.records) {
      if (record.kind !== 'persona.response.committed') continue
      const payload = record.payload as { grantId: string; text: string }
      committedByGrant.set(payload.grantId, payload.text)
    }
    expect([...chunksByGrant.entries()]).toEqual([...committedByGrant.entries()])
  })

  it.each(fixturePaths)(
    'classifies content correctly and derives expiry from the clock for %s',
    async (relativePath) => {
      const fixture = loadFixture(relativePath)
      const result = await replayFixture({
        runId: 'content-class-test',
        fixture,
        clock: new FakeClock(0),
        provider: cannedProviderFor(fixture),
        wallNow: fixedWallNow,
      })

      for (const record of result.records) {
        if (!isSessionEventName(record.kind)) throw new Error(`unexpected kind ${record.kind}`)
        expect(record.contentClass).toBe(expectedContentClass(record.kind))
        if (
          [
            'user.utterance.committed',
            'persona.response.chunk',
            'persona.response.committed',
          ].includes(record.kind)
        ) {
          expect(record.contentClass).toBe('restricted')
        }
      }

      for (const record of result.records) {
        if (record.kind !== 'turn.granted') continue
        const grant = (record.payload as { grant: { expiresAt: string } }).grant
        expect(Date.parse(grant.expiresAt)).toBeGreaterThan(record.tSim)
      }
    },
  )

  it('produces byte-identical normalized traces for two identical replays', async () => {
    const fixture = loadFixture(fixturePaths[0])

    const first = await replayFixture({
      runId: 'same-run',
      fixture,
      clock: new FakeClock(0),
      provider: cannedProviderFor(fixture),
      wallNow: fixedWallNow,
    })
    const second = await replayFixture({
      runId: 'same-run',
      fixture,
      clock: new FakeClock(0),
      provider: cannedProviderFor(fixture),
      wallNow: () => fixedWallNow() + 999_999,
    })

    expect(second.jsonl).toBe(first.jsonl)
    expect(first.jsonl.endsWith('\n')).toBe(true)
  })

  it('fails hard when the grant expires before the response completes', async () => {
    const fixture = loadFixture(fixturePaths[0])

    await expect(
      replayFixture({
        runId: 'expiry-test',
        fixture,
        clock: new FakeClock(0),
        provider: cannedProviderFor(fixture),
        wallNow: fixedWallNow,
        grantTtlMs: 1,
      }),
    ).rejects.toBeInstanceOf(ReplayError)
  })
})

describe('chunkText', () => {
  it('splits on word groups and preserves the exact text', () => {
    const text = 'That works if you send me the headline numbers on Friday.'
    const chunks = chunkText(text, 3)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })

  it('falls back to one chunk when leading whitespace would be lost', () => {
    expect(chunkText(' leading space', 3)).toEqual([' leading space'])
  })
})
