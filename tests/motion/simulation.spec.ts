import { describe, it, expect } from 'vitest'
import { advance, initialState } from '../../apps/desktop/src/motion/motion-engine.js'
import { DEFAULT_MOTION_CONFIG, type MotionConfig } from '../../apps/desktop/src/motion/motion-config.js'
import { idleAnimationFor } from '../../apps/desktop/src/motion/run-planner.js'
import { ANIMATIONS, ANIMATION_STATES } from '../../apps/desktop/src/pet-animations.generated.js'
import type { Floor, MotionState, MotionTrigger } from '../../apps/desktop/src/motion/types.js'

/**
 * The M3 gate, second half: ten minutes of pet life, headless and deterministic.
 *
 * This is the test the whole pure-core design exists to make possible. It runs 10,000 ticks in a few
 * milliseconds and asserts the invariants that a human watching the pet for ten minutes would be
 * checking — never off the floor, never stuck, always facing the way it moves — plus the ones a
 * human could not check at all, like "the same seed produces the same life".
 */

const TICK = DEFAULT_MOTION_CONFIG.tickMs
const TEN_MINUTES_TICKS = Math.round((10 * 60 * 1_000) / TICK)

const floor: Floor = {
  minX: 100,
  maxX: 1_400,
  y: 900,
  // Mirrors a real envelope: the feet may rise until the window's top hits the work area.
  minFeetY: 304,
  maxFeetY: 900,
  displayKey: 'primary',
}

interface SimOptions {
  seed?: number
  ticks?: number
  startX?: number
  movementEnabled?: boolean
  floorAt?: (tick: number) => Floor
  triggersAt?: (tick: number) => readonly MotionTrigger[]
  config?: MotionConfig
}

interface SimResult {
  final: MotionState
  frames: Array<{ tick: number; now: number; state: MotionState }>
  animationsSeen: Set<string>
  hash: string
}

function simulate(options: SimOptions = {}): SimResult {
  const config = options.config ?? DEFAULT_MOTION_CONFIG
  const ticks = options.ticks ?? TEN_MINUTES_TICKS
  const movementEnabled = options.movementEnabled ?? true

  let state = initialState({
    seed: options.seed ?? 1,
    x: options.startX ?? 700,
    now: 0,
    movementEnabled,
    config,
  })

  const frames: SimResult['frames'] = []
  const animationsSeen = new Set<string>()
  // A cheap rolling hash over the visible outcome, so a behavioural regression shows up as a
  // one-line diff in review rather than as "the pet feels different somehow".
  let hash = 0

  for (let tick = 1; tick <= ticks; tick += 1) {
    const now = tick * TICK
    const currentFloor = options.floorAt ? options.floorAt(tick) : floor
    state = advance(
      state,
      {
        now,
        floor: currentFloor,
        settings: { movementEnabled },
        pending: options.triggersAt ? options.triggersAt(tick) : [],
      },
      config,
    )
    frames.push({ tick, now, state })
    animationsSeen.add(state.animation)
    hash = (Math.imul(hash ^ Math.round(state.x), 0x01000193) ^ state.animation.length ^ state.animationNonce) | 0
  }

  return { final: state, frames, animationsSeen, hash: (hash >>> 0).toString(16) }
}

