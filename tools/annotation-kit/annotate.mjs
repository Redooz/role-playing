#!/usr/bin/env node
/**
 * Self-contained annotation CLI for a context-free agent.
 *
 *   node annotate.mjs status   [--lang en|fr]
 *   node annotate.mjs list     [--lang en|fr]
 *   node annotate.mjs next     [--lang en|fr]
 *   node annotate.mjs show     <traceId>
 *   node annotate.mjs submit   <label.json> [--complete] [--dry-run] [--allow-missing-evidence]
 *   node annotate.mjs submit-all <labels-dir> [--complete] [--dry-run]
 *   node annotate.mjs complete-all [--lang en|fr]
 *
 * Global options:
 *   --labels <dir>   label directory (default: labels)
 *   --pass <id>      annotator pass id, used in score IDs + metadata (default: config.defaultPass or p1)
 *
 * A label file is:
 * {
 *   "traceId": "...",
 *   "scores": {
 *     "persona.consistency": { "value": 5, "comment": null },
 *     "language.quality":    { "value": 4, "comment": "..." },
 *     "register.fit":        { "value": 5 },
 *     "response.clarity":    { "value": 5 },
 *     "objective.completion":{"value": 5 }
 *   },
 *   "notes": "..."
 * }
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'))

function loadEnv(path) {
  let txt
  try {
    txt = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const raw of txt.split('\n')) {
    const line = raw.replace(/^\s*export\s+/, '')
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}
loadEnv(CONFIG.envFile)

const BASE = (process.env.LANGFUSE_BASE_URL || '').replace(/\/+$/, '')
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY
if (!BASE || !PUBLIC_KEY || !SECRET_KEY)
  throw new Error('Langfuse credentials missing from ' + CONFIG.envFile)
const AUTH = 'Basic ' + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64')

const TRACES = readFileSync(join(HERE, 'traces.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const BY_TRACE = new Map(TRACES.map((t) => [t.traceId, t]))
const AXES = CONFIG.axes

function opt(argv, name, fallback) {
  const i = argv.indexOf(name)
  if (i < 0) return fallback
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} requires a value`)
  return v
}
function flag(argv, name) {
  return argv.includes(name)
}

const PASS = opt(process.argv.slice(2), '--pass', CONFIG.defaultPass ?? 'p1')
const LABELS = resolve(HERE, opt(process.argv.slice(2), '--labels', 'labels'))
mkdirSync(LABELS, { recursive: true })
const labelPath = (traceId) => join(LABELS, `${traceId}.json`)
const hasLabel = (traceId) => existsSync(labelPath(traceId))

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: AUTH,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

async function queueItems(queueId) {
  const all = []
  for (let page = 1; ; page += 1) {
    const r = await api(`/api/public/annotation-queues/${queueId}/items?limit=100&page=${page}`)
    if (r.status !== 200)
      throw new Error(`queue items ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`)
    all.push(...r.body.data)
    if (page >= (r.body.meta?.totalPages ?? 1)) break
  }
  return all
}

async function annotationScores(queueId) {
  const all = []
  let cursor
  for (;;) {
    const q = new URLSearchParams({ limit: '100', queueId, fields: 'details,subject,annotation' })
    if (cursor) q.set('cursor', cursor)
    const r = await api(`/api/public/v3/scores?${q}`)
    if (r.status !== 200)
      throw new Error(`scores ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`)
    all.push(...r.body.data)
    cursor = r.body.meta?.cursor
    if (!cursor || r.body.data.length === 0) break
  }
  const byTrace = new Map()
  for (const s of all) {
    if (s.source !== 'ANNOTATION' || s.subject?.kind !== 'trace') continue
    if (!byTrace.has(s.subject.id)) byTrace.set(s.subject.id, [])
    byTrace.get(s.subject.id).push(s)
  }
  return byTrace
}

function langFilter(argv) {
  return opt(argv, '--lang', undefined)
}

function stableUuid(seed) {
  const h = createHash('sha256').update(seed).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function normalizeScore(axis, raw, allowMissingEvidence) {
  const value = typeof raw === 'number' ? raw : raw?.value
  const comment = typeof raw === 'object' ? (raw?.comment ?? null) : null
  const evidence = typeof raw === 'object' ? (raw?.evidence ?? null) : null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 5) {
    throw new Error(`${axis}: value must be a number 1–5, got ${JSON.stringify(value)}`)
  }
  const text = [comment, evidence && JSON.stringify(evidence)].filter(Boolean).join(' | ')
  if (value <= 3 && text === '' && !allowMissingEvidence) {
    throw new Error(
      `${axis}: scores 1–3 require a comment/evidence quote (or pass --allow-missing-evidence)`,
    )
  }
  return { value, comment: text || null }
}

async function submit(file, opts) {
  const label = JSON.parse(readFileSync(file, 'utf8'))
  const trace = BY_TRACE.get(label.traceId)
  if (!trace) throw new Error(`unknown traceId ${label.traceId} (not in traces.jsonl)`)

  const keys = Object.keys(label.scores || {})
  if (keys.length !== AXES.length)
    throw new Error(`expected ${AXES.length} scores, got ${keys.length}`)
  const missing = AXES.filter((a) => label.scores[a.name] === undefined)
  if (missing.length) throw new Error(`missing axes: ${missing.map((a) => a.name).join(', ')}`)

  const submittedAt = label.submittedAt ?? new Date().toISOString()
  // Score identity is (id, name, date): a stable id + reused timestamp makes retries update, not duplicate.
  // The pass id is part of the seed so two annotator passes coexist instead of overwriting each other.
  const scores = AXES.map((a) => {
    const s = normalizeScore(a.name, label.scores[a.name], opts.allowMissingEvidence)
    return {
      id: stableUuid(`${trace.traceId}:${a.name}:${PASS}`),
      traceId: trace.traceId,
      name: a.name,
      value: s.value,
      dataType: 'NUMERIC',
      configId: a.configId,
      queueId: trace.queueId,
      source: 'ANNOTATION',
      environment: 'experiment',
      timestamp: submittedAt,
      comment: s.comment,
      metadata: {
        annotator: 'agent',
        pass: PASS,
        kit: CONFIG.kit ?? 'annotation-kit-v1',
        model: process.env.ANNOTATOR_MODEL ?? 'unspecified',
      },
    }
  })

  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        { dryRun: true, traceId: trace.traceId, itemId: trace.itemId, pass: PASS, scores },
        null,
        2,
      ),
    )
    return { traceId: trace.traceId, dryRun: true }
  }

  const posted = await api('/api/public/scores', { method: 'POST', body: JSON.stringify(scores) })
  if (posted.status !== 202 && posted.status !== 207) {
    throw new Error(`POST scores ${posted.status}: ${JSON.stringify(posted.body).slice(0, 500)}`)
  }
  if (posted.status === 207 && posted.body.rejected > 0) {
    throw new Error(
      `POST scores rejected ${posted.body.rejected}: ${JSON.stringify(posted.body.errors).slice(0, 500)}`,
    )
  }

  let completed = false
  if (opts.complete) {
    const patched = await api(
      `/api/public/annotation-queues/${trace.queueId}/items/${trace.itemId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'COMPLETED' }),
      },
    )
    if (patched.status !== 200)
      throw new Error(`PATCH item ${patched.status}: ${JSON.stringify(patched.body).slice(0, 300)}`)
    completed = patched.body.status === 'COMPLETED'
  }

  const out = {
    ...label,
    submittedAt,
    pass: PASS,
    submittedBy: 'agent',
    completed,
    scoreIds: scores.map((s) => s.id),
  }
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  console.log(
    JSON.stringify({
      traceId: trace.traceId,
      lang: trace.lang,
      pass: PASS,
      scores: scores.length,
      completed,
      status: posted.status,
    }),
  )
  return out
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const lang = langFilter(argv)
  const queues = Object.entries(CONFIG.queues).filter(([l]) => !lang || l === lang)
  const local = TRACES.filter((t) => !lang || t.lang === lang)

  if (command === 'status') {
    const done = local.filter((t) => hasLabel(t.traceId)).length
    console.log(
      `local\tpass=${PASS}\tlabels=${LABELS}\tcomplete=${done}/${local.length}\tmissing=${local.length - done}`,
    )
    for (const [l, q] of queues) {
      const items = await queueItems(q.id)
      const scores = await annotationScores(q.id)
      const completed = items.filter((i) => i.status === 'COMPLETED').length
      const fully = items.filter((i) => (scores.get(i.objectId)?.length ?? 0) >= AXES.length).length
      console.log(
        `${l}\titems=${items.length}\tcompleted=${completed}\tpending=${items.length - completed}\tscores_on_trace>=5=${fully}`,
      )
    }
    return
  }

  if (command === 'list') {
    for (const t of local) {
      console.log(
        [t.lang, hasLabel(t.traceId) ? 'LABELED' : 'MISSING', t.round, t.taskId, t.traceId].join(
          '\t',
        ),
      )
    }
    return
  }

  if (command === 'next') {
    const todo = local.filter((t) => !hasLabel(t.traceId))
    if (todo.length === 0) {
      console.log(JSON.stringify({ done: true, pass: PASS, labels: LABELS }))
      return
    }
    console.log(
      JSON.stringify(
        { done: false, pass: PASS, remaining_hint: todo.length, trace: todo[0] },
        null,
        2,
      ),
    )
    return
  }

  if (command === 'show') {
    const t = BY_TRACE.get(argv[1])
    if (!t) throw new Error(`unknown traceId ${argv[1]}`)
    console.log(JSON.stringify(t, null, 2))
    return
  }

  if (command === 'submit') {
    if (!argv[1]) throw new Error('usage: submit <label.json> [--complete] [--dry-run]')
    await submit(argv[1], {
      complete: flag(argv, '--complete'),
      dryRun: flag(argv, '--dry-run'),
      allowMissingEvidence: flag(argv, '--allow-missing-evidence'),
    })
    return
  }

  if (command === 'submit-all') {
    if (!argv[1]) throw new Error('usage: submit-all <labels-dir> [--complete] [--dry-run]')
    const files = readdirSync(argv[1])
      .filter((f) => f.endsWith('.json'))
      .sort()
    let ok = 0
    const failures = []
    for (const f of files) {
      try {
        await submit(join(argv[1], f), {
          complete: flag(argv, '--complete'),
          dryRun: flag(argv, '--dry-run'),
          allowMissingEvidence: flag(argv, '--allow-missing-evidence'),
        })
        ok += 1
      } catch (e) {
        failures.push({ file: f, error: e.message })
      }
    }
    console.log(
      JSON.stringify({ pass: PASS, submitted: ok, failed: failures.length, failures }, null, 2),
    )
    if (failures.length) process.exitCode = 1
    return
  }

  if (command === 'complete-all') {
    let patched = 0
    for (const [, q] of queues) {
      const items = await queueItems(q.id)
      for (const item of items) {
        if (item.status === 'COMPLETED') continue
        const r = await api(`/api/public/annotation-queues/${q.id}/items/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'COMPLETED' }),
        })
        if (r.status !== 200)
          throw new Error(`PATCH ${item.id} ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`)
        patched += 1
      }
    }
    console.log(JSON.stringify({ completed: patched }))
    return
  }

  console.error(
    'unknown command. Use: status | list | next | show | submit | submit-all | complete-all',
  )
  process.exitCode = 2
}

main().catch((e) => {
  console.error('ERROR:', e.message)
  process.exitCode = 1
})
