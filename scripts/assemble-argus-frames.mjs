#!/usr/bin/env node
/**
 * Assemble individual Argos frame PNGs into pet/spritesheet.png.
 *
 *   node scripts/assemble-argos-frames.mjs [/path/to/argos-mascot]
 *
 * Expects subfolders: argos-idle, argos-run-right, argos-jumping-jacks, argos-drinking-water,
 * argos-wave, argos-sleep, argos-thinking, argos-electrocute, argos-panic — with numbered PNGs
 * (1.png, 2.png, …). Uses every frame. Run-left is a horizontal flip of run-right; jumping-left
 * is a horizontal flip of jumping-jacks; idle-left is a horizontal flip of idle; review-left is
 * a horizontal flip of thinking.
 * Sheet columns = max frame count so nothing is trimmed.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { decodePng, encodePng } from './lib/png.mjs'
import { ALPHA_THRESHOLD } from './lib/mask.mjs'
import { ROOT, SPRITESHEET_PNG } from './lib/spritesheet.mjs'

const FRAME_W = 192
const FRAME_H = 208
/** Distance from cell bottom to the character's feet. */
const FOOT_INSET = 16
/** On-screen character height. Width follows aspect; clamped only if a pose would clip the cell. */
const TARGET_CONTENT_H = 150
const CONTENT_MAX_W = FRAME_W - 8
/**
 * Drink/run/jacks exports have an orange fringe (alpha ~2–9) to the canvas edge.
 * Counting that as content makes those poses fill the cell and look tiny next to
 * idle, which is true transparent. Higher than ALPHA_THRESHOLD on purpose — bounds only.
 */
const BOUNDS_ALPHA = 16

const FILTER_SUPPORT = 1

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(2)
}

function filterWeight(x) {
  const ax = Math.abs(x)
  return ax >= 1 ? 0 : 1 - ax
}

/** Alpha-aware triangle downsample of a region (same kernel as import-sheet-rows.mjs). */
function resample(img, region, outWidth, outHeight) {
  const out = Buffer.alloc(outWidth * outHeight * 4)
  const scaleX = region.width / outWidth
  const scaleY = region.height / outHeight
  const supportX = Math.max(1, scaleX) * FILTER_SUPPORT
  const supportY = Math.max(1, scaleY) * FILTER_SUPPORT

  for (let oy = 0; oy < outHeight; oy += 1) {
    const cy = region.y + (oy + 0.5) * scaleY - 0.5
    const y0 = Math.max(region.y, Math.ceil(cy - supportY))
    const y1 = Math.min(region.y + region.height - 1, Math.floor(cy + supportY))

    for (let ox = 0; ox < outWidth; ox += 1) {
      const cx = region.x + (ox + 0.5) * scaleX - 0.5
      const x0 = Math.max(region.x, Math.ceil(cx - supportX))
      const x1 = Math.min(region.x + region.width - 1, Math.floor(cx + supportX))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let weightSum = 0

      for (let sy = y0; sy <= y1; sy += 1) {
        const wy = filterWeight((sy - cy) / Math.max(1, scaleY))
        if (wy === 0) continue
        for (let sx = x0; sx <= x1; sx += 1) {
          const wx = filterWeight((sx - cx) / Math.max(1, scaleX))
          if (wx === 0) continue
          const w = wx * wy
          const i = (sy * img.width + sx) * 4
          const alpha = img.data[i + 3] / 255
          r += img.data[i] * alpha * w
          g += img.data[i + 1] * alpha * w
          b += img.data[i + 2] * alpha * w
          a += alpha * w
          weightSum += w
        }
      }

      const d = (oy * outWidth + ox) * 4
      if (weightSum === 0 || a <= 0) continue
      const alphaOut = Math.max(0, Math.min(1, a / weightSum))
      if (alphaOut <= 0.02) continue
      out[d] = Math.max(0, Math.min(255, Math.round(r / a)))
      out[d + 1] = Math.max(0, Math.min(255, Math.round(g / a)))
      out[d + 2] = Math.max(0, Math.min(255, Math.round(b / a)))
      out[d + 3] = Math.round(alphaOut * 255)
    }
  }
  return { width: outWidth, height: outHeight, data: out }
}