describe('ten minutes of pet life', () => {
  const result = simulate({ seed: 42 })

  it('runs 10,000 ticks fast enough to be a normal test', () => {
    const started = performance.now()
    simulate({ seed: 99 })
    const elapsed = performance.now() - started
    expect(elapsed, `simulation took ${elapsed.toFixed(0)}ms`).toBeLessThan(500)
  })

  it('never leaves the floor', () => {
    for (const { tick, state } of result.frames) {
      expect(state.x, `tick ${tick}`).toBeGreaterThanOrEqual(floor.minX)
      expect(state.x, `tick ${tick}`).toBeLessThanOrEqual(floor.maxX)
    }
  })

  it('never drifts off the floor on its own', () => {
    // There is no gravity and nothing but a drag moves the pet vertically. If any plan ever starts
    // touching `feetY`, ten minutes of unattended running is where it would show up.
    for (const { tick, state } of result.frames) {
      expect(state.floorLocked, `tick ${tick}`).toBe(true)
      expect(state.feetY, `tick ${tick}`).toBe(floor.maxFeetY)
    }
  })

  it('only ever plays real animation states', () => {
    for (const animation of result.animationsSeen) {
      expect(ANIMATION_STATES).toContain(animation)
    }
  })

  it('never travels backwards relative to its facing', () => {
    // A pet sliding backwards is the most visible motion bug there is.
    //
    // Scoped to ticks where the plan did not change, and that exclusion is a real property of the
    // engine rather than a convenience: on the tick a plan ends, the *outgoing* plan's final drift
    // and the *incoming* plan's facing are both applied. The delta therefore belongs to the old
    // plan and the facing to the new one. That is one 60ms frame and a few pixels — imperceptible —
    // and special-casing the engine to avoid it would add a branch for a cosmetic non-issue.
    // Sustained motion is what matters, and that is exactly what this checks.
    let previous = result.frames[0]!.state
    for (const { tick, state } of result.frames.slice(1)) {
      const moved = state.x - previous.x
      const planUnchanged = state.plan === previous.plan
      previous = state
      if (!planUnchanged || Math.abs(moved) <= 0.01) continue
      expect(state.facing, `tick ${tick} moved ${moved.toFixed(2)}`).toBe(moved < 0 ? 'left' : 'right')
    }
  })

  it('plays the locomotion row that matches travel while actually running', () => {
    // Scoped to `run` plans on purpose. The skid deliberately plays the *opposite* run row while
    // still drifting forwards — a character leaning back against their own momentum, the standard
    // pixel-art idiom for stopping hard. Asserting globally would forbid it.
    let previous = result.frames[0]!.state
    for (const { tick, state } of result.frames.slice(1)) {
      const moved = state.x - previous.x
      const planUnchanged = state.plan === previous.plan
      previous = state
      if (!planUnchanged || state.plan.kind !== 'run' || Math.abs(moved) <= 0.01) continue
      expect(state.animation, `tick ${tick} moved ${moved.toFixed(2)}`).toBe(
        moved < 0 ? 'running-left' : 'running-right',
      )
    }
  })

  it('skids by playing the opposite run row while still drifting forwards', () => {
    // Off by default — the opposite-row beat reads as a mistaken one-step turnaround.
    const skidRun = simulate({
      seed: 7,
      config: {
        ...DEFAULT_MOTION_CONFIG,
        skidChance: 1,
        jumpChance: 0,
        runDistancePx: { min: 280, max: 520 },
      },
    })
    const skids = skidRun.frames.filter(
      (f, i) =>
        i > 0 &&
        f.state.plan.kind === 'act' &&
        f.state.plan.driftPxPerSec !== 0 &&
        (f.state.animation === 'running-left' || f.state.animation === 'running-right'),
    )
    expect(skids.length, 'expected at least one skid when skidChance is 1').toBeGreaterThan(0)
    for (const skid of skids) {
      const plan = skid.state.plan
      if (plan.kind !== 'act') continue
      // Drifting the way the pet is facing, while showing the opposite row.
      const expectedRow = skid.state.facing === 'left' ? 'running-right' : 'running-left'
      expect(skid.state.animation).toBe(expectedRow)
      expect(Math.sign(plan.driftPxPerSec)).toBe(skid.state.facing === 'left' ? -1 : 1)
    }
  })

  it('never sticks in one animation longer than it should last', () => {
    // "Stuck" is the failure a human notices after a minute and a test would otherwise never see.
    let run = { animation: result.frames[0]!.state.animation, nonce: result.frames[0]!.state.animationNonce, since: 0 }
    for (const { now, state } of result.frames) {
      if (state.animation !== run.animation || state.animationNonce !== run.nonce) {
        run = { animation: state.animation, nonce: state.animationNonce, since: now }
        continue
      }
      const spec = ANIMATIONS[state.animation]
      // Looping states are bounded by the longest dwell/act the config can choose; finite ones by
      // their own length. Doubled to leave room for a plan legitimately re-adopting the same state.
      const budget = (spec.totalMs ?? DEFAULT_MOTION_CONFIG.sleepSettleMs.max) * 2 + 4 * TICK
      expect(now - run.since, `${state.animation} held too long`).toBeLessThanOrEqual(budget)
    }
  })

  it('actually explores: flips direction and plays playful moves', () => {
    expect(result.final.stats.flips, 'expected edge flips').toBeGreaterThanOrEqual(2)
    expect(result.final.stats.playfulMoves, 'expected playful moves').toBeGreaterThanOrEqual(8)
    expect(result.final.stats.plansCompleted).toBeGreaterThan(20)
  })

  it('uses a good spread of the screen', () => {
    const xs = result.frames.map((f) => f.state.x)
    const span = Math.max(...xs) - Math.min(...xs)
    // A pet that only ever paces a small patch reads as broken even though nothing crashed.
    expect(span).toBeGreaterThan((floor.maxX - floor.minX) * 0.5)
  })

  it('never plays sleep or drink without being asked', () => {
    // `sleep` belongs to movement-off and `drink` to the water reminder. Seeing either during
    // ordinary play would mean the planner is picking from the wrong set.
    expect(result.animationsSeen.has('sleep')).toBe(false)
    expect(result.animationsSeen.has('drink')).toBe(false)
  })

  it('uses both locomotion rows and at least one in-place act', () => {
    expect(result.animationsSeen.has('running-left')).toBe(true)
    expect(result.animationsSeen.has('running-right')).toBe(true)
    expect(
      result.animationsSeen.has('jumping-left') || result.animationsSeen.has('jumping-right'),
      'expected a directional jumping-jacks row',
    ).toBe(true)
  })

  it('plays the jumping-jacks row that matches facing', () => {
    const jumps = result.frames.filter(
      (f) => f.state.animation === 'jumping-left' || f.state.animation === 'jumping-right',
    )
    expect(jumps.length).toBeGreaterThan(0)
    for (const jump of jumps) {
      expect(jump.state.animation).toBe(jump.state.facing === 'left' ? 'jumping-left' : 'jumping-right')
    }
  })

  it('plays the idle row that matches facing', () => {
    const idles = result.frames.filter(
      (f) => f.state.animation === 'idle' || f.state.animation === 'idle-left',
    )
    expect(idles.length).toBeGreaterThan(0)
    expect(result.animationsSeen.has('idle-left')).toBe(true)
    for (const idle of idles) {
      expect(idle.state.animation).toBe(idle.state.facing === 'left' ? 'idle-left' : 'idle')
    }
  })

  it('plays the thinking row that matches facing', () => {
    const reviews = result.frames.filter(
      (f) => f.state.animation === 'review' || f.state.animation === 'review-left',
    )
    expect(reviews.length).toBeGreaterThan(0)
    for (const review of reviews) {
      expect(review.state.animation).toBe(review.state.facing === 'left' ? 'review-left' : 'review')
    }
  })

  it('puts two idle loops between thinking poses instead of stacking thinks', () => {
    const think = new Set(['review', 'review-left'])
    const idle = new Set(['idle', 'idle-left'])
    let lastThinkEnd: (typeof result.frames)[number] | null = null
    for (let i = 0; i < result.frames.length; i += 1) {
      const frame = result.frames[i]!
      const isThink = think.has(frame.state.animation)
      const prevThink = i > 0 && think.has(result.frames[i - 1]!.state.animation)
      if (!isThink && prevThink) lastThinkEnd = result.frames[i - 1]!
      if (isThink && lastThinkEnd) {
        const gap = result.frames.slice(
          result.frames.indexOf(lastThinkEnd) + 1,
          i,
        )
        const idleMs = gap.filter((f) => idle.has(f.state.animation)).length * TICK
        expect(idleMs, 'expected two idle loops between thinks').toBeGreaterThanOrEqual(
          ANIMATIONS.idle.durationMs * 2 - TICK,
        )
        lastThinkEnd = null
      }
    }
  })
})

