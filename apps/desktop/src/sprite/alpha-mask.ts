/**
 * Alpha-mask accessors. Pure, and importable from main and the renderer alike.
 *
 * The generated data lives in `alpha-mask.generated.ts`; this is the behaviour around it.
 */

import { ALPHA_MASK, type AlphaMaskData, type MaskRect } from './alpha-mask.generated.js'

export { ALPHA_MASK }
export type { AlphaMaskData, MaskRect }

/**
 * Default hit-test padding, in pixels.
 *
 * A mask cell is 4px, and the character's limbs are only a few pixels wide in places. Without
 * padding, grabbing an arm requires pixel-perfect aim on something 3px across — technically
 * correct and miserable to use. openpets needed 18px of padding because it had no mask at all
 * and was padding a bounding box; 8px around actual geometry is the equivalent generosity.
 */
export const DEFAULT_HIT_PADDING = 8

function cellSet(mask: AlphaMaskData, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= mask.cols || cy >= mask.rows) return false
  const index = cy * mask.cols + cx
  return ((mask.bits[index >> 3] ?? 0) >> (7 - (index & 7))) % 2 === 1
}

/**
 * Is the given cell-local point on the pet?
 *
 * @param xInCell x relative to the sprite's top-left, in CSS pixels
 * @param yInCell y relative to the sprite's top-left, in CSS pixels
 * @param paddingPx how far off the character still counts as a hit
 */
export function isOpaqueAt(
  mask: AlphaMaskData,
  xInCell: number,
  yInCell: number,
  paddingPx: number = DEFAULT_HIT_PADDING,
): boolean {
  const reach = Math.ceil(paddingPx / mask.granularity)
  const cx = Math.floor(xInCell / mask.granularity)
  const cy = Math.floor(yInCell / mask.granularity)

  // Cheap exact test first; the neighbourhood scan only runs on a miss.
  if (cellSet(mask, cx, cy)) return true
  if (reach <= 0) return false

  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      if (dx === 0 && dy === 0) continue
      if (cellSet(mask, cx + dx, cy + dy)) return true
    }
  }
  return false
}

/**
 * The mask's shape rects translated into window coordinates, for `setShape` on Linux.
 *
 * Padding is applied by inflating each rect, which over-covers slightly at rect seams. That is
 * the right direction to be wrong: an input region marginally larger than the character costs
 * a few clicks near its edge, whereas one marginally smaller makes the pet feel unresponsive.
 */
export function shapeRectsForWindow(
  mask: AlphaMaskData,
  origin: { x: number; y: number },
  options: { paddingPx?: number } = {},
): MaskRect[] {
  const pad = options.paddingPx ?? DEFAULT_HIT_PADDING
  return mask.shapeRects.map((rect) => ({
    x: Math.max(0, origin.x + rect.x - pad),
    y: Math.max(0, origin.y + rect.y - pad),
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }))
}

/** The sprite's *visible* bounds in screen coordinates. What the harness asserts against. */
export function spriteScreenRect(
  mask: AlphaMaskData,
  windowBounds: { x: number; y: number },
  origin: { x: number; y: number },
): MaskRect {
  return {
    x: windowBounds.x + origin.x + mask.bbox.x,
    y: windowBounds.y + origin.y + mask.bbox.y,
    width: mask.bbox.width,
    height: mask.bbox.height,
  }
}

/** Half the visible body width — the amount the pet's centre must stay clear of a screen edge. */
export function bodyHalfWidth(mask: AlphaMaskData): number {
  return mask.bbox.width / 2
}