function contentBounds(img) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (img.data[(y * img.width + x) * 4 + 3] <= BOUNDS_ALPHA) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function flipHorizontal(img) {
  const out = Buffer.alloc(img.data.length)
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const si = (y * img.width + x) * 4
      const di = (y * img.width + (img.width - 1 - x)) * 4
      out[di] = img.data[si]
      out[di + 1] = img.data[si + 1]
      out[di + 2] = img.data[si + 2]
      out[di + 3] = img.data[si + 3]
    }
  }
  return { width: img.width, height: img.height, data: out }
}

function listFrames(dir) {
  if (!existsSync(dir)) fail(`Missing folder: ${dir}`)
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((f) => join(dir, f))
}

function blit(dest, sheetW, frame, col, row) {
  const destX0 = col * FRAME_W
  const destY0 = row * FRAME_H
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const si = (y * frame.width + x) * 4
      if (frame.data[si + 3] <= ALPHA_THRESHOLD) continue
      const dx = destX0 + x
      const dy = destY0 + y
      if (dx < 0 || dy < 0 || dx >= sheetW || dy >= destY0 + FRAME_H) continue
      const di = (dy * sheetW + dx) * 4
      dest[di] = frame.data[si]
      dest[di + 1] = frame.data[si + 1]
      dest[di + 2] = frame.data[si + 2]
      dest[di + 3] = frame.data[si + 3]
    }
  }
}

function unionContentBounds(files, flip) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  for (const file of files) {
    const png = decodePng(readFileSync(file))
    const source = flip ? flipHorizontal(png) : png
    const bounds = contentBounds(source)
    if (!bounds) fail(`Frame has no opaque pixels: ${file}`)
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.width - 1)
    maxY = Math.max(maxY, bounds.y + bounds.height - 1)
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function scaleForBounds(bounds) {
  let scale = TARGET_CONTENT_H / bounds.height
  if (bounds.width * scale > CONTENT_MAX_W) {
    scale = CONTENT_MAX_W / bounds.width
  }
  return scale
}

/**
 * Scale content into a FRAME_W×FRAME_H cell with feet on the shared baseline.
 * Pass a locked `scale` so a whole animation row stays the same size.
 * Optional `anchors` pin wave (and similar) so arm-only motion does not slide or bob.
 */
function fitToCell(img, flip, scale, anchors = null, crop = null) {
  const source = flip ? flipHorizontal(img) : img
  const bounds = crop ?? contentBounds(source)
  if (!bounds) fail('Frame has no opaque pixels.')
  const usedScale = scale ?? scaleForBounds(bounds)

  const outW = Math.max(1, Math.round(bounds.width * usedScale))
  const outH = Math.max(1, Math.round(bounds.height * usedScale))

  const scaled = resample(source, bounds, outW, outH)
  /** Last row the character may paint; `FOOT_INSET` pixels below stay empty for floor math. */
  const footBaseline = FRAME_H - FOOT_INSET - 1

  let destX
  let destY
  let footCenterX
  let footCenterY
  if (anchors) {
    // Pin shoe contact, not the full content box — wave arms dip below the feet in the bounds.
    const footCx = lowerBodyCenterX(scaled.data, outW, outH)
    const footCy = footContactY(scaled.data, outW, outH)
    destX =
      anchors.footX == null ? Math.round((FRAME_W - outW) / 2) : Math.round(anchors.footX - footCx)
    destY =
      anchors.footY == null ? footBaseline - footCy : Math.round(anchors.footY - footCy)
    footCenterX = destX + footCx
    footCenterY = destY + footCy
  } else {
    destX = Math.round((FRAME_W - outW) / 2)
    destY = FRAME_H - FOOT_INSET - outH
    footCenterX = destX + outW / 2
    footCenterY = destY + outH - 1
  }

  const cell = Buffer.alloc(FRAME_W * FRAME_H * 4)
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const si = (y * outW + x) * 4
      if (scaled.data[si + 3] <= ALPHA_THRESHOLD) continue
      const dx = destX + x
      const dy = destY + y
      // Clip anything below the shared foot baseline (wave arms) so floor inset stays stable.
      if (dx < 0 || dy < 0 || dx >= FRAME_W || dy > footBaseline) continue
      const di = (dy * FRAME_W + dx) * 4
      cell[di] = scaled.data[si]
      cell[di + 1] = scaled.data[si + 1]
      cell[di + 2] = scaled.data[si + 2]
      cell[di + 3] = scaled.data[si + 3]
    }
  }
  return {
    width: FRAME_W,
    height: FRAME_H,
    data: cell,
    outW,
    outH,
    scale: usedScale,
    footCenterX,
    footCenterY,
  }
}

