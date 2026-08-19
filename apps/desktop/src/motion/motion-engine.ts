/**
 * The motion engine. `advance(state, input) => state`, pure.
 *
 * No `Date.now()`, no `Math.random()`, no Electron, no timers. That is what lets a test simulate ten
 * minutes of pet life in a few milliseconds, deterministically, and assert that the pet never leaves
 * the floor, never sticks in a state, and always faces the way it is travelling.
 *
 * Animation completion is *state*, not a timer: `animationEndsAt` is a number the existing 60ms tick
 * compares against `now`. openpets uses a `setTimeout` of `durationMs * iterations` for this, which
 * drifts, leaks on state change, and — the real problem — cannot be exercised by a headless
 * simulation. Worst case here is up to one tick of overshoot on a held final frame, which
 * `animation-fill-mode: forwards` makes invisible.
 */

import type { AnimationState } from '../pet-animations.generated.js'
import { DEFAULT_MOTION_CONFIG, type MotionConfig } from './motion-config.js'
import { nextFloat } from './rng.js'
import {
  planNext,
  planDwell,
  planAct,
  planSleepCycle,
  runAnimationFor,
  jumpAnimationFor,
  idleAnimationFor,
  hasRoomToRun,
  type PlanChoice,
} from './run-planner.js'
import type { Facing, MotionInput, MotionState, MotionTrigger, Plan } from './types.js'

export function initialState(options: {
  seed: number
  x: number
  now: number
  movementEnabled: boolean
  /** Restored free-placement height. Omitted or null means floor-locked, which is the default. */
  feetY?: number | null
  floor?: { y: number }
  config?: MotionConfig
}): MotionState {
  const config = options.config ?? DEFAULT_MOTION_CONFIG
  const animation = config.idleAnimation
  const floorY = options.floor?.y ?? 0
  const restored = options.feetY ?? null
  const windDownMs = config.sleepWindDownMs.min
  return {
    x: options.x,
    feetY: restored ?? floorY,
    floorLocked: restored === null,
    facing: 'right',
    animation,
    animationNonce: 0,
    animationEndsAt: options.movementEnabled ? null : options.now + windDownMs,
    plan: options.movementEnabled
      ? { kind: 'dwell', untilMs: options.now, state: animation }
      : { kind: 'dwell', untilMs: options.now + windDownMs, state: animation },
    dragging: false,
    hovering: false,
    movementEnabled: options.movementEnabled,
    rngSeed: options.seed | 0,
    lastTickAt: options.now,
    stats: { flips: 0, playfulMoves: 0, plansCompleted: 0 },
  }
}

/** Apply a plan choice, flipping the nonce so the renderer restarts the animation. */
function adopt(state: MotionState, choice: PlanChoice): MotionState {
  return {
    ...state,
    plan: choice.plan,
    animation: choice.animation,
    // Flip on every adoption, not only on change: re-triggering the same state must replay, and
    // that is only possible if the animation-name the renderer selects actually changes.
    animationNonce: state.animationNonce === 0 ? 1 : 0,
    animationEndsAt: endsAtFor(choice.plan),
    facing: choice.facing,
    rngSeed: choice.seed,
    stats: {
      ...state.stats,
      playfulMoves: state.stats.playfulMoves + (choice.playful ? 1 : 0),
    },
  }
}

function endsAtFor(plan: Plan): number | null {
  if (plan.kind === 'act') return plan.endsAt
  if (plan.kind === 'dwell') return plan.untilMs
  // A run ends on arrival, not on a clock, and its animation loops — so there is nothing to time out.
  return null
}

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return (min + max) / 2
  return Math.min(max, Math.max(min, value))
}

/** `jumping` (and either directional row) plays the jacks row that matches facing. */
function directedJump(state: AnimationState, facing: Facing): AnimationState {
  if (state === 'jumping' || state === 'jumping-left' || state === 'jumping-right') {
    return jumpAnimationFor(facing)
  }
  return state
}

