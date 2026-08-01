/**
 * Pure alpha-mask maths. No filesystem, so it unit-tests directly.
 *
 * The mask is a **union across every frame of every state**, not per-frame. That is a
 * deliberate correctness choice: a per-frame mask makes the grabbable region pulse in time with
 * the animation, so the pet becomes intermittently un-grabbable in a way that feels broken.
 * Slight over-grab is invisible; flicker is not.
 */

/** Alpha above this counts as opaque. Low enough to keep antialiased edges, high enough to drop dust. */
export const ALPHA_THRESHOLD = 8

/** Mask resolution. 4px keeps the mask tiny (312 bytes) while staying finer than any limb. */
export const GRANULARITY = 4

/**
 * Build the union coverage bitmap for one sheet cell size across a set of frames.
 *
 * @param {{width:number,height:number,data:Uint8Array}} png
 * @param {{frameWidth:number,frameHeight:number}} sheet
 * @param {Array<{row:number,frames:number,name:string}>} states
 * @returns {{ union: Uint8Array, perFrameOpaque: number[], footInsetByState: Record<string, number>, headTopByState: Record<string, number> }}
 */
export function buildUnion(png, sheet, states) {
  const { frameWidth: fw, frameHeight: fh } = sheet
  const union = new Uint8Array(fw * fh)
  const perFrameOpaque = []
  const footInsetByState = {}
  const headTopByState = {}

  const alpha = (x, y) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return 0
    return png.data[(y * png.width + x) * 4 + 3]
  }

  for (const state of states) {
    let lowestOpaqueRow = -1
    let highestOpaqueRow = fh

    for (let frame = 0; frame < state.frames; frame += 1) {
      const originX = frame * fw
      const originY = state.row * fh
      let opaque = 0

      for (let y = 0; y < fh; y += 1) {
        for (let x = 0; x < fw; x += 1) {
          if (alpha(originX + x, originY + y) <= ALPHA_THRESHOLD) continue
          opaque += 1
          union[y * fw + x] = 1
          if (y > lowestOpaqueRow) lowestOpaqueRow = y
          if (y < highestOpaqueRow) highestOpaqueRow = y
        }
      }

      perFrameOpaque.push(opaque)
    }

    if (lowestOpaqueRow < 0) {
      throw new Error(`state "${state.name}" (row ${state.row}) is entirely transparent.`)
    }
    footInsetByState[state.name] = fh - 1 - lowestOpaqueRow
    // Highest opaque row in this state, across all its frames. The speech bubble hangs off this:
    // anchoring to the *union* top instead puts every pose's bubble as high as the tallest pose
    // (`jumping` reaches 34px above idle's hair), which leaves a visible gap and stops the bubble
    // reading as attached to the character. Per state, not per frame — per frame would make it
    // bob with the animation.
    headTopByState[state.name] = highestOpaqueRow
  }

  return { union, perFrameOpaque, footInsetByState, headTopByState }
}

/** Tight bounding box of the set pixels. */
export function boundingBox(union, width, height) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!union[y * width + x]) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) throw new Error('the union mask is empty — no opaque pixels anywhere.')
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** Downsample the pixel union to a coarse cell grid. A cell is set if *any* pixel in it is set. */
export function toCellGrid(union, width, height, granularity = GRANULARITY) {
  const cols = Math.ceil(width / granularity)
  const rows = Math.ceil(height / granularity)
  const cells = new Uint8Array(cols * rows)

  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      let set = 0
      for (let y = cy * granularity; y < Math.min((cy + 1) * granularity, height) && !set; y += 1) {
        for (let x = cx * granularity; x < Math.min((cx + 1) * granularity, width); x += 1) {
          if (union[y * width + x]) {
            set = 1
            break
          }
        }
      }
      cells[cy * cols + cx] = set
    }
  }

  return { cells, cols, rows }
}

/** Pack a 0/1 cell grid into a bitfield, row-major, MSB first. */
export function packBits(cells) {
  const bytes = new Uint8Array(Math.ceil(cells.length / 8))
  for (let i = 0; i < cells.length; i += 1) {
    if (cells[i]) bytes[i >> 3] |= 0x80 >> (i & 7)
  }
  return bytes
}

export function unpackBits(bytes, length) {
  const cells = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    cells[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1
  }
  return cells
}

/**
 * Derive a small rectangle list covering the mask, for Electron's `setShape` on Linux.
 *
 * Two passes: maximal horizontal runs per row, then merge vertically adjacent runs whose
 * `[start, end)` span matches exactly. On this art that collapses 46 runs to 26 rects covering
 * exactly the mask area with zero over-cover.
 *
 * Rects are cell-local pixels; the caller translates them by the sprite's origin in the window.
 */
export function toShapeRects(cells, cols, rows, granularity = GRANULARITY, maxRects = 48) {
  /** @type {Array<{x:number,y:number,width:number,height:number}>} */
  const open = []
  /** @type {Array<{x:number,y:number,width:number,height:number}>} */
  const closed = []

  for (let cy = 0; cy < rows; cy += 1) {
    const runs = []
    let start = -1
    for (let cx = 0; cx <= cols; cx += 1) {
      const set = cx < cols && cells[cy * cols + cx]
      if (set && start === -1) start = cx
      else if (!set && start !== -1) {
        runs.push([start, cx])
        start = -1
      }
    }

    const stillOpen = []
    for (const run of runs) {
      const match = open.find(
        (r) => r.x === run[0] * granularity && r.width === (run[1] - run[0]) * granularity,
      )
      if (match && match.y + match.height === cy * granularity) {
        match.height += granularity
        stillOpen.push(match)
      } else {
        const rect = {
          x: run[0] * granularity,
          y: cy * granularity,
          width: (run[1] - run[0]) * granularity,
          height: granularity,
        }
        stillOpen.push(rect)
      }
    }

    // Anything not extended this row can never be extended again.
    for (const rect of open) if (!stillOpen.includes(rect)) closed.push(rect)
    open.length = 0
    open.push(...stillOpen)
  }
  closed.push(...open)

  closed.sort((a, b) => a.y - b.y || a.x - b.x)

  if (closed.length <= maxRects) return closed

  // Degrade predictably rather than handing setShape hundreds of rects: one bounding run per
  // mask row, and failing that a single box. Both over-cover, which costs click-through
  // precision on Linux but never correctness.
  const perRow = []
  for (let cy = 0; cy < rows; cy += 1) {
    let min = -1
    let max = -1
    for (let cx = 0; cx < cols; cx += 1) {
      if (!cells[cy * cols + cx]) continue
      if (min === -1) min = cx
      max = cx
    }
    if (min !== -1) {
      perRow.push({
        x: min * granularity,
        y: cy * granularity,
        width: (max - min + 1) * granularity,
        height: granularity,
      })
    }
  }
  return perRow.length <= maxRects ? perRow : []
}

/** Total area of a rect list, for over-cover assertions. */
export function rectsArea(rects) {
  return rects.reduce((sum, r) => sum + r.width * r.height, 0)
}