/** Horizontal centre of opaque pixels in the lower third — stable for arm-only motion. */
function lowerBodyCenterX(data, width, height) {
  const y0 = Math.floor((height * 2) / 3)
  let sumX = 0
  let count = 0
  for (let y = y0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= ALPHA_THRESHOLD) continue
      sumX += x
      count += 1
    }
  }
  if (count === 0) return width / 2
  return sumX / count
}

/** Lowest opaque row in the central lower half — the shoe contact, not a dipping arm. */
function footContactY(data, width, height) {
  const x0 = Math.floor(width * 0.28)
  const x1 = Math.ceil(width * 0.72)
  const y0 = Math.floor(height * 0.45)
  let maxY = -1
  for (let y = y0; y < height; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= ALPHA_THRESHOLD) continue
      maxY = y
    }
  }
  return maxY < 0 ? height - 1 : maxY
}

/** Largest scale that still fits `bounds` in the cell. Taller than TARGET_CONTENT_H is fine. */
function cellFitScale(bounds) {
  const maxH = FRAME_H - FOOT_INSET - 1
  const maxW = CONTENT_MAX_W
  return Math.min(maxH / bounds.height, maxW / bounds.width)
}

function lockedCellFitScale(files, flip) {
  let min = Infinity
  for (const file of files) {
    const png = decodePng(readFileSync(file))
    const source = flip ? flipHorizontal(png) : png
    const bounds = contentBounds(source)
    if (!bounds) fail(`Frame has no opaque pixels: ${file}`)
    min = Math.min(min, cellFitScale(bounds))
  }
  return min
}

/** Cap a row to TARGET_CONTENT_H so a pose whose union is the whole canvas cannot dwarf idle. */
function lockedTargetScale(files, flip) {
  let min = Infinity
  for (const file of files) {
    const png = decodePng(readFileSync(file))
    const source = flip ? flipHorizontal(png) : png
    const bounds = contentBounds(source)
    if (!bounds) fail(`Frame has no opaque pixels: ${file}`)
    min = Math.min(min, scaleForBounds(bounds))
  }
  return min
}

