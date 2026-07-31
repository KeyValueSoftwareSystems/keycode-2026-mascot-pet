/**
 * Motion types. Pure data — no Electron, no clock, no randomness.
 *
 * The whole point of this module boundary: `advance(state, input) => state` is a function of its
 * arguments, so ten minutes of pet life can be simulated headlessly in milliseconds and asserted
 * on. Every impure thing the engine needs — the time, the screen geometry, the settings, the
 * triggers — arrives as input.
 */

import type { AnimationState } from '../pet-animations.generated.js'
import type { Floor } from '../main/display-manager.js'

export type Facing = 'left' | 'right'

export type { Floor }

/** Things that happen *to* the pet, drained once each tick. */
export type MotionTrigger =
  /** Play an animation now, interrupting the current plan. */
  | { kind: 'reaction'; state: AnimationState; holdMs?: number }
  | { kind: 'drag-start' }
  | { kind: 'drag-end'; petCentreX: number }
  | { kind: 'movement-changed'; enabled: boolean }
  | { kind: 'reset-position'; petCentreX: number }

export interface MotionInput {
  /** Injected. The engine never calls Date.now(). */
  now: number
  /** Recomputed each tick, which is what makes a monitor unplug self-correcting. */
  floor: Floor
  settings: { movementEnabled: boolean }
  pending: readonly MotionTrigger[]
}

/**
 * What the pet is currently trying to do.
 *
 * `act` carries `driftPxPerSec` so a jump can move the pet horizontally while it plays — without
 * it, a jump mid-run freezes forward motion for its whole duration and reads as a stumble rather
 * than a hop over something.
 */
export type Plan =
  | { kind: 'run'; targetX: number; speedPxPerSec: number; skidOnArrival: boolean }
  | { kind: 'dwell'; untilMs: number; state: AnimationState }
  | { kind: 'act'; state: AnimationState; endsAt: number; driftPxPerSec: number }

export interface MotionStats {
  flips: number
  playfulMoves: number
  plansCompleted: number
}

export interface MotionState {
  /**
   * The pet's visible-body centre, in screen coordinates. A float on purpose: sub-pixel
   * accumulation is inherent to keeping a float, so there is no separate fractional-remainder
   * bookkeeping, and rounding happens exactly once at the setPosition boundary.
   */
  x: number
  facing: Facing
  animation: AnimationState
  /** Flipped on every animation assignment so the renderer restarts even for the same state. */
  animationNonce: 0 | 1
  /** When the current animation finishes, or null if it loops. Observed by the tick; never a timer. */
  animationEndsAt: number | null
  plan: Plan
  dragging: boolean
  movementEnabled: boolean
  rngSeed: number
  lastTickAt: number
  stats: MotionStats
}
