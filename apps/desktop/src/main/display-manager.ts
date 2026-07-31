/**
 * Cached display geometry, plus the floor the pet runs along.
 *
 * Two decisions worth knowing about:
 *
 * 1. **Displays are keyed by geometry (`"x,y,WxH"`), not by Electron's numeric `id`.**
 *    Display ids are not stable across reboots on some platforms, and an id-keyed saved
 *    position silently resolves to "no saved position" — the pet quietly forgets where it
 *    was every time the machine restarts.
 *
 * 2. **The list is cached.** The 60ms motion tick asks for the floor on every tick; going
 *    to `screen.getAllDisplays()` that often is wasteful and, with several windows, shows
 *    up in profiles. The cache is invalidated only by display events, which are debounced
 *    because macOS emits a burst of them for a single physical change.
 */

import { screen } from 'electron'
import type { Display, Rectangle } from 'electron'

export interface DisplaySnapshot {
  /** Ordinal within `screen.getAllDisplays()`. The smoke harness maps this to `screencapture -D`. */
  index: number
  /** Stable geometry key: `"x,y,WxH"`. */
  key: string
  bounds: Rectangle
  workArea: Rectangle
  scaleFactor: number
}

/** The horizontal line the pet runs along, in screen coordinates. */
export interface Floor {
  /** Leftmost permitted centre-x for the sprite's visible body. */
  minX: number
  /** Rightmost permitted centre-x for the sprite's visible body. */
  maxX: number
  /** Screen y of the floor itself — the bottom of the work area. */
  y: number
  /** Key of the display this floor belongs to. */
  displayKey: string
}

export const DISPLAY_CHANGE_DEBOUNCE_MS = 200

export function displayKeyOf(bounds: Rectangle): string {
  return `${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`
}

function snapshot(display: Display, index: number): DisplaySnapshot {
  return {
    index,
    key: displayKeyOf(display.bounds),
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
  }
}

export interface DisplayManager {
  all(): readonly DisplaySnapshot[]
  primary(): DisplaySnapshot
  nearest(point: { x: number; y: number }): DisplaySnapshot
  byKey(key: string): DisplaySnapshot | null
  /** The floor for a display, given how far the sprite's visible body extends from its centre. */
  floorFor(display: DisplaySnapshot, bodyHalfWidth: number): Floor
  /** Subscribe to debounced display changes. Returns an unsubscribe function. */
  onChanged(listener: () => void): () => void
  dispose(): void
}

export function createDisplayManager(): DisplayManager {
  let cache: DisplaySnapshot[] | null = null
  const listeners = new Set<() => void>()
  let debounce: NodeJS.Timeout | null = null

  const rebuild = (): DisplaySnapshot[] => {
    cache = screen.getAllDisplays().map(snapshot)
    return cache
  }

  const all = (): readonly DisplaySnapshot[] => cache ?? rebuild()

  const invalidate = (): void => {
    cache = null
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      rebuild()
      for (const listener of listeners) listener()
    }, DISPLAY_CHANGE_DEBOUNCE_MS)
    debounce.unref?.()
  }

  screen.on('display-added', invalidate)
  screen.on('display-removed', invalidate)
  screen.on('display-metrics-changed', invalidate)

  return {
    all,

    primary(): DisplaySnapshot {
      const primary = screen.getPrimaryDisplay()
      const key = displayKeyOf(primary.bounds)
      return all().find((d) => d.key === key) ?? snapshot(primary, 0)
    },

    nearest(point): DisplaySnapshot {
      const display = screen.getDisplayNearestPoint(point)
      const key = displayKeyOf(display.bounds)
      return all().find((d) => d.key === key) ?? snapshot(display, 0)
    },

    byKey(key): DisplaySnapshot | null {
      return all().find((d) => d.key === key) ?? null
    },

    floorFor(display, bodyHalfWidth): Floor {
      const { workArea } = display
      return {
        // Clamping the pet's *body* centre, not the window, is deliberate: the window is far
        // wider than the visible character, so clamping window bounds would stop the pet
        // ~126px short of the screen edge and the transparent margin would read as a bug.
        minX: workArea.x + bodyHalfWidth,
        maxX: workArea.x + workArea.width - bodyHalfWidth,
        y: workArea.y + workArea.height,
        displayKey: display.key,
      }
    },

    onChanged(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    dispose(): void {
      screen.removeListener('display-added', invalidate)
      screen.removeListener('display-removed', invalidate)
      screen.removeListener('display-metrics-changed', invalidate)
      listeners.clear()
      if (debounce) clearTimeout(debounce)
      debounce = null
    },
  }
}
