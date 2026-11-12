/**
 * Small helpers shared by the single- and multi-persona streaming loops.
 *
 * They are transport bookkeeping, not session policy: a bounded provider close
 * and a sanitized one-line failure cause.
 */

export const MAX_ITERATOR_CLOSE_MS = 1_000

/** Resolve when `promise` settles or after `ms`, whichever happens first. */
export async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })

  try {
    await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** A bounded, single-line cause for a failed model call; never a raw provider body. */
export function describeModelError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  const text = `${name}: ${message}`.replace(/\s+/g, ' ').trim()
  return text.length > 200 ? `${text.slice(0, 197)}...` : text
}