describe('determinism', () => {
  it('replays identically for the same seed', () => {
    expect(simulate({ seed: 42 }).hash).toBe(simulate({ seed: 42 }).hash)
  })

  it('differs for a different seed', () => {
    expect(simulate({ seed: 42 }).hash).not.toBe(simulate({ seed: 43 }).hash)
  })

  it('matches the committed golden hash', () => {
    // A behavioural regression becomes a one-line diff in review. Regenerate deliberately when the
    // change to the pet's behaviour is the intended change.
    expect(simulate({ seed: 42 }).hash).toBe('2f4e5574')
  })

  it('holds every invariant across twenty seeds', () => {
    // Guards against a single lucky seed. Shorter runs so the whole sweep stays fast.
    for (let seed = 1; seed <= 20; seed += 1) {
      const run = simulate({ seed, ticks: 3_000 })
      for (const { state } of run.frames) {
        expect(state.x, `seed ${seed}`).toBeGreaterThanOrEqual(floor.minX)
        expect(state.x, `seed ${seed}`).toBeLessThanOrEqual(floor.maxX)
        expect(ANIMATION_STATES, `seed ${seed}`).toContain(state.animation)
      }
      expect(run.final.stats.plansCompleted, `seed ${seed} made no progress`).toBeGreaterThan(3)
    }
  })
})

