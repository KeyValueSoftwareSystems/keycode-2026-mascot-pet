/**
 * Deciding what the pet does next. Pure.
 *
 * This is original work: openpets has nothing to copy here. Its wander is a plugin picking a random
 * 2D angle, and its patrol is a fixed +/-220px alternation on a timer — neither has edge detection,
 * a pause before turning, or any playful move. Everything below is built from the rows this
 * particular sheet actually has.
 */

import type { AnimationState } from '../pet-animations.generated.js'
import { ANIMATIONS } from '../pet-animations.generated.js'
import { nextInt, nextFloat, nextChance, pickWeighted } from './rng.js'
import type { MotionConfig } from './motion-config.js'
import type { Facing, Floor, Plan } from './types.js'

export interface PlanChoice {
  plan: Plan
  animation: AnimationState
  facing: Facing
  seed: number
  /** True for a move that exists purely to look alive, so the simulation can assert variety. */
  playful: boolean
}

/** The locomotion row for a direction. Direction is a spritesheet row, never a mirror transform. */
export function runAnimationFor(facing: Facing): AnimationState {
  return facing === 'left' ? 'running-left' : 'running-right'
}

/** Jumping-jacks row for a direction. Same rule as running: a row, not a CSS flip. */
export function jumpAnimationFor(facing: Facing): AnimationState {
  return facing === 'left' ? 'jumping-left' : 'jumping-right'
}

/** Idle row for a direction. Same rule as running: a row, not a CSS flip. */
export function idleAnimationFor(facing: Facing): AnimationState {
  return facing === 'left' ? 'idle-left' : 'idle'
}

/** Thinking row for a direction. Same rule as idle: a row, not a CSS flip. */
export function reviewAnimationFor(facing: Facing): AnimationState {
  return facing === 'left' ? 'review-left' : 'review'
}

function scaled(seed: number, range: { min: number; max: number }): { value: number; seed: number } {
  const draw = nextFloat(seed)
  return { value: range.min + draw.value * (range.max - range.min), seed: draw.seed }
}

/**
 * Plan a run, choosing a direction that has room.
 *
 * Never picks a target outside the floor: clamping the *target* rather than the position is what
 * makes an edge arrival a deliberate event the planner can react to, instead of the pet grinding
 * against a wall while its plan insists it should keep going.
 */
export function planRun(
  seed: number,
  x: number,
  floor: Floor,
  config: MotionConfig,
  preferred?: Facing,
): PlanChoice {
  const distanceDraw = scaled(seed, config.runDistancePx)
  const speedDraw = scaled(distanceDraw.seed, config.runSpeedPxPerSec)

  const roomLeft = x - floor.minX
  const roomRight = floor.maxX - x

  let facing: Facing
  let workingSeed = speedDraw.seed

  if (preferred && (preferred === 'left' ? roomLeft : roomRight) > 8) {
    facing = preferred
  } else if (roomLeft < 8 && roomRight < 8) {
    // Nowhere to go — a display narrower than the pet. The caller turns this into a dwell.
    facing = preferred ?? 'right'
  } else if (roomLeft < config.runDistancePx.min) {
    facing = 'right'
  } else if (roomRight < config.runDistancePx.min) {
    facing = 'left'
  } else {
    // Bias towards the side with more room, so the pet uses the whole screen rather than
    // hovering wherever it happened to start.
    const pick = pickWeighted(workingSeed, [
      ['left' as Facing, roomLeft],
      ['right' as Facing, roomRight],
    ])
    facing = pick.value
    workingSeed = pick.seed
  }

  const direction = facing === 'left' ? -1 : 1
  const room = facing === 'left' ? roomLeft : roomRight
  const distance = Math.min(distanceDraw.value, room)
  const targetX = Math.min(floor.maxX, Math.max(floor.minX, x + direction * distance))

  const skidDraw = nextChance(workingSeed, distance > 260 ? config.skidChance : 0)

  return {
    plan: {
      kind: 'run',
      targetX,
      speedPxPerSec: speedDraw.value,
      skidOnArrival: skidDraw.value,
    },
    animation: runAnimationFor(facing),
    facing,
    seed: skidDraw.seed,
    playful: false,
  }
}

