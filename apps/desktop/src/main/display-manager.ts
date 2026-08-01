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
/**
 * The envelope the pet may occupy on one display.
 *
 * Still called `Floor` because the floor is still the default and the thing the pet returns to — but
 * since the pet became freely placeable it also carries how far off the floor it may be lifted.
 */
export interface Floor {
  /** Leftmost permitted centre-x for the sprite's visible body. */
  minX: number
  /** Rightmost permitted centre-x for the sprite's visible body. */
  maxX: number
  /** Screen y of the floor itself — the bottom of the work area. */
  y: number
  /**
   * Highest permitted feet-y. Bounded so the *window* top stays inside the work area, which is what
   * guarantees a speech bubble is always fully visible: the bubble lives in the window above the
   * sprite, and above the work area it would render behind the menu bar. The cost is that the pet's
   * head cannot reach the top ~126px of the screen. Messages being readable wins.
   */
  minFeetY: number
  /** Lowest permitted feet-y — the floor. The pet never sinks below it. */
  maxFeetY: number
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
  // No `floorFor` here: `floorForWorkArea` in floor-placement.ts is the single definition of the
  // envelope. There used to be a second one on this interface, never called, and adding the vertical
  // bounds to only one of them is exactly how two definitions of the same thing start to disagree.
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
