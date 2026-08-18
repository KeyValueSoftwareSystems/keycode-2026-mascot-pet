/*
 * GENERATED FILE — DO NOT EDIT.
 * Source of truth: pet/spritesheet.json
 * Regenerate with: pnpm generate
 */

export interface MaskRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface AlphaMaskData {
  /** Mask cell size in pixels. */
  readonly granularity: number
  readonly alphaThreshold: number
  readonly cols: number
  readonly rows: number
  readonly frameWidth: number
  readonly frameHeight: number
  /** Tight bounds of the union of every frame, in cell-local pixels. */
  readonly bbox: MaskRect
  /** Cell bottom to lowest opaque pixel. The floor-placement input. */
  readonly footInset: number
  readonly footInsetByState: Readonly<Record<string, number>>
  /**
   * Cell top to the *highest* opaque pixel, per state. Where the speech bubble's tail points.
   *
   * Per state rather than from the union bbox: "jumping" reaches well above idle's hair, so a
   * union-anchored bubble floats a visible gap above the character in every other pose. Per state
   * rather than per frame because a per-frame anchor makes the bubble bob with the animation.
   */
  readonly headTopByState: Readonly<Record<string, number>>
  /** Cell-local rects covering the mask, for Electron setShape on Linux. */
  readonly shapeRects: readonly MaskRect[]
  /** Row-major, MSB-first coverage bits over the cell grid. */
  readonly bits: Uint8Array
  readonly stats: {
    readonly unionOpaquePixels: number
    readonly cellPixels: number
    readonly maskSetCells: number
    readonly maskTotalCells: number
    readonly framesMeasured: number
    readonly perFrameOpaqueMin: number
    readonly perFrameOpaqueMax: number
    readonly perFrameOpaqueMean: number
    readonly shapeRectsArea: number
    readonly maskArea: number
  }
  /** sha256 of the spritesheet the mask was built from. */
  readonly sourceSha256: string
}

/**
 * Coverage bits as plain byte values.
 *
 * Deliberately not base64: this module is compiled by both the main-process tsconfig (node types)
 * and the renderer tsconfig (DOM types, no node types), so it can reference neither Buffer nor
 * atob. A literal array needs no decoding at all and works identically on both sides.
 */
const BITS: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24, 24, 0, 0,
  0, 0, 124, 62, 0, 0, 0, 0, 254, 63, 128, 0, 0, 1, 255, 255,
  192, 0, 0, 31, 255, 255, 248, 0, 0, 31, 255, 255, 248, 0, 0, 31,
  255, 255, 248, 0, 0, 63, 255, 255, 252, 0, 0, 255, 255, 255, 255, 0,
  0, 255, 255, 255, 254, 0, 1, 255, 255, 255, 255, 0, 1, 255, 255, 255,
  255, 0, 1, 255, 255, 255, 255, 128, 0, 255, 255, 255, 255, 224, 1, 255,
  255, 255, 255, 224, 1, 255, 255, 255, 255, 224, 3, 255, 255, 255, 255, 224,
  7, 255, 255, 255, 255, 192, 7, 255, 255, 255, 255, 192, 7, 255, 255, 255,
  255, 224, 7, 255, 255, 255, 255, 224, 7, 255, 255, 255, 255, 224, 7, 255,
  255, 255, 255, 128, 7, 255, 255, 255, 255, 128, 7, 255, 255, 255, 255, 128,
  7, 255, 255, 255, 255, 0, 1, 255, 255, 255, 255, 224, 1, 255, 255, 255,
  255, 224, 0, 63, 255, 255, 255, 240, 1, 191, 255, 255, 255, 240, 3, 255,
  255, 255, 255, 248, 3, 255, 255, 255, 255, 248, 15, 255, 255, 255, 255, 248,
  31, 255, 255, 255, 255, 248, 31, 255, 255, 255, 255, 240, 31, 255, 255, 255,
  255, 0, 31, 255, 255, 255, 255, 0, 31, 255, 255, 255, 255, 0, 31, 255,
  255, 255, 255, 0, 31, 255, 255, 255, 252, 0, 31, 255, 255, 255, 252, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
]

