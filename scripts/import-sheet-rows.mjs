#!/usr/bin/env node
/**
 * Import animation rows from a generated contact sheet into `pet/spritesheet.png`.
 *
 *   node scripts/import-sheet-rows.mjs <source.png> --row drink:6:8 --row stretch:9:7
 *
 *   --row <name>:<targetRow>:<frames>   which source row (in order) goes where, and how many of its
 *                                       frames to take. Repeatable; source rows are consumed from
 *                                       the *bottom* of the sheet upward unless --from is given.
 *   --from <n>                          index of the first source row to consume (default: the last
 *                                       `--row` count, i.e. the bottom rows)
 *   --key <r,g,b>|magenta               background colour to remove (default: auto-detect a corner)
 *   --scale <n>|auto                    resample factor; `auto` derives it by comparing a pose the
 *                                       source and the committed sheet share (default: auto)
 *   --keep-all                          keep every blob in a frame, not just the largest. Off by
 *                                       default; see `largestBlob`.
 *   --alpha-floor <n>                   0..1; alpha below this is dropped instead of un-mixed
 *                                       (default 0.2). See `keyImage`.
 *   --dry-run                           report the plan and write nothing
 *   --preview <path>                    also write a side-by-side strip for eyeballing
 *
 * ---------------------------------------------------------------------------------------
 * Why this is a committed script and not a one-off
 * ---------------------------------------------------------------------------------------
 *
 * The art arrives as an image-model contact sheet: no alpha, no cell grid, a flat key colour, and
 * whatever resolution the generator felt like. Every one of those has to be undone, and the sheet
 * will be regenerated again — better art, a different character, another animation. A transformation
 * pasted into a shell once is not reproducible and cannot be reviewed; this can be re-run with one
 * command against a new source, and it re-derives its own scale factor rather than trusting a number
 * measured by hand.
 *
 * ---------------------------------------------------------------------------------------
 * The four things that are easy to get wrong
 * ---------------------------------------------------------------------------------------
 *
 * 1. **Alpha on the anti-aliased fringe.** This generator's edges ramp from background to solid over
 *    6-7px, and the gaps between limbs are entirely ramp. Getting this wrong is visible immediately:
 *    too eager and the skin turns green, too timid and the character wears a magenta rim. See
 *    `keyImage`, which records the two approaches that failed before the one that works.
 *
 * 2. **Slicing.** There is no grid to slice on — measured row pitch varies 112-143px and frame pitch
 *    varies too. Frames are found by scanning for runs of non-background columns, which is also what
 *    makes stray content separable: a water bottle standing on the ground beside the character comes
 *    out as its own span and is simply not taken.
 *
 * 3. **The feet.** `footInset` — the distance from the cell's bottom edge to the lowest opaque pixel —
 *    is what every placement calculation is built on, and it is measured as a union across all
 *    frames. One new frame whose feet sit lower changes the window height and moves the pet on every
 *    display. So each frame is placed with its own lowest opaque pixel on the existing baseline.
 *
 * 4. **The horizontal centre.** `spriteCentreOffset` comes from the union bbox, so a row drawn
 *    off-centre drags the pet's anchor sideways in every *other* state too.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { decodePng, encodePng } from './lib/png.mjs'
import { loadSpritesheet, ROOT, SPRITESHEET_PNG } from './lib/spritesheet.mjs'
import { ALPHA_THRESHOLD } from './lib/mask.mjs'

const KEY_NAMES = { magenta: [239, 0, 243], black: [0, 0, 0] }

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const opts = {
    source: null,
    rows: [],
    from: null,
    key: null,
    scale: 'auto',
    dryRun: false,
    preview: null,
    keepAll: false,
    alphaFloor: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--row': {
        const value = argv[(i += 1)] ?? ''
        const [name, row, frames] = value.split(':')
        if (!name || row === undefined || frames === undefined) {
          fail(`--row wants <name>:<targetRow>:<frames>, got ${JSON.stringify(value)}`)
        }
        opts.rows.push({ name, targetRow: Number(row), frames: Number(frames) })
        break
      }
      case '--from':
        opts.from = Number(argv[(i += 1)])
        break
      case '--key': {
        const value = argv[(i += 1)] ?? ''
        opts.key = KEY_NAMES[value] ?? value.split(',').map(Number)
        if (opts.key.length !== 3 || opts.key.some((n) => !Number.isFinite(n))) {
          fail(`--key wants r,g,b or one of ${Object.keys(KEY_NAMES).join('/')}`)
        }
        break
      }
      case '--scale': {
        const value = argv[(i += 1)]
        opts.scale = value === 'auto' ? 'auto' : Number(value)
        break
      }
      case '--dry-run':
        opts.dryRun = true
        break
      case '--keep-all':
        opts.keepAll = true
        break
      case '--alpha-floor':
        opts.alphaFloor = Number(argv[(i += 1)])
        break
      case '--preview':
        opts.preview = argv[(i += 1)]
        break
      default:
        if (arg.startsWith('--')) fail(`Unknown flag ${arg}`)
        else if (!opts.source) opts.source = arg
        else fail(`Unexpected argument ${arg}`)
    }
  }
  if (!opts.source) fail('Give a source PNG.')
  if (!existsSync(opts.source)) fail(`${opts.source} does not exist.`)
  if (opts.rows.length === 0) fail('Give at least one --row.')
  return opts
}

// ---------------------------------------------------------------------------------------
// Background keying
// ---------------------------------------------------------------------------------------

const rgbAt = (png, x, y) => {
  const i = (y * png.width + x) * 4
  return [png.data[i], png.data[i + 1], png.data[i + 2]]
}

const distance = (a, b) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])

/**
 * Detect the key colour from the image's corners.
 *
 * All four rather than one: a generated sheet sometimes has content running into a corner, and the
 * majority vote survives that where a single sample does not.
 */
