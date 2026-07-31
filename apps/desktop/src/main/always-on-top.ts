/**
 * Keeping the pet on top. Harder than one API call, for reasons that are entirely the OS's fault.
 *
 * Every mechanism here is ported from openpets, whose comments record having verified the
 * behaviour live. None of it is defensive guesswork; each line answers a specific observed bug.
 */

import type { BrowserWindow } from 'electron'
import { powerMonitor } from 'electron'

/**
 * How often to re-assert on Windows while visible.
 *
 * The shell's demotion sweep re-strips the topmost flag every ~2-4s while a fullscreen app is
 * foreground, so a slower cadence loses the race and the pet spends seconds at a time buried.
 * Two `SetWindowPos` calls a second is negligible.
 */
export const TOPMOST_KEEPER_INTERVAL_MS = 1_000

/** The always-on-top level per platform. Linux needs a higher band to clear panels and docks. */
export function alwaysOnTopLevel(): 'floating' | 'screen-saver' {
  return process.platform === 'linux' ? 'screen-saver' : 'floating'
}

/**
 * Assert always-on-top, defeating Electron's cached state.
 *
 * On Windows the shell strips `WS_EX_TOPMOST` behind Electron's back when another app goes
 * fullscreen, but Electron's cached flag still reads "on" — so a plain `setAlwaysOnTop(true)`
 * short-circuits and never reaches the OS. openpets verified the flag staying off through minutes
 * of re-asserts. Dropping the cached value first forces a real `SetWindowPos`.
 */
export function assertAlwaysOnTop(win: BrowserWindow): void {
  if (win.isDestroyed()) return

  if (process.platform === 'win32' && win.isAlwaysOnTop()) {
    win.setAlwaysOnTop(false)
  }

  win.setAlwaysOnTop(true, alwaysOnTopLevel())

  // macOS: without this the window is bound to the Space it was created on and vanishes when the
  // user switches. `visibleOnFullScreen` is also what lets it float above a fullscreened app.
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } else if (process.platform === 'linux') {
    win.setVisibleOnAllWorkspaces(true)
  }
}

export interface AlwaysOnTopKeeper {
  /** Re-assert now. Call after anything that could have disturbed z-order. */
  reassert(): void
  dispose(): void
}

/**
 * Keep asserting. Returns a disposer.
 *
 * The interval only runs on Windows, where the OS actively takes the flag away. Elsewhere the
 * event hooks are sufficient and a needless 1s timer would be pure battery cost.
 */
export function startAlwaysOnTopKeeper(
  win: BrowserWindow,
  options: { intervalMs?: number } = {},
): AlwaysOnTopKeeper {
  const intervalMs = options.intervalMs ?? TOPMOST_KEEPER_INTERVAL_MS
  let timer: NodeJS.Timeout | null = null
  let disposed = false

  const reassert = (): void => {
    if (disposed || win.isDestroyed()) return
    assertAlwaysOnTop(win)
  }

  reassert()

  // Each of these is a moment where the window manager may have reordered things underneath us.
  win.on('show', reassert)
  win.on('restore', reassert)
  win.on('blur', reassert)
  powerMonitor.on('resume', reassert)

  if (process.platform === 'win32') {
    timer = setInterval(() => {
      if (disposed || win.isDestroyed()) return
      if (win.isVisible()) reassert()
    }, intervalMs)
    timer.unref?.()
  }

  return {
    reassert,
    dispose(): void {
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
      powerMonitor.removeListener('resume', reassert)
      if (!win.isDestroyed()) {
        win.removeListener('show', reassert)
        win.removeListener('restore', reassert)
        win.removeListener('blur', reassert)
      }
    },
  }
}
