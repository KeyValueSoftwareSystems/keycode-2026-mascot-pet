/**
 * Click-through, and the watchdog that keeps it working.
 *
 * The pet window is much larger than the visible character, so most of it must pass clicks to
 * whatever is underneath while the character itself stays grabbable. How that is achieved differs
 * per platform, and the differences are not cosmetic:
 *
 * **macOS / Windows** — `setIgnoreMouseEvents(true, { forward: true })`. The window ignores
 * clicks but Chromium still forwards *move* events to the renderer, which is the only way a
 * click-through window can learn the cursor is over it. The renderer hit-tests the alpha mask and
 * reports back; main flips the window interactive while the pointer is on the pet.
 *
 * **Linux** — forwarding does not deliver hover at all. A click-through Linux window therefore
 * never learns the cursor arrived and is permanently ungrabbable. So the window stays interactive
 * and `setShape()` restricts its *input region* to the mask's rects instead. Best effort: it is
 * X11-only, needs the XShape extension, and does not survive navigation.
 *
 * **The watchdog** exists because forwarding dies silently. From openpets, having verified it:
 * on Windows Chromium's forwarded-mouse tracking goes stale after rapid reloads and fullscreen
 * sweeps; on macOS the WindowServer stops delivering forwarded moves after Space switches, display
 * sleep and fullscreen transitions. The symptom is a pet stuck click-through that cannot be
 * grabbed at all. `screen.getCursorScreenPoint()` keeps working when forwarding is dead, so main
 * polls it and re-arms.
 */

import { screen } from 'electron'
import type { BrowserWindow, Rectangle } from 'electron'
import { IPC } from '../pet-frame.js'

/** Platforms where `{ forward: true }` actually delivers hover events. */
export function canForwardMouseEvents(platform: NodeJS.Platform | string): boolean {
  return platform === 'darwin' || platform === 'win32'
}

/**
 * Platforms needing the cursor-probe watchdog.
 *
 * Deliberately identical to `canForwardMouseEvents`: the watchdog exists to recover forwarding,
 * so it is needed exactly where forwarding is used. Guarding it on Windows alone — the tempting
 * reading, since Windows is the noisier case — leaves macOS pets stuck after a Space switch.
 */
export function shouldWatchForwarding(platform: NodeJS.Platform | string): boolean {
  return canForwardMouseEvents(platform)
}

export const WATCHDOG_INTERVAL_MS = 750

/**
 * Extra re-arm attempts on Windows, in ms after the first.
 *
 * Empirical constants from openpets: Windows sometimes re-registers mouse forwarding only after
 * Chromium finishes late compositing work, so a single re-arm loses the race. Kept in one named
 * object so a future Windows session can tune them without archaeology.
 */
export const WINDOWS_REARM_DELAYS_MS = [75, 175, 400, 900, 1_500] as const

export interface ForwardingController {
  /** The renderer's verdict on whether the pointer is over the pet. */
  setPointerOverPet(over: boolean): void
  /** Suspend passthrough management for the duration of a drag. */
  setDragging(active: boolean): void
  /** Re-apply after the window is shown. */
  onShown(): void
  /** Re-apply after a page load; `setShape` and forwarding both reset on navigation. */
  afterNavigate(): void
  /**
   * Replace the Linux input region, e.g. after a pet-size change.
   *
   * The rects are window-local, so resizing the window without updating them leaves the grabbable
   * area in the wrong place — and on Linux that is the *only* thing making the pet grabbable.
   */
  setShapeRects(rects: readonly Rectangle[]): void
  /**
   * Keep the window interactive while a bubble that must be clicked (ok / snooze) is showing.
   * Otherwise the first click falls through because forwarding has not yet seen a hover.
   */
  setForceInteractive(active: boolean): void
  dispose(): void
}

export interface ForwardingOptions {
  /** Window-local input rects for the Linux `setShape` path. */
  shapeRects: readonly Rectangle[]
  intervalMs?: number
  log?: (message: string, meta?: unknown) => void
}

