/**
 * Where the window goes so that the pet's feet land on the floor. Pure.
 *
 * ---------------------------------------------------------------------------------------
 * The formula, and the one that was wrong.
 * ---------------------------------------------------------------------------------------
 *
 * docs/PROMPT.md §4.3 originally gave:
 *
 *     y = floor.y - windowHeight + bubbleAreaHeight + footInset
 *
 * That double-counts. The bubble area sits *above* the sprite, so adding it lifts the pet by the
 * full bubble height — 112px of daylight between its shoes and the Dock.
 *
 * The correct term is the sprite's *bottom* offset inside the window:
 *
 *     y = floor.y - (spriteOrigin.y + frameHeight - footInset)
 *
 * `spriteOrigin.y + frameHeight` is where the sprite cell's bottom edge sits inside the window;
 * subtracting `footInset` moves up to the lowest *opaque* pixel, which is what "the feet" means.
 * For this art that is `floor.y - 304`. Derived here, once, from the measured mask — so an art
 * pack with different padding re-derives it with no code change.
 *
 * ---------------------------------------------------------------------------------------
 * Why the window is allowed off-screen, and the pet is not.
 * ---------------------------------------------------------------------------------------
 *
 * The window (360px) is far wider than the visible character (107px). Clamping *window* bounds
 * to the work area would stop the pet's body ~126px short of the screen edge, and that gap of
 * nothing looks exactly like the bug it was meant to prevent. So the window may hang partly
 * off-screen and the *pet's centre x* is what gets clamped.
 */

import { ALPHA_MASK, bodyHalfWidth, type AlphaMaskData } from '../sprite/alpha-mask.js'
import { SHEET } from '../pet-animations.generated.js'
import type { Floor } from './display-manager.js'

/** Width leaves room for a speech bubble wider than the sprite. */
export const PET_WINDOW_WIDTH = 360

/** Height reserved above the sprite cell for the callout bubble. */
export const BUBBLE_AREA_HEIGHT = 112

/**
 * The window's height ends at the sprite's lowest *opaque* row, not at the bottom of its cell.
 *
 * Found by assertion, not by reasoning: with the window sized to the full cell, its bottom 16 rows
 * are transparent padding, so putting the feet on the work-area floor requires the window to
 * extend 16px *below* that floor — into the Dock strip. macOS clamps a window back inside the
 * visible frame when it tries that, which silently lifted the pet 16px and left it hovering.
 *
 * Trimming the empty rows instead means the window bottom *is* the feet, so nothing ever needs to
 * hang below the work area and there is nothing for the OS to clamp. The clipped rows are
 * transparent, so nothing visible is lost. Derived from the measured mask, so a differently
 * padded art pack re-derives it with no code change.
 */
export const PET_WINDOW_HEIGHT = BUBBLE_AREA_HEIGHT + SHEET.frameHeight - ALPHA_MASK.footInset

export const PET_WINDOW = { width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT } as const

export interface Placement {
  windowSize: { width: number; height: number }
  /** Sprite cell's top-left inside the window. */
  spriteOrigin: { x: number; y: number }
  /**
   * Distance from the window's left edge to the pet's visible-body centre. Converting between
   * "where the pet is" and "where the window is" goes through this and nothing else.
   */
  spriteCentreOffset: number
  footInset: number
  /** Distance from the window's top edge to the pet's lowest opaque pixel. */
  spriteBottomOffset: number
}

export function computePlacement(
  mask: AlphaMaskData = ALPHA_MASK,
  window: { width: number; height: number } = PET_WINDOW,
  bubbleAreaHeight: number = BUBBLE_AREA_HEIGHT,
): Placement {
  // Centre the sprite cell horizontally; hang it below the bubble area. The cell's bottom rows
  // may fall outside the window — see PET_WINDOW_HEIGHT — and that is deliberate.
  const spriteOrigin = {
    x: Math.round((window.width - mask.frameWidth) / 2),
    y: bubbleAreaHeight,
  }

  return {
    windowSize: { width: window.width, height: window.height },
    spriteOrigin,
    spriteCentreOffset: spriteOrigin.x + mask.bbox.x + mask.bbox.width / 2,
    footInset: mask.footInset,
    spriteBottomOffset: spriteOrigin.y + mask.frameHeight - mask.footInset,
  }
}

/**
 * Window y that puts the pet's lowest opaque pixel exactly on `feetY - 1`.
 *
 * Named for the floor because that is the only y the pet had before it became freely placeable; it
 * takes any feet-y now, and the floor is simply the default one.
 */
export function windowYForFloor(feetY: number, placement: Placement): number {
  return Math.round(feetY - placement.spriteBottomOffset)
}

/** Feet-y for a given window y. The inverse of the above. */
export function feetYForWindowY(windowY: number, placement: Placement): number {
  return windowY + placement.spriteBottomOffset
}

/** Window x for a given pet-centre x. */
export function windowXForPetCentre(petCentreX: number, placement: Placement): number {
  return Math.round(petCentreX - placement.spriteCentreOffset)
}

/** Pet-centre x for a given window x. The inverse of the above. */
export function petCentreForWindowX(windowX: number, placement: Placement): number {
  return windowX + placement.spriteCentreOffset
}

/**
 * The floor for a display: the horizontal band the pet's centre may occupy, and the y its feet
 * rest on. `bodyHalfWidth` rather than half the window, so the body can reach the screen edge.
 */
export function floorForWorkArea(
  workArea: { x: number; y: number; width: number; height: number },
  displayKey: string,
  mask: AlphaMaskData = ALPHA_MASK,
  placement: Placement = computePlacement(mask),
): Floor {
  const half = bodyHalfWidth(mask)
  const floorY = workArea.y + workArea.height
  // The highest the feet may go is set by the *window*, not the body: `spriteBottomOffset` is the
  // distance from the window's top edge down to the feet, so keeping the window top at or below the
  // work area's top means feetY >= workArea.y + spriteBottomOffset.
  const minFeetY = workArea.y + placement.spriteBottomOffset
  return {
    minX: workArea.x + half,
    maxX: workArea.x + workArea.width - half,
    y: floorY,
    // A work area shorter than the window (a tiny display, or a huge art pack) would invert these.
    // Collapsing to the floor is the honest degradation: the pet stays where it can be seen.
    minFeetY: Math.min(minFeetY, floorY),
    maxFeetY: floorY,
    displayKey,
  }
}

/** Clamp a pet-centre x into a floor. Applied every tick, which makes a monitor unplug self-correcting. */
export function clampToFloor(petCentreX: number, floor: Floor): number {
  if (floor.maxX <= floor.minX) return (floor.minX + floor.maxX) / 2
  return Math.min(floor.maxX, Math.max(floor.minX, petCentreX))
}

/** Clamp a feet-y into a floor's vertical envelope. Applied every tick, for the same reason. */
export function clampFeetY(feetY: number, floor: Floor): number {
  if (floor.maxFeetY <= floor.minFeetY) return floor.maxFeetY
  return Math.min(floor.maxFeetY, Math.max(floor.minFeetY, feetY))
}

/**
 * How close to the floor a drop counts as "on the floor".
 *
 * Dropping the pet near the bottom re-locks it to the floor, so dragging it back down is how you
 * undo a free placement — no menu item needed. Without a threshold you could never re-lock by hand,
 * because landing on the exact pixel is not a thing anyone can do with a mouse.
 */
export const FLOOR_SNAP_PX = 24

export function isOnFloor(feetY: number, floor: Floor): boolean {
  return feetY >= floor.maxFeetY - FLOOR_SNAP_PX
}
