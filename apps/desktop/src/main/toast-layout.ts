/**
 * Toast stacking geometry. Pure, so the bug below is testable.
 *
 * openpets tracks toast slots with a module-level counter that is incremented per toast and never
 * compacted — so when a toast in the middle of a stack is destroyed, the ones above it keep their
 * original offsets and a visible hole is left behind. Here layout is recomputed from the *current*
 * list every time one goes away, which makes the hole impossible rather than unlikely.
 */

import { TOAST } from '../config/constants.js'

export interface ToastBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Bottom-right stack, growing upwards. Index 0 is the lowest.
 *
 * Anchored to the work area rather than the display bounds so a toast never slides under the Dock or
 * the taskbar.
 */
export function layoutToasts(count: number, workArea: WorkArea): ToastBounds[] {
  const bounds: ToastBounds[] = []
  const x = Math.round(workArea.x + workArea.width - TOAST.width - TOAST.margin)

  for (let index = 0; index < count; index += 1) {
    const y = Math.round(
      workArea.y +
        workArea.height -
        TOAST.height -
        TOAST.margin -
        index * (TOAST.height + TOAST.gap),
    )
    bounds.push({ x, y, width: TOAST.width, height: TOAST.height })
  }

  return bounds
}

/** Clamp a requested duration into the range the UI can actually service. */
export function clampToastDuration(durationMs: number | undefined): number {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return TOAST.defaultMs
  return Math.min(TOAST.maxMs, Math.max(TOAST.minMs, durationMs))
}

/** Whether another toast may be shown, or should be dropped rather than stacked off-screen. */
export function hasToastCapacity(currentCount: number): boolean {
  return currentCount < TOAST.max
}