function main() {
  const root = process.argv[2] ?? '/Users/aleena/Desktop/argos-mascot'
  const folders = {
    idle: join(root, 'argos-idle'),
    runRight: join(root, 'argos-run-right'),
    jacks: join(root, 'argos-jumping-jacks'),
    drink: join(root, 'argos-drinking-water'),
    wave: join(root, 'argos-wave'),
    sleep: join(root, 'argos-sleep'),
    thinking: join(root, 'argos-thinking'),
    electrocute: join(root, 'argos-electrocute'),
    panic: join(root, 'argos-panic'),
  }

  const idle = listFrames(folders.idle)
  const runRight = listFrames(folders.runRight)
  const jacks = listFrames(folders.jacks)
  const drink = listFrames(folders.drink)
  const wave = listFrames(folders.wave)
  const sleep = listFrames(folders.sleep)
  const thinking = listFrames(folders.thinking)
  const electrocute = listFrames(folders.electrocute)
  const panic = listFrames(folders.panic)

  const columns = Math.max(
    idle.length,
    runRight.length,
    jacks.length,
    drink.length,
    wave.length,
    sleep.length,
    thinking.length,
    electrocute.length,
    panic.length,
  )
  const rows = 13
  const sheetW = columns * FRAME_W
  const sheetH = rows * FRAME_H
  const sheet = Buffer.alloc(sheetW * sheetH * 4)

  console.log(`source     ${root}`)
  console.log(
    `frames     idle=${idle.length} runR=${runRight.length} jacks=${jacks.length} drink=${drink.length} wave=${wave.length} sleep=${sleep.length} think=${thinking.length} electrocute=${electrocute.length} panic=${panic.length}`,
  )
  console.log(`sheet      ${columns}×${rows} cells → ${sheetW}×${sheetH}`)

  const rowsSpec = [
    { name: 'idle', files: idle, row: 0, flip: false },
    { name: 'running-right', files: runRight, row: 1, flip: false },
    { name: 'running-left', files: runRight, row: 2, flip: true },
    { name: 'jumping-right', files: jacks, row: 3, flip: false },
    { name: 'drink', files: drink, row: 4, flip: false },
    { name: 'jumping-left', files: jacks, row: 5, flip: true },
    { name: 'idle-left', files: idle, row: 6, flip: true },
    { name: 'waving', files: wave, row: 7, flip: false },
    { name: 'sleep', files: sleep, row: 8, flip: false },
    { name: 'review', files: thinking, row: 9, flip: false },
    { name: 'review-left', files: thinking, row: 10, flip: true },
    { name: 'electrocute', files: electrocute, row: 11, flip: false },
    { name: 'panic', files: panic, row: 12, flip: false },
  ]

  // Idle/drink/sleep/electrocute/panic exports are 2508px; thinking/wave/jacks/run are 1254px
  // (exactly half). Fitting each pose independently to TARGET_CONTENT_H shrinks the half-res rows,
  // so idle looks zoomed-in when thinking ends. Scale everything from idle, then only shrink if a
  // pose clips.
  const idleCanvasW = decodePng(readFileSync(idle[0])).width
  const idleScaleRef = scaleForBounds(unionContentBounds(idle, false))

  const packed = rowsSpec.map((spec) => {
    const perFrame =
      spec.name === 'sleep' ||
      spec.name === 'jumping-right' ||
      spec.name === 'jumping-left' ||
      spec.name === 'waving'
    const crop = perFrame ? null : unionContentBounds(spec.files, spec.flip)
    const canvasW = decodePng(readFileSync(spec.files[0])).width
    const worldScale = idleScaleRef * (idleCanvasW / canvasW)
    const fitScale = crop ? cellFitScale(crop) : lockedCellFitScale(spec.files, spec.flip)
    // Wave's union is the whole 1254 canvas (an arm hits the edge). Cap to TARGET_CONTENT_H.
    // Jacks: several hop frames are flush with the top of the export, so scale the *tallest*
    // to TARGET (not the shortest) or the horn is clipped at the peak. Pin feet so the jump
    // still grows upward from a planted stance.
    const scale =
      spec.name === 'waving'
        ? Math.min(worldScale, lockedTargetScale(spec.files, spec.flip))
        : spec.name === 'jumping-right' || spec.name === 'jumping-left'
          ? Math.min(
              worldScale,
              lockedTargetScale(spec.files, spec.flip),
              lockedCellFitScale(spec.files, spec.flip),
            )
          : spec.name === 'running-right' ||
              spec.name === 'running-left' ||
              spec.name === 'drink' ||
              spec.name === 'electrocute' ||
              spec.name === 'panic'
            ? Math.min(worldScale, scaleForBounds(crop))
            : Math.min(worldScale, fitScale)
    return { spec, crop, scale }
  })

  for (const row of packed) {
    const { spec, crop, scale } = row
    const pinFeet = spec.name === 'waving' || spec.name === 'jumping-right' || spec.name === 'jumping-left'
    let anchors = pinFeet ? { footX: null, footY: null } : null
    console.log(
      `row ${spec.row}  ${spec.name}  ${spec.files.length} frames${spec.flip ? ' (flipped)' : ''}  lockedScale=${scale.toFixed(4)}${crop ? '  unionCrop' : ''}${pinFeet ? '  pinFeet' : ''}`,
    )
    for (let i = 0; i < spec.files.length; i += 1) {
      const png = decodePng(readFileSync(spec.files[i]))
      const cell = fitToCell(png, spec.flip, scale, anchors, crop)
      if (pinFeet && i === 0) {
        anchors = { footX: cell.footCenterX, footY: cell.footCenterY }
      }
      blit(sheet, sheetW, cell, i, spec.row)
      process.stdout.write(`  ${i + 1}/${spec.files.length} ${cell.outW}×${cell.outH}\n`)
    }
  }

  writeFileSync(SPRITESHEET_PNG, encodePng(sheetW, sheetH, sheet))
  console.log(`wrote     ${SPRITESHEET_PNG}`)
  console.log(`next      update pet/spritesheet.json sheet to ${sheetW}×${sheetH}, columns=${columns}, rows=${rows}`)
  console.log(
    `          states: idle/idle-left:${idle.length} running-right/left:${runRight.length} jumping-right/left:${jacks.length} drink:${drink.length} waving:${wave.length} sleep:${sleep.length} review/review-left:${thinking.length} electrocute:${electrocute.length} panic:${panic.length}`,
  )
}

main()
