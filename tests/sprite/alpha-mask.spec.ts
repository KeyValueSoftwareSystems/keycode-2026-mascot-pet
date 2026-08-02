import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error — untyped .mjs helpers shared with the generators
import { decodePng, alphaAt } from '../../scripts/lib/png.mjs'
// @ts-expect-error — untyped .mjs helpers shared with the generators
import { buildUnion, toCellGrid, packBits, unpackBits, toShapeRects, rectsArea, ALPHA_THRESHOLD } from '../../scripts/lib/mask.mjs'
// @ts-expect-error — untyped .mjs helpers shared with the generators
import { loadSpritesheet } from '../../scripts/lib/spritesheet.mjs'
import {
  ALPHA_MASK,
  isOpaqueAt,
  shapeRectsForWindow,
  shapeRectsForFrame,
  bubbleBandRect,
  spriteScreenRect,
  bodyHalfWidth,
} from '../../apps/desktop/src/sprite/alpha-mask.js'

const REPO = resolve(import.meta.dirname, '..', '..')
const maskJson = JSON.parse(
  readFileSync(resolve(REPO, 'apps/desktop/assets/pet/alpha-mask.json'), 'utf8'),
) as Record<string, any>

const png = decodePng(readFileSync(resolve(REPO, 'pet/spritesheet.png')))
const { sheet, states } = loadSpritesheet()

