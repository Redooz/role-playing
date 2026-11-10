#!/usr/bin/env node
/**
 * Compare two independent routing-label passes. Deterministic; no model calls.
 *
 * Example:
 *   node tools/annotation-kit/routing-analyze-agreement.mjs \
 *     --a /path/to/pass-a/labels --b /path/to/pass-b/labels
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseRoutingLabel, summarizeRoutingAgreement } from './routing-labels.mjs'

function arg(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) throw new Error(`${name} is required`)
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function labels(directory) {
  const root = resolve(directory)
  if (!statSync(root).isDirectory()) throw new Error(`${root} is not a directory`)
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => parseRoutingLabel(JSON.parse(readFileSync(join(root, name), 'utf8'))))
}

const summary = summarizeRoutingAgreement(labels(arg('--a')), labels(arg('--b')))
console.log(JSON.stringify(summary, null, 2))
if (summary.unmatched.length > 0) process.exitCode = 2