/** Stand still for a while. `state` must be a sustained animation, or it would end mid-dwell. */
export function planDwell(
  seed: number,
  now: number,
  facing: Facing,
  config: MotionConfig,
  options: { state?: AnimationState; range?: { min: number; max: number }; playful?: boolean } = {},
): PlanChoice {
  const range = options.range ?? config.dwellMs
  const draw = nextInt(seed, Math.round(range.min), Math.round(range.max))
  const requested = options.state ?? config.idleAnimation
  const state =
    requested === 'idle' || requested === 'idle-left' ? idleAnimationFor(facing) : requested
  return {
    plan: { kind: 'dwell', untilMs: now + draw.value, state },
    animation: state,
    facing,
    seed: draw.seed,
    playful: options.playful ?? false,
  }
}

/**
 * Play a one-off animation.
 *
 * A finite animation's length comes from the generated `totalMs`, so the engine's idea of when it
 * ends always matches the CSS that plays it. An infinite animation gets an explicit hold, since
 * "until it finishes" would be never.
 */
export function planAct(
  seed: number,
  now: number,
  facing: Facing,
  state: AnimationState,
  options: { holdMs?: number; driftPxPerSec?: number; playful?: boolean } = {},
): PlanChoice {
  // `running` is the in-place busy/drag alias: reuse the locomotion row for this facing, planted.
  // Do not redirect `running-left`/`running-right` — skid plays the opposite row on purpose.
  const resolved =
    state === 'running'
      ? runAnimationFor(facing)
      : state === 'review' || state === 'review-left'
        ? reviewAnimationFor(facing)
        : state
  const spec = ANIMATIONS[resolved]
  const duration = options.holdMs ?? spec.totalMs ?? 1_200
  return {
    plan: {
      kind: 'act',
      state: resolved,
      endsAt: now + duration,
      driftPxPerSec: options.driftPxPerSec ?? 0,
    },
    animation: resolved,
    facing,
    seed,
    playful: options.playful ?? false,
  }
}

/**
 * Choose the next thing to do once a plan completes.
 *
 * Weighted rather than round-robin: a fixed rotation is legible as a pattern within about a minute
 * of watching, which is exactly the thing that stops reading as alive.
 */
export function planNext(
  seed: number,
  now: number,
  x: number,
  facing: Facing,
  floor: Floor,
  config: MotionConfig,
): PlanChoice {
  if (!hasRoomToRun(x, floor)) {
    return planDwell(seed, now, facing, config)
  }

  const weights = config.idleActivityWeights
  const choice = pickWeighted(seed, [
    ['run' as const, weights.run],
    ['dwell' as const, weights.dwell],
    ['act' as const, weights.act],
  ])

  switch (choice.value) {
    case 'run':
      // Keep the current heading until the edge, so a rightward run does not flick left for a step.
      return planRun(choice.seed, x, floor, config, facing)
    case 'dwell': {
      const cycle = ANIMATIONS[idleAnimationFor(facing)].durationMs
      return planDwell(choice.seed, now, facing, config, { range: { min: cycle, max: cycle } })
    }
    case 'act': {
      const pick = nextInt(choice.seed, 0, config.idleActs.length - 1)
      const state = config.idleActs[pick.value] ?? config.idleAnimation
      return planAct(pick.seed, now, facing, state, { holdMs: pickHold(state), playful: true })
    }
  }
}

/** Idling into an in-place animation needs an explicit hold, since those states loop forever. */
function pickHold(state: AnimationState): number {
  const spec = ANIMATIONS[state]
  // One cycle, then back to moving — a second loop reads as stuck.
  return spec.totalMs ?? spec.durationMs
}

/** With movement off, stay on the on-ground sleep loop until woken. */
export function planSleepCycle(
  seed: number,
  now: number,
  facing: Facing,
  config: MotionConfig,
): PlanChoice {
  return planAct(seed, now, facing, config.sleepAnimation, {
    holdMs: Number.MAX_SAFE_INTEGER,
    playful: true,
  })
}

export function hasRoomToRun(x: number, floor: Floor): boolean {
  return floor.maxX - floor.minX > 16 && (x - floor.minX > 8 || floor.maxX - x > 8)
}
