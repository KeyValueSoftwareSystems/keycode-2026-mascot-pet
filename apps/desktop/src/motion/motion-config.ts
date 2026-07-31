/**
 * Every tunable number for the pet's behaviour, in one object.
 *
 * Two reasons it lives here rather than inline. Tuning is done by *watching*, not deriving — the
 * gap between "the pet moves" and "the pet feels alive" is entirely in these numbers, and you
 * cannot reason your way to them. So they need to be adjustable in one file. And tests can inject
 * absurd values (speed 10000, zero dwell) to hammer the edge-clamping paths that normal play would
 * take hours to reach.
 */

import type { AnimationState } from '../pet-animations.generated.js'

export interface MotionConfig {
  /** Nominal tick spacing. The engine reads real elapsed time; this only sizes the dt clamp. */
  tickMs: number
  /**
   * Largest elapsed time a single tick may integrate.
   *
   * A real fix, not defensiveness: after a lid close the first tick's `now` delta is *hours*, and
   * an unclamped integration teleports the pet across three screens before anything clamps it.
   */
  dtClampMs: number

  runSpeedPxPerSec: { min: number; max: number }
  /** How far a single run goes before the pet picks something else to do. */
  runDistancePx: { min: number; max: number }

  dwellMs: { min: number; max: number }
  /**
   * The pause *before* turning around at an edge.
   *
   * Most of what separates "moves" from "alive". Without it the pet bounces off the wall like a
   * screensaver; with it, it looks like it noticed the wall.
   */
  edgePauseMs: { min: number; max: number }

  /** Chance a long run ends with a skid rather than stopping dead. */
  skidChance: number
  skidMs: number
  skidDriftFactor: number

  /** Chance a jump interrupts a run. */
  jumpChance: number
  jumpDriftFactor: number

  /** Relative weights for what to do after a plan completes. */
  idleActivityWeights: { run: number; dwell: number; act: number }
  /** In-place animations the pet may idle into. Must be sustained (infinite) states. */
  idleActs: readonly AnimationState[]

  /** Pose while being dragged. Must be a sustained state. */
  dragAnimation: AnimationState
  /** Played once on drop. Finite is fine — it is a beat, not a pose. */
  dropAnimation: AnimationState
  /** Pose when movement is switched off. */
  sleepAnimation: AnimationState
  /** Neutral standing pose. */
  idleAnimation: AnimationState

  /**
   * With movement off the pet sleeps, then drifts between in-place animations rather than staying
   * frozen — a napping pet rather than a switched-off one, while still making the toggle visible.
   */
  sleepSettleMs: { min: number; max: number }
  /** Chance an in-place cycle returns to `sleep` rather than another idle act. */
  sleepReturnChance: number
}

export const DEFAULT_MOTION_CONFIG: MotionConfig = {
  tickMs: 60,
  dtClampMs: 250,

  runSpeedPxPerSec: { min: 70, max: 130 },
  runDistancePx: { min: 140, max: 520 },

  dwellMs: { min: 900, max: 4_200 },
  edgePauseMs: { min: 260, max: 700 },

  skidChance: 0.35,
  skidMs: 200,
  skidDriftFactor: 0.35,

  jumpChance: 0.18,
  jumpDriftFactor: 0.6,

  idleActivityWeights: { run: 6, dwell: 3, act: 2 },
  // `running` here is row 7, the in-place busy loop — NOT locomotion. `review` is the
  // hand-to-chin thinking pose.
  idleActs: ['review', 'running'],

  dragAnimation: 'running',
  dropAnimation: 'jumping',
  sleepAnimation: 'sleep',
  idleAnimation: 'idle',

  sleepSettleMs: { min: 6_000, max: 14_000 },
  sleepReturnChance: 0.55,
}
