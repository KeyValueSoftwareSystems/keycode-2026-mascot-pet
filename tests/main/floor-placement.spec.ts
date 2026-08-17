import { describe, it, expect } from 'vitest'
import {
  computePlacement,
  windowYForFloor,
  windowXForPetCentre,
  petCentreForWindowX,
  floorForWorkArea,
  clampToFloor,
  PET_WINDOW,
  PET_WINDOW_HEIGHT,
  PET_WINDOW_WIDTH,
  BUBBLE_AREA_HEIGHT,
  petWindowFor,
  placementForScale,
  bubbleSideFor,
  spriteVisibleHeight,
  feetYForWindowY,
} from '../../apps/desktop/src/main/floor-placement.js'
import {
  ALPHA_MASK,
  isOpaqueAt,
  shapeRectsForWindow,
  spriteScreenRect,
  type AlphaMaskData,
} from '../../apps/desktop/src/sprite/alpha-mask.js'
import { PET_SIZES, petScaleFor } from '../../apps/desktop/src/config/constants.js'
import { SHEET } from '../../apps/desktop/src/pet-animations.generated.js'

/** A mask with different padding, to prove the formulas are derived rather than hardcoded. */
function maskWithFootInset(footInset: number): AlphaMaskData {
  const height = SHEET.frameHeight
  return {
    ...ALPHA_MASK,
    footInset,
    bbox: { x: 40, y: 10, width: 100, height: height - 10 - footInset },
  }
}

describe('window sizing', () => {
  it('ends the window at the sprite’s lowest opaque row, not at the cell bottom', () => {
    // Found by assertion, not reasoning: with the window sized to the full 208px cell, its bottom
    // 16 rows are transparent padding, so putting the feet on the work-area floor requires the
    // window to hang 16px below it — into the Dock. macOS clamps that back inside the visible
    // frame, which silently lifted the pet 16px and left it hovering.
    expect(PET_WINDOW_HEIGHT).toBe(BUBBLE_AREA_HEIGHT + SHEET.frameHeight - ALPHA_MASK.footInset)
    expect(PET_WINDOW_HEIGHT).toBe(304)
    expect(PET_WINDOW_HEIGHT).toBeLessThan(BUBBLE_AREA_HEIGHT + SHEET.frameHeight)
  })

  it('puts the window bottom exactly at the feet, so nothing needs to hang below the floor', () => {
    const placement = computePlacement()
    expect(placement.spriteBottomOffset).toBe(placement.windowSize.height)
  })
})

describe('computePlacement', () => {
  it('centres the sprite cell horizontally and hangs it below the bubble area', () => {
    const placement = computePlacement()
    expect(placement.spriteOrigin).toEqual({
      x: Math.round((PET_WINDOW.width - SHEET.frameWidth) / 2),
      y: BUBBLE_AREA_HEIGHT,
    })
  })

  it('measures the centre offset from the visible body, not the window', () => {
    const placement = computePlacement()
    // Derived, not restated: cell origin + bbox x + half the body width. Written as a literal once, it
    // had to be edited when the stretch art widened the union mask from 107px to 120px — which is
    // exactly the kind of edit that turns a test into a transcription of the code.
    const bbox = ALPHA_MASK.bbox
    const expected = placement.spriteOrigin.x + bbox.x + bbox.width / 2
    expect(placement.spriteCentreOffset).toBeCloseTo(expected, 5)
    // The property this is really about — the offset follows the *body*, not the window — needs a mask
    // whose body is off-centre to show at all. With the current art the two happen to coincide exactly
    // (the body is centred in its cell, so 84 + 36 + 60 = 180 = 360/2), and the original assertion here
    // was `not.toBe(window/2)`, which passed only by the accident of the old 107px width.
    const offCentre: AlphaMaskData = {
      ...ALPHA_MASK,
      bbox: { x: 10, y: ALPHA_MASK.bbox.y, width: 40, height: ALPHA_MASK.bbox.height },
    }
    const shifted = computePlacement(offCentre)
    expect(shifted.spriteCentreOffset).toBeCloseTo(shifted.spriteOrigin.x + 10 + 20, 5)
    expect(shifted.spriteCentreOffset).not.toBeCloseTo(PET_WINDOW.width / 2, 0)
  })

  it('re-derives everything for a differently padded art pack', () => {
    // The zero-code-change art-swap promise, tested. A 40px footInset must shift the maths, not
    // require an edit.
    const placement = computePlacement(maskWithFootInset(40), {
      width: 360,
      height: BUBBLE_AREA_HEIGHT + SHEET.frameHeight - 40,
    })
    expect(placement.footInset).toBe(40)
    expect(placement.spriteBottomOffset).toBe(BUBBLE_AREA_HEIGHT + SHEET.frameHeight - 40)
    expect(placement.spriteBottomOffset).toBe(placement.windowSize.height)
  })
})