/** `idle` (and either directional row) plays the idle row that matches facing. */
function directedIdle(state: AnimationState, facing: Facing): AnimationState {
  if (state === 'idle' || state === 'idle-left') {
    return idleAnimationFor(facing)
  }
  return state
}

/**
 * Settle the vertical position against the envelope that arrived this tick.
 *
 * Floor-locked is *re-derived*, not clamped: that is what makes a Dock resize or a resolution change
 * move the pet automatically, the same self-correcting property `x` has. A freely placed pet is only
 * clamped, because its height is the user's intent and recomputing it would throw that away.
 */
function settleFeetY(state: MotionState, input: MotionInput): MotionState {
  const feetY = state.floorLocked
    ? input.floor.maxFeetY
    : clamp(state.feetY, input.floor.minFeetY, input.floor.maxFeetY)
  return feetY === state.feetY ? state : { ...state, feetY }
}

/** Triggers are applied in order, so the last one in a batch wins where they conflict. */
function applyTrigger(state: MotionState, trigger: MotionTrigger, input: MotionInput, config: MotionConfig): MotionState {
  switch (trigger.kind) {
    case 'reaction': {
      const choice = planAct(
        state.rngSeed,
        input.now,
        state.facing,
        directedIdle(directedJump(trigger.state, state.facing), state.facing),
        {
          ...(trigger.holdMs === undefined ? {} : { holdMs: trigger.holdMs }),
        },
      )
      return adopt(state, choice)
    }

    case 'drag-start': {
      const choice = planAct(state.rngSeed, input.now, state.facing, config.dragAnimation, {
        // Held for as long as the drag lasts; drag-end replaces it.
        holdMs: Number.MAX_SAFE_INTEGER,
      })
      return { ...adopt(state, choice), dragging: true, hovering: false }
    }

    case 'drag-end': {
      const dropped = {
        ...state,
        dragging: false,
        x: trigger.petCentreX,
        // A drop near the floor re-locks; anywhere else is a free placement the pet keeps.
        feetY: trigger.floorLocked ? input.floor.maxFeetY : trigger.feetY,
        floorLocked: trigger.floorLocked,
      }
      // Panic is only for the lift. Dropping cuts it immediately and resumes standing idle;
      // locomotion (or the movement-off rest cycle) picks up on the next completed plan.
      return adopt(
        dropped,
        planDwell(dropped.rngSeed, input.now, dropped.facing, config, {
          state: config.dropAnimation,
          range: { min: 200, max: 400 },
        }),
      )
    }

    case 'hover-start': {
      // Freeze locomotion. If the pet is lying down, play the stand-up beat instead of snapping awake.
      if (state.dragging || state.hovering) return state
      const lying =
        !state.movementEnabled &&
        (state.animation === config.sleepAnimation ||
          state.animation === config.sleepEnterAnimation)
      if (lying) {
        return {
          ...adopt(
            state,
            planAct(state.rngSeed, input.now, state.facing, config.sleepExitAnimation, {
              playful: true,
            }),
          ),
          hovering: true,
        }
      }
      return { ...state, hovering: true }
    }

    case 'hover-end': {
      if (!state.hovering) return state
      return { ...state, hovering: false }
    }

    case 'movement-changed': {
      if (trigger.enabled === state.movementEnabled) return state
      const next = { ...state, movementEnabled: trigger.enabled, hovering: false }
      if (trigger.enabled) {
        // Only the lie-down poses need the stand-up beat. Playing it from idle/think would flash
        // the sleep row for a frame.
        if (next.animation === config.sleepExitAnimation) return next
        if (
          next.animation === config.sleepAnimation ||
          next.animation === config.sleepEnterAnimation
        ) {
          return adopt(
            next,
            planAct(next.rngSeed, input.now, next.facing, config.sleepExitAnimation, { playful: true }),
          )
        }
        return adopt(
          next,
          planDwell(next.rngSeed, input.now, next.facing, config, { range: { min: 200, max: 600 } }),
        )
      }
      // Stand still first so turning movement off does not drop him onto the floor mid-stride.
      return adopt(
        next,
        planDwell(next.rngSeed, input.now, next.facing, config, { range: config.sleepWindDownMs }),
      )
    }

    case 'reset-position': {
      // Reset means the floor as well as the default x — otherwise a pet parked somewhere awkward
      // stays awkward and the menu item appears not to work.
      const moved = {
        ...state,
        x: clamp(trigger.petCentreX, input.floor.minX, input.floor.maxX),
        feetY: input.floor.maxFeetY,
        floorLocked: true,
      }
      return adopt(moved, planDwell(moved.rngSeed, input.now, moved.facing, config, { range: { min: 300, max: 900 } }))
    }
  }
}