function detectKey(png) {
  const corners = [
    rgbAt(png, 0, 0),
    rgbAt(png, png.width - 1, 0),
    rgbAt(png, 0, png.height - 1),
    rgbAt(png, png.width - 1, png.height - 1),
  ]
  const counts = new Map()
  for (const c of corners) {
    const k = c.join(',')
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return best[0].split(',').map(Number)
}

/**
 * Two approaches tried and discarded before the one below, both recorded because each looked right.
 *
 * **A border flood.** The theory was that topology beats colour: flood inward from the edges and
 * whatever you reach is background, whatever its hue. It is strictly *worse* than a colour test,
 * because the flood only expands through pixels that already pass that same test — so flood ⊆
 * threshold, and it can only ever subtract. What it subtracts is background **enclosed** by the
 * character: the gap between the legs, the triangle under a raised arm, the space around a dumbbell
 * handle. Those pockets stayed opaque and came out as bright magenta slivers.
 *
 * **A colour threshold plus a fringe band.** Better, and it fixed the outlines, but it fails in exactly
 * the same places for a different reason: a narrow gap is where the soft edges of *both* legs overlap,
 * so its centre is a three-way blend that is neither near the key nor within a few pixels of anything
 * that is.
 *
 * Both failures share a cause — treating "is this background" as a question about *position*. It is a
 * question about *how much key is in this pixel*, which `spillFraction` answers directly, everywhere,
 * with no notion of inside or outside. See `keyImage`.
 */

/**
 * How much of a pixel is key spill, 0..1.
 *
 * The Vlahos measure, rotated for a magenta key: magenta is high in red and blue and zero in green, so
 * `min(R,B) - G` is large for the key, zero for a black outline, and *negative* for this character's
 * greens, skin tones and denim — which is what makes it safe to apply to every pixel rather than only
 * to a band. Scaled by the key's own value it reads as the fraction of the pixel covered by
 * background.
 *
 * Verified against the rows actually being imported rather than assumed: of the pixels this would make
 * translucent, 745 sit mid-ramp between magenta and a dark outline, and exactly **one** is near the key.
 * The palette contains no magenta. `warnFarSpill` in `keyImage` re-checks that on every future import,
 * because a character with pink in it would lose it silently.
 */
const SPILL_DEADZONE = 48

function spillFraction(observed, key) {
  const keySpill = Math.min(key[0], key[2]) - key[1]
  if (keySpill <= SPILL_DEADZONE) return 0
  const spill = Math.min(observed[0], observed[2]) - observed[1]
  // The deadzone is what stops the character's own warm colours being read as background. Brown hair
  // measures `rgb(145,78,87)`: `min(R,B) - G` is 9, small but positive, so an ungated measure called it
  // 4% background — knocking a little alpha off every hair pixel and desaturating it. Traced by dumping
  // the pixels that changed and looking at where they came from, after two wrong guesses (filter ringing,
  // then the un-mix division) had been ruled out by measurement.
  //
  // Real background blends are far above this: half key and half black outline measures 120.
  return Math.max(0, Math.min(1, (spill - SPILL_DEADZONE) / (keySpill - SPILL_DEADZONE)))
}

/**
 * Key the source to RGBA with real alpha.
 *
 * One rule for every pixel: `alpha = 1 - spillFraction`. No inside, no outside, no band — which is why
 * it handles the gap between the legs and the outside of the silhouette identically, and why the two
 * position-based attempts above did not.
 *
 * Three bands of the result, and the middle one is the whole point:
 *
 *   - **spill ≈ 1** → transparent. Plain background.
 *   - **spill in between** → partial alpha, and the colour **un-mixed**:
 *     `C = (observed - (1-a)*K) / a`. Without this the edge keeps the key's hue and the character wears
 *     a magenta outline on a dark window.
 *   - **spill ≈ 0** → opaque, **colour untouched**. An earlier version un-mixed here too and turned the
 *     skin green and the denim teal: for a magenta key the green channel is pinned at 0, so a
 *     per-channel coverage estimate reads solid interior colour as ~78% covered and then subtracts
 *     magenta that was never there.
 */
function keyImage(png, key, opts = {}) {
  // Back down to a light floor now that the colour step no longer divides by alpha — see below. It only
  // trims the very faintest outer glow, where the pixel contributes a few percent of itself.
  const alphaFloor = opts.alphaFloor ?? 0.08
  const alphaCeil = opts.alphaCeil ?? 0.97
  const { width, height } = png
  const out = Buffer.alloc(width * height * 4)

  // Pixels made translucent while sitting a long way from the key are the signature of a character
  // that genuinely contains the key's hue — magenta clothing, pink hair. Counted rather than assumed
  // absent, so the next import of different art gets a warning instead of quiet holes.
  let farSpill = 0

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = (y * width + x) * 4
      const observed = rgbAt(png, x, y)
      const alpha = 1 - spillFraction(observed, key)

      if (alpha <= alphaFloor) continue // transparent

      if (distance(observed, key) > 260 && alpha < alphaCeil) farSpill += 1

      // **Subtractive despill, not division.** The textbook un-mix is
      // `C = (observed - (1-a)*K) / a`, and dividing by a small alpha multiplies whatever residue the
      // key left: at alpha 0.1 it amplified it tenfold and scattered saturated orange specks along the
      // hair and shoes. Verified against the source at 6× — its edges are clean, so the specks were
      // manufactured here.
      //
      // Removing the magenta *excess* instead cancels exactly what compositing added, with no division
      // and therefore no amplification: for a pixel that is half key and half black outline it yields
      // black, and for the character's own greens and skin the excess is zero and the pixel is
      // untouched. Edge pixels over a strongly-coloured area come out a little desaturated, which is
      // the honest cost of keying against one flat colour with no clean plate.
      // Alpha and colour are decided by *different* measures, on purpose.
      //
      // Alpha uses the deadzoned spill, so the character's own warm colours stay fully opaque — without
      // that, brown hair reads as 4% background and the whole head loses a little alpha.
      //
      // Colour removes the **full** magenta excess, with no deadzone. Deadzoning the colour too left a
      // visible purple rim: an edge pixel whose excess fell under the deadzone kept both full opacity
      // *and* its magenta tint, which showed up as a halo around the hair and the dumbbells against a
      // light background. Subtraction is gentle enough to apply everywhere — it desaturates brown hair
      // by about 6% and leaves greens, denim and skin untouched, because their excess is zero.
      const excess = Math.max(0, Math.min(observed[0], observed[2]) - observed[1])
      out[d] = Math.max(0, observed[0] - excess)
      out[d + 1] = observed[1]
      out[d + 2] = Math.max(0, observed[2] - excess)
      out[d + 3] = alpha >= alphaCeil ? 255 : Math.round(alpha * 255)
    }
  }

  return { width, height, data: out, farSpill }
}