describe('windowYForFloor', () => {
  it('places the pet’s lowest opaque pixel on the floor', () => {
    const placement = computePlacement()
    const floorY = 940
    const windowY = windowYForFloor(floorY, placement)

    // The corrected formula. The original brief added the bubble height, which double-counted and
    // lifted the pet by the full 112px bubble area.
    expect(windowY).toBe(floorY - placement.spriteBottomOffset)
    expect(windowY).toBe(636)

    // Feet land exactly on the floor.
    const feet = windowY + placement.spriteOrigin.y + ALPHA_MASK.bbox.y + ALPHA_MASK.bbox.height
    expect(feet).toBe(floorY)
  })

  it('is not the naive window-height subtraction', () => {
    const placement = computePlacement()
    // Guards against someone "simplifying" this back to `floorY - windowHeight`, which happens to
    // be equal here only because the window was resized to make it so. Assert the derivation.
    expect(windowYForFloor(1000, placement)).toBe(1000 - placement.spriteBottomOffset)
  })

  it('recomputes for a mask with different padding', () => {
    const mask = maskWithFootInset(40)
    const placement = computePlacement(mask, {
      width: 360,
      height: BUBBLE_AREA_HEIGHT + SHEET.frameHeight - 40,
    })
    const floorY = 500
    const windowY = windowYForFloor(floorY, placement)
    const feet = windowY + placement.spriteOrigin.y + mask.bbox.y + mask.bbox.height
    expect(feet).toBe(floorY)
  })
})

describe('x conversions', () => {
  it('round-trips pet centre and window x', () => {
    const placement = computePlacement()
    for (const centre of [0, 100.5, 1234, -50]) {
      const windowX = windowXForPetCentre(centre, placement)
      // Rounding to whole pixels loses at most half a pixel; anything more means the two
      // conversions disagree about the offset.
      expect(Math.abs(petCentreForWindowX(windowX, placement) - centre)).toBeLessThanOrEqual(0.5)
    }
  })

  it('returns integer window coordinates', () => {
    const placement = computePlacement()
    expect(Number.isInteger(windowXForPetCentre(500.4, placement))).toBe(true)
  })
})

describe('floorForWorkArea', () => {
  const workArea = { x: 0, y: 33, width: 1512, height: 907 }

  it('sets the floor at the bottom of the work area, above the Dock', () => {
    const floor = floorForWorkArea(workArea, 'key')
    expect(floor.y).toBe(940)
    expect(floor.displayKey).toBe('key')
  })

  it('lets the pet’s body reach the screen edge', () => {
    const floor = floorForWorkArea(workArea, 'key')
    const half = ALPHA_MASK.bbox.width / 2
    expect(floor.minX).toBe(workArea.x + half)
    expect(floor.maxX).toBe(workArea.x + workArea.width - half)

    // Clamping the *window* instead would stop the body ~126px short of the edge, and that gap of
    // nothing looks exactly like the bug it was meant to prevent.
    const windowHalf = PET_WINDOW.width / 2
    expect(floor.minX).toBeLessThan(workArea.x + windowHalf)
  })

  it('respects a secondary display that is not at the origin', () => {
    const floor = floorForWorkArea({ x: 1512, y: 0, width: 1920, height: 1080 }, 'second')
    expect(floor.y).toBe(1080)
    expect(floor.minX).toBeGreaterThan(1512)
  })
})