/**
 * Advance one tick.
 *
 * Order matters: triggers first (so a drag or a toggle takes effect this tick rather than after the
 * current plan finishes), then the movement-off override, then plan integration, then an
 * unconditional clamp.
 */
export function advance(
  state: MotionState,
  input: MotionInput,
  config: MotionConfig = DEFAULT_MOTION_CONFIG,
): MotionState {
  // The clamp is the lid-close fix: an unclamped dt after a suspend is hours long and would
  // integrate the pet across three screens in a single step.
  const dt = Math.min(Math.max(input.now - state.lastTickAt, 0), config.dtClampMs) / 1_000

  let next: MotionState = { ...state, lastTickAt: input.now }

  for (const trigger of input.pending) {
    next = applyTrigger(next, trigger, input, config)
  }

  // While dragging or the hover menu is open, position freezes (main owns the cursor for drag).
  // Both axes are still clamped, so neither path can carry the pet outside the envelope.
  if (next.dragging) {
    return settleFeetY({ ...next, x: clamp(next.x, input.floor.minX, input.floor.maxX) }, input)
  }
  if (next.hovering) {
    // Freeze locomotion, not the current pose. Sleep-exit and electrocute (and any other finite
    // act) must be allowed to finish — otherwise CSS `forwards` holds the last frame forever and
    // zap cannot fire again because the shell still thinks the pet is electrocuting.
    if (next.plan.kind === 'act' && input.now >= next.plan.endsAt) {
      next = adopt(
        next,
        planDwell(next.rngSeed, input.now, next.facing, config, { range: { min: 200, max: 400 } }),
      )
    }
    return settleFeetY({ ...next, x: clamp(next.x, input.floor.minX, input.floor.maxX) }, input)
  }

  // Steady-state truth, separate from the one-shot trigger: settings may have changed without a
  // trigger ever being enqueued (a restored value, an external edit).
  if (input.settings.movementEnabled !== next.movementEnabled) {
    next = applyTrigger(next, { kind: 'movement-changed', enabled: input.settings.movementEnabled }, input, config)
  }

  if (!next.movementEnabled) {
    // Abandon a run *this tick*, with x unchanged. Not teleporting to targetX matters: the toggle
    // must stop the pet where it stands, not snap it to where it was heading.
    if (next.plan.kind === 'run') {
      next = adopt(
        next,
        planDwell(next.rngSeed, input.now, next.facing, config, { range: config.sleepWindDownMs }),
      )
    }
    return advanceInPlace(next, input, dt, config, true)
  }

  return advanceInPlace(next, input, dt, config, false)
}

