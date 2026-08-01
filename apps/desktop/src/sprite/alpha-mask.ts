/**
 * Alpha-mask accessors. Pure, and importable from main and the renderer alike.
 *
 * The generated data lives in `alpha-mask.generated.ts`; this is the behaviour around it.
 *
 * **Everything here works in unscaled cell pixels, and takes `scale` where screen pixels are
 * involved.** The mask is measured once from the spritesheet at its native size; the pet can be
 * rendered at 0.5×, 0.75× or 1×. Rescaling the mask itself would mean three masks that can disagree,
 * so instead the conversion happens at the two boundaries that touch the screen: a hit-test divides
 * by the scale on the way in, and a screen rect multiplies by it on the way out.
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
  scale = 1,
): boolean {
  // `xInCell`/`yInCell` arrive in *rendered* pixels, so undo the scale to index the mask. Padding is
  // divided too, which keeps the grab margin the same size on screen at every pet size — otherwise a
  // small pet would be proportionally as easy to grab but absolutely much harder.
  const s = scale > 0 ? scale : 1
  const reach = Math.ceil(paddingPx / s / mask.granularity)
  const cx = Math.floor(xInCell / s / mask.granularity)
  const cy = Math.floor(yInCell / s / mask.granularity)

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
  options: { paddingPx?: number; scale?: number } = {},
): MaskRect[] {
  const pad = options.paddingPx ?? DEFAULT_HIT_PADDING
  const s = options.scale && options.scale > 0 ? options.scale : 1
  return mask.shapeRects.map((rect) => ({
    x: Math.max(0, Math.round(origin.x + rect.x * s - pad)),
    y: Math.max(0, Math.round(origin.y + rect.y * s - pad)),
    width: Math.round(rect.width * s + pad * 2),
    height: Math.round(rect.height * s + pad * 2),
  }))
}

/** The sprite's *visible* bounds in screen coordinates. What the harness asserts against. */
export function spriteScreenRect(
  mask: AlphaMaskData,
  windowBounds: { x: number; y: number },
  origin: { x: number; y: number },
  scale = 1,
): MaskRect {
  const s = scale > 0 ? scale : 1
  return {
    x: Math.round(windowBounds.x + origin.x + mask.bbox.x * s),
    y: Math.round(windowBounds.y + origin.y + mask.bbox.y * s),
    width: Math.round(mask.bbox.width * s),
    height: Math.round(mask.bbox.height * s),
  }
}

/** Half the visible body width — the amount the pet's centre must stay clear of a screen edge. */
export function bodyHalfWidth(mask: AlphaMaskData, scale = 1): number {
  return (mask.bbox.width * (scale > 0 ? scale : 1)) / 2
}
