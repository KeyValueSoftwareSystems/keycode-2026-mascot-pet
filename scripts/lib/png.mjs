/**
 * Zero-dependency PNG decoder.
 *
 * Exists because two load-bearing paths need pixel access and neither may depend on a
 * native module: `smoke.mjs` asserts on captured screenshots, and `generate-alpha-mask.mjs`
 * runs in CI under `--check`. `sharp` stays a devDependency used only for the optional
 * WebP conversion.
 *
 * Supports colour types 0/2/3/6 at bit depth 8, non-interlaced — which covers the pet
 * spritesheet (verified colour type 6, depth 8, non-interlaced) and macOS `screencapture`
 * output. Anything else throws a typed error rather than mis-decoding, so the caller can
 * report something actionable instead of comparing garbage pixels.
 */

import { inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Channels per pixel for each supported PNG colour type. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export class PngUnsupportedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PngUnsupportedError'
  }
}

export class PngFormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PngFormatError'
  }
}

/**
 * @typedef {object} DecodedPng
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} data RGBA, 4 bytes per pixel, row-major, top-left origin.
 */

/**
 * Decode a PNG buffer to RGBA.
 * @param {Buffer|Uint8Array} buffer
 * @returns {DecodedPng}
 */
export function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngFormatError('Not a PNG file (bad signature).')
  }

  let offset = 8
  let header = null
  let palette = null
  let transparency = null
  const idat = []

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) throw new PngFormatError(`Truncated chunk ${type}.`)
    const data = buf.subarray(dataStart, dataEnd)

    switch (type) {
      case 'IHDR':
        header = readHeader(data)
        break
      case 'PLTE':
        palette = Buffer.from(data)
        break
      case 'tRNS':
        transparency = Buffer.from(data)
        break
      case 'IDAT':
        idat.push(Buffer.from(data))
        break
      default:
        break
    }

    offset = dataEnd + 4 // skip the CRC; we are not validating integrity here
    if (type === 'IEND') break
  }

  if (!header) throw new PngFormatError('PNG is missing its IHDR chunk.')
  if (idat.length === 0) throw new PngFormatError('PNG has no IDAT chunks.')

  const { width, height, bitDepth, colourType } = header
  const channels = CHANNELS[colourType]
  const bytesPerPixel = channels // bit depth is 8, so one byte per channel
  const stride = width * bytesPerPixel

  const raw = inflateSync(Buffer.concat(idat))
  const expected = (stride + 1) * height
  if (raw.length < expected) {
    throw new PngFormatError(`Inflated data too short: ${raw.length} < ${expected}.`)
  }

  const unfiltered = unfilter(raw, width, height, bytesPerPixel, stride)
  return {
    width,
    height,
    data: toRgba(unfiltered, width, height, colourType, channels, palette, transparency),
  }
}

function readHeader(data) {
  if (data.length < 13) throw new PngFormatError('IHDR chunk is too short.')
  const width = data.readUInt32BE(0)
  const height = data.readUInt32BE(4)
  const bitDepth = data[8]
  const colourType = data[9]
  const interlace = data[12]

  if (width === 0 || height === 0) throw new PngFormatError('PNG has zero dimensions.')
  if (interlace !== 0) {
    throw new PngUnsupportedError('Interlaced (Adam7) PNGs are not supported by this decoder.')
  }
  if (bitDepth !== 8) {
    throw new PngUnsupportedError(
      `Only bit depth 8 is supported; this PNG is ${bitDepth}-bit. ` +
        'A 16-bit or HDR screen capture will land here.',
    )
  }
  if (CHANNELS[colourType] === undefined) {
    throw new PngUnsupportedError(`Unsupported PNG colour type ${colourType}.`)
  }
  return { width, height, bitDepth, colourType }
}

/**
 * Reverse the per-scanline filters. All five filter types, because a real encoder
 * picks per row and a decoder that only handles type 0 works right up until it doesn't.
 */