describe('robustness', () => {
  it('survives a three-hour suspend without teleporting', () => {
    // After a lid close the first tick's dt is hours. Unclamped, the pet would integrate across
    // several screens in a single step.
    let state = initialState({ seed: 5, x: 700, now: 0, movementEnabled: true })
    state = advance(state, { now: 60, floor, settings: { movementEnabled: true }, pending: [] })
    const before = state.x

    const threeHours = 3 * 60 * 60 * 1_000
    state = advance(state, { now: 60 + threeHours, floor, settings: { movementEnabled: true }, pending: [] })

    const maxTravel =
      (DEFAULT_MOTION_CONFIG.runSpeedPxPerSec.max * DEFAULT_MOTION_CONFIG.dtClampMs) / 1_000
    expect(Math.abs(state.x - before)).toBeLessThanOrEqual(maxTravel + 1)
    expect(state.x).toBeGreaterThanOrEqual(floor.minX)
    expect(state.x).toBeLessThanOrEqual(floor.maxX)
  })

  it('re-clamps within one tick when the floor shrinks', () => {
    // P5's monitor-unplug case, headless. The floor arrives as input every tick, so a smaller
    // display is self-correcting rather than needing its own recovery path.
    const wide: Floor = { minX: 100, maxX: 1_400, y: 900, displayKey: 'wide' }
    const narrow: Floor = { minX: 100, maxX: 400, y: 900, displayKey: 'narrow' }

    let state = initialState({ seed: 11, x: 1_300, now: 0, movementEnabled: true })
    state = advance(state, { now: 60, floor: wide, settings: { movementEnabled: true }, pending: [] })
    expect(state.x).toBeGreaterThan(narrow.maxX)

    state = advance(state, { now: 120, floor: narrow, settings: { movementEnabled: true }, pending: [] })
    expect(state.x).toBeLessThanOrEqual(narrow.maxX)
  })

  it('centres the pet on a display narrower than its own body', () => {
    const degenerate: Floor = { minX: 500, maxX: 400, y: 900, displayKey: 'tiny' }
    let state = initialState({ seed: 2, x: 0, now: 0, movementEnabled: true })
    for (let tick = 1; tick <= 50; tick += 1) {
      state = advance(state, {
        now: tick * TICK,
        floor: degenerate,
        settings: { movementEnabled: true },
        pending: [],
      })
      expect(Number.isFinite(state.x)).toBe(true)
    }
    expect(state.x).toBe(450)
  })

  it('tolerates an absurd speed config without escaping the floor', () => {
    const config: MotionConfig = {
      ...DEFAULT_MOTION_CONFIG,
      runSpeedPxPerSec: { min: 10_000, max: 10_000 },
      runDistancePx: { min: 5_000, max: 5_000 },
    }
    const run = simulate({ seed: 3, ticks: 2_000, config })
    for (const { state } of run.frames) {
      expect(state.x).toBeGreaterThanOrEqual(floor.minX)
      expect(state.x).toBeLessThanOrEqual(floor.maxX)
    }
  })

  it('ignores a backwards clock without moving or crashing', () => {
    let state = initialState({ seed: 8, x: 700, now: 10_000, movementEnabled: true })
    const before = state.x
    state = advance(state, { now: 5_000, floor, settings: { movementEnabled: true }, pending: [] })
    // dt floors at 0, so a backwards jump is a no-op rather than reverse motion.
    expect(state.x).toBe(before)
    expect(state.lastTickAt).toBe(5_000)
  })
})

