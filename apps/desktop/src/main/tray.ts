/**
 * The tray icon — the app's only permanent, always-reachable surface.
 *
 * It matters more than it looks: on Linux under Wayland, right-click on the sprite is
 * swallowed by the compositor as system input, so the tray menu is the *only* way to reach
 * settings there. That is why the menu template is injected rather than defined here — one
 * template function feeds both the sprite's context menu and this one, so the two can never
 * drift apart.
 *
 * The menu is rebuilt on every refresh rather than mutated. Mutating menu items in place is
 * how a checkbox ends up disagreeing with the state it is supposed to display.
 */

import { Menu, Tray, nativeImage } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { assetPath } from './paths.js'
import { emit } from './harness-handshake.js'

export interface TrayController {
  refresh(): void
  dispose(): void
}

export interface TrayOptions {
  /** Called on every refresh. Must return a freshly built template. */
  buildTemplate: () => MenuItemConstructorOptions[]
  tooltip?: string
}

function loadTrayImage(): Electron.NativeImage {
  // The `Template` filename suffix is what tells macOS to treat the image as a mask and
  // recolour it for light and dark menu bars. Without it the icon is a fixed-colour blob
  // that is invisible in one appearance or the other.
  const image = nativeImage.createFromPath(assetPath('tray', 'trayIconTemplate.png'))
  if (image.isEmpty()) {
    emit({ ev: 'error', where: 'tray', message: 'tray icon asset missing or unreadable' })
    return image
  }
  image.setTemplateImage(true)
  return image
}

export function createTray(options: TrayOptions): TrayController {
  const tray = new Tray(loadTrayImage())
  tray.setToolTip(options.tooltip ?? 'Keycode Pet')

  const refresh = (): void => {
    if (tray.isDestroyed()) return
    tray.setContextMenu(Menu.buildFromTemplate(options.buildTemplate()))
  }

  refresh()

  // On Windows and Linux a left click should also surface the menu — there is no other
  // affordance, and users reasonably expect a tray icon to respond to a plain click.
  if (process.platform !== 'darwin') {
    tray.on('click', () => tray.popUpContextMenu())
  }

  return {
    refresh,
    dispose(): void {
      if (!tray.isDestroyed()) tray.destroy()
    },
  }
}
