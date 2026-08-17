#!/usr/bin/env node
/**
 * Generate app icons from the pet art.
 *
 *   node scripts/generate-icons.mjs [--check]
 *
 * macOS-only (uses `sips` and `iconutil`), and the **outputs are committed** so CI never needs to run
 * it. That is the point: a Windows or Linux runner can package without any image tooling installed.
 *
 * Derived rather than hand-authored, for the same reason as the tray icon — it keeps the "swap the
 * spritesheet, change no code" promise whole. A Keycode-branded art pack regenerates its own icons.
 *
 * `pet/spritesheet.png` idle frame is the source. Unlike the tray glyph this keeps full colour, because
 * an app icon is shown at 128px and up where the character is perfectly legible.
 *
 * Outputs (all committed):
 *   build/icon.icns              macOS
 *   build/icon.png               1024x1024 — electron-builder's Linux source
 *   build/icon.ico               Windows
 *   build/icons/{16..512}.png    Linux hicolor sizes
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, pixelAt } from './lib/png.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SHEET = join(ROOT, 'pet', 'spritesheet.png')
const SPRITE_JSON = join(ROOT, 'pet', 'spritesheet.json')
const BUILD = join(ROOT, 'build')
const ICONS_DIR = join(BUILD, 'icons')

/** Sizes electron-builder wants for Linux, plus the iconset sizes macOS needs. */
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512]
const ICONSET = [
  [16, '16x16'],
  [32, '16x16@2x'],
  [32, '32x32'],
  [64, '32x32@2x'],
  [128, '128x128'],
  [256, '128x128@2x'],
  [256, '256x256'],
  [512, '256x256@2x'],
  [512, '512x512'],
  [1024, '512x512@2x'],
]

function ensureMac() {
  if (process.platform !== 'darwin') {
    console.error(
      'generate-icons is macOS-only (it needs sips and iconutil).\n' +
        'The generated icons are committed, so this only needs running when the art changes.',
    )
    process.exit(2)
  }
}

/** `sips` resizes with good quality and no dependency; the alpha channel survives. */
function resize(from, to, size) {
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(size), String(size), from, '--out', to], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

/**
 * Minimal ICO writer: a container of PNG-encoded images.
 *
 * Windows has accepted PNG-in-ICO since Vista, so this needs no BMP encoder. Written by hand rather
 * than adding an `ico` dependency for ~40 lines of header.
 */
function writeIco(pngPaths, outPath) {
  const images = pngPaths.map((path) => {
    const data = readFileSync(path)
    const decoded = decodePng(data)
    return { data, width: decoded.width, height: decoded.height }
  })

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type 1 = icon
  header.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = 6 + images.length * 16

  for (const image of images) {
    const entry = Buffer.alloc(16)
    // 0 means 256 in the ICO format.
    entry.writeUInt8(image.width >= 256 ? 0 : image.width, 0)
    entry.writeUInt8(image.height >= 256 ? 0 : image.height, 1)
    entry.writeUInt8(0, 2) // palette size
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(image.data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += image.data.length
  }

  writeFileSync(outPath, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]))
}

function extractIdleFrame(outPath) {
  const png = decodePng(readFileSync(SHEET))
  const spec = JSON.parse(readFileSync(SPRITE_JSON, 'utf8'))
  const idle = spec.states.idle
  if (!idle) throw new Error('spritesheet.json has no idle state')
  const { frameWidth, frameHeight } = spec.sheet
  const originX = 0
  const originY = idle.row * frameHeight
  const out = new Uint8Array(frameWidth * frameHeight * 4)
  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const [r, g, b, a] = pixelAt(png, originX + x, originY + y)
      const i = (y * frameWidth + x) * 4
      out[i] = r
      out[i + 1] = g
      out[i + 2] = b
      out[i + 3] = a
    }
  }
  writeFileSync(outPath, encodePng(frameWidth, frameHeight, out))
}

/**
 * Trim the source's transparent margin and re-centre on a square.
 *
 * `preview.png` has generous empty space around the character; left alone the icon reads as tiny in a
 * dock full of edge-to-edge icons.
 */
function tightenSource(sourcePath, outPath) {
  const png = decodePng(readFileSync(sourcePath))
  let minX = png.width
  let minY = png.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (pixelAt(png, x, y)[3] <= 8) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) throw new Error('idle frame is fully transparent')

  // Square, with ~8% breathing room, clamped to the source.
  const side = Math.max(maxX - minX + 1, maxY - minY + 1)
  const padded = Math.round(side * 1.16)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2

  const out = new Uint8Array(padded * padded * 4)
  for (let y = 0; y < padded; y += 1) {
    for (let x = 0; x < padded; x += 1) {
      const sx = Math.round(cx - padded / 2 + x)
      const sy = Math.round(cy - padded / 2 + y)
      const [r, g, b, a] = pixelAt(png, sx, sy)
      const i = (y * padded + x) * 4
      out[i] = r
      out[i + 1] = g
      out[i + 2] = b
      out[i + 3] = a
    }
  }

  writeFileSync(outPath, encodePng(padded, padded, out))
  return padded
}

function main() {
  const check = process.argv.includes('--check')

  if (check) {
    // In check mode, only assert the committed outputs exist. Re-deriving them would require the
    // macOS tooling this deliberately does not depend on in CI.
    const required = [
      join(BUILD, 'icon.icns'),
      join(BUILD, 'icon.png'),
      join(BUILD, 'icon.ico'),
      ...LINUX_SIZES.map((size) => join(ICONS_DIR, `${size}x${size}.png`)),
    ]
    const missing = required.filter((path) => !existsSync(path))
    if (missing.length > 0) {
      console.error(`✗ icons: ${missing.length} committed file(s) missing:`)
      for (const path of missing) console.error(`  ${path}`)
      process.exit(1)
    }
    console.log(`✓ icons: ${required.length} committed file(s) present`)
    return
  }

  ensureMac()
  mkdirSync(ICONS_DIR, { recursive: true })

  const idleFrame = join(BUILD, '.idle-frame.png')
  extractIdleFrame(idleFrame)
  const staging = join(BUILD, '.icon-src.png')
  const side = tightenSource(idleFrame, staging)
  rmSync(idleFrame, { force: true })
  console.log(`  source tightened to ${side}x${side}`)

  // macOS iconset
  const iconset = join(BUILD, 'icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  for (const [size, name] of ICONSET) {
    resize(staging, join(iconset, `icon_${name}.png`), size)
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(BUILD, 'icon.icns')])
  rmSync(iconset, { recursive: true, force: true })

  // Linux sizes, and the 1024 master electron-builder reads
  for (const size of LINUX_SIZES) {
    resize(staging, join(ICONS_DIR, `${size}x${size}.png`), size)
  }
  resize(staging, join(BUILD, 'icon.png'), 1024)

  // Windows ICO. 256 is the largest Windows renders from an ICO.
  const icoSizes = [16, 32, 48, 64, 128, 256]
  const icoParts = icoSizes.map((size) => {
    const path = join(BUILD, `.ico-${size}.png`)
    resize(staging, path, size)
    return path
  })
  writeIco(icoParts, join(BUILD, 'icon.ico'))
  for (const path of icoParts) rmSync(path, { force: true })
  rmSync(staging, { force: true })

  // electron-builder also looks for build/icon.png as the Linux source.
  cpSync(join(BUILD, 'icon.png'), join(ICONS_DIR, '1024x1024.png'))

  console.log(`✓ icons: icns, ico, png and ${LINUX_SIZES.length} Linux sizes`)
}

main()
