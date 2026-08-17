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
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 254,
  0, 0, 0, 3, 255, 255, 224, 0, 0, 51, 255, 255, 236, 0, 0, 63,
  255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 63, 255, 255, 254, 0,
  0, 63, 255, 255, 254, 0, 0, 31, 255, 255, 252, 0, 0, 31, 255, 255,
  248, 0, 0, 63, 255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 63,
  255, 255, 252, 0, 0, 31, 255, 255, 248, 0, 0, 63, 255, 255, 252, 0,
  0, 63, 255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 63, 255, 255,
  252, 0, 0, 63, 255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 63,
  255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 63, 255, 255, 252, 0,
  0, 63, 255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 31, 255, 255,
  248, 0, 0, 31, 255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 63,
  255, 255, 254, 0, 0, 63, 255, 255, 254, 0, 0, 63, 255, 255, 254, 0,
  0, 63, 255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 63, 255, 255,
  252, 0, 0, 63, 255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 63,
  255, 255, 252, 0, 0, 63, 255, 255, 252, 0, 0, 63, 255, 255, 252, 0,
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
  bbox: { x: 40, y: 42, width: 113, height: 150 },
  footInset: 16,
  footInsetByState: {
  'drink': 16,
  'failed': 16,
  'idle': 16,
  'jumping': 16,
  'jumping-left': 16,
  'jumping-right': 16,
  'review': 16,
  'running': 16,
  'running-left': 16,
  'running-right': 16,
  'sleep': 16,
  'stretch': 16,
  'waving': 16,
  },
  headTopByState: {
  'drink': 42,
  'failed': 42,
  'idle': 42,
  'jumping': 42,
  'jumping-left': 42,
  'jumping-right': 42,
  'review': 42,
  'running': 42,
  'running-left': 42,
  'running-right': 42,
  'sleep': 42,
  'stretch': 42,
  'waving': 42,
  },
  shapeRects: [
  { x: 80, y: 40, width: 44, height: 4 },
  { x: 56, y: 44, width: 84, height: 8 },
  { x: 40, y: 48, width: 8, height: 4 },
  { x: 144, y: 48, width: 8, height: 4 },
  { x: 40, y: 52, width: 112, height: 8 },
  { x: 40, y: 60, width: 116, height: 8 },
  { x: 44, y: 68, width: 108, height: 4 },
  { x: 44, y: 72, width: 104, height: 4 },
  { x: 40, y: 76, width: 112, height: 12 },
  { x: 44, y: 88, width: 104, height: 4 },
  { x: 40, y: 92, width: 112, height: 44 },
  { x: 44, y: 136, width: 104, height: 4 },
  { x: 44, y: 140, width: 108, height: 4 },
  { x: 40, y: 144, width: 112, height: 4 },
  { x: 40, y: 148, width: 116, height: 12 },
  { x: 40, y: 160, width: 112, height: 32 },
  ],
  bits: new Uint8Array(BITS),
  stats: {
    unionOpaquePixels: 15737,
    cellPixels: 39936,
    maskSetCells: 1034,
    maskTotalCells: 2496,
    framesMeasured: 111,
    perFrameOpaqueMin: 7339,
    perFrameOpaqueMax: 9407,
    perFrameOpaqueMean: 8184,
    shapeRectsArea: 16544,
    maskArea: 16544,
  },
  sourceSha256: '76d396080aeaef5855fc879486a13e0a80b82b7c675ee3eca5838d46d7641b2d',
}
