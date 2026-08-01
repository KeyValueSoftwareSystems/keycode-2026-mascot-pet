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
  0, 0, 0, 0, 25, 128, 0, 0, 0, 0, 31, 248, 0, 0, 0, 0,
  127, 252, 0, 0, 0, 1, 255, 254, 0, 0, 0, 1, 255, 255, 128, 0,
  0, 1, 255, 255, 128, 0, 0, 3, 255, 255, 192, 0, 0, 3, 255, 255,
  192, 0, 0, 7, 255, 255, 192, 0, 0, 3, 255, 255, 224, 0, 0, 3,
  255, 255, 192, 0, 0, 7, 255, 255, 192, 0, 0, 3, 255, 255, 224, 0,
  0, 7, 255, 255, 224, 0, 0, 7, 255, 255, 240, 0, 0, 7, 255, 255,
  224, 0, 0, 7, 255, 255, 224, 0, 0, 7, 255, 255, 224, 0, 0, 7,
  255, 255, 224, 0, 0, 15, 255, 255, 192, 0, 0, 31, 255, 255, 248, 0,
  0, 63, 255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 63, 255, 255,
  252, 0, 0, 31, 255, 255, 248, 0, 0, 15, 255, 255, 240, 0, 0, 15,
  255, 255, 240, 0, 0, 7, 255, 255, 224, 0, 0, 3, 255, 255, 192, 0,
  0, 3, 255, 255, 224, 0, 0, 7, 255, 255, 224, 0, 0, 7, 255, 255,
  224, 0, 0, 7, 255, 255, 224, 0, 0, 7, 255, 255, 224, 0, 0, 7,
  255, 255, 224, 0, 0, 7, 255, 255, 224, 0, 0, 7, 255, 255, 192, 0,
  0, 7, 255, 255, 192, 0, 0, 7, 255, 255, 192, 0, 0, 7, 255, 255,
  192, 0, 0, 7, 255, 255, 192, 0, 0, 7, 255, 255, 192, 0, 0, 7,
  255, 255, 192, 0, 0, 3, 255, 255, 128, 0, 0, 3, 255, 255, 128, 0,
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
  bbox: { x: 42, y: 14, width: 107, height: 178 },
  footInset: 16,
  footInsetByState: {
  'drink': 16,
  'failed': 16,
  'idle': 16,
  'jumping': 16,
  'review': 16,
  'running': 16,
  'running-left': 16,
  'running-right': 16,
  'sleep': 16,
  'waving': 16,
  },
  headTopByState: {
  'drink': 37,
  'failed': 52,
  'idle': 37,
  'jumping': 46,
  'review': 14,
  'running': 28,
  'running-left': 46,
  'running-right': 51,
  'sleep': 37,
  'waving': 37,
  },
  shapeRects: [
  { x: 76, y: 12, width: 8, height: 4 },
  { x: 92, y: 12, width: 8, height: 4 },
  { x: 76, y: 16, width: 40, height: 4 },
  { x: 68, y: 20, width: 52, height: 4 },
  { x: 60, y: 24, width: 64, height: 4 },
  { x: 60, y: 28, width: 72, height: 8 },
  { x: 56, y: 36, width: 80, height: 8 },
  { x: 52, y: 44, width: 84, height: 4 },
  { x: 56, y: 48, width: 84, height: 4 },
  { x: 56, y: 52, width: 80, height: 4 },
  { x: 52, y: 56, width: 84, height: 4 },
  { x: 56, y: 60, width: 84, height: 4 },
  { x: 52, y: 64, width: 88, height: 4 },
  { x: 52, y: 68, width: 92, height: 4 },
  { x: 52, y: 72, width: 88, height: 16 },
  { x: 48, y: 88, width: 88, height: 4 },
  { x: 44, y: 92, width: 104, height: 4 },
  { x: 40, y: 96, width: 112, height: 12 },
  { x: 44, y: 108, width: 104, height: 4 },
  { x: 48, y: 112, width: 96, height: 8 },
  { x: 52, y: 120, width: 88, height: 4 },
  { x: 56, y: 124, width: 80, height: 4 },
  { x: 56, y: 128, width: 84, height: 4 },
  { x: 52, y: 132, width: 88, height: 24 },
  { x: 52, y: 156, width: 84, height: 28 },
  { x: 56, y: 184, width: 76, height: 8 },
  ],
  bits: new Uint8Array(BITS),
  stats: {
    unionOpaquePixels: 14111,
    cellPixels: 39936,
    maskSetCells: 942,
    maskTotalCells: 2496,
    framesMeasured: 63,
    perFrameOpaqueMin: 7393,
    perFrameOpaqueMax: 9725,
    perFrameOpaqueMean: 8349,
    shapeRectsArea: 15072,
    maskArea: 15072,
  },
  sourceSha256: '21be4df61b0b3ccc0c4fe4588fc5adb9916a3e145906481ecca45be71d66c5b5',
}
