import { describe, it, expect } from 'vitest'
import {
  petFrameSchema,
  frameNeedsCellRegion,
  type PetFrame,
} from '../../apps/desktop/src/pet-frame.js'

function frame(overrides: Partial<PetFrame> = {}): PetFrame {
  return {
    animation: 'idle',
    animationNonce: 0,
    facing: 'right',
    sprite: { x: 0, y: 0 },
    bubbleSide: 'above',
    scale: 1,
    bubble: null,
    quickActions: [],
    overlay: 'none',
    claudeState: 'none',
    ...overrides,
  }
}

describe('claudeState on the frame', () => {
  it.each(['none', 'waiting', 'running', 'idle'] as const)('round-trips %s', (state) => {
    const parsed = petFrameSchema.safeParse(frame({ claudeState: state }))
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.claudeState).toBe(state)
  })

  it('rejects a state the renderer has no colour for', () => {
    expect(petFrameSchema.safeParse(frame({ claudeState: 'busy' as never })).success).toBe(false)
  })

  it('is required, so no frame can reach the renderer without one', () => {
    const { claudeState: _dropped, ...without } = frame()
    expect(petFrameSchema.safeParse(without).success).toBe(false)
  })
})

describe('frameNeedsCellRegion', () => {
  // Electron's setShape decides where the system permits *drawing*, not just where clicks land.
  // Anything outside the region is never painted. The cap sits over the hair, which is
  // transparent in the alpha mask, so without this it would be invisible on Linux — and the
  // screenshot harness would not catch it, because capturePage() ignores the window shape.
  it('is false for a plain frame', () => {
    expect(frameNeedsCellRegion(frame())).toBe(false)
  })

  it('is true while the sleep Z-s are up', () => {
    expect(frameNeedsCellRegion(frame({ overlay: 'sleep-z' }))).toBe(true)
  })

  it.each(['waiting', 'running', 'idle'] as const)('is true while the cap is %s', (state) => {
    expect(frameNeedsCellRegion(frame({ claudeState: state }))).toBe(true)
  })

  it('is true when both are up at once', () => {
    // A sleeping pet still wears the cap. This is why claudeState is its own field rather than
    // another value on `overlay`.
    expect(frameNeedsCellRegion(frame({ overlay: 'sleep-z', claudeState: 'waiting' }))).toBe(true)
  })
})
