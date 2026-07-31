#!/usr/bin/env node
/**
 * Generate the alpha mask from the spritesheet.
 *
 *   node scripts/generate-alpha-mask.mjs [--check] [--granularity 4] [--max-shape-rects 48]
 *
 * One artifact, three consumers:
 *
 *   1. **Renderer hit-testing.** The character fills only ~21% of its 192x208 cell, and the
 *      transparent margin is overwhelmingly horizontal (the body is 107px of 192). Hit-testing
 *      window bounds would therefore eat clicks across a wide invisible band beside the pet.
 *   2. **Linux `setShape`.** Electron cannot forward mouse events on Linux, so a click-through
 *      window there is permanently ungrabbable. Instead the window stays interactive and its
 *      *input region* is restricted to these rects.
 *   3. **Floor placement.** `footInset` is the distance from the bottom of the cell to the
 *      lowest opaque pixel. Without it the pet floats above the Dock or sinks into it, and
 *      hardcoding the number breaks the moment the art is swapped.
 *
 * Emits both a JSON artifact (readable by tests and humans) and a TypeScript module (what the
 * app imports). The duplication is deliberate: JSON import behaves differently across tsc-ESM
 * main, a sandboxed renderer, and an asar archive, and a generated .ts sidesteps all three. A
 * test asserts the two agree on every field.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { decodePng } from './lib/png.mjs'
import { loadSpritesheet, ROOT, SPRITESHEET_PNG } from './lib/spritesheet.mjs'
import {
  buildUnion,
  boundingBox,
  toCellGrid,
  packBits,
  toShapeRects,
  rectsArea,
  ALPHA_THRESHOLD,
  GRANULARITY,
} from './lib/mask.mjs'
import { emitOrCheck, reportResults, tsBanner } from './lib/generated-file.mjs'

const JSON_OUT = join(ROOT, 'apps', 'desktop', 'assets', 'pet', 'alpha-mask.json')
const TS_OUT = join(ROOT, 'apps', 'desktop', 'src', 'sprite', 'alpha-mask.generated.ts')

function numberArg(flag, fallback) {
  const at = process.argv.indexOf(flag)
  if (at === -1) return fallback
  const value = Number(process.argv[at + 1])
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${flag} needs a positive number.`)
    process.exit(2)
  }
  return value
}

function main() {
  const check = process.argv.includes('--check')
  const granularity = numberArg('--granularity', GRANULARITY)
  const maxShapeRects = numberArg('--max-shape-rects', 48)

  const { sheet, states } = loadSpritesheet()
  const pngBytes = readFileSync(SPRITESHEET_PNG)
  const png = decodePng(pngBytes)

  if (png.width !== sheet.width || png.height !== sheet.height) {
    console.error(
      `spritesheet.png is ${png.width}x${png.height} but spritesheet.json declares ` +
        `${sheet.width}x${sheet.height}. Fix one of them before regenerating.`,
    )
    process.exit(2)
  }

  const { union, perFrameOpaque, footInsetByState } = buildUnion(png, sheet, states)
  const bbox = boundingBox(union, sheet.frameWidth, sheet.frameHeight)
  const { cells, cols, rows } = toCellGrid(union, sheet.frameWidth, sheet.frameHeight, granularity)
  const bits = packBits(cells)
  const shapeRects = toShapeRects(cells, cols, rows, granularity, maxShapeRects)

  const unionOpaque = union.reduce((sum, v) => sum + v, 0)
  const maskSetCells = cells.reduce((sum, v) => sum + v, 0)

  // Every state on this art has the same footInset (the feet are drawn at the same height in
  // every pose), so a single constant is correct. Taking the minimum is the safe reading if a
  // future art pack differs: it places the window so the *lowest* pose still touches the floor,
  // which means no pose ever clips below it.
  const footInset = Math.min(...Object.values(footInsetByState))

  const data = {
    granularity,
    alphaThreshold: ALPHA_THRESHOLD,
    cols,
    rows,
    frameWidth: sheet.frameWidth,
    frameHeight: sheet.frameHeight,
    bbox,
    footInset,
    footInsetByState,
    shapeRects,
    stats: {
      unionOpaquePixels: unionOpaque,
      cellPixels: sheet.frameWidth * sheet.frameHeight,
      maskSetCells,
      maskTotalCells: cols * rows,
      framesMeasured: perFrameOpaque.length,
      perFrameOpaqueMin: Math.min(...perFrameOpaque),
      perFrameOpaqueMax: Math.max(...perFrameOpaque),
      perFrameOpaqueMean: Math.round(perFrameOpaque.reduce((a, b) => a + b, 0) / perFrameOpaque.length),
      shapeRectsArea: rectsArea(shapeRects),
      maskArea: maskSetCells * granularity * granularity,
    },
    bitsBase64: Buffer.from(bits).toString('base64'),
    sourceSha256: createHash('sha256').update(pngBytes).digest('hex'),
  }

  const results = [
    emitOrCheck(JSON_OUT, `${JSON.stringify(data, null, 2)}\n`, { check }),
    emitOrCheck(TS_OUT, buildTs(data, bits), { check }),
  ]

  reportResults(
    `alpha mask (${maskSetCells}/${cols * rows} cells, ${shapeRects.length} rects, footInset ${footInset})`,
    results,
    { check },
  )
}

/** Format bytes as indented rows of 16, so the generated file stays reviewable. */
function chunkNumbers(bytes) {
  const rows = []
  for (let i = 0; i < bytes.length; i += 16) {
    rows.push(`  ${Array.from(bytes.slice(i, i + 16)).join(', ')},`)
  }
  return rows.join('\n')
}

function buildTs(data, bits) {
  const rects = data.shapeRects
    .map((r) => `  { x: ${r.x}, y: ${r.y}, width: ${r.width}, height: ${r.height} },`)
    .join('\n')

  const footByState = Object.entries(data.footInsetByState)
    .map(([name, inset]) => `  '${name}': ${inset},`)
    .join('\n')

  return `${tsBanner()}
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
${chunkNumbers(bits)}
]

export const ALPHA_MASK: AlphaMaskData = {
  granularity: ${data.granularity},
  alphaThreshold: ${data.alphaThreshold},
  cols: ${data.cols},
  rows: ${data.rows},
  frameWidth: ${data.frameWidth},
  frameHeight: ${data.frameHeight},
  bbox: { x: ${data.bbox.x}, y: ${data.bbox.y}, width: ${data.bbox.width}, height: ${data.bbox.height} },
  footInset: ${data.footInset},
  footInsetByState: {
${footByState}
  },
  shapeRects: [
${rects}
  ],
  bits: new Uint8Array(BITS),
  stats: {
    unionOpaquePixels: ${data.stats.unionOpaquePixels},
    cellPixels: ${data.stats.cellPixels},
    maskSetCells: ${data.stats.maskSetCells},
    maskTotalCells: ${data.stats.maskTotalCells},
    framesMeasured: ${data.stats.framesMeasured},
    perFrameOpaqueMin: ${data.stats.perFrameOpaqueMin},
    perFrameOpaqueMax: ${data.stats.perFrameOpaqueMax},
    perFrameOpaqueMean: ${data.stats.perFrameOpaqueMean},
    shapeRectsArea: ${data.stats.shapeRectsArea},
    maskArea: ${data.stats.maskArea},
  },
  sourceSha256: '${data.sourceSha256}',
}
`
}

main()
