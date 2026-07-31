/**
 * Seeded pseudo-randomness, threaded through state rather than held in a closure.
 *
 * `Math.random()` would make the pet's behaviour untestable — and the liveliness logic is exactly
 * the code most in need of tests, because its bugs are subtle and only visible after minutes of
 * watching. So the seed is a value in `MotionState`, every draw returns the next seed alongside its
 * result, and a ten-minute simulation replays identically every time.
 *
 * mulberry32: 32-bit integer ops only, so it produces the same sequence on every platform and
 * every Node version. Statistical quality is far beyond what picking dwell times needs.
 */

export interface Draw<T> {
  value: T
  seed: number
}

/** Advance the seed. Exported for tests that need to step without consuming a value. */
export function nextSeed(seed: number): number {
  return (seed + 0x6d2b79f5) | 0
}

/** A float in [0, 1). */
export function nextFloat(seed: number): Draw<number> {
  const next = nextSeed(seed)
  let t = next
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: next }
}

/** An integer in [min, max], both inclusive. */
export function nextInt(seed: number, min: number, max: number): Draw<number> {
  if (max < min) return { value: min, seed: nextSeed(seed) }
  const draw = nextFloat(seed)
  return { value: min + Math.floor(draw.value * (max - min + 1)), seed: draw.seed }
}

/** True with probability `p`. */
export function nextChance(seed: number, p: number): Draw<boolean> {
  const draw = nextFloat(seed)
  return { value: draw.value < p, seed: draw.seed }
}

/**
 * Pick from `[item, weight]` pairs, proportional to weight.
 *
 * Non-positive weights are skipped, so a behaviour can be switched off by setting its weight to
 * zero without restructuring the table.
 */
export function pickWeighted<T>(seed: number, items: readonly (readonly [T, number])[]): Draw<T> {
  const total = items.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0)
  if (total <= 0) {
    // Nothing is eligible. Return the first entry rather than throwing: a zeroed table is a
    // configuration choice, not a bug, and the caller has no better fallback than "do the default".
    return { value: items[0]![0], seed: nextSeed(seed) }
  }

  const draw = nextFloat(seed)
  let threshold = draw.value * total
  for (const [item, weight] of items) {
    threshold -= Math.max(0, weight)
    if (threshold < 0) return { value: item, seed: draw.seed }
  }
  return { value: items[items.length - 1]![0], seed: draw.seed }
}
