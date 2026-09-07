/**
 * The status crowns: which art belongs to which Claude Code state, and how big it is worn.
 *
 * Shared by the asset generator (which produces the small PNGs) and the CSS generator (which
 * sizes and places them), so the crown's dimensions have exactly one definition. Hand-written
 * CSS is asserted to contain no such geometry.
 */

/** Claude Code state -> source art. Order is the order they are emitted in. */
export const CROWNS = [
  { state: 'waiting', source: 'waiting.png', file: 'crown-waiting.png' },
  { state: 'running', source: 'running.png', file: 'crown-running.png' },
  { state: 'idle', source: 'idle.png', file: 'crown-idle.png' },
]

/**
 * Worn size, in unscaled sprite-cell pixels.
 *
 * The pet's head is ~40px of visible skull in a 192px cell, so a crown much wider than this
 * stops reading as worn and starts reading as a banner floating overhead. The height follows
 * the source art's 340x264 aspect ratio; changing the width without the height would squash it.
 */
export const CROWN_WIDTH = 28
export const CROWN_HEIGHT = 22

/**
 * Gap between the crown's bottom edge and the top of the head, in unscaled cell pixels.
 *
 * Deliberate daylight rather than a seated hat: it keeps the crown clear of the horn, which
 * reaches as high as the hair does, and reads as "status floating above the pet" rather than as
 * a costume change.
 */
export const CROWN_GAP = 4