describe('movement toggle', () => {
  it('abandons a run on the very next tick, without teleporting to the target', () => {
    let state = initialState({ seed: 4, x: 700, now: 0, movementEnabled: true })
    // Advance until a run is underway.
    let tick = 1
    while (state.plan.kind !== 'run' && tick < 500) {
      state = advance(state, { now: tick * TICK, floor, settings: { movementEnabled: true }, pending: [] })
      tick += 1
    }
    expect(state.plan.kind).toBe('run')
    const runTarget = state.plan.kind === 'run' ? state.plan.targetX : Number.NaN
    const xBefore = state.x

    state = advance(state, {
      now: tick * TICK,
      floor,
      settings: { movementEnabled: false },
      pending: [{ kind: 'movement-changed', enabled: false }],
    })

    expect(state.plan.kind).not.toBe('run')
    // Stops where it stands. Snapping to targetX would look like the pet was yanked.
    expect(state.x).toBe(xBefore)
    expect(state.x).not.toBe(runTarget)
    expect(state.animation === 'idle' || state.animation === 'idle-left').toBe(true)
    expect(state.animation).not.toBe('sleep-enter')
  })

  it('idles for a wind-down before lying down when movement is turned off', () => {
    let state = initialState({ seed: 4, x: 700, now: 0, movementEnabled: true })
    let tick = 1
    while (state.plan.kind !== 'run' && tick < 500) {
      state = advance(state, { now: tick * TICK, floor, settings: { movementEnabled: true }, pending: [] })
      tick += 1
    }
    const offAt = tick * TICK
    state = advance(state, {
      now: offAt,
      floor,
      settings: { movementEnabled: false },
      pending: [{ kind: 'movement-changed', enabled: false }],
    })
    expect(state.animation === 'idle' || state.animation === 'idle-left').toBe(true)

    const beforeNap = offAt + DEFAULT_MOTION_CONFIG.sleepWindDownMs.min - TICK
    state = advance(state, { now: beforeNap, floor, settings: { movementEnabled: false }, pending: [] })
    expect(state.animation).not.toBe('sleep-enter')
    expect(state.animation).not.toBe('sleep')
  })

  it('holds a nap for at least the minimum settle window', () => {
    let state = initialState({ seed: 6, x: 700, now: 0, movementEnabled: false })
    let now = 0
    while (state.animation !== 'sleep' && now < 40_000) {
      now += TICK
      state = advance(state, { now, floor, settings: { movementEnabled: false }, pending: [] })
    }
    expect(state.animation).toBe('sleep')
    const sleptAt = now
    while (state.animation === 'sleep' && now < sleptAt + 40_000) {
      now += TICK
      state = advance(state, { now, floor, settings: { movementEnabled: false }, pending: [] })
    }
    expect(now - sleptAt).toBeGreaterThanOrEqual(DEFAULT_MOTION_CONFIG.sleepSettleMs.min)
    expect(now - sleptAt).toBeLessThanOrEqual(DEFAULT_MOTION_CONFIG.sleepSettleMs.max + 4 * TICK)
  })

  it('after a nap, idles, thinks, idles, then lies down again', () => {
    let state = initialState({ seed: 6, x: 700, now: 0, movementEnabled: false })
    let now = 0
    const sequence: string[] = []
    let last = ''
    while (now < 90_000) {
      now += TICK
      state = advance(state, { now, floor, settings: { movementEnabled: false }, pending: [] })
      if (state.animation !== last) {
        sequence.push(state.animation)
        last = state.animation
      }
      const firstEnter = sequence.indexOf('sleep-enter')
      if (firstEnter !== -1 && sequence.indexOf('sleep-enter', firstEnter + 1) !== -1) break
    }
    const exitAt = sequence.indexOf('sleep-exit')
    expect(exitAt).toBeGreaterThanOrEqual(0)
    const afterWake = sequence.slice(exitAt).map((name) => name.replace('-left', ''))
    expect(afterWake.join('>')).toContain('sleep-exit>idle>review>idle>sleep-enter')
  })

  it('stays put but keeps cycling poses while movement is off', () => {
    const run = simulate({ seed: 6, ticks: 6_000, movementEnabled: false })
    const xs = run.frames.map((f) => f.state.x)
    // Exactly still: no drift at all.
    expect(new Set(xs).size).toBe(1)

    expect(run.animationsSeen.has('sleep')).toBe(true)
    expect(run.animationsSeen.has('sleep-exit')).toBe(true)
    expect(run.animationsSeen.has('drink')).toBe(false)
    expect(run.animationsSeen.has('stretch')).toBe(false)
    expect(run.animationsSeen.has('jumping-left')).toBe(false)
    expect(run.animationsSeen.has('jumping-right')).toBe(false)
    expect(
      run.animationsSeen.has('review') || run.animationsSeen.has('review-left'),
      'expected thinking in the rest cycle',
    ).toBe(true)
    const standing = ['idle', 'idle-left', 'review', 'review-left']
    expect(
      standing.some((name) => run.animationsSeen.has(name)),
      `expected a standing rest pose, saw ${[...run.animationsSeen].join(',')}`,
    ).toBe(true)
    expect(run.animationsSeen.has('running-left')).toBe(false)
    expect(run.animationsSeen.has('running-right')).toBe(false)
  })

  it('never plays a locomotion row while movement is off, over 10k ticks', () => {
    const run = simulate({ seed: 12, ticks: 10_000, movementEnabled: false })
    expect(run.animationsSeen.has('running-left')).toBe(false)
    expect(run.animationsSeen.has('running-right')).toBe(false)
    expect(run.animationsSeen.has('jumping-left')).toBe(false)
    expect(run.animationsSeen.has('jumping-right')).toBe(false)
    expect(run.animationsSeen.has('stretch')).toBe(false)
  })

  it('resumes moving when movement is switched back on', () => {
    let state = initialState({ seed: 9, x: 700, now: 0, movementEnabled: false })
    for (let tick = 1; tick <= 200; tick += 1) {
      state = advance(state, { now: tick * TICK, floor, settings: { movementEnabled: false }, pending: [] })
    }
    const stillX = state.x

    for (let tick = 201; tick <= 2_500; tick += 1) {
      state = advance(state, {
        now: tick * TICK,
        floor,
        settings: { movementEnabled: true },
        pending: tick === 201 ? [{ kind: 'movement-changed', enabled: true }] : [],
      })
    }
    expect(state.x).not.toBe(stillX)
  })
})