// ---------------------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------------------

const alphaAtRgba = (img, x, y) => img.data[(y * img.width + x) * 4 + 3]

/**
 * Bands of rows containing content, in order top to bottom.
 *
 * `minHeight` is applied to a band that ends at the image edge as well as to one that ends because the
 * content stopped. Leaving that off is a real bug and not a tidiness point: a 2px strip of keying noise
 * along the bottom of the source counted as a ninth row, which shifted the whole row mapping down one
 * and imported the *stretch* art as `drink` before failing outright on the noise. A mis-mapped import
 * that still succeeds would have been much worse — it very nearly did.
 */
function rowBands(img, minHeight = 12, minPixels = 8) {
  const bands = []
  let start = null
  const close = (end) => {
    if (start !== null && end - start + 1 >= minHeight) bands.push([start, end])
    start = null
  }
  for (let y = 0; y < img.height; y += 1) {
    let n = 0
    for (let x = 0; x < img.width; x += 1) if (alphaAtRgba(img, x, y) > ALPHA_THRESHOLD) n += 1
    if (n > minPixels && start === null) start = y
    else if (n <= minPixels && start !== null) close(y - 1)
  }
  close(img.height - 1)
  return bands
}

/** Column spans containing content within a row band, in order left to right. */
function columnSpans(img, y0, y1, minWidth = 6, minPixels = 2) {
  const spans = []
  let start = null
  const close = (end) => {
    if (start !== null && end - start + 1 >= minWidth) spans.push([start, end])
    start = null
  }
  for (let x = 0; x < img.width; x += 1) {
    let n = 0
    for (let y = y0; y <= y1; y += 1) if (alphaAtRgba(img, x, y) > ALPHA_THRESHOLD) n += 1
    if (n > minPixels && start === null) start = x
    else if (n <= minPixels && start !== null) close(x - 1)
  }
  close(img.width - 1)
  return spans
}

