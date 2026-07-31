/**
 * The app shell — everything that exists once the app is ready.
 *
 * Kept separate from `main.ts` so that `main.ts` contains only ordering-sensitive boot
 * steps, and so this module can be imported lazily after `whenReady`.
 *
 * Grows across milestones: M0 brings up the backdrop, M1 the settings store and tray,
 * M2 the pet window, M3 the controller, M4–M8 the rest.
 */

import { app, type BrowserWindow } from 'electron'
import { createDisplayManager, type DisplayManager } from './display-manager.js'
import { createBackdropWindow, shouldShowBackdrop } from './backdrop-window.js'
import { installHarnessControl } from './harness-control.js'
import { emit } from './harness-handshake.js'

export interface AppShell {
  displays: DisplayManager
  backdrop: BrowserWindow | null
  onSecondInstance(): void
  dispose(): Promise<void>
}

export async function startApp(): Promise<AppShell> {
  const displays = createDisplayManager()

  let backdrop: BrowserWindow | null = null
  if (shouldShowBackdrop()) {
    // The harness pins captures to one display, so the backdrop covers the display the
    // pet will start on — the one nearest the cursor.
    backdrop = await createBackdropWindow(displays.primary())
  }

  const stopHarnessControl = installHarnessControl({
    pet: () => null, // wired to the real pet window in M2
    backdrop: () => backdrop,
  })

  const shell: AppShell = {
    displays,
    backdrop,

    onSecondInstance(): void {
      // Nothing to focus — the pet has no focusable surface and no settings window by
      // design. The first instance simply stays as it is; the second exits.
    },

    async dispose(): Promise<void> {
      stopHarnessControl()
      displays.dispose()
      if (backdrop && !backdrop.isDestroyed()) backdrop.destroy()
    },
  }

  app.on('before-quit', () => {
    void shell.dispose().catch((error: unknown) => {
      emit({ ev: 'error', where: 'dispose', message: String(error) })
    })
  })

  return shell
}
