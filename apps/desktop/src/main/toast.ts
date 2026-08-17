/**
 * Corner-toast windows.
 *
 * The fallback surface for messages the bubble cannot serve: the pet is hidden, or the message is
 * urgent enough to deserve a spot the user is definitely looking at.
 */

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { SECURE_WEB_PREFERENCES, applyWindowSecurity } from './window-security.js'
import { layoutToasts, clampToastDuration, hasToastCapacity } from './toast-layout.js'
import { rendererFile, paths } from './paths.js'
import { PRODUCT_NAME, TOAST } from '../config/constants.js'
import type { Tone } from '../pet-frame.js'
import { emit } from './harness-handshake.js'

const TOAST_CHANNEL = 'keycode-pet:toast'

export interface ToastRequest {
  text: string
  tone: Tone
  durationMs?: number
}

export interface ToastManager {
  show(request: ToastRequest): void
  count(): number
  destroyAll(): void
}

interface ToastEntry {
  win: BrowserWindow
  timer: NodeJS.Timeout | null
}

export function createToastManager(
  options: { log?: (message: string, meta?: unknown) => void } = {},
): ToastManager {
  const log = options.log ?? (() => {})
  const entries: ToastEntry[] = []

  const workArea = (): { x: number; y: number; width: number; height: number } => {
    // The display under the cursor: a notification should appear where the user is looking, not on
    // whichever display the OS calls primary.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    return display.workArea
  }

  /** Recompute every surviving toast's position from the current list. */
  const relayout = (): void => {
    const bounds = layoutToasts(entries.length, workArea())
    entries.forEach((entry, index) => {
      const target = bounds[index]
      if (!target || entry.win.isDestroyed()) return
      entry.win.setBounds(target)
    })
  }

  const destroy = (entry: ToastEntry): void => {
    const at = entries.indexOf(entry)
    if (at !== -1) entries.splice(at, 1)
    if (entry.timer) clearTimeout(entry.timer)
    if (!entry.win.isDestroyed()) entry.win.destroy()
    // Recompute from the current list rather than trusting a counter — this is what stops a hole
    // appearing when a toast in the middle of the stack goes away.
    relayout()
  }

  return {
    show(request: ToastRequest): void {
      if (!hasToastCapacity(entries.length)) {
        // Dropped rather than stacked off the top of the screen. Counted so it is not invisible.
        log('toast dropped: at capacity', { max: TOAST.max, text: request.text.slice(0, 40) })
        return
      }

      const durationMs = clampToastDuration(request.durationMs)
      const bounds = layoutToasts(entries.length + 1, workArea())[entries.length]!

      const win = new BrowserWindow({
        ...bounds,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        // Never take focus: a notification that steals the caret while someone is typing is worse
        // than no notification.
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        title: `${PRODUCT_NAME} notification`,
        webPreferences: {
          ...SECURE_WEB_PREFERENCES,
          preload: join(paths.distDir, 'preload', 'toast-preload.cjs'),
        },
      })

      applyWindowSecurity(win, 'toast')
      win.setAlwaysOnTop(true, process.platform === 'linux' ? 'screen-saver' : 'floating')
      win.setIgnoreMouseEvents(true)

      const entry: ToastEntry = { win, timer: null }
      entries.push(entry)

      win
        .loadFile(rendererFile('toast.html'))
        .then(() => {
          if (win.isDestroyed()) return
          win.webContents.send(TOAST_CHANNEL, {
            text: request.text,
            tone: request.tone,
            durationMs,
          })
          win.showInactive()

          // +60ms so the CSS fade-out finishes before the window disappears; destroying at exactly
          // `durationMs` would cut the last frame and look like a glitch.
          entry.timer = setTimeout(() => destroy(entry), durationMs + 60)
          entry.timer.unref?.()
        })
        .catch((error: unknown) => {
          emit({ ev: 'error', where: 'toast:load', message: String(error) })
          destroy(entry)
        })
    },

    count(): number {
      return entries.length
    },

    destroyAll(): void {
      for (const entry of [...entries]) destroy(entry)
    },
  }
}
