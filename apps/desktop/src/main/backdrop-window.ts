/**
 * The dark backdrop window — dev and harness only.
 *
 * Its entire purpose is to make transparency bugs visible. Against a white desktop, an
 * opaque black or white box behind the sprite looks like nothing at all; against #101014
 * it is unmissable both to a human and to the smoke harness's pixel assertions.
 *
 * Gated on `KEYCODE_PET_BACKDROP=1` **and** `!app.isPackaged`, so it can never appear in a
 * shipped build even if someone sets the env var.
 */

import { BrowserWindow, app } from 'electron'
import { SECURE_WEB_PREFERENCES, applyWindowSecurity } from './window-security.js'
import { emit } from './harness-handshake.js'
import { rendererFile } from './paths.js'
import type { DisplaySnapshot } from './display-manager.js'

/** Must match `--backdrop` in backdrop.html. The harness asserts against this exact value. */
export const BACKDROP_RGB: readonly [number, number, number] = [0x10, 0x10, 0x14]
export const BACKDROP_HEX = '#101014'

export function shouldShowBackdrop(): boolean {
  return process.env.KEYCODE_PET_BACKDROP === '1' && !app.isPackaged
}

export async function createBackdropWindow(display: DisplaySnapshot): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: false,
    backgroundColor: BACKDROP_HEX,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    title: 'Keycode Pet Backdrop',
    webPreferences: { ...SECURE_WEB_PREFERENCES },
  })

  applyWindowSecurity(win, 'backdrop')
  win.setIgnoreMouseEvents(true)

  // 'normal' keeps it above ordinary windows so the pet has something dark to sit on,
  // while staying below the pet's 'floating' level. Relative always-on-top levels are the
  // least predictable corner of this design; if the ordering ever inverts, the harness's
  // sprite-present assertion fails loudly rather than passing a wrong screenshot.
  win.setAlwaysOnTop(true, 'normal')

  await win.loadFile(rendererFile('backdrop.html'))
  win.showInactive()

  emit({
    ev: 'window-ready',
    window: 'backdrop',
    bounds: win.getContentBounds(),
    display: {
      index: display.index,
      key: display.key,
      scaleFactor: display.scaleFactor,
      bounds: display.bounds,
      workArea: display.workArea,
    },
  })

  return win
}