describe('hover', () => {
  it('freezes locomotion without swapping the current pose', () => {
    let state = initialState({ seed: 4, x: 700, now: 0, movementEnabled: true })
    let tick = 1
    while (state.plan.kind !== 'run' && tick < 500) {
      state = advance(state, { now: tick * TICK, floor, settings: { movementEnabled: true }, pending: [] })
      tick += 1
    }
    expect(state.plan.kind).toBe('run')
    const pose = state.animation
    const nonce = state.animationNonce
    const xBefore = state.x

    state = advance(state, {
      now: tick * TICK,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'hover-start' }],
    })
    expect(state.hovering).toBe(true)
    expect(state.animation).toBe(pose)
    expect(state.animationNonce).toBe(nonce)

    tick += 1
    for (let i = 0; i < 20; i += 1) {
      state = advance(state, { now: (tick + i) * TICK, floor, settings: { movementEnabled: true }, pending: [] })
    }
    expect(state.x).toBe(xBefore)
    expect(state.animation).toBe(pose)
  })

  it('stands up through sleep-exit when hovered while lying down', () => {
    let state = initialState({ seed: 22, x: 700, now: 0, movementEnabled: false })
    let now = 0
    while (state.animation !== 'sleep' && now < 30_000) {
      now += TICK
      state = advance(state, { now, floor, settings: { movementEnabled: false }, pending: [] })
    }
    expect(state.animation).toBe('sleep')
    state = advance(state, {
      now: now + TICK,
      floor,
      settings: { movementEnabled: false },
      pending: [{ kind: 'hover-start' }],
    })
    expect(state.hovering).toBe(true)
    expect(state.animation).toBe('sleep-exit')

    const wakeMs = ANIMATIONS['sleep-exit'].totalMs ?? ANIMATIONS['sleep-exit'].durationMs
    const hoverStarted = now + TICK
    now = hoverStarted
    while (now <= hoverStarted + wakeMs + 4 * TICK && state.animation === 'sleep-exit') {
      now += TICK
      state = advance(state, { now, floor, settings: { movementEnabled: false }, pending: [] })
    }
    expect(state.hovering).toBe(true)
    expect(state.animation === 'idle' || state.animation === 'idle-left').toBe(true)
  })

  it('starts dragging from sleep, so a sleeping pet can be repositioned', () => {
    let state = initialState({ seed: 24, x: 700, now: 0, movementEnabled: false })
    let now = 0
    while (state.animation !== 'sleep' && now < 30_000) {
      now += TICK
      state = advance(state, { now, floor, settings: { movementEnabled: false }, pending: [] })
    }
    expect(state.animation).toBe('sleep')
    state = advance(state, {
      now: now + TICK,
      floor,
      settings: { movementEnabled: false },
      pending: [{ kind: 'drag-start' }],
    })
    expect(state.dragging).toBe(true)
    expect(state.animation).toBe('panic')
  })

  it('does not put a sleeping pet back to sleep when a reminder bubble hides the hover menu', () => {
    let state = initialState({ seed: 21, x: 700, now: 0, movementEnabled: false })
    state = advance(state, {
      now: TICK,
      floor,
      settings: { movementEnabled: false },
      pending: [{ kind: 'hover-start' }],
    })
    expect(state.hovering).toBe(true)

    state = advance(state, {
      now: 2 * TICK,
      floor,
      settings: { movementEnabled: false },
      pending: [{ kind: 'reaction', state: 'stretch' }, { kind: 'hover-end' }],
    })
    expect(state.hovering).toBe(false)
    expect(state.animation).toBe('stretch')
  })
})

describe('drag', () => {
  it('freezes position while dragging and repositions on drop', () => {
    let state = initialState({ seed: 13, x: 700, now: 0, movementEnabled: true })
    state = advance(state, {
      now: 60,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'drag-start' }],
    })
    expect(state.dragging).toBe(true)
    expect(state.animation).toBe('panic')

    const held = state.x
    for (let tick = 2; tick <= 60; tick += 1) {
      state = advance(state, { now: tick * 60, floor, settings: { movementEnabled: true }, pending: [] })
    }
    expect(state.x).toBe(held)
    expect(state.animation).toBe('panic')

    state = advance(state, {
      now: 4_000,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'drag-end', petCentreX: 300 }],
    })
    expect(state.dragging).toBe(false)
    expect(state.x).toBe(300)
    expect(state.animation).toBe(idleAnimationFor(state.facing))
  })

  it('repositions on drop even while movement is off', () => {
    // Locked decision 7: dragging works regardless of the movement setting.
    let state = initialState({ seed: 14, x: 700, now: 0, movementEnabled: false })
    state = advance(state, {
      now: 60,
      floor,
      settings: { movementEnabled: false },
      pending: [{ kind: 'drag-start' }],
    })
    state = advance(state, {
      now: 500,
      floor,
      settings: { movementEnabled: false },
      pending: [{ kind: 'drag-end', petCentreX: 250 }],
    })
    expect(state.x).toBe(250)
  })

  it('clamps a drop outside the floor', () => {
    let state = initialState({ seed: 15, x: 700, now: 0, movementEnabled: true })
    state = advance(state, {
      now: 60,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'drag-end', petCentreX: 99_999 }],
    })
    expect(state.x).toBe(floor.maxX)
  })
})