describe('clampToFloor', () => {
  const floor = { minX: 100, maxX: 900, y: 500, displayKey: 'k' }

  it('leaves an in-range position alone', () => {
    expect(clampToFloor(500, floor)).toBe(500)
  })

  it('clamps both edges', () => {
    expect(clampToFloor(-999, floor)).toBe(100)
    expect(clampToFloor(9999, floor)).toBe(900)
  })

  it('centres when the floor is degenerate', () => {
    // A display narrower than the pet's body. Returning something inside the display beats
    // returning NaN or an inverted clamp.
    const narrow = { minX: 500, maxX: 400, y: 0, displayKey: 'k' }
    expect(clampToFloor(450, narrow)).toBe(450)
  })
})

describe('pet size scaling', () => {
  it('keeps the window as wide as the bubble needs at every size', () => {
    // The bubble's text does not scale, so the window must not shrink horizontally with the pet or a
    // small pet's messages would wrap to a column.
    for (const size of PET_SIZES) {
      expect(petWindowFor(petScaleFor(size)).width).toBe(PET_WINDOW_WIDTH)
    }
  })

  it('shrinks only the sprite half of the window height', () => {
    const large = petWindowFor(1).height
    const small = petWindowFor(0.5).height
    // The bubble area is a fixed reservation; only the sprite's contribution halves.
    expect(large - BUBBLE_AREA_HEIGHT).toBe(ALPHA_MASK.frameHeight - ALPHA_MASK.footInset)
    expect(small - BUBBLE_AREA_HEIGHT).toBe(
      Math.round((ALPHA_MASK.frameHeight - ALPHA_MASK.footInset) * 0.5),
    )
    expect(small).toBeLessThan(large)
  })

  it('still lands the feet exactly on the floor at every size', () => {
    // The regression that would otherwise arrive with scaling: the window shrinks but the offset used
    // to place it does not, so the pet floats or sinks by the difference.
    for (const size of PET_SIZES) {
      const placement = placementForScale(petScaleFor(size))
      const windowY = windowYForFloor(900, placement)
      expect(windowY + placement.spriteBottomOffset).toBeCloseTo(900, 6)
    }
  })

  it('centres the body horizontally at every size', () => {
    for (const size of PET_SIZES) {
      const placement = placementForScale(petScaleFor(size))
      const windowX = windowXForPetCentre(500, placement)
      // Within a pixel, not exact: window positions are integers, so a body centre that lands on a
      // half pixel cannot be hit exactly. That rounding predates sizes and is the reason `x` is a
      // float in the engine and only rounded at this boundary.
      expect(Math.abs(windowX + placement.spriteCentreOffset - 500)).toBeLessThanOrEqual(1)
      // And the body's centre stays near the window's centre, so the bubble (which is centred on the
      // body) still fits inside a window that never changes width.
      expect(placement.spriteCentreOffset).toBeGreaterThan(PET_WINDOW_WIDTH * 0.4)
      expect(placement.spriteCentreOffset).toBeLessThan(PET_WINDOW_WIDTH * 0.6)
    }
  })

  it('lets a smaller pet stand closer to the screen edge and be lifted higher', () => {
    const area = { x: 0, y: 0, width: 1_440, height: 900 }
    const big = floorForWorkArea(area, 'k', undefined, placementForScale(1))
    const small = floorForWorkArea(area, 'k', undefined, placementForScale(0.5))

    expect(small.minX).toBeLessThan(big.minX)
    expect(small.maxX).toBeGreaterThan(big.maxX)
    // A shorter window can have its top edge lower down before the bubble would leave the screen.
    expect(small.minFeetY).toBeLessThan(big.minFeetY)
    expect(small.maxFeetY).toBe(big.maxFeetY)
  })

  it('scales the hit-test so the grab margin stays constant on screen', () => {
    // Find a cell-space point that is a hit only thanks to padding (just off real opaque pixels),
    // then confirm the same on-screen margin still hits at 0.5×. Using the union bbox edge is not
    // enough: sleep lies wide near the feet, so the left of the bbox is empty at mid-body height.
    const bbox = ALPHA_MASK.bbox
    const y = bbox.y + bbox.height / 2
    let edge = bbox.x
    while (edge < bbox.x + bbox.width && !isOpaqueAt(ALPHA_MASK, edge, y, 0)) edge += 1
    const justOutside = { x: edge - 1, y }
    expect(isOpaqueAt(ALPHA_MASK, justOutside.x, justOutside.y, 0)).toBe(false)
    expect(isOpaqueAt(ALPHA_MASK, justOutside.x, justOutside.y)).toBe(true)
    expect(
      isOpaqueAt(ALPHA_MASK, justOutside.x * 0.5, justOutside.y * 0.5, undefined, 0.5),
    ).toBe(true)
  })

  it('scales the screen rect and the setShape rects together', () => {
    const bounds = { x: 100, y: 200 }
    const p1 = placementForScale(1)
    const pHalf = placementForScale(0.5)

    const r1 = spriteScreenRect(ALPHA_MASK, bounds, p1.spriteOrigin, p1.scale)
    const rHalf = spriteScreenRect(ALPHA_MASK, bounds, pHalf.spriteOrigin, pHalf.scale)
    expect(rHalf.width).toBe(Math.round(r1.width * 0.5))
    expect(rHalf.height).toBe(Math.round(r1.height * 0.5))

    // The Linux input region must shrink with the pet or the pet stays grabbable in thin air.
    const shape1 = shapeRectsForWindow(ALPHA_MASK, p1.spriteOrigin, { scale: 1 })
    const shapeHalf = shapeRectsForWindow(ALPHA_MASK, pHalf.spriteOrigin, { scale: 0.5 })
    expect(shapeHalf).toHaveLength(shape1.length)
    const area = (rects: readonly { width: number; height: number }[]) =>
      rects.reduce((sum, r) => sum + r.width * r.height, 0)
    expect(area(shapeHalf)).toBeLessThan(area(shape1))
  })
})