function advanceInPlace(
  state: MotionState,
  input: MotionInput,
  dt: number,
  config: MotionConfig,
  asleep: boolean,
): MotionState {
  let next = state

  switch (next.plan.kind) {
    case 'run': {
      const plan = next.plan
      const direction = plan.targetX >= next.x ? 1 : -1
      const step = plan.speedPxPerSec * dt * direction
      const projected = next.x + step
      const arrived =
        direction > 0 ? projected >= plan.targetX : projected <= plan.targetX

      if (!arrived) {
        next = { ...next, x: projected }
        break
      }

      next = { ...next, x: plan.targetX, stats: { ...next.stats, plansCompleted: next.stats.plansCompleted + 1 } }

      const atEdge = plan.targetX <= input.floor.minX + 1 || plan.targetX >= input.floor.maxX - 1

      if (atEdge) {
        // Pause, *then* turn. The beat before the turn is most of what reads as noticing the wall.
        const turnTo: Facing = plan.targetX <= input.floor.minX + 1 ? 'right' : 'left'
        const turned = adopt(
          next,
          planDwell(next.rngSeed, input.now, turnTo, config, {
            range: config.edgePauseMs,
            playful: true,
          }),
        )
        // `adopt` already counted the playful move; only the flip is new here.
        next = { ...turned, stats: { ...turned.stats, flips: turned.stats.flips + 1 } }
        break
      }

      if (plan.skidOnArrival) {
        // The classic pixel-art skid, using only rows that exist: the *opposite* run row played
        // briefly while still drifting forwards.
        const opposite: Facing = next.facing === 'left' ? 'right' : 'left'
        next = adopt(
          next,
          planAct(next.rngSeed, input.now, next.facing, runAnimationFor(opposite), {
            holdMs: config.skidMs,
            driftPxPerSec: direction * plan.speedPxPerSec * config.skidDriftFactor,
            playful: true,
          }),
        )
        break
      }

      next = adopt(next, planNext(next.rngSeed, input.now, next.x, next.facing, input.floor, config, next.animation))
      break
    }

    case 'dwell': {
      if (input.now < next.plan.untilMs) break
      next = { ...next, stats: { ...next.stats, plansCompleted: next.stats.plansCompleted + 1 } }
      next = asleep
        ? adopt(next, planSleepCycle(next.rngSeed, input.now, next.facing, config, next.animation, next.plan))
        : adopt(next, planNext(next.rngSeed, input.now, next.x, next.facing, input.floor, config, next.animation))
      break
    }

    case 'act': {
      const plan = next.plan
      if (plan.driftPxPerSec !== 0) {
        next = { ...next, x: next.x + plan.driftPxPerSec * dt }
      }
      if (input.now < plan.endsAt) break
      next = { ...next, stats: { ...next.stats, plansCompleted: next.stats.plansCompleted + 1 } }
      if (asleep) {
        next = adopt(next, planSleepCycle(next.rngSeed, input.now, next.facing, config, next.animation, next.plan))
      } else {
        next = adopt(next, planNext(next.rngSeed, input.now, next.x, next.facing, input.floor, config, next.animation))
      }
      break
    }
  }

  // A jump can interrupt a run mid-stride, which is what makes traversal look playful rather than
  // mechanical. Only from a run, only when there is room, and never while asleep.
  if (!asleep && next.plan.kind === 'run' && hasRoomToRun(next.x, input.floor)) {
    const roll = nextJumpRoll(next.rngSeed, config.jumpChance, dt)
    if (roll.jump) {
      next = adopt(
        { ...next, rngSeed: roll.seed },
        planAct(roll.seed, input.now, next.facing, jumpAnimationFor(next.facing), {
          driftPxPerSec:
            (next.plan.targetX >= next.x ? 1 : -1) * next.plan.speedPxPerSec * config.jumpDriftFactor,
          playful: true,
        }),
      )
    } else {
      next = { ...next, rngSeed: roll.seed }
    }
  }

  return settleFeetY({ ...next, x: clamp(next.x, input.floor.minX, input.floor.maxX) }, input)
}

/**
 * Roll for a jump, scaled by elapsed time.
 *
 * `jumpChance` is per second, not per tick: without the dt scaling the jump rate would silently
 * depend on the tick rate, so changing `tickMs` would change the pet's personality.
 */
function nextJumpRoll(seed: number, chancePerSecond: number, dt: number): { jump: boolean; seed: number } {
  const p = 1 - Math.pow(1 - Math.min(1, Math.max(0, chancePerSecond)), Math.max(0, dt))
  const draw = nextFloat(seed)
  return { jump: draw.value < p, seed: draw.seed }
}