describe('reactions', () => {
  it('holds a stretch reminder instead of napping while movement is off', () => {
    let state = initialState({ seed: 23, x: 700, now: 0, movementEnabled: false })
    state = advance(state, {
      now: TICK,
      floor,
      settings: { movementEnabled: false },
      pending: [{ kind: 'reaction', state: 'stretch', holdMs: 30_000 }],
    })
    expect(state.animation).toBe('stretch')
    for (let tick = 2; tick <= 200; tick += 1) {
      state = advance(state, {
        now: tick * TICK,
        floor,
        settings: { movementEnabled: false },
        pending: [],
      })
    }
    expect(state.animation).toBe('stretch')
  })

  it('plays electrocute when zapped', () => {
    let state = initialState({ seed: 17, x: 700, now: 0, movementEnabled: true })
    state = advance(state, {
      now: TICK,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'reaction', state: 'electrocute' }],
    })
    expect(state.animation).toBe('electrocute')
  })

  it('returns to idle after electrocute even while the pointer is still over the pet', () => {
    let state = initialState({ seed: 17, x: 700, now: 0, movementEnabled: true })
    state = advance(state, {
      now: TICK,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'hover-start' }, { kind: 'reaction', state: 'electrocute' }],
    })
    expect(state.hovering).toBe(true)
    expect(state.animation).toBe('electrocute')
    const done = TICK + (ANIMATIONS.electrocute.totalMs ?? ANIMATIONS.electrocute.durationMs) + TICK
    state = advance(state, {
      now: done,
      floor,
      settings: { movementEnabled: true },
      pending: [],
    })
    expect(state.hovering).toBe(true)
    expect(state.animation === 'idle' || state.animation === 'idle-left').toBe(true)
    expect(state.animation).not.toBe('electrocute')
  })

  it('preempts the current plan, then returns to normal life', () => {
    let state = initialState({ seed: 16, x: 700, now: 0, movementEnabled: true })
    for (let tick = 1; tick <= 40; tick += 1) {
      state = advance(state, { now: tick * TICK, floor, settings: { movementEnabled: true }, pending: [] })
    }

    const nonceBefore = state.animationNonce
    state = advance(state, {
      now: 41 * TICK,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'reaction', state: 'waving' }],
    })
    expect(state.animation).toBe('waving')
    expect(state.animationNonce).not.toBe(nonceBefore)

    const wavingEnds = ANIMATIONS.waving.totalMs!
    let tick = 42
    const deadline = 41 * TICK + wavingEnds + 4 * TICK
    while (state.animation === 'waving' && tick * TICK <= deadline) {
      state = advance(state, { now: tick * TICK, floor, settings: { movementEnabled: true }, pending: [] })
      tick += 1
    }
    expect(state.animation).not.toBe('waving')
  })

  it('flips the nonce when the same reaction fires twice, so it replays', () => {
    // Without this the renderer's animation-name would be unchanged and CSS would not restart —
    // the second wave would simply not happen.
    let state = initialState({ seed: 17, x: 700, now: 0, movementEnabled: true })
    state = advance(state, {
      now: 60,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'reaction', state: 'waving' }],
    })
    const first = state.animationNonce
    state = advance(state, {
      now: 120,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'reaction', state: 'waving' }],
    })
    expect(state.animation).toBe('waving')
    expect(state.animationNonce).not.toBe(first)
  })

  it('honours an explicit hold for a looping animation', () => {
    let state = initialState({ seed: 18, x: 700, now: 0, movementEnabled: true })
    state = advance(state, {
      now: 60,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'reaction', state: 'review', holdMs: 5_000 }],
    })
    expect(state.animationEndsAt).toBe(60 + 5_000)
  })

  it('reports animationEndsAt for finite animations and null for loops', () => {
    let state = initialState({ seed: 19, x: 700, now: 0, movementEnabled: true })
    state = advance(state, {
      now: 60,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'reaction', state: 'jumping' }],
    })
    expect(state.animation).toBe('jumping-right')
    expect(state.animationEndsAt).toBe(60 + ANIMATIONS['jumping-right'].totalMs!)
  })
})

describe('reset position', () => {
  it('moves to the requested x, clamped to the floor', () => {
    let state = initialState({ seed: 20, x: 700, now: 0, movementEnabled: true })
    state = advance(state, {
      now: 60,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'reset-position', petCentreX: 250 }],
    })
    expect(state.x).toBe(250)

    state = advance(state, {
      now: 120,
      floor,
      settings: { movementEnabled: true },
      pending: [{ kind: 'reset-position', petCentreX: -5_000 }],
    })
    expect(state.x).toBe(floor.minX)
  })
})

