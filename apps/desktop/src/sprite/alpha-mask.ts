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

/** Which side of the pet the speech bubble is anchored on. */
export type BubbleSide = 'above' | 'below'

/**
 * Enough of the window's geometry to place things in it.
 *
 * Structural rather than an import of `Placement`, so `sprite/` stays independent of `main/` —
 * `Placement` satisfies this shape, but naming it here would close a cycle, since floor-placement
 * derives its whole geometry from this module.
 */
export interface WindowLayout {
  spriteOrigin: { x: number; y: number }
  scale: number
  windowWidth: number
  windowHeight: number
}

/**
 * Where in the window the bubble is allowed to paint, given the pose and which side it is on.
 *
 * `above` runs from the window's top edge down to the pose's topmost opaque pixel; `below` runs from
 * the pose's lowest opaque pixel to the window's bottom edge. Both are derived from the *per-state*
 * mask entries rather than the union bbox, because "jumping" reaches well above idle's hair and its
 * feet leave the ground — a band measured from the union would be short of the tail by that
 * difference, and the tail is the first thing to disappear.
 *
 * Full window width, because main cannot know how wide the bubble rendered: it is `max-content` and
 * depends on the text.
 */
export function bubbleBandRect(
  mask: AlphaMaskData,
  layout: WindowLayout,
  animation: string,
  side: BubbleSide,
): MaskRect {
  const s = layout.scale > 0 ? layout.scale : 1
  if (side === 'below') {
    const footInset = mask.footInsetByState[animation] ?? mask.footInset
    const bodyBottom = Math.round(layout.spriteOrigin.y + (mask.frameHeight - footInset) * s)
    return {
      x: 0,
      y: Math.max(0, bodyBottom),
      width: layout.windowWidth,
      height: Math.max(0, layout.windowHeight - Math.max(0, bodyBottom)),
    }
  }
  const headTop = mask.headTopByState[animation] ?? mask.bbox.y
  return {
    x: 0,
    y: 0,
    width: layout.windowWidth,
    height: Math.max(0, Math.round(layout.spriteOrigin.y + headTop * s)),
  }
}

/**
 * The Linux `setShape` region for a *specific frame* — sprite, plus whatever else is on screen.
 *
 * ### Why this is not just the sprite rects
 *
 * `setShape` is documented as determining "the area within the window where the system permits
 * **drawing** and user interaction. Outside of the given region, **no pixels will be drawn**."
 * Restricting the region to the character therefore does not merely stop clicks landing in the
 * window's transparent margin — it stops anything in that margin being *painted*. The speech bubble
 * lives entirely in a band above the sprite, so on Linux it was silently never drawn: only the sliver
 * overlapping the head's mask cells appeared. The sleep Z's, which sit above the hair, went the same
 * way.
 *
 * Nothing caught it because the only pixel evidence the harness produces is
 * `webContents.capturePage()`, which renders the web contents and never touches the window shape.
 *
 * ### Why over-covering is the right error
 *
 * The band is the full window width and the overlay region is the whole sprite cell, both larger than
 * what is actually painted. Too large costs a few click-throughs in empty space *while a bubble is up*;
 * too small makes the bubble invisible again. Those are not comparable costs.
 *
 * The overlay region is the sprite cell rather than the Z's own rectangle so that their offsets stay
 * in the stylesheet, where they belong — the Z's are positioned from `--sprite-x`/`--sprite-y`, which
 * puts them inside the cell by construction. It is also 192px wide rather than 360, and that matters
 * because sleep persists for as long as movement is off.
 */
export function shapeRectsForFrame(
  mask: AlphaMaskData,
  layout: WindowLayout,
  frame: {
    animation: string
    bubbleVisible: boolean
    overlayVisible: boolean
    quickMenuVisible?: boolean
    bubbleSide?: BubbleSide
  },
  options: { paddingPx?: number } = {},
): MaskRect[] {
  const s = layout.scale > 0 ? layout.scale : 1
  const rects = shapeRectsForWindow(mask, layout.spriteOrigin, {
    paddingPx: options.paddingPx,
    scale: s,
  })

  if (frame.bubbleVisible) {
    rects.push(bubbleBandRect(mask, layout, frame.animation, frame.bubbleSide ?? 'above'))
  }

  if (frame.overlayVisible) {
    rects.push({
      x: Math.max(0, layout.spriteOrigin.x),
      y: Math.max(0, layout.spriteOrigin.y),
      width: Math.round(mask.frameWidth * s),
      height: Math.round(mask.frameHeight * s),
    })
  }

  // Hover zap chip sits beside the *body*, not the cell. The cell is 192px and mostly empty, so a
  // strip hung off the cell's right edge misses the 36px button (which CSS places at
  // `--body-cx + 52px`) and Linux clips it to a notch. Same anchors as `#quick-menu` in pet.css;
  // size is CSS px (the chip does not shrink with the pet), offsets scale. Glow padding is the
  // `0 0 10px 2px` box-shadow — too small and the halo is eaten the same way the button was.
  if (frame.quickMenuVisible) {
    const chipSize = 36
    const chipGlow = 14
    const bodyCx = layout.spriteOrigin.x + (mask.bbox.x + mask.bbox.width / 2) * s
    const headTop =
      layout.spriteOrigin.y + (mask.headTopByState[frame.animation] ?? mask.bbox.y) * s
    rects.push({
      x: Math.round(bodyCx + 52 * s - chipGlow),
      y: Math.round(headTop + 36 * s - chipGlow),
      width: chipSize + chipGlow * 2,
      height: chipSize + chipGlow * 2,
    })
  }

  // Clipped to the window, and empties dropped. A rect reaching past the window is not defined
  // behaviour in Electron's `setShape`, and an empty one is a wasted region entry.
  return rects
    .map((rect) => {
      const x = Math.max(0, Math.min(rect.x, layout.windowWidth))
      const y = Math.max(0, Math.min(rect.y, layout.windowHeight))
      return {
        x,
        y,
        width: Math.min(rect.width, layout.windowWidth - x),
        height: Math.min(rect.height, layout.windowHeight - y),
      }
    })
    .filter((rect) => rect.width > 0 && rect.height > 0)
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
