import { createHash } from 'node:crypto'

/**
 * Deterministic JSON serialization with a stable key order.
 *
 * The eval contract (M0 D3) requires that replaying the same manifest twice
 * produces byte-identical normalized traces, so every value that ends up in a
 * trace or in a canned-provider cache key goes through this function.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set())
}

/** SHA-256 of the canonical JSON form of `value`, as lowercase hex. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

/** SHA-256 of a string, as lowercase hex. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalize non-finite number: ${String(value)}`)
      }
      return JSON.stringify(value)
    }
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object':
      break
    default:
      throw new TypeError(`Cannot canonicalize value of type ${typeof value}`)
  }

  const object = value as Record<string, unknown> | unknown[]
  if (seen.has(object)) throw new TypeError('Cannot canonicalize a circular structure')

  seen.add(object)
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => serialize(item, seen)).join(',')}]`
    }

    const record = object as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    const entries = keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], seen)}`)
    return `{${entries.join(',')}}`
  } finally {
    seen.delete(object)
  }
}