export function createForwardingController(
  win: BrowserWindow,
  options: ForwardingOptions,
): ForwardingController {
  const platform = process.platform
  const forwardable = canForwardMouseEvents(platform)
  const watch = shouldWatchForwarding(platform)
  const intervalMs = options.intervalMs ?? WATCHDOG_INTERVAL_MS
  const log = options.log ?? (() => {})

  let pointerOverPet = false
  let dragging = false
  let forceInteractive = false
  let disposed = false
  let watchTimer: NodeJS.Timeout | null = null
  let rearmTimers: NodeJS.Timeout[] = []
  let shapeWarned = false
  let shapeRects: readonly Rectangle[] = options.shapeRects

  const applyLinuxShape = (): void => {
    if (platform !== 'linux' || win.isDestroyed()) return
    try {
      // Restricting the input region is Linux's only route to click-through, since ignored
      // windows there cannot receive the events needed to detect hover or start a drag.
      win.setShape([...shapeRects])
    } catch (error) {
      if (!shapeWarned) {
        shapeWarned = true
        log(
          'setShape failed; the pet window stays fully interactive. Clicks in its transparent ' +
            'margin will not reach the app underneath.',
          { error: String(error) },
        )
      }
    }
  }

  const applyPassthrough = (): void => {
    if (disposed || win.isDestroyed()) return

    if (platform === 'linux') {
      win.setIgnoreMouseEvents(false)
      applyLinuxShape()
      return
    }

    const passthrough = !forceInteractive && !pointerOverPet && !dragging
    if (passthrough) {
      if (forwardable) win.setIgnoreMouseEvents(true, { forward: true })
      else win.setIgnoreMouseEvents(true)
    } else {
      win.setIgnoreMouseEvents(false)
    }
  }

  const cursorProbe = (): { clientX: number; clientY: number; inside: boolean } => {
    const cursor = screen.getCursorScreenPoint()
    const bounds = win.getContentBounds()
    const clientX = cursor.x - bounds.x
    const clientY = cursor.y - bounds.y
    return {
      clientX,
      clientY,
      inside: clientX >= 0 && clientY >= 0 && clientX < bounds.width && clientY < bounds.height,
    }
  }

  const clearRearmTimers = (): void => {
    for (const timer of rearmTimers) clearTimeout(timer)
    rearmTimers = []
  }

  /**
   * Force forwarding back on and make the renderer re-hit-test.
   *
   * The toggle off-then-on is what actually re-registers the tracking; the probe is needed
   * because the renderer will otherwise never see another mouse event to react to.
   */
  const rearm = (reason: string): void => {
    if (disposed || win.isDestroyed() || !forwardable) return
    if (forceInteractive || dragging || pointerOverPet) return

    win.setIgnoreMouseEvents(false)
    win.setIgnoreMouseEvents(true, { forward: true })

    const probe = cursorProbe()
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(IPC.pointerProbe, probe)
    }

    if (platform === 'win32') {
      clearRearmTimers()
      for (const delay of WINDOWS_REARM_DELAYS_MS) {
        const timer = setTimeout(() => {
          if (disposed || win.isDestroyed() || pointerOverPet || dragging || forceInteractive) return
          win.setIgnoreMouseEvents(false)
          win.setIgnoreMouseEvents(true, { forward: true })
          if (!win.webContents.isDestroyed()) {
            win.webContents.send(IPC.pointerProbe, cursorProbe())
          }
        }, delay)
        timer.unref?.()
        rearmTimers.push(timer)
      }
    }

    // A re-arm is routine recovery, not a fault — log it, do not raise it.
    log('re-armed mouse forwarding', { reason })
  }

  const stopWatch = (): void => {
    if (watchTimer) clearTimeout(watchTimer)
    watchTimer = null
  }

  /**
   * Self-rescheduling rather than a fixed interval, and disarmed whenever the pointer is already
   * known to be on the pet or a drag is in progress — in both cases forwarding is demonstrably
   * alive and probing would be noise.
   */
  const scheduleWatch = (reason: string): void => {
    if (!watch || disposed || watchTimer || dragging || pointerOverPet || forceInteractive || win.isDestroyed())
      return
    watchTimer = setTimeout(() => {
      watchTimer = null
      if (disposed || win.isDestroyed() || dragging || pointerOverPet || forceInteractive) return
      if (cursorProbe().inside) rearm(reason)
      scheduleWatch(reason)
    }, intervalMs)
    watchTimer.unref?.()
  }

  applyPassthrough()
  scheduleWatch('startup')

  return {
    setPointerOverPet(over: boolean): void {
      pointerOverPet = over
      applyPassthrough()
      if (over || dragging) stopWatch()
      else scheduleWatch('pointer-left')
    },

    setDragging(active: boolean): void {
      dragging = active
      applyPassthrough()
      if (active) {
        stopWatch()
        clearRearmTimers()
      } else {
        scheduleWatch('drag-ended')
      }
    },

    onShown(): void {
      applyPassthrough()
      scheduleWatch('shown')
    },

    setShapeRects(rects: readonly Rectangle[]): void {
      shapeRects = rects
      applyLinuxShape()
    },

    setForceInteractive(active: boolean): void {
      forceInteractive = active
      applyPassthrough()
      if (active) {
        stopWatch()
        clearRearmTimers()
      } else {
        scheduleWatch('callout-actions-cleared')
      }
    },

    afterNavigate(): void {
      // Passthrough and the Linux input shape are both reset by a page load. Without this the
      // pet comes back from a reload permanently click-through.
      if (win.isDestroyed()) return
      win.setIgnoreMouseEvents(false)
      pointerOverPet = false
      applyPassthrough()
      scheduleWatch('after-navigate')
    },

    dispose(): void {
      disposed = true
      stopWatch()
      clearRearmTimers()
      if (!win.isDestroyed()) win.setIgnoreMouseEvents(false)
    },
  }
}