export const ALPHA_MASK: AlphaMaskData = {
  granularity: 4,
  alphaThreshold: 8,
  cols: 48,
  rows: 52,
  frameWidth: 192,
  frameHeight: 208,
  bbox: { x: 13, y: 31, width: 167, height: 161 },
  footInset: 16,
  footInsetByState: {
  'drink': 16,
  'electrocute': 16,
  'failed': 16,
  'idle': 16,
  'idle-left': 16,
  'jumping': 16,
  'jumping-left': 16,
  'jumping-right': 16,
  'panic': 16,
  'review': 16,
  'review-left': 16,
  'running': 16,
  'running-left': 16,
  'running-right': 16,
  'sleep': 16,
  'sleep-enter': 16,
  'sleep-exit': 16,
  'stretch': 16,
  'waving': 16,
  },
  headTopByState: {
  'drink': 42,
  'electrocute': 42,
  'failed': 42,
  'idle': 42,
  'idle-left': 42,
  'jumping': 42,
  'jumping-left': 42,
  'jumping-right': 42,
  'panic': 42,
  'review': 31,
  'review-left': 31,
  'running': 42,
  'running-left': 42,
  'running-right': 42,
  'sleep': 128,
  'sleep-enter': 43,
  'sleep-exit': 44,
  'stretch': 42,
  'waving': 47,
  },
  shapeRects: [
  { x: 76, y: 28, width: 8, height: 4 },
  { x: 108, y: 28, width: 8, height: 4 },
  { x: 68, y: 32, width: 20, height: 4 },
  { x: 104, y: 32, width: 20, height: 4 },
  { x: 64, y: 36, width: 28, height: 4 },
  { x: 104, y: 36, width: 28, height: 4 },
  { x: 60, y: 40, width: 76, height: 4 },
  { x: 44, y: 44, width: 104, height: 12 },
  { x: 40, y: 56, width: 112, height: 4 },
  { x: 32, y: 60, width: 128, height: 4 },
  { x: 32, y: 64, width: 124, height: 4 },
  { x: 28, y: 68, width: 132, height: 8 },
  { x: 28, y: 76, width: 136, height: 4 },
  { x: 32, y: 80, width: 140, height: 4 },
  { x: 28, y: 84, width: 144, height: 8 },
  { x: 24, y: 92, width: 148, height: 4 },
  { x: 20, y: 96, width: 148, height: 8 },
  { x: 20, y: 104, width: 152, height: 12 },
  { x: 20, y: 116, width: 144, height: 12 },
  { x: 20, y: 128, width: 140, height: 4 },
  { x: 28, y: 132, width: 144, height: 8 },
  { x: 40, y: 140, width: 136, height: 8 },
  { x: 28, y: 144, width: 8, height: 4 },
  { x: 24, y: 148, width: 156, height: 8 },
  { x: 16, y: 156, width: 164, height: 4 },
  { x: 12, y: 160, width: 168, height: 4 },
  { x: 12, y: 164, width: 164, height: 4 },
  { x: 12, y: 168, width: 148, height: 16 },
  { x: 12, y: 184, width: 140, height: 8 },
  ],
  bits: new Uint8Array(BITS),
  stats: {
    unionOpaquePixels: 20653,
    cellPixels: 39936,
    maskSetCells: 1353,
    maskTotalCells: 2496,
    framesMeasured: 237,
    perFrameOpaqueMin: 6174,
    perFrameOpaqueMax: 13789,
    perFrameOpaqueMean: 8151,
    shapeRectsArea: 21648,
    maskArea: 21648,
  },
  sourceSha256: 'd641ab703b3803d00ac3ffea199ebf35282a6b3acf09f37c9a0cebae4c508054',
}
