import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
// @ts-expect-error — .mjs script helper, intentionally untyped JS shared with the harness
import { decodePng, alphaAt, pixelAt, rgbDistance, PngUnsupportedError, PngFormatError } from '../../scripts/lib/png.mjs'

const REPO = resolve(import.meta.dirname, '..', '..')

/**
 * Build a minimal valid PNG so filter handling can be tested without fixture files.
 *
 * Applies each filter *forward* (encoding) so the decoder has to reverse it. The previous
 * scanline used for the up/average/paeth predictors is the previous *unfiltered* row, per
 * the PNG spec — getting that wrong is the classic way a hand-rolled encoder produces data
 * a correct decoder cannot read.
 */
function buildPng(
  width: number,
  height: number,
  pixels: number[][],
  filterType: number,
  colourType = 6,
): Buffer {
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 1
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)

  let previousUnfiltered = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const unfiltered = Buffer.alloc(stride)
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        unfiltered[x * channels + c] = pixels[y * width + x]![c]!
      }
    }

    const filtered = Buffer.alloc(stride)
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? unfiltered[i - channels]! : 0
      const up = previousUnfiltered[i]!
      const upLeft = i >= channels ? previousUnfiltered[i - channels]! : 0
      switch (filterType) {
        case 0:
          filtered[i] = unfiltered[i]!
          break
        case 1:
          filtered[i] = (unfiltered[i]! - left) & 0xff
          break
        case 2:
          filtered[i] = (unfiltered[i]! - up) & 0xff
          break
        case 3:
          filtered[i] = (unfiltered[i]! - ((left + up) >> 1)) & 0xff
          break
        case 4:
          filtered[i] = (unfiltered[i]! - paeth(left, up, upLeft)) & 0xff
          break
        default:
          throw new Error(`test helper does not encode filter type ${filterType}`)
      }
    }

    raw[y * (stride + 1)] = filterType
    filtered.copy(raw, y * (stride + 1) + 1)
    previousUnfiltered = unfiltered
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colourType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  // The decoder skips CRCs, so a zero placeholder is fine and keeps this helper small.
  const crc = Buffer.alloc(4)
  return Buffer.concat([length, typeBuf, data, crc])
}

describe('png decoder', () => {
  it('round-trips every scanline filter type', () => {
    // A 4x3 gradient: adjacent pixels differ in every channel, so a filter implemented
    // wrongly produces visibly wrong values rather than accidentally matching.
    const width = 4
    const height = 3
    const pixels: number[][] = []
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        pixels.push([x * 40 + y, 255 - x * 30, (x * y * 17) % 256, 200 + y * 10])
      }
    }

    for (const filterType of [0, 1, 2, 3, 4]) {
      const png = decodePng(buildPng(width, height, pixels, filterType))
      expect(png.width, `filter ${filterType} width`).toBe(width)
      expect(png.height, `filter ${filterType} height`).toBe(height)
      for (let i = 0; i < pixels.length; i += 1) {
        const x = i % width
        const y = Math.floor(i / width)
        expect(pixelAt(png, x, y), `filter ${filterType} pixel ${x},${y}`).toEqual(pixels[i])
      }
    }
  })

  it('decodes RGB (colour type 2) as fully opaque', () => {
    const png = decodePng(buildPng(2, 1, [[10, 20, 30], [40, 50, 60]], 0, 2))
    expect(pixelAt(png, 0, 0)).toEqual([10, 20, 30, 255])
    expect(pixelAt(png, 1, 0)).toEqual([40, 50, 60, 255])
  })

  it('reads the real pet spritesheet at its documented geometry', () => {
    const png = decodePng(readFileSync(resolve(REPO, 'pet/spritesheet.png')))
    expect(png.width).toBe(1536)
    expect(png.height).toBe(1872)
    expect(png.data.length).toBe(1536 * 1872 * 4)
  })

  it('rejects a non-PNG buffer', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(PngFormatError)
  })

  it('rejects a 16-bit PNG with a typed error rather than mis-decoding', () => {
    // A 16-bit or HDR screen capture lands here. Throwing lets the harness report exit
    // code 5 with actionable advice instead of comparing garbage pixels.
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(1, 0)
    ihdr.writeUInt32BE(1, 4)
    ihdr[8] = 16
    ihdr[9] = 6
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.alloc(9))),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => decodePng(png)).toThrow(PngUnsupportedError)
  })

  it('rejects an interlaced PNG with a typed error', () => {
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(1, 0)
    ihdr.writeUInt32BE(1, 4)
    ihdr[8] = 8
    ihdr[9] = 6
    ihdr[12] = 1 // Adam7
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.alloc(5))),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => decodePng(png)).toThrow(PngUnsupportedError)
  })

  it('reads out-of-bounds probes as fully transparent instead of throwing', () => {
    const png = decodePng(buildPng(1, 1, [[1, 2, 3, 4]], 0))
    expect(alphaAt(png, -1, 0)).toBe(0)
    expect(alphaAt(png, 0, 99)).toBe(0)
    expect(pixelAt(png, 99, 99)).toEqual([0, 0, 0, 0])
  })

  it('measures Chebyshev distance across channels', () => {
    expect(rgbDistance([0, 0, 0], [0, 0, 0])).toBe(0)
    expect(rgbDistance([10, 0, 0], [0, 0, 0])).toBe(10)
    // The max, not the sum: one channel moving a lot matters more than three moving a little.
    expect(rgbDistance([5, 5, 40], [0, 0, 0])).toBe(40)
  })
})