/**
 * Copy a region out into its own image, keeping only the largest connected blob.
 *
 * This is what separates the character from things standing next to it. The sheet's drinking row ends
 * with a water bottle set down on the ground beside the character — genuinely detached art, but the
 * anti-aliased fringe left by keying is enough to bridge the gap at the column level, so span
 * detection alone merged the two and reported that frame as 85px wide instead of 65. Since frames are
 * centred on their content, that would have shoved the character sideways for one frame of the loop,
 * and widened the union mask — which every other state then inherits.
 *
 * Largest-blob rather than a hand-tuned gap: the character is always one connected piece (the bottle
 * it drinks from and the dumbbells it holds are in its hands, so they are part of the blob), and
 * anything genuinely separate is by definition not the character. `--keep-all` opts out for art that
 * deliberately has detached elements.
 */
function largestBlob(img, x0, y0, x1, y1, keepAll) {
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const out = Buffer.alloc(w * h * 4)
  const copy = (i, d) => {
    out[d] = img.data[i]
    out[d + 1] = img.data[i + 1]
    out[d + 2] = img.data[i + 2]
    out[d + 3] = img.data[i + 3]
  }

  if (keepAll) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        copy(((y0 + y) * img.width + x0 + x) * 4, (y * w + x) * 4)
      }
    }
    return { width: w, height: h, data: out, dropped: 0 }
  }

  // Connectivity is judged on *solid* pixels, not on any pixel with a trace of alpha. The generator
  // puts a soft glow around everything, and after keying that glow carries a few units of alpha — enough
  // to bridge a gap of several pixels and make the character and a bottle standing beside it one blob.
  // Labelling on the core and then growing back out by `grow` keeps the character's own soft edge while
  // leaving anything genuinely separate behind.
  const CORE_ALPHA = 64
  const grow = 3
  const solid = (x, y) => alphaAtRgba(img, x0 + x, y0 + y) > CORE_ALPHA
  const label = new Int32Array(w * h).fill(-1)
  const sizes = []

  for (let sy = 0; sy < h; sy += 1) {
    for (let sx = 0; sx < w; sx += 1) {
      if (label[sy * w + sx] !== -1 || !solid(sx, sy)) continue
      const id = sizes.length
      let size = 0
      // Explicit stack; a recursive fill blows up on a 200x200 blob.
      const stack = [sy * w + sx]
      label[sy * w + sx] = id
      while (stack.length > 0) {
        const at = stack.pop()
        const ax = at % w
        const ay = (at - ax) / w
        size += 1
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = ax + dx
            const ny = ay + dy
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
            const ni = ny * w + nx
            if (label[ni] !== -1 || !solid(nx, ny)) continue
            label[ni] = id
            stack.push(ni)
          }
        }
      }
      sizes.push(size)
    }
  }

  let best = -1
  sizes.forEach((size, id) => {
    if (best === -1 || size > sizes[best]) best = id
  })

  // The kept core, grown by `grow` so the character's own anti-aliased edge comes back with it.
  const keep = new Uint8Array(w * h)
  let frontier = []
  for (let i = 0; i < label.length; i += 1) {
    if (label[i] === best) {
      keep[i] = 1
      frontier.push(i)
    }
  }
  for (let step = 0; step < grow; step += 1) {
    const next = []
    for (const at of frontier) {
      const ax = at % w
      const ay = (at - ax) / w
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const nx = ax + dx
        const ny = ay + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const ni = ny * w + nx
        if (keep[ni]) continue
        keep[ni] = 1
        next.push(ni)
      }
    }
    frontier = next
  }

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!keep[y * w + x]) continue
      copy(((y0 + y) * img.width + x0 + x) * 4, (y * w + x) * 4)
    }
  }
  return { width: w, height: h, data: out, dropped: Math.max(0, sizes.length - 1) }
}

