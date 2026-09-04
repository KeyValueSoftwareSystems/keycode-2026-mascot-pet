import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error — untyped .mjs helpers shared with the generators
import { loadSpritesheet } from '../../scripts/lib/spritesheet.mjs'
// @ts-expect-error — untyped .mjs helpers shared with the generators
import { headAnchorsByFrame } from '../../scripts/lib/mask.mjs'
// @ts-expect-error — untyped .mjs helpers shared with the generators
import { decodePng } from '../../scripts/lib/png.mjs'

const REPO = resolve(import.meta.dirname, '..', '..')
const CSS = readFileSync(resolve(REPO, 'apps/desktop/src/renderer/pet.generated.css'), 'utf8')

/**
 * The status cap has to bob with the pet.
 *
 * The pet's bounce is entirely `background-position` stepping — the sprite element never moves —
 * so anything anchored to a per-state constant stays put while the character bobs underneath it.
 * `headTopByState` is deliberately such a constant (it is the minimum across the state's frames,
 * so the speech bubble does not jitter with the pet's breathing), which makes it exactly the
 * wrong anchor for a hat.
 */
describe('per-frame head anchors', () => {
  const { sheet, states } = loadSpritesheet() as {
    sheet: { frameWidth: number; frameHeight: number }
    states: Array<{ name: string; row: number; frames: number; startColumn?: number }>
  }
  const png = decodePng(readFileSync(resolve(REPO, 'pet/spritesheet.png')))
  const anchors = headAnchorsByFrame(png, sheet, states) as Record<
    string,
    Array<{ top: number; cx: number }>
  >

  it('produces one anchor per frame of every state', () => {
    for (const state of states) {
      expect(anchors[state.name], state.name).toHaveLength(state.frames)
    }
  })

  it('sees the idle bob the bubble is deliberately blind to', () => {
    // Measured from the art: idle's two frames sit 7px apart vertically. A cap pinned to the
    // per-state minimum floats a gap wider than half its own height on the second frame, which
    // is the bug this exists to prevent regressing.
    const tops = anchors['idle'].map((a) => a.top)
    expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThanOrEqual(5)
  })

  it('tracks the head sideways too, which a body-bbox centre cannot', () => {
    // jumping leans: the head centre swings while the body's bounding box barely moves.
    const cxs = anchors['jumping'].map((a) => a.cx)
    expect(Math.max(...cxs) - Math.min(...cxs)).toBeGreaterThanOrEqual(5)
  })

  it('keeps every anchor inside the cell', () => {
    for (const [name, frames] of Object.entries(anchors)) {
      for (const { top, cx } of frames) {
        expect(top, `${name} top`).toBeGreaterThanOrEqual(0)
        expect(top, `${name} top`).toBeLessThan(sheet.frameHeight)
        expect(cx, `${name} cx`).toBeGreaterThanOrEqual(0)
        expect(cx, `${name} cx`).toBeLessThan(sheet.frameWidth)
      }
    }
  })
})

describe('generated cap keyframes', () => {
  const { states } = loadSpritesheet() as {
    states: Array<{ name: string; frames: number; durationMs: number; iterations?: unknown }>
  }

  it('emits a cap keyframe rule per state per nonce', () => {
    for (const state of states) {
      for (const nonce of [0, 1]) {
        expect(CSS, `${state.name}/${nonce}`).toContain(`@keyframes kp-cap-${state.name}-${nonce}`)
      }
    }
  })

  it('gives multi-frame states one stop per frame', () => {
    // One stop per frame is what makes the cap land on the real head position rather than on a
    // linear interpolation between the first and last — the head tops are not a ramp.
    const block = CSS.slice(CSS.indexOf('@keyframes kp-cap-jumping-0'))
    const body = block.slice(0, block.indexOf('}\n@') + 1)
    const stops = body.match(/^\s+[\d.]+% \{/gm) ?? []
    const jumping = states.find((s) => s.name === 'jumping')!
    expect(stops).toHaveLength(jumping.frames)
  })

  it('steps rather than interpolates, and scales with the pet', () => {
    expect(CSS).toMatch(/#claude-cap[\s\S]*?animation-timing-function:\s*step-end/)
    expect(CSS).toMatch(/@keyframes kp-cap-idle-0[\s\S]*?var\(--pet-scale/)
  })

  it('runs the cap on the same clock as the sprite', () => {
    // Out of phase by even one frame and the cap lands on the wrong head position all the way
    // through the loop. Same duration, same iteration count, restarted by the same nonce flip.
    for (const state of states) {
      const rule = CSS.slice(CSS.indexOf(`[data-pet-state="${state.name}"][data-pet-nonce="0"] #claude-cap`))
      const decl = rule.slice(0, rule.indexOf('}'))
      expect(decl, state.name).toContain(`${state.durationMs}ms`)
    }
  })
})