function unfilter(raw, width, height, bytesPerPixel, stride) {
  const out = Buffer.allocUnsafe(stride * height)
  let rawPos = 0
  let prevRow = Buffer.alloc(stride) // an all-zero row above the first, per spec

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawPos]
    rawPos += 1
    const row = raw.subarray(rawPos, rawPos + stride)
    rawPos += stride
    const target = out.subarray(y * stride, (y + 1) * stride)

    switch (filter) {
      case 0:
        row.copy(target)
        break
      case 1:
        for (let i = 0; i < stride; i += 1) {
          const left = i >= bytesPerPixel ? target[i - bytesPerPixel] : 0
          target[i] = (row[i] + left) & 0xff
        }
        break
      case 2:
        for (let i = 0; i < stride; i += 1) {
          target[i] = (row[i] + prevRow[i]) & 0xff
        }
        break
      case 3:
        for (let i = 0; i < stride; i += 1) {
          const left = i >= bytesPerPixel ? target[i - bytesPerPixel] : 0
          target[i] = (row[i] + ((left + prevRow[i]) >> 1)) & 0xff
        }
        break
      case 4:
        for (let i = 0; i < stride; i += 1) {
          const left = i >= bytesPerPixel ? target[i - bytesPerPixel] : 0
          const up = prevRow[i]
          const upLeft = i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0
          target[i] = (row[i] + paeth(left, up, upLeft)) & 0xff
        }
        break
      default:
        throw new PngFormatError(`Unknown scanline filter type ${filter} on row ${y}.`)
    }

    prevRow = target
  }

  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function toRgba(pixels, width, height, colourType, channels, palette, transparency) {
  const count = width * height
  const rgba = new Uint8Array(count * 4)

  for (let i = 0; i < count; i += 1) {
    const src = i * channels
    const dst = i * 4
    switch (colourType) {
      case 0: {
        // greyscale
        const v = pixels[src]
        rgba[dst] = v
        rgba[dst + 1] = v
        rgba[dst + 2] = v
        rgba[dst + 3] = 255
        break
      }
      case 4: {
        // greyscale + alpha
        const v = pixels[src]
        rgba[dst] = v
        rgba[dst + 1] = v
        rgba[dst + 2] = v
        rgba[dst + 3] = pixels[src + 1]
        break
      }
      case 2: {
        rgba[dst] = pixels[src]
        rgba[dst + 1] = pixels[src + 1]
        rgba[dst + 2] = pixels[src + 2]
        rgba[dst + 3] = 255
        break
      }
      case 3: {
        if (!palette) throw new PngFormatError('Indexed PNG is missing its PLTE chunk.')
        const index = pixels[src]
        const p = index * 3
        if (p + 2 >= palette.length) {
          throw new PngFormatError(`Palette index ${index} is out of range.`)
        }
        rgba[dst] = palette[p]
        rgba[dst + 1] = palette[p + 1]
        rgba[dst + 2] = palette[p + 2]
        rgba[dst + 3] = transparency && index < transparency.length ? transparency[index] : 255
        break
      }
      case 6: {
        rgba[dst] = pixels[src]
        rgba[dst + 1] = pixels[src + 1]
        rgba[dst + 2] = pixels[src + 2]
        rgba[dst + 3] = pixels[src + 3]
        break
      }
      default:
        throw new PngUnsupportedError(`Unsupported PNG colour type ${colourType}.`)
    }
  }

  return rgba
}

/** Alpha of one pixel. Bounds-checked so callers can probe freely. */
export function alphaAt(png, x, y) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return 0
  return png.data[(y * png.width + x) * 4 + 3]
}

/** `[r, g, b, a]` of one pixel. Out of bounds reads as fully transparent black. */
export function pixelAt(png, x, y) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return [0, 0, 0, 0]
  const i = (y * png.width + x) * 4
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]
}

/**
 * Chebyshev distance between two RGB triples — the max per-channel delta.
 *
 * Used instead of Euclidean distance because the question a screenshot assertion asks is
 * "did *any* channel move meaningfully", and a max is both cheaper and easier to pick a
 * threshold for than a sum of squares.
 */
export function rgbDistance(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}