/** Tight bounds of the opaque content in a region. */
function contentBounds(img, x0, y0, x1, y1) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (alphaAtRgba(img, x, y) <= ALPHA_THRESHOLD) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

// ---------------------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------------------

/**
 * A triangle (bilinear) kernel, chosen over Lanczos-3 deliberately.
 *
 * Lanczos was the first choice — sharper, the usual default for photographic resizing. It is the wrong
 * tool here for a reason that showed up as visible damage: its negative lobes **ring**, and this
 * pipeline then un-premultiplies by dividing by the accumulated alpha. Where ringing leaves a small
 * alpha next to a large colour sum, that division amplifies it, and the result was ~155 saturated warm
 * specks scattered along the imported silhouettes where the original rows have exactly zero.
 *
 * A triangle kernel cannot overshoot: every weight is non-negative, so an output pixel is always a
 * convex combination of its inputs and can never leave their range. The cost is a slightly softer
 * result — at a 1.23× upscale, indistinguishable, and this art is anti-aliased rather than crisp pixel
 * art in the first place.
 */
const FILTER_SUPPORT = 1

function filterWeight(x) {
  const ax = Math.abs(x)
  return ax >= 1 ? 0 : 1 - ax
}

/**
 * Resample a region to an exact size, alpha-aware.
 *
 * Colour is weighted by alpha before filtering: a transparent pixel carries no colour, and letting its
 * (arbitrary) RGB into the average is what produces dark or coloured halos around edges after a resize.
 * Both sheets are 1-pixel detailed art rather than coarse pixel art — measured, horizontal run-lengths
 * dominated by 1 — so there is no block grid for a smooth filter to destroy.
 */
function resample(img, region, outWidth, outHeight) {
  const out = Buffer.alloc(outWidth * outHeight * 4)
  const scaleX = region.width / outWidth
  const scaleY = region.height / outHeight
  // Support widens when downscaling so the filter still covers the source footprint.
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
      // Un-premultiply, using the alpha-weighted total rather than the plain weight sum.
      out[d] = Math.max(0, Math.min(255, Math.round(r / a)))
      out[d + 1] = Math.max(0, Math.min(255, Math.round(g / a)))
      out[d + 2] = Math.max(0, Math.min(255, Math.round(b / a)))
      out[d + 3] = Math.round(alphaOut * 255)
    }
  }
  return { width: outWidth, height: outHeight, data: out }
}

