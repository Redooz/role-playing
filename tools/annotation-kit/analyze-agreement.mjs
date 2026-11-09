#!/usr/bin/env node
/**
 * Compare two annotation passes.
 *
 *   node analyze-agreement.mjs --a pass-a/labels --b pass-b/labels \
 *     [--traces pass-a/traces.jsonl] [--json out.json]
 *
 * Reports exact agreement, quadratic weighted kappa (1–5) and Cohen's kappa for
 * the binary mapping (4–5 = yes, 1–3 = no), per axis and per language when a
 * traces.jsonl is supplied. Deterministic; no model call.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} requires a value`)
  return v
}

const A = arg('--a')
const B = arg('--b')
const TRACES = arg('--traces', undefined)
const JSON_OUT = arg('--json', undefined)
if (!A || !B)
  throw new Error(
    'usage: analyze-agreement.mjs --a <labels-dir> --b <labels-dir> [--traces traces.jsonl] [--json out.json]',
  )

const AXES = [
  'persona.consistency',
  'language.quality',
  'register.fit',
  'response.clarity',
  'objective.completion',
]

function load(dir) {
  const map = new Map()
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    if (!j.traceId || !j.scores) continue
    map.set(j.traceId, j)
  }
  return map
}
const a = load(A)
const b = load(B)
const common = [...a.keys()].filter((t) => b.has(t)).sort()

const langOf = new Map()
if (TRACES) {
  for (const line of readFileSync(TRACES, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const t = JSON.parse(line)
    langOf.set(t.traceId, t.lang)
  }
}

function qwk(xs, ys, k = 5) {
  const n = xs.length
  if (n === 0) return NaN
  const O = Array.from({ length: k }, () => Array(k).fill(0))
  for (let i = 0; i < n; i += 1) O[xs[i] - 1][ys[i] - 1] += 1
  const row = O.map((r) => r.reduce((x, y) => x + y, 0))
  const col = Array(k).fill(0)
  for (const r of O)
    r.forEach((v, j) => {
      col[j] += v
    })
  let obs = 0
  let exp = 0
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      const w = (i - j) ** 2 / (k - 1) ** 2
      obs += (w * O[i][j]) / n
      exp += (w * (row[i] * col[j])) / n / n
    }
  }
  return exp === 0 ? NaN : 1 - obs / exp
}

function kappa2(xs, ys) {
  const n = xs.length
  if (n === 0) return NaN
  let agree = 0
  let ax = 0
  let by = 0
  for (let i = 0; i < n; i += 1) {
    if (xs[i] === ys[i]) agree += 1
    ax += xs[i]
    by += ys[i]
  }
  const pa = ax / n
  const pb = by / n
  const pe = pa * pb + (1 - pa) * (1 - pb)
  return pe === 1 ? NaN : (agree / n - pe) / (1 - pe)
}

function fmt(x, digits = 2) {
  return Number.isFinite(x) ? x.toFixed(digits) : 'n/a'
}

function analyze(traceIds) {
  const rows = []
  for (const axis of AXES) {
    const xs = []
    const ys = []
    for (const t of traceIds) {
      const va = a.get(t).scores[axis]
      const vb = b.get(t).scores[axis]
      const x = typeof va === 'number' ? va : va?.value
      const y = typeof vb === 'number' ? vb : vb?.value
      if (typeof x === 'number' && typeof y === 'number') {
        xs.push(x)
        ys.push(y)
      }
    }
    const n = xs.length
    const exact = n ? xs.filter((x, i) => x === ys[i]).length / n : NaN
    const bx = xs.map((x) => (x >= 4 ? 1 : 0))
    const by = ys.map((y) => (y >= 4 ? 1 : 0))
    rows.push({
      axis,
      n,
      exact: fmt(exact, 3),
      qwk: fmt(qwk(xs, ys), 3),
      kappa: fmt(kappa2(bx, by), 3),
      meanA: n ? fmt(xs.reduce((x, y) => x + y, 0) / n) : 'n/a',
      meanB: n ? fmt(ys.reduce((x, y) => x + y, 0) / n) : 'n/a',
      yesA: n ? fmt(bx.reduce((x, y) => x + y, 0) / n, 3) : 'n/a',
      yesB: n ? fmt(by.reduce((x, y) => x + y, 0) / n, 3) : 'n/a',
    })
  }
  const validQ = rows.filter((r) => r.qwk !== 'n/a').map((r) => Number(r.qwk))
  const validK = rows.filter((r) => r.kappa !== 'n/a').map((r) => Number(r.kappa))
  return {
    rows,
    macroQwk: validQ.length ? validQ.reduce((x, y) => x + y, 0) / validQ.length : NaN,
    macroKappa: validK.length ? validK.reduce((x, y) => x + y, 0) / validK.length : NaN,
  }
}

const groups = new Map()
groups.set('all', common)
if (langOf.size) {
  for (const lang of [...new Set(common.map((t) => langOf.get(t)).filter(Boolean))].sort()) {
    groups.set(
      lang,
      common.filter((t) => langOf.get(t) === lang),
    )
  }
}

const out = {}
for (const [name, ids] of groups) out[name] = analyze(ids)

console.log(`pass A: ${A}\npass B: ${B}\ncommon traces: ${common.length}\n`)
for (const [name, r] of out) {
  console.log(`== ${name} (n=${groups.get(name).length}) ==`)
  console.log('axis\t\t\t n  exact  QWK   kappa  meanA  meanB  yesA  yesB')
  for (const row of r.rows) {
    console.log(
      `${row.axis.padEnd(22)} ${String(row.n).padStart(2)}  ${row.exact}  ${row.qwk}  ${row.kappa}   ${row.meanA}   ${row.meanB}   ${row.yesA}  ${row.yesB}`,
    )
  }
  console.log(`macro QWK ${fmt(r.macroQwk, 3)} | macro kappa ${fmt(r.macroKappa, 3)}\n`)
}

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        a: A,
        b: B,
        common: common.length,
        groups: Object.fromEntries(
          Object.entries(out).map(([k, v]) => [k, { ...v, traceIds: groups.get(k) }]),
        ),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`wrote ${JSON_OUT}`)
}