describe('free placement', () => {
  const step = (state: MotionState, now: number, pending: readonly MotionTrigger[] = [], f = floor) =>
    advance(state, { now, floor: f, settings: { movementEnabled: true }, pending })

  const fresh = () => initialState({ seed: 7, x: 700, now: 0, movementEnabled: true, floor })

  it('starts floor-locked, with the feet on the floor', () => {
    const state = fresh()
    expect(state.floorLocked).toBe(true)
    expect(state.feetY).toBe(floor.y)
  })

  it('keeps the pet where it was dropped, and stops re-deriving y', () => {
    let state = fresh()
    state = step(state, 60, [{ kind: 'drag-end', petCentreX: 900, feetY: 400, floorLocked: false }])
    expect(state.x).toBe(900)
    expect(state.feetY).toBe(400)
    expect(state.floorLocked).toBe(false)

    // Ten seconds of ordinary life must not pull it back down: there is no gravity.
    for (let t = 120; t <= 10_000; t += TICK) state = step(state, t)
    expect(state.feetY).toBe(400)
    expect(state.floorLocked).toBe(false)
  })

  it('patrols horizontally at the height it was left at', () => {
    let state = fresh()
    state = step(state, 60, [{ kind: 'drag-end', petCentreX: 900, feetY: 500, floorLocked: false }])
    const xs = new Set<number>()
    for (let t = 120; t <= 60_000; t += TICK) {
      state = step(state, t)
      xs.add(Math.round(state.x))
      expect(state.feetY).toBe(500)
    }
    // It is still alive — it just does it up there.
    expect(xs.size).toBeGreaterThan(50)
  })

  it('re-locks to the floor when dropped on it, snapping to the exact floor y', () => {
    let state = fresh()
    state = step(state, 60, [{ kind: 'drag-end', petCentreX: 900, feetY: 400, floorLocked: false }])
    // The host decides `floorLocked` from the drop height; a near-floor drop lands exactly on it
    // rather than a few pixels above, so "dragged it back down" does not leave a visible gap.
    state = step(state, 120, [{ kind: 'drag-end', petCentreX: 900, feetY: 890, floorLocked: true }])
    expect(state.floorLocked).toBe(true)
    expect(state.feetY).toBe(floor.y)
  })

  it('re-derives y for a floor-locked pet when the work area changes', () => {
    // The Dock-resize case. Floor-locked means the y is a derivation, so it must follow the floor.
    let state = fresh()
    const raised: Floor = { ...floor, y: 700, maxFeetY: 700 }
    state = step(state, 60, [], raised)
    expect(state.feetY).toBe(700)
  })

  it('clamps a freely placed pet into a shrunken envelope instead of following the floor', () => {
    let state = fresh()
    state = step(state, 60, [{ kind: 'drag-end', petCentreX: 900, feetY: 350, floorLocked: false }])
    // A display whose envelope no longer contains 350: clamp to the closest legal height, and do not
    // silently convert the pet back to floor-locked — the user's intent is "up high", not "on the floor".
    const shorter: Floor = { ...floor, y: 600, minFeetY: 500, maxFeetY: 600 }
    state = step(state, 120, [], shorter)
    expect(state.feetY).toBe(500)
    expect(state.floorLocked).toBe(false)
  })

  it('returns to the floor on reset-position', () => {
    let state = fresh()
    state = step(state, 60, [{ kind: 'drag-end', petCentreX: 900, feetY: 400, floorLocked: false }])
    state = step(state, 120, [{ kind: 'reset-position', petCentreX: 500 }])
    expect(state.floorLocked).toBe(true)
    expect(state.feetY).toBe(floor.y)
  })

  it('restores a saved height, and ignores null as "on the floor"', () => {
    expect(initialState({ seed: 1, x: 0, now: 0, movementEnabled: true, feetY: 450, floor }).feetY).toBe(450)
    expect(
      initialState({ seed: 1, x: 0, now: 0, movementEnabled: true, feetY: 450, floor }).floorLocked,
    ).toBe(false)
    expect(initialState({ seed: 1, x: 0, now: 0, movementEnabled: true, feetY: null, floor }).feetY).toBe(
      floor.y,
    )
    expect(
      initialState({ seed: 1, x: 0, now: 0, movementEnabled: true, feetY: null, floor }).floorLocked,
    ).toBe(true)
  })

  it('never lets a drag carry the pet outside the envelope', () => {
    let state = fresh()
    for (const feetY of [-9_999, 0, 100, 9_999]) {
      state = step(state, 60, [{ kind: 'drag-end', petCentreX: 900, feetY, floorLocked: false }])
      expect(state.feetY).toBeGreaterThanOrEqual(floor.minFeetY)
      expect(state.feetY).toBeLessThanOrEqual(floor.maxFeetY)
    }
  })
})