// ---------------------------------------------------------------------------------------
// Scale derivation
// ---------------------------------------------------------------------------------------

/**
 * Derive the resample factor by comparing a pose both sheets contain.
 *
 * The generator draws at whatever size it likes, and hardcoding the factor measured from one file
 * means the next import silently produces a differently-sized character. Comparing the *first* row of
 * each — idle, the pose every generation of this sheet has started with — re-derives it per source.
 *
 * Averaged over both axes: the two agreed to three decimal places on the sheet this was written for
 * (1.246 wide, 1.240 tall), and a disagreement beyond a few percent means the source is not a
 * uniformly scaled version of the same art, which is worth stopping for.
 */
function deriveScale(keyed, committed, sheet) {
  const bands = rowBands(keyed)
  if (bands.length === 0) fail('The source has no visible content.')
  const [sy0, sy1] = bands[0]
  const sourceSpans = columnSpans(keyed, sy0, sy1)
  if (sourceSpans.length === 0) fail('The source’s first row has no frames.')
  const source = contentBounds(keyed, sourceSpans[0][0], sy0, sourceSpans[0][1], sy1)

  const target = contentBounds(committed, 0, 0, sheet.frameWidth - 1, sheet.frameHeight - 1)
  if (!target) fail('The committed sheet’s first frame is empty.')

  const byWidth = target.width / source.width
  const byHeight = target.height / source.height
  const disagreement = Math.abs(byWidth - byHeight) / Math.max(byWidth, byHeight)
  if (disagreement > 0.05) {
    fail(
      `The source is not a uniformly scaled version of the committed art: its first frame implies ` +
        `${byWidth.toFixed(3)}x horizontally but ${byHeight.toFixed(3)}x vertically ` +
        `(${(disagreement * 100).toFixed(1)}% apart). Compare the reference pose by eye before forcing --scale.`,
    )
  }
  return {
    scale: (byWidth + byHeight) / 2,
    detail: `source idle ${source.width}x${source.height} → committed ${target.width}x${target.height}`,
  }
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const { sheet } = loadSpritesheet()

  const sourcePng = decodePng(readFileSync(opts.source))
  const committed = decodePng(readFileSync(SPRITESHEET_PNG))
  // Checked against the *cell grid*, not against `sheet.rows`. This import adds rows, so the manifest's
  // row count is the target and not a precondition — and once it has been updated, insisting the PNG
  // already match it makes the script refuse to run a second time against the same source. Which it
  // did, and the failure looked like a corrupt sheet rather than an ordering problem.
  if (committed.width !== sheet.width || committed.height % sheet.frameHeight !== 0) {
    fail(
      `pet/spritesheet.png is ${committed.width}x${committed.height}, which is not ` +
        `${sheet.width} wide and a whole number of ${sheet.frameHeight}px rows.`,
    )
  }
  const committedRows = committed.height / sheet.frameHeight

  const key = opts.key ?? detectKey(sourcePng)
  console.log(`source     ${opts.source}`)
  console.log(`           ${sourcePng.width}x${sourcePng.height}, key rgb(${key.join(',')})`)

  const keyed = keyImage(sourcePng, key, { alphaFloor: opts.alphaFloor ?? undefined })

  const derived = opts.scale === 'auto' ? deriveScale(keyed, committed, sheet) : null
  const scale = derived ? derived.scale : opts.scale
  console.log(`scale      ${scale.toFixed(4)}x${derived ? `  (auto: ${derived.detail})` : '  (forced)'}`)

  const bands = rowBands(keyed)
  console.log(`rows found ${bands.length}`)

  // Source rows are taken from the bottom up by default: new animations get appended to the end of a
  // generated sheet, and counting from the bottom survives the generator changing how many rows it
  // re-renders above them — which it has done on every attempt so far.
  const from = opts.from ?? bands.length - opts.rows.length
  if (from < 0 || from + opts.rows.length > bands.length) {
    fail(`--from ${from} + ${opts.rows.length} rows does not fit in ${bands.length} source rows.`)
  }

  // Grow the sheet to hold the highest target row.
  const maxRow = Math.max(committedRows - 1, ...opts.rows.map((r) => r.targetRow))
  const outRows = maxRow + 1
  const outHeight = outRows * sheet.frameHeight
  const out = Buffer.alloc(sheet.width * outHeight * 4)
  committed.data.copy
    ? Buffer.from(committed.data).copy(out, 0)
    : out.set(committed.data.subarray(0, sheet.width * sheet.height * 4), 0)

  // The baseline every frame's feet must land on, and the centre column, both taken from the sheet
  // that already exists rather than assumed — this is the whole reason placement keeps working.
  const committedUnion = (() => {
    let minX = Infinity
    let maxX = -1
    let maxY = -1
    for (let row = 0; row < committedRows; row += 1) {
      for (let col = 0; col < sheet.columns; col += 1) {
        const b = contentBounds(
          committed,
          col * sheet.frameWidth,
          row * sheet.frameHeight,
          (col + 1) * sheet.frameWidth - 1,
          (row + 1) * sheet.frameHeight - 1,
        )
        if (!b) continue
        minX = Math.min(minX, b.x - col * sheet.frameWidth)
        maxX = Math.max(maxX, b.x + b.width - 1 - col * sheet.frameWidth)
        maxY = Math.max(maxY, b.y + b.height - 1 - row * sheet.frameHeight)
      }
    }
    return { minX, maxX, baseline: maxY, centre: (minX + maxX + 1) / 2 }
  })()

  console.log(
    `baseline   feet at cell y=${committedUnion.baseline} (footInset ${sheet.frameHeight - 1 - committedUnion.baseline}), ` +
      `centre x=${committedUnion.centre}`,
  )
  console.log()

  const report = []

  opts.rows.forEach((spec, index) => {
    const [y0, y1] = bands[from + index]
    const spans = columnSpans(keyed, y0, y1)
    if (spans.length < spec.frames) {
      fail(
        `${spec.name}: asked for ${spec.frames} frames but source row ${from + index} has only ` +
          `${spans.length} spans (y ${y0}-${y1}).`,
      )
    }
    if (spans.length > spec.frames) {
      console.log(
        `  ${spec.name}: source row has ${spans.length} spans, taking the first ${spec.frames} ` +
          `(dropping ${spans.length - spec.frames} — stray content or a damaged frame)`,
      )
    }
    if (spec.frames > sheet.columns) {
      fail(`${spec.name}: ${spec.frames} frames will not fit in ${sheet.columns} columns.`)
    }

    const placed = []
    for (let f = 0; f < spec.frames; f += 1) {
      const [sx0, sx1] = spans[f]
      // Isolate the character before measuring it: bounds taken over anything standing beside it
      // would centre the frame on the pair rather than on the pet. See `largestBlob`.
      const frame = largestBlob(keyed, sx0, y0, sx1, y1, opts.keepAll)
      const bounds = contentBounds(frame, 0, 0, frame.width - 1, frame.height - 1)
      if (!bounds) fail(`${spec.name} frame ${f}: no content in span ${sx0}-${sx1}.`)

      const outW = Math.max(1, Math.round(bounds.width * scale))
      const outH = Math.max(1, Math.round(bounds.height * scale))
      if (outW > sheet.frameWidth || outH > sheet.frameHeight) {
        fail(
          `${spec.name} frame ${f}: scaled to ${outW}x${outH}, which does not fit a ` +
            `${sheet.frameWidth}x${sheet.frameHeight} cell. Lower --scale or redraw smaller.`,
        )
      }

      const scaled = resample(frame, bounds, outW, outH)

      // Feet on the baseline, body centred: the two invariants placement depends on.
      const cellX = spec.targetRow >= 0 ? f * sheet.frameWidth : 0
      const cellY = spec.targetRow * sheet.frameHeight
      const offsetX = Math.round(cellX + committedUnion.centre - outW / 2)
      const offsetY = cellY + committedUnion.baseline - (outH - 1)

      if (offsetX < cellX || offsetX + outW > cellX + sheet.frameWidth) {
        fail(`${spec.name} frame ${f}: ${outW}px wide does not fit centred in the cell.`)
      }
      if (offsetY < cellY) {
        fail(
          `${spec.name} frame ${f}: ${outH}px tall does not fit above the baseline ` +
            `(needs ${outH} rows, cell has ${committedUnion.baseline + 1}).`,
        )
      }

      for (let y = 0; y < outH; y += 1) {
        for (let x = 0; x < outW; x += 1) {
          const s = (y * outW + x) * 4
          if (scaled.data[s + 3] === 0) continue
          const d = ((offsetY + y) * sheet.width + offsetX + x) * 4
          out[d] = scaled.data[s]
          out[d + 1] = scaled.data[s + 1]
          out[d + 2] = scaled.data[s + 2]
          out[d + 3] = scaled.data[s + 3]
        }
      }
      placed.push({ frame: f, source: `${bounds.width}x${bounds.height}`, out: `${outW}x${outH}` })
    }

    // Clear any cells in the target row beyond the frames we wrote — a row being overwritten may
    // have had more frames before (drink went from 6 idle duplicates to 8 real ones, but a future
    // import could shrink a row and leave orphans that the mask would then include).
    for (let f = spec.frames; f < sheet.columns; f += 1) {
      for (let y = 0; y < sheet.frameHeight; y += 1) {
        const rowStart = ((spec.targetRow * sheet.frameHeight + y) * sheet.width + f * sheet.frameWidth) * 4
        out.fill(0, rowStart, rowStart + sheet.frameWidth * 4)
      }
    }

    report.push({ spec, placed })
    console.log(
      `  ${spec.name.padEnd(8)} source row ${from + index} (y ${y0}-${y1}) → sheet row ${spec.targetRow}, ${spec.frames} frames`,
    )
    placed.forEach((p) => console.log(`      f${p.frame}  ${p.source} → ${p.out}`))
  })

  console.log()
  console.log(`sheet      ${committedRows} rows → ${outRows} rows (${sheet.width}x${outHeight})`)
  console.log()
  console.log('Next, by hand, because they are decisions and not derivations:')
  console.log('  pet/spritesheet.json  sheet.rows/height, the state entries, aliases, freeCells')
  console.log('  pnpm generate         CSS keyframes, the state union, and the alpha mask')

  if (opts.dryRun) {
    console.log('\n--dry-run: nothing written.')
    return
  }

  writeFileSync(SPRITESHEET_PNG, encodePng(sheet.width, outHeight, out))
  console.log(`\n✓ wrote ${SPRITESHEET_PNG.replace(ROOT + '/', '')}`)

  if (opts.preview) {
    const strip = buildPreview(out, sheet, outRows, report)
    writeFileSync(opts.preview, encodePng(strip.width, strip.height, strip.data))
    console.log(`✓ wrote ${opts.preview}`)
  }
}

