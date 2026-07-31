#!/usr/bin/env node
/**
 * Derive the tray icon from the pet's own silhouette.
 *
 *   node scripts/generate-tray-icon.mjs [--check]
 *
 * Why derive rather than hand-author: it keeps the "swap the spritesheet, change no code"
 * promise whole. A new art pack regenerates its own tray glyph.
 *
 * Why a silhouette rather than a downscaled sprite: `preview.png` is a full-colour chibi;
 * at 16px it is mud. A macOS tray icon wants a **template image** — black pixels plus alpha,
 * which the system recolours for light and dark menu bars. So we take the alpha channel of
 * one idle frame, box-downsample it to 16px and 32px, and paint it solid black.
 *
 * Output (committed, so CI never needs to run this):
 *   apps/desktop/assets/tray/trayIconTemplate.png     16x16
 *   apps/desktop/assets/tray/trayIconTemplate@2x.png  32x32
 */

import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, alphaAt } from './lib/png.mjs'
import { emitOrCheckBuffer, reportResults } from './lib/generated-file.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SHEET = join(ROOT, 'pet', 'spritesheet.png')
const SPRITE_JSON = join(ROOT, 'pet', 'spritesheet.json')
const OUT_DIR = join(ROOT, 'apps', 'desktop', 'assets', 'tray')

const ALPHA_THRESHOLD = 8

/**
 * Box-downsample a source alpha region to `size`x`size`, then emit solid black + that alpha.
 *
 * Coverage-based rather than nearest-neighbour: at 16px a limb is a couple of source pixels
 * wide, and point-sampling drops it entirely. Averaging keeps the shape legible.
 */
function silhouette(png, region, size) {
  const rgba = new Uint8Array(size * size * 4)
  const cell = { w: region.width / size, h: region.height / size }

  for (let ty = 0; ty < size; ty += 1) {
    for (let tx = 0; tx < size; tx += 1) {
      const x0 = Math.floor(region.x + tx * cell.w)
      const x1 = Math.max(x0 + 1, Math.floor(region.x + (tx + 1) * cell.w))
      const y0 = Math.floor(region.y + ty * cell.h)
      const y1 = Math.max(y0 + 1, Math.floor(region.y + (ty + 1) * cell.h))

      let covered = 0
      let total = 0
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          total += 1
          if (alphaAt(png, x, y) > ALPHA_THRESHOLD) covered += 1
        }
      }

      const coverage = total === 0 ? 0 : covered / total
      // A gentle curve: fully-covered cells go opaque, partial ones antialias the edge,
      // and near-empty ones drop out rather than smearing a grey halo.
      const alpha = coverage <= 0.12 ? 0 : Math.round(Math.min(1, coverage * 1.25) * 255)

      const at = (ty * size + tx) * 4
      rgba[at] = 0
      rgba[at + 1] = 0
      rgba[at + 2] = 0
      rgba[at + 3] = alpha
    }
  }

  return rgba
}

/** Tight bounding box of the opaque pixels in one sheet cell. */
function cellBoundingBox(png, sheet, row, column) {
  const originX = column * sheet.frameWidth
  const originY = row * sheet.frameHeight
  let minX = sheet.frameWidth
  let minY = sheet.frameHeight
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < sheet.frameHeight; y += 1) {
    for (let x = 0; x < sheet.frameWidth; x += 1) {
      if (alphaAt(png, originX + x, originY + y) <= ALPHA_THRESHOLD) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) throw new Error(`Cell row=${row} column=${column} is fully transparent.`)
  return {
    x: originX + minX,
    y: originY + minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }
}

function main() {
  const check = process.argv.includes('--check')

  const png = decodePng(readFileSync(SHEET))
  const spec = JSON.parse(readFileSync(SPRITE_JSON, 'utf8'))
  const sheet = spec.sheet
  const idle = spec.states.idle
  if (!idle) throw new Error('spritesheet.json has no `idle` state to derive a tray icon from.')

  const box = cellBoundingBox(png, sheet, idle.row, 0)

  // Pad to a square so the character is not stretched, then centre it.
  const side = Math.max(box.width, box.height)
  const square = {
    x: Math.round(box.x + box.width / 2 - side / 2),
    y: Math.round(box.y + box.height / 2 - side / 2),
    width: side,
    height: side,
  }

  const results = []
  for (const [size, name] of [
    [16, 'trayIconTemplate.png'],
    [32, 'trayIconTemplate@2x.png'],
  ]) {
    const rgba = silhouette(png, square, size)
    const buffer = encodePng(size, size, rgba)
    results.push(emitOrCheckBuffer(join(OUT_DIR, String(name)), buffer, { check }))
  }

  reportResults('tray icon', results, { check })
}

main()