describe('alpha mask generation', () => {
  it('is a true union: every opaque sprite pixel maps to a set mask cell', () => {
    // The assertion that actually protects hit-testing across an art swap. If the mask ever
    // stops covering the art, the pet becomes partly ungrabbable — and nothing else would notice.
    const { granularity, cols } = ALPHA_MASK
    let misses = 0

    for (const state of states as Array<{ row: number; frames: number; name: string }>) {
      for (let frame = 0; frame < state.frames; frame += 1) {
        for (let y = 0; y < sheet.frameHeight; y += 1) {
          for (let x = 0; x < sheet.frameWidth; x += 1) {
            const a = alphaAt(png, frame * sheet.frameWidth + x, state.row * sheet.frameHeight + y)
            if (a <= ALPHA_THRESHOLD) continue
            const index = Math.floor(y / granularity) * cols + Math.floor(x / granularity)
            const set = ((ALPHA_MASK.bits[index >> 3] ?? 0) >> (7 - (index & 7))) & 1
            if (!set) misses += 1
          }
        }
      }
    }

    expect(misses).toBe(0)
  })

  it('separates per-frame fill from union fill', () => {
    // docs/PROMPT.md §5.4 conflated these. Per-frame is ~21%; the *union* the mask covers is
    // ~35%, and the coarse cell grid is ~38% set. Asserting the wrong one makes the test a lie.
    const stats = ALPHA_MASK.stats
    const perFramePct = (stats.perFrameOpaqueMean / stats.cellPixels) * 100
    const unionPct = (stats.unionOpaquePixels / stats.cellPixels) * 100
    const cellPct = (stats.maskSetCells / stats.maskTotalCells) * 100

    expect(perFramePct).toBeGreaterThan(19)
    expect(perFramePct).toBeLessThan(23)
    expect(unionPct).toBeGreaterThan(33)
    expect(unionPct).toBeLessThan(38)
    expect(cellPct).toBeGreaterThan(35)
    expect(cellPct).toBeLessThan(41)

    expect(stats.perFrameOpaqueMin).toBeGreaterThan(6_500)
    expect(stats.perFrameOpaqueMax).toBeLessThan(10_500)
  })

  it('measures footInset as the gap below the lowest opaque row, identically for every state', () => {
    expect(ALPHA_MASK.footInset).toBe(16)
    // Uniform across states on this art, which is why a single placement constant is correct.
    const distinct = new Set(Object.values(ALPHA_MASK.footInsetByState))
    expect([...distinct]).toEqual([16])
    // Sanity bound: a footInset near the cell height would mean the mask found the wrong rows.
    expect(ALPHA_MASK.footInset).toBeGreaterThan(0)
    expect(ALPHA_MASK.footInset).toBeLessThan(60)
  })

  it('has the measured bounding box', () => {
    expect(ALPHA_MASK.bbox).toEqual({ x: 42, y: 14, width: 107, height: 178 })
  })

  it('measures a per-state head top for every state, at or below the union top', () => {
    // The speech bubble hangs off these. Every declared state needs one or the bubble silently
    // falls back to the union top for that state and drifts away from the character's head.
    const stateNames = states.map((s: { name: string }) => s.name).sort()
    expect(Object.keys(ALPHA_MASK.headTopByState).sort()).toEqual(stateNames)

    for (const [state, top] of Object.entries(ALPHA_MASK.headTopByState)) {
      // The union top is the minimum over all states, so no state can be above it.
      expect(top, `${state} is above the union bbox`).toBeGreaterThanOrEqual(ALPHA_MASK.bbox.y)
      // And every head is above its own feet, or the rows have been read upside down.
      expect(top, `${state} head is not above the feet`).toBeLessThan(
        ALPHA_MASK.frameHeight - ALPHA_MASK.footInset,
      )
    }
  })

  it('anchors the bubble tighter than the union bbox would for the common poses', () => {
    // The whole point of the per-state measurement: on this art `review` reaches to y=14 and sets
    // the union top, which is 23px above idle's hair. A union-anchored bubble floats that far off
    // the head in the pose the pet spends most of its life in.
    expect(ALPHA_MASK.headTopByState['idle']).toBeGreaterThan(ALPHA_MASK.bbox.y + 15)
    expect(Math.min(...Object.values(ALPHA_MASK.headTopByState))).toBe(ALPHA_MASK.bbox.y)
  })

  it('reports a mostly-horizontal transparent margin, which is why bounds hit-testing is unusable', () => {
    // 107 of 192 columns used: ~44% of the cell width is empty space beside the character. A
    // bounds hit-test would swallow clicks across that whole band.
    expect(ALPHA_MASK.bbox.width).toBeLessThan(sheet.frameWidth * 0.6)
  })

  it('derives few shape rects with no over-cover', () => {
    const rects = ALPHA_MASK.shapeRects
    expect(rects.length).toBeGreaterThan(0)
    expect(rects.length).toBeLessThanOrEqual(48)
    // Exact coverage: run-merging loses nothing and adds nothing.
    expect(ALPHA_MASK.stats.shapeRectsArea).toBe(ALPHA_MASK.stats.maskArea)
    // Every set cell is inside some rect, or Linux click-through would have holes.
    const { granularity, cols, rows } = ALPHA_MASK
    for (let cy = 0; cy < rows; cy += 1) {
      for (let cx = 0; cx < cols; cx += 1) {
        const index = cy * cols + cx
        const set = ((ALPHA_MASK.bits[index >> 3] ?? 0) >> (7 - (index & 7))) & 1
        if (!set) continue
        const px = cx * granularity
        const py = cy * granularity
        const covered = rects.some(
          (r) => px >= r.x && py >= r.y && px < r.x + r.width && py < r.y + r.height,
        )
        expect(covered, `cell ${cx},${cy} is not covered by any shape rect`).toBe(true)
      }
    }
  })

  it('keeps the JSON artifact and the generated TS in agreement', () => {
    // Two representations exist because JSON import behaves differently across tsc-ESM main, a
    // sandboxed renderer and an asar. They must never disagree.
    expect(maskJson.granularity).toBe(ALPHA_MASK.granularity)
    expect(maskJson.cols).toBe(ALPHA_MASK.cols)
    expect(maskJson.rows).toBe(ALPHA_MASK.rows)
    expect(maskJson.footInset).toBe(ALPHA_MASK.footInset)
    expect(maskJson.bbox).toEqual(ALPHA_MASK.bbox)
    expect(maskJson.shapeRects).toEqual(ALPHA_MASK.shapeRects)
    expect(maskJson.footInsetByState).toEqual(ALPHA_MASK.footInsetByState)
    expect(maskJson.headTopByState).toEqual(ALPHA_MASK.headTopByState)
    expect(maskJson.stats).toEqual(ALPHA_MASK.stats)
    expect(Buffer.from(ALPHA_MASK.bits).toString('base64')).toBe(maskJson.bitsBase64)
  })

  it('records the spritesheet hash it was built from', () => {
    expect(ALPHA_MASK.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('mask helpers', () => {
  it('round-trips packed bits', () => {
    const cells = new Uint8Array([1, 0, 1, 1, 0, 0, 0, 1, 1, 0])
    expect([...unpackBits(packBits(cells), cells.length)]).toEqual([...cells])
  })

  it('merges vertically aligned runs into single rects', () => {
    // Three stacked identical runs must become one rect, not three.
    const cols = 4
    const rows = 3
    const cells = new Uint8Array(cols * rows)
    for (let r = 0; r < rows; r += 1) {
      cells[r * cols + 1] = 1
      cells[r * cols + 2] = 1
    }
    const rects = toShapeRects(cells, cols, rows, 4, 48)
    expect(rects).toEqual([{ x: 4, y: 0, width: 8, height: 12 }])
    expect(rectsArea(rects)).toBe(96)
  })

  it('does not merge runs of different spans', () => {
    const cols = 4
    const cells = new Uint8Array([
      0, 1, 1, 0, //
      0, 1, 0, 0,
    ])
    const rects = toShapeRects(cells, cols, 2, 4, 48)
    expect(rects).toHaveLength(2)
  })

  it('degrades to per-row bounding runs when the rect budget is exceeded', () => {
    // A checkerboard is the worst case for run-merging; the fallback must stay under budget
    // rather than handing setShape hundreds of rects.
    const cols = 16
    const rows = 16
    const cells = new Uint8Array(cols * rows)
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) cells[r * cols + c] = (r + c) % 2
    }
    const rects = toShapeRects(cells, cols, rows, 4, 8)
    expect(rects.length).toBeLessThanOrEqual(rows)
  })

  it('builds the same union the committed mask has', () => {
    const { union, footInsetByState } = buildUnion(png, sheet, states)
    const { cells, cols, rows } = toCellGrid(union, sheet.frameWidth, sheet.frameHeight, 4)
    expect(cols).toBe(ALPHA_MASK.cols)
    expect(rows).toBe(ALPHA_MASK.rows)
    expect(Buffer.from(packBits(cells)).toString('base64')).toBe(maskJson.bitsBase64)
    expect(footInsetByState).toEqual(ALPHA_MASK.footInsetByState)
  })
})

describe('mask accessors', () => {
  it('hits the middle of the body and misses the empty margin', () => {
    const centreX = ALPHA_MASK.bbox.x + ALPHA_MASK.bbox.width / 2
    const centreY = ALPHA_MASK.bbox.y + ALPHA_MASK.bbox.height / 2
    expect(isOpaqueAt(ALPHA_MASK, centreX, centreY, 0)).toBe(true)
    // Far left of the cell is transparent margin in every frame.
    expect(isOpaqueAt(ALPHA_MASK, 4, centreY, 0)).toBe(false)
    expect(isOpaqueAt(ALPHA_MASK, ALPHA_MASK.bbox.x - 30, centreY, 0)).toBe(false)
  })

  it('treats out-of-cell coordinates as a miss', () => {
    expect(isOpaqueAt(ALPHA_MASK, -50, -50, 0)).toBe(false)
    expect(isOpaqueAt(ALPHA_MASK, 9999, 9999, 0)).toBe(false)
  })

  it('padding makes points just off the character count as a hit', () => {
    // Without padding, grabbing a 3px-wide limb needs pixel-perfect aim.
    const y = ALPHA_MASK.bbox.y + 4
    let edgeX = -1
    for (let x = 0; x < ALPHA_MASK.frameWidth; x += 1) {
      if (isOpaqueAt(ALPHA_MASK, x, y, 0)) {
        edgeX = x
        break
      }
    }
    expect(edgeX).toBeGreaterThan(0)
    expect(isOpaqueAt(ALPHA_MASK, edgeX - 6, y, 0)).toBe(false)
    expect(isOpaqueAt(ALPHA_MASK, edgeX - 6, y, 8)).toBe(true)
  })

  it('translates shape rects into window space and inflates them by the padding', () => {
    const origin = { x: 84, y: 112 }
    const rects = shapeRectsForWindow(ALPHA_MASK, origin, { paddingPx: 8 })
    expect(rects).toHaveLength(ALPHA_MASK.shapeRects.length)
    const first = ALPHA_MASK.shapeRects[0]!
    expect(rects[0]).toEqual({
      x: origin.x + first.x - 8,
      y: origin.y + first.y - 8,
      width: first.width + 16,
      height: first.height + 16,
    })
  })

  it('never emits negative shape-rect coordinates', () => {
    // setShape with a negative origin is undefined behaviour on X11.
    const rects = shapeRectsForWindow(ALPHA_MASK, { x: 0, y: 0 }, { paddingPx: 64 })
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
    }
  })

  it('reports the sprite rect in screen space', () => {
    const rect = spriteScreenRect(ALPHA_MASK, { x: 1000, y: 500 }, { x: 84, y: 112 })
    expect(rect).toEqual({
      x: 1000 + 84 + ALPHA_MASK.bbox.x,
      y: 500 + 112 + ALPHA_MASK.bbox.y,
      width: ALPHA_MASK.bbox.width,
      height: ALPHA_MASK.bbox.height,
    })
  })

  it('reports half the visible body width, not half the window', () => {
    expect(bodyHalfWidth(ALPHA_MASK)).toBe(ALPHA_MASK.bbox.width / 2)
    expect(bodyHalfWidth(ALPHA_MASK)).toBeLessThan(sheet.frameWidth / 2)
  })
})

describe('shapeRectsForFrame', () => {
  // `setShape` is documented as deciding where the system "permits drawing", not merely where it
  // permits clicks: "Outside of the given region, no pixels will be drawn." Every test here is about
  // that sentence. The bug it fixes was a speech bubble that Linux never painted, which passed every
  // assertion the harness makes because `capturePage()` renders the web contents and never sees the
  // window shape.
  const layout = {
    spriteOrigin: { x: 84, y: 112 },
    scale: 1,
    windowWidth: 360,
    windowHeight: 304,
  }

  const covers = (rects: readonly { x: number; y: number; width: number; height: number }[], x: number, y: number) =>
    rects.some((r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height)

  const frame = (over: Partial<Parameters<typeof shapeRectsForFrame>[2]> = {}) => ({
    animation: 'idle',
    bubbleVisible: false,
    overlayVisible: false,
    ...over,
  })

  it('is the sprite rects, clipped to the window, when only the pet is on screen', () => {
    const rects = shapeRectsForFrame(ALPHA_MASK, layout, frame())
    const unclipped = shapeRectsForWindow(ALPHA_MASK, layout.spriteOrigin, { scale: 1 })
    expect(rects).toHaveLength(unclipped.length)

    // Not identical, and that is the point of clipping. The 8px hit padding inflates the lowest rect
    // past the window's bottom edge — the window ends *at the feet*, so there are no rows below them
    // to inflate into. A region reaching outside the window is not defined behaviour in `setShape`.
    const last = rects.at(-1)!
    expect(last.y + last.height).toBe(layout.windowHeight)
    expect(unclipped.at(-1)!.height).toBeGreaterThan(last.height)
    expect(rects.slice(0, -1)).toEqual(unclipped.slice(0, -1))
  })

  it('does NOT cover the bubble band when no bubble is up', () => {
    // The bug, stated as a property. Without a bubble the band must stay outside the region, or the
    // window swallows clicks across an empty 360×112 strip for no reason.
    const rects = shapeRectsForFrame(ALPHA_MASK, layout, frame())
    expect(covers(rects, layout.windowWidth / 2, 8)).toBe(false)
  })

  it('covers the whole band above the head when a bubble is up', () => {
    const rects = shapeRectsForFrame(ALPHA_MASK, layout, frame({ bubbleVisible: true }))
    const headTop = layout.spriteOrigin.y + (ALPHA_MASK.headTopByState['idle'] ?? ALPHA_MASK.bbox.y)

    // Every row from the window's top edge down to the head, at the centre and at both extremes —
    // the bubble is wider than the character, so the horizontal clipping was as bad as the vertical.
    for (let y = 0; y < headTop; y += 4) {
      for (const x of [0, 1, layout.windowWidth / 2, layout.windowWidth - 1]) {
        expect(covers(rects, x, y)).toBe(true)
      }
    }
  })

  it('covers the tail, which hangs below the nominal band', () => {
    // The tail's tip reaches to within a few pixels of the hair, i.e. *below* y=112. A band of a flat
    // 112px would clip the one part of the bubble that makes it read as speech.
    const rects = shapeRectsForFrame(ALPHA_MASK, layout, frame({ bubbleVisible: true }))
    expect(covers(rects, layout.windowWidth / 2, 112 + 2)).toBe(true)
  })

  it('reaches the top for every pose, including the ones that reach highest', () => {
    for (const animation of Object.keys(ALPHA_MASK.headTopByState)) {
      const rects = shapeRectsForFrame(ALPHA_MASK, layout, frame({ animation, bubbleVisible: true }))
      const headTop = layout.spriteOrigin.y + ALPHA_MASK.headTopByState[animation]!
      expect(covers(rects, layout.windowWidth / 2, Math.max(0, headTop - 1))).toBe(true)
      expect(covers(rects, 2, 2)).toBe(true)
    }
  })

  it('covers below the feet instead when the bubble is under the pet', () => {
    const below = { ...layout, spriteOrigin: { x: 84, y: 0 } }
    const rects = shapeRectsForFrame(
      ALPHA_MASK,
      below,
      frame({ bubbleVisible: true, bubbleSide: 'below' }),
    )
    const feet = ALPHA_MASK.frameHeight - (ALPHA_MASK.footInsetByState['idle'] ?? ALPHA_MASK.footInset)
    expect(covers(rects, below.windowWidth / 2, feet + 4)).toBe(true)
    expect(covers(rects, below.windowWidth - 1, below.windowHeight - 1)).toBe(true)
    // And not the other end, which is where the pet's head now is.
    expect(covers(rects, below.windowWidth - 1, 2)).toBe(false)
  })

  it('covers the sprite cell for the sleep Z’s, which sit above the hair', () => {
    const rects = shapeRectsForFrame(ALPHA_MASK, layout, frame({ overlayVisible: true }))
    // The Z's are positioned from --sprite-x/--sprite-y at roughly +118,+6 in cell space. Asserting
    // the cell rather than that rectangle is what keeps their offsets in the stylesheet.
    expect(covers(rects, layout.spriteOrigin.x + 118, layout.spriteOrigin.y + 6)).toBe(true)
    // Narrower than the whole window, which matters because sleep persists indefinitely.
    expect(covers(rects, 2, layout.spriteOrigin.y + 6)).toBe(false)
  })

  it('scales the bubble band with the pet, since the head moves down as it shrinks', () => {
    const small = { ...layout, scale: 0.5 }
    const rects = shapeRectsForFrame(ALPHA_MASK, small, frame({ bubbleVisible: true }))
    const headTop =
      small.spriteOrigin.y + (ALPHA_MASK.headTopByState['idle'] ?? ALPHA_MASK.bbox.y) * 0.5
    expect(covers(rects, small.windowWidth / 2, headTop - 1)).toBe(true)
  })

  it('never emits a rect outside the window, or an empty one', () => {
    for (const bubbleVisible of [true, false]) {
      for (const overlayVisible of [true, false]) {
        for (const side of ['above', 'below'] as const) {
          const rects = shapeRectsForFrame(
            ALPHA_MASK,
            side === 'below' ? { ...layout, spriteOrigin: { x: 84, y: 0 } } : layout,
            frame({ bubbleVisible, overlayVisible, bubbleSide: side }),
          )
          for (const r of rects) {
            expect(r.width).toBeGreaterThan(0)
            expect(r.height).toBeGreaterThan(0)
            expect(r.x).toBeGreaterThanOrEqual(0)
            expect(r.y).toBeGreaterThanOrEqual(0)
            expect(r.x + r.width).toBeLessThanOrEqual(layout.windowWidth)
            expect(r.y + r.height).toBeLessThanOrEqual(layout.windowHeight)
          }
        }
      }
    }
  })
})