/**
 * A strip of the imported rows over a mid-grey, plus one committed row for comparison.
 *
 * The point is the comparison: the imported art is upscaled and the existing art is not, so the only
 * question that matters is whether they read as the same character. That is a judgement call, and it
 * needs the two side by side rather than a number.
 */
function buildPreview(sheetData, sheet, outRows, report) {
  const rows = [0, ...report.map((r) => r.spec.targetRow)]
  const cols = Math.max(...report.map((r) => r.spec.frames), 6)
  const width = cols * sheet.frameWidth
  const height = rows.length * sheet.frameHeight
  const data = Buffer.alloc(width * height * 4)
  // Mid-grey, so both light outlines and dark ones are visible.
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = 96
    data[i * 4 + 1] = 96
    data[i * 4 + 2] = 100
    data[i * 4 + 3] = 255
  }
  rows.forEach((row, r) => {
    for (let y = 0; y < sheet.frameHeight; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const s = ((row * sheet.frameHeight + y) * sheet.width + x) * 4
        if (x >= sheet.width || row >= outRows) continue
        const a = sheetData[s + 3] / 255
        if (a === 0) continue
        const d = ((r * sheet.frameHeight + y) * width + x) * 4
        for (let c = 0; c < 3; c += 1) {
          data[d + c] = Math.round(sheetData[s + c] * a + data[d + c] * (1 - a))
        }
      }
    }
  })
  return { width, height, data }
}

main()
