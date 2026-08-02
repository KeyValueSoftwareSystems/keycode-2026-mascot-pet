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

/** Drop the window out of the always-on-top band. The inverse of `assertAlwaysOnTop`. */
export function releaseAlwaysOnTop(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.setAlwaysOnTop(false)
  // `setVisibleOnAllWorkspaces` is deliberately left alone. Being on every Space is a different
  // question from being in front of things, and revoking it here would make a pet the user merely
  // sent to the back *vanish* when they switched Space — which reads as a crash, not as a setting.
}

export interface AlwaysOnTopKeeper {
  /** Re-assert now. Call after anything that could have disturbed z-order. */
  reassert(): void
  /**
   * Turn the behaviour on or off. Off releases the window and silences every hook, so nothing
   * quietly puts it back — which is the failure this whole module is otherwise designed to prevent.
   */
  setEnabled(enabled: boolean): void
  /**
   * Hold the pet on top for as long as a callout is on screen, even when the setting is off.
   *
   * Without this, turning the setting off would mean team broadcasts and reminders could be
   * delivered to a window nobody can see — the message is "shown" and missed. Scoped to the
   * lifetime of the bubble and nothing longer: this is a pet raising its hand, not a pet
   * changing its mind about where it lives.
   */
  raiseForCallout(active: boolean): void
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
  options: { intervalMs?: number; enabled?: boolean } = {},
): AlwaysOnTopKeeper {
  const intervalMs = options.intervalMs ?? TOPMOST_KEEPER_INTERVAL_MS
  let timer: NodeJS.Timeout | null = null
  let disposed = false
  let enabled = options.enabled ?? true
  let calloutActive = false

  /** Should the window be on top right now? The setting, or a callout overriding it. */
  const wanted = (): boolean => enabled || calloutActive

  const reassert = (): void => {
    if (disposed || win.isDestroyed() || !wanted()) return
    assertAlwaysOnTop(win)
  }

  /**
   * Start or stop the Windows re-assert sweep to match the current state.
   *
   * Windows is the only platform that strips the flag behind Electron's back, so it is the only one
   * that needs a timer — and while the pet is deliberately *not* on top, that timer would be a
   * battery cost whose only possible effect is to undo the user's choice.
   */
  const syncTimer = (): void => {
    if (process.platform !== 'win32') return
    if (wanted() && !timer && !disposed) {
      timer = setInterval(() => {
        if (disposed || win.isDestroyed() || !wanted()) return
        if (win.isVisible()) reassert()
      }, intervalMs)
      timer.unref?.()
    } else if (!wanted() && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const apply = (): void => {
    if (disposed || win.isDestroyed()) return
    if (wanted()) assertAlwaysOnTop(win)
    else releaseAlwaysOnTop(win)
    syncTimer()
  }

  apply()

  // Each of these is a moment where the window manager may have reordered things underneath us.
  // `reassert` is a no-op while the pet is meant to be behind things, so the hooks can stay attached.
  win.on('show', reassert)
  win.on('restore', reassert)
  win.on('blur', reassert)
  powerMonitor.on('resume', reassert)

  return {
    reassert,

    setEnabled(next: boolean): void {
      if (next === enabled) return
      enabled = next
      apply()
    },

    raiseForCallout(active: boolean): void {
      if (active === calloutActive) return
      calloutActive = active
      apply()
    },

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
