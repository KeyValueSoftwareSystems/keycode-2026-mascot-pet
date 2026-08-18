import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { advance, initialState } from '../../apps/desktop/src/motion/motion-engine.js'
import { DEFAULT_MOTION_CONFIG } from '../../apps/desktop/src/motion/motion-config.js'
import type { MotionInput } from '../../apps/desktop/src/motion/types.js'

/**
 * The M3 gate, first half: the motion core really is pure.
 *
 * Stated as an executable check rather than a convention, because purity is the property everything
 * else in M3 rests on. The moment `advance` reaches for a real clock or `Math.random()`, the
 * ten-minute simulation stops being possible — and the liveliness logic becomes the one part of the
 * app that cannot be tested, which is exactly backwards.
 */

const MOTION_DIR = resolve(import.meta.dirname, '..', '..', 'apps/desktop/src/motion')

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const motionFiles = readdirSync(MOTION_DIR)
  .filter((n) => n.endsWith('.ts'))
  .map((n) => join(MOTION_DIR, n))

const floor = { minX: 100, maxX: 1400, y: 900, displayKey: 'test' }

function input(now: number, overrides: Partial<MotionInput> = {}): MotionInput {
  return { now, floor, settings: { movementEnabled: true }, pending: [], ...overrides }
}

describe('motion core purity', () => {
  it('has motion source to check', () => {
    expect(motionFiles.length).toBeGreaterThanOrEqual(4)
  })

  it('reaches for no clock, no randomness, no timers and no Electron', () => {
    const forbidden = [
      /\bDate\.now\b/,
      /\bnew Date\b/,
      /\bMath\.random\b/,
      /\bperformance\.now\b/,
      /\bsetTimeout\b/,
      /\bsetInterval\b/,
      /\bprocess\./,
      /from\s+['"]electron['"]/,
      /\brequire\s*\(/,
    ]
    for (const file of motionFiles) {
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file} matches ${pattern}`).toBe(false)
      }
    }
  })

  it('does not mutate the state or input it is given', () => {
    // Deep-frozen inputs turn accidental mutation into a thrown TypeError instead of a subtle
    // aliasing bug that only shows up as the pet behaving differently on a second read.
    const state = Object.freeze({
      ...initialState({ seed: 7, x: 500, now: 0, movementEnabled: true }),
      stats: Object.freeze({ flips: 0, playfulMoves: 0, plansCompleted: 0 }),
    })
    const frozenInput = Object.freeze({
      now: 60,
      floor: Object.freeze({ ...floor }),
      settings: Object.freeze({ movementEnabled: true }),
      pending: Object.freeze([]),
    }) as MotionInput

    const before = structuredClone(state)
    const next = advance(state, frozenInput)

    expect(next).not.toBe(state)
    expect(structuredClone(state)).toEqual(before)
  })

  it('is a pure function of its arguments', () => {
    // Same inputs, same output — twice, from independent starting objects.
    const a = advance(initialState({ seed: 42, x: 300, now: 0, movementEnabled: true }), input(60))
    const b = advance(initialState({ seed: 42, x: 300, now: 0, movementEnabled: true }), input(60))
    expect(a).toEqual(b)
  })

  it('never advances the clock on its own', () => {
    const state = initialState({ seed: 1, x: 300, now: 1_000, movementEnabled: true })
    const next = advance(state, input(1_060))
    expect(next.lastTickAt).toBe(1_060)
  })
})

describe('sustained poses', () => {
  it('only uses infinite animations where a pose must hold', async () => {
    // A finite animation ends and then holds one frame. Using one as a *pose* would look like the
    // pet froze mid-gesture, so the config's pose slots must name looping states.
    const { ANIMATIONS } = await import('../../apps/desktop/src/pet-animations.generated.js')
    for (const key of ['dragAnimation', 'sleepAnimation', 'idleAnimation', 'dropAnimation'] as const) {
      const state = DEFAULT_MOTION_CONFIG[key]
      expect(ANIMATIONS[state].iterations, `${key} (${state}) must loop`).toBe('infinite')
    }
    for (const act of DEFAULT_MOTION_CONFIG.idleActs) {
      expect(ANIMATIONS[act].iterations, `idleAct ${act} must loop`).toBe('infinite')
    }
    // The sleep-enter / sleep-exit beats are deliberately finite.
    expect(ANIMATIONS[DEFAULT_MOTION_CONFIG.sleepEnterAnimation].iterations).not.toBe('infinite')
    expect(ANIMATIONS[DEFAULT_MOTION_CONFIG.sleepExitAnimation].iterations).not.toBe('infinite')
  })

  it('never uses the in-place busy loop for locomotion', () => {
    // `running` is the in-place busy alias. Wiring it to a run plan would jog in place
    // while sliding sideways; locomotion uses running-left/running-right instead.
    expect(DEFAULT_MOTION_CONFIG.dragAnimation).toBe('panic')
    expect(DEFAULT_MOTION_CONFIG.idleActs).not.toContain('running')
    const state = initialState({ seed: 3, x: 300, now: 0, movementEnabled: true })
    expect(state.animation).not.toBe('running')
  })
})
