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
  0, 0, 0, 0, 63, 224, 0, 0, 0, 62, 63, 252, 124, 0, 0, 127,
  255, 255, 254, 0, 0, 127, 255, 255, 254, 0, 0, 127, 255, 255, 254, 0,
  0, 255, 255, 255, 254, 0, 0, 255, 255, 255, 254, 0, 0, 255, 255, 255,
  254, 0, 0, 255, 255, 255, 254, 0, 0, 127, 255, 255, 254, 0, 0, 127,
  255, 255, 252, 0, 0, 31, 255, 255, 248, 0, 0, 31, 255, 255, 248, 0,
  0, 31, 255, 255, 248, 0, 0, 31, 255, 255, 248, 0, 0, 31, 255, 255,
  248, 0, 0, 31, 255, 255, 248, 0, 0, 31, 255, 255, 248, 0, 0, 31,
  255, 255, 252, 0, 0, 15, 255, 255, 254, 0, 0, 63, 255, 255, 254, 0,
  0, 127, 255, 255, 254, 0, 0, 127, 255, 255, 254, 0, 0, 127, 255, 255,
  254, 0, 0, 127, 255, 255, 252, 0, 0, 127, 255, 255, 252, 0, 0, 127,
  255, 255, 240, 0, 0, 63, 255, 255, 240, 0, 0, 15, 255, 255, 240, 0,
  0, 15, 255, 255, 240, 0, 0, 31, 255, 255, 248, 0, 0, 63, 255, 255,
  252, 0, 0, 63, 255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 63,
  255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 31, 255, 255, 248, 0,
  0, 15, 255, 255, 240, 0, 0, 15, 255, 255, 224, 0, 0, 15, 255, 255,
  224, 0, 0, 15, 255, 255, 224, 0, 0, 31, 255, 255, 224, 0, 0, 31,
  255, 255, 224, 0, 0, 15, 255, 255, 224, 0, 0, 15, 255, 255, 192, 0,
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
  bbox: { x: 35, y: 13, width: 121, height: 179 },
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
  'stretch': 16,
  'waving': 16,
  },
  headTopByState: {
  'drink': 24,
  'failed': 52,
  'idle': 37,
  'jumping': 46,
  'review': 14,
  'running': 28,
  'running-left': 46,
  'running-right': 51,
  'sleep': 37,
  'stretch': 13,
  'waving': 37,
  },
  shapeRects: [
  { x: 72, y: 12, width: 36, height: 4 },
  { x: 40, y: 16, width: 20, height: 4 },
  { x: 72, y: 16, width: 48, height: 4 },
  { x: 132, y: 16, width: 20, height: 4 },
  { x: 36, y: 20, width: 120, height: 12 },
  { x: 32, y: 32, width: 124, height: 16 },
  { x: 36, y: 48, width: 120, height: 4 },
  { x: 36, y: 52, width: 116, height: 4 },
  { x: 44, y: 56, width: 104, height: 28 },
  { x: 44, y: 84, width: 108, height: 4 },
  { x: 48, y: 88, width: 108, height: 4 },
  { x: 40, y: 92, width: 116, height: 4 },
  { x: 36, y: 96, width: 120, height: 12 },
  { x: 36, y: 108, width: 116, height: 8 },
  { x: 36, y: 116, width: 108, height: 4 },
  { x: 40, y: 120, width: 104, height: 4 },
  { x: 48, y: 124, width: 96, height: 8 },
  { x: 44, y: 132, width: 104, height: 4 },
  { x: 40, y: 136, width: 112, height: 20 },
  { x: 44, y: 156, width: 104, height: 4 },
  { x: 48, y: 160, width: 96, height: 4 },
  { x: 48, y: 164, width: 92, height: 12 },
  { x: 44, y: 176, width: 96, height: 8 },
  { x: 48, y: 184, width: 92, height: 4 },
  { x: 48, y: 188, width: 88, height: 4 },
  ],
  bits: new Uint8Array(BITS),
  stats: {
    unionOpaquePixels: 18162,
    cellPixels: 39936,
    maskSetCells: 1196,
    maskTotalCells: 2496,
    framesMeasured: 72,
    perFrameOpaqueMin: 7393,
    perFrameOpaqueMax: 13060,
    perFrameOpaqueMean: 9078,
    shapeRectsArea: 19136,
    maskArea: 19136,
  },
  sourceSha256: '89dff51fb4501ea62bbb3d7586aa83fda7110311967b6a3ac04d449242c7ce66',
}
