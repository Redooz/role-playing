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
import {
  agreementFailures,
  parseRoutingLabel,
  summarizeRoutingAgreement,
} from './routing-labels.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) {
    if (fallback !== undefined) return fallback
    throw new Error(`${name} is required`)
  }
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

const minimum = Number(arg('--min', '0.8'))
if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) {
  throw new Error('--min must be a number in [0, 1]')
}

const summary = summarizeRoutingAgreement(labels(arg('--a')), labels(arg('--b')))
console.log(JSON.stringify(summary, null, 2))
if (summary.unmatched.length > 0) {
  console.error(`unmatched case ids: ${summary.unmatched.join(', ')}`)
  process.exitCode = 2
}
const failures = agreementFailures(summary, minimum)
if (failures.length > 0) {
  console.error(`agreement below ${minimum}: ${failures.join('; ')}`)
  process.exitCode = 3
}