describe('reaching the top of the screen', () => {
  const workArea = { x: 0, y: 33, width: 1512, height: 907 }

  it('lets the pet’s feet rise until the character reaches the top of the work area', () => {
    // The bug this replaces: `minFeetY` was measured from `spriteBottomOffset`, which in the only
    // layout that then existed included the 112px bubble band. The head stopped 112px short of the
    // top with nothing up there to explain why.
    const floor = floorForWorkArea(workArea, 'key')
    expect(floor.minFeetY).toBe(workArea.y + ALPHA_MASK.frameHeight - ALPHA_MASK.footInset)
    expect(floor.minFeetY).toBeLessThan(workArea.y + BUBBLE_AREA_HEIGHT + 192)
  })

  it('leaves the window inside the work area at the highest feet position, on both sides', () => {
    // The invariant that keeps the OS out of it: a window hanging outside the work area gets clamped
    // back, which silently moves the pet. True in the layout that is actually used up there (below)
    // and in the one it came from (above).
    const floor = floorForWorkArea(workArea, 'key')
    for (const side of ['above', 'below'] as const) {
      const placement = placementForScale(1, ALPHA_MASK, side)
      const windowTop = windowYForFloor(floor.minFeetY, placement)
      if (side === 'below') expect(windowTop).toBeGreaterThanOrEqual(workArea.y)
      expect(windowTop + placement.windowSize.height).toBeLessThanOrEqual(floor.y + BUBBLE_AREA_HEIGHT)
    }
  })

  it('rises further at a smaller size, because a smaller character needs less room', () => {
    const large = floorForWorkArea(workArea, 'k', undefined, placementForScale(1)).minFeetY
    const small = floorForWorkArea(workArea, 'k', undefined, placementForScale(0.5)).minFeetY
    expect(small).toBeLessThan(large)
  })

  it('collapses to the floor on a display shorter than the pet rather than inverting', () => {
    const tiny = floorForWorkArea({ x: 0, y: 0, width: 800, height: 100 }, 'k')
    expect(tiny.minFeetY).toBe(tiny.maxFeetY)
  })
})

