/**
 * Seeded pseudo-random generator.
 *
 * One documented algorithm for the whole project (mulberry32) so a seed in a
 * run manifest reproduces the same sequence everywhere. Never use
 * `Math.random()` in engine or eval code.
 */
export interface SeededRandom {
  /** Float in [0, 1). */
  next(): number
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number
  /** True with probability `p` (default 0.5). */
  bool(p?: number): boolean
}

/** mulberry32 — small, fast, deterministic 32-bit generator. */
export function createSeededRandom(seed: number): SeededRandom {
  if (!Number.isInteger(seed)) throw new TypeError(`Seed must be an integer: ${seed}`)
  let state = seed >>> 0

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`maxExclusive must be a positive integer: ${maxExclusive}`)
      }
      return Math.floor(next() * maxExclusive)
    },
    bool(p = 0.5) {
      return next() < p
    },
  }
}
