#!/usr/bin/env node
/**
 * Build a self-contained annotation bundle from eval run artifacts.
 *
 * Operator-only. Reads runs, traces and annotation-queue items, and writes a
 * directory an annotator can use with no project context.
 *
 * It deliberately excludes automated scores, grades, model identity and the
 * candidate/baseline run name from the annotator bundle. The trace -> run map is
 * written separately for the operator.
 *
 * Example:
 *   node tools/annotation-kit/build-bundle.mjs \
 *     --repo . --out evals/results/annotation-kit-m2 \
 *     --run evals/results/m2-persona-scenarios-lk \
 *     --run evals/results/m2-persona-baseline-lk \
 *     --queue en=<queue-id> --queue fr=<queue-id> \
 *     --axis persona.consistency=<config-id> \
 *     --axis language.quality=<config-id> \
 *     --axis register.fit=<config-id> \
 *     --axis response.clarity=<config-id> \
 *     --axis objective.completion=<config-id>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} requires a value`)
  return v
}
function args(name) {
  const out = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== name) continue
    const v = process.argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} requires a value`)
    out.push(v)
  }
  return out
}
function pairs(specs, label) {
  return specs.map((s) => {
    const at = s.indexOf('=')
    if (at < 1) throw new Error(`${label} must be key=value, got ${s}`)
    return [s.slice(0, at), s.slice(at + 1)]
  })
}

const REPO = resolve(arg('--repo', process.cwd()))
const OUT = resolve(REPO, arg('--out', 'evals/results/annotation-kit'))
const ENV_FILE = resolve(REPO, arg('--env-file', join(REPO, '.env')))
const MANIFEST = resolve(REPO, arg('--manifest', `${OUT}-operator/manifest.json`))
const RUNS = args('--run')
const QUEUES = Object.fromEntries(
  pairs(args('--queue'), '--queue').map(([lang, id]) => [
    lang,
    { id, name: `Annotation queue — ${lang}` },
  ]),
)
const AXES = pairs(args('--axis'), '--axis')
if (RUNS.length === 0) throw new Error('provide at least one --run <evals/results/...>')
if (Object.keys(QUEUES).length === 0) throw new Error('provide at least one --queue lang=<id>')
if (AXES.length === 0) throw new Error('provide at least one --axis name=<config-id>')

function loadEnv(path) {
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/^\s*export\s+/, '')
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}
loadEnv(ENV_FILE)

const base = process.env.LANGFUSE_BASE_URL
const auth =
  'Basic ' +
  Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString(
    'base64',
  )
async function get(path) {
  const res = await fetch(base + path, { headers: { Authorization: auth } })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

const index = new Map()
for (const runSpec of RUNS) {
  const runDir = resolve(REPO, runSpec)
  const runId = basename(runDir)
  const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'))
  const lf = JSON.parse(readFileSync(join(runDir, 'langfuse.json'), 'utf8'))
  for (const [itemId, traceId] of Object.entries(lf.traceIds ?? {})) {
    const [round, lang, taskId] = itemId.split(':')
    const trial = result.trials.find(
      (t) => t.lang === lang && t.round === Number(round) && t.taskId === taskId,
    )
    if (!trial) continue
    index.set(traceId, {
      runId,
      runDir,
      itemId,
      lang,
      round: Number(round),
      taskId,
      transcriptPath: join(runDir, trial.transcriptPath),
      dataset: result.manifest.tasks.dataset,
      version: result.manifest.tasks.version,
    })
  }
}

function committedTurns(path) {
  const turns = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const rec = JSON.parse(line)
    const text = rec?.payload?.text
    if (typeof text !== 'string' || text.length === 0) continue
    if (rec.kind === 'persona.response.committed') turns.push({ speaker: 'persona', text })
    else if (rec.kind === 'user.utterance.committed') turns.push({ speaker: 'learner', text })
  }
  return turns.map((t, i) => ({ turn: i + 1, ...t }))
}

const rows = []
for (const [lang, queue] of Object.entries(QUEUES)) {
  const items = []
  for (let page = 1; ; page += 1) {
    const r = await get(`/api/public/annotation-queues/${queue.id}/items?limit=100&page=${page}`)
    items.push(...r.data)
    if (page >= (r.meta?.totalPages ?? 1)) break
  }
  for (const item of items) {
    const loc = index.get(item.objectId)
    if (!loc) throw new Error(`no local trial for trace ${item.objectId} in ${lang} queue`)
    if (loc.lang !== lang)
      throw new Error(`language mismatch for ${item.objectId}: queue ${lang}, trial ${loc.lang}`)
    const task = JSON.parse(
      readFileSync(
        join(REPO, 'evals/tasks', loc.dataset, loc.version, lang, `${loc.taskId}.json`),
        'utf8',
      ),
    )
    // Deliberately omit run id, model, automated scores and grades: blind labelling.
    rows.push({
      traceId: item.objectId,
      itemId: item.id,
      queueId: queue.id,
      lang,
      taskId: loc.taskId,
      round: loc.round,
      personaId: task.session?.personaId,
      scenarioId: task.session?.scenarioId,
      cefrBand: task.cefrBand,
      locale: task.locale ?? task.lang,
      scenarioBrief: task.content?.scenarioBrief ?? '',
      turns: committedTurns(loc.transcriptPath),
    })
  }
}

rows.sort(
  (a, b) => a.lang.localeCompare(b.lang) || a.round - b.round || a.taskId.localeCompare(b.taskId),
)

mkdirSync(OUT, { recursive: true })
mkdirSync(dirname(MANIFEST), { recursive: true })
writeFileSync(join(OUT, 'traces.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
writeFileSync(
  join(OUT, 'config.json'),
  JSON.stringify(
    {
      envFile: ENV_FILE,
      defaultPass: 'p1',
      queues: QUEUES,
      axes: AXES.map(([name, configId]) => ({ name, configId })),
    },
    null,
    2,
  ) + '\n',
)
writeFileSync(
  MANIFEST,
  JSON.stringify(
    rows.map((r) => {
      const l = index.get(r.traceId)
      return {
        traceId: r.traceId,
        lang: r.lang,
        itemId: r.itemId,
        run: l.runId,
        round: l.round,
        taskId: l.taskId,
      }
    }),
    null,
    2,
  ) + '\n',
)

const counts = rows.reduce((a, r) => ((a[r.lang] = (a[r.lang] || 0) + 1), a), {})
console.log(`wrote ${rows.length} traces to ${OUT}/traces.jsonl`, counts)
console.log(`operator manifest: ${MANIFEST}`)