describe('bubbleSideFor', () => {
  const workArea = { x: 0, y: 33, width: 1512, height: 907 }
  const spriteHeight = ALPHA_MASK.frameHeight - ALPHA_MASK.footInset

  it('keeps the bubble above the pet anywhere there is room for it', () => {
    expect(bubbleSideFor(940, workArea, 1)).toBe('above')
    expect(bubbleSideFor(workArea.y + spriteHeight + BUBBLE_AREA_HEIGHT, workArea, 1)).toBe('above')
  })

  it('flips it below once the band would leave the work area', () => {
    expect(bubbleSideFor(workArea.y + spriteHeight + BUBBLE_AREA_HEIGHT - 1, workArea, 1)).toBe(
      'below',
    )
    expect(bubbleSideFor(workArea.y + spriteHeight, workArea, 1)).toBe('below')
  })

  it('is monotonic in feetY — one flip, never oscillation', () => {
    // A predicate that flipped twice would make the bubble hop sides as the pet was dragged, which
    // reads as a rendering fault rather than as a decision.
    const sides = []
    for (let feetY = workArea.y + spriteHeight; feetY <= 940; feetY += 1) {
      sides.push(bubbleSideFor(feetY, workArea, 1))
    }
    const flips = sides.filter((side, i) => i > 0 && side !== sides[i - 1]).length
    expect(flips).toBe(1)
    expect(sides[0]).toBe('below')
    expect(sides.at(-1)).toBe('above')
  })

  it('flips lower down for a smaller pet, whose band clears the top sooner', () => {
    // 220px of headroom: enough for a half-size pet (96px) plus the 112px band, not for a full one.
    const feetY = workArea.y + 220
    expect(spriteVisibleHeight(1)).toBe(192)
    expect(spriteVisibleHeight(0.5)).toBe(96)
    expect(bubbleSideFor(feetY, workArea, 1)).toBe('below')
    expect(bubbleSideFor(feetY, workArea, 0.5)).toBe('above')
  })

  it('does not depend on the pose, so a jump cannot move the bubble', () => {
    // Deliberately the union bbox and not `headTopByState`: `jumping` reaches well above idle's hair,
    // and a per-pose threshold would flip the side mid-animation.
    const feetY = workArea.y + spriteHeight + BUBBLE_AREA_HEIGHT + 4
    expect(bubbleSideFor(feetY, workArea, 1)).toBe('above')
    expect(bubbleSideFor(feetY, workArea, 1, ALPHA_MASK)).toBe('above')
  })
})

describe('placement with the bubble below', () => {
  it('moves the sprite cell to the window’s top edge and keeps the window the same size', () => {
    const above = placementForScale(1, ALPHA_MASK, 'above')
    const below = placementForScale(1, ALPHA_MASK, 'below')
    expect(below.spriteOrigin.y).toBe(0)
    expect(above.spriteOrigin.y).toBe(BUBBLE_AREA_HEIGHT)
    expect(below.windowSize).toEqual(above.windowSize)
    // Horizontal geometry is untouched, so the pet does not shift sideways when the side flips.
    expect(below.spriteOrigin.x).toBe(above.spriteOrigin.x)
    expect(below.spriteCentreOffset).toBe(above.spriteCentreOffset)
  })

  it('keeps the pet on the same screen pixels when the side flips', () => {
    // What makes the flip invisible: the window moves by exactly the band height, so the sprite
    // does not. If this ever fails, the pet jumps 112px as it is dragged past the threshold.
    const feetY = 400
    const above = placementForScale(1, ALPHA_MASK, 'above')
    const below = placementForScale(1, ALPHA_MASK, 'below')
    const yAbove = windowYForFloor(feetY, above) + above.spriteOrigin.y
    const yBelow = windowYForFloor(feetY, below) + below.spriteOrigin.y
    expect(yBelow).toBe(yAbove)
    expect(windowYForFloor(feetY, below) - windowYForFloor(feetY, above)).toBe(BUBBLE_AREA_HEIGHT)
  })

  it('round-trips window y and feet y in both layouts', () => {
    for (const side of ['above', 'below'] as const) {
      const placement = placementForScale(0.75, ALPHA_MASK, side)
      const windowY = windowYForFloor(517, placement)
      expect(feetYForWindowY(windowY, placement)).toBe(517)
    }
  })
})
