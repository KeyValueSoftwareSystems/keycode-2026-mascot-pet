#!/usr/bin/env node
/**
 * Downsample the status crown art to the size it is actually worn at.
 *
 *   node scripts/generate-crowns.mjs [--check]
 *
 * The source art is ~340x264 with soft shading, and the pet is drawn at 192x208 per cell. Letting
 * CSS shrink the big PNG instead would fight `image-rendering: pixelated`: the browser would be
 * resampling by a non-integer factor every frame, and the result is mush at exactly the sizes the
 * pet is usually shown at. Resampling once, here, means the renderer only ever paints 1:1 (at
 * full size) or by a clean half/three-quarter step.
 *
 * The filter is a box average over premultiplied alpha. Averaging straight RGBA instead pulls the
 * fully transparent pixels' colour into the edge pixels, which on this art is black — the crown
 * would come out with a dark fringe all the way round.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { decodePng, encodePng } from './lib/png.mjs'
import { ROOT } from './lib/spritesheet.mjs'
import { CROWNS, CROWN_WIDTH, CROWN_HEIGHT } from './lib/crowns.mjs'

const SOURCE_DIR = join(ROOT, 'pet', 'crowns-source')
const OUT_DIR = join(ROOT, 'pet')

/** Tight bounding box of everything not fully transparent. */
function opaqueBounds(png) {
  let x0 = png.width
  let y0 = png.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (png.data[(y * png.width + x) * 4 + 3] < 8) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) throw new Error('crown source is entirely transparent')
  return { x0, y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

/** Box-average `src` (cropped to `box`) down to `outW` x `outH`, premultiplied. */
function downsample(png, box, outW, outH) {
  const out = Buffer.alloc(outW * outH * 4)
  for (let oy = 0; oy < outH; oy += 1) {
    for (let ox = 0; ox < outW; ox += 1) {
      const sx0 = box.x0 + Math.floor((ox * box.width) / outW)
      const sx1 = box.x0 + Math.floor(((ox + 1) * box.width) / outW)
      const sy0 = box.y0 + Math.floor((oy * box.height) / outH)
      const sy1 = box.y0 + Math.floor(((oy + 1) * box.height) / outH)

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = sy0; sy < Math.max(sy1, sy0 + 1); sy += 1) {
        for (let sx = sx0; sx < Math.max(sx1, sx0 + 1); sx += 1) {
          const i = (sy * png.width + sx) * 4
          const alpha = png.data[i + 3] / 255
          r += png.data[i] * alpha
          g += png.data[i + 1] * alpha
          b += png.data[i + 2] * alpha
          a += png.data[i + 3]
          n += 1
        }
      }

      const meanAlpha = a / n
      const o = (oy * outW + ox) * 4
      if (meanAlpha < 1) {
        out[o] = 0
        out[o + 1] = 0
        out[o + 2] = 0
        out[o + 3] = 0
        continue
      }
      // Un-premultiply back to straight alpha for storage.
      const scale = 255 / meanAlpha / n
      out[o] = Math.min(255, Math.round(r * scale))
      out[o + 1] = Math.min(255, Math.round(g * scale))
      out[o + 2] = Math.min(255, Math.round(b * scale))
      out[o + 3] = Math.round(meanAlpha)
    }
  }
  return out
}

function main() {
  const check = process.argv.slice(2).includes('--check')
  const stale = []

  for (const crown of CROWNS) {
    const sourcePath = join(SOURCE_DIR, crown.source)
    if (!existsSync(sourcePath)) {
      console.error(`generate-crowns: missing source pet/crowns-source/${crown.source}`)
      process.exit(1)
    }
    const png = decodePng(readFileSync(sourcePath))
    const box = opaqueBounds(png)
    const rgba = downsample(png, box, CROWN_WIDTH, CROWN_HEIGHT)
    const encoded = encodePng(CROWN_WIDTH, CROWN_HEIGHT, rgba)

    const outPath = join(OUT_DIR, crown.file)
    const current = existsSync(outPath) ? readFileSync(outPath) : null
    if (current && current.equals(encoded)) continue
    if (check) {
      stale.push(crown.file)
      continue
    }
    writeFileSync(outPath, encoded)
  }

  if (check && stale.length > 0) {
    console.error(`crowns are stale: ${stale.join(', ')} — run \`pnpm generate\``)
    process.exit(1)
  }
  console.log(
    `✓ crowns (${CROWNS.length} at ${CROWN_WIDTH}x${CROWN_HEIGHT})${check ? ': up to date' : ''}`,
  )
}

main()
