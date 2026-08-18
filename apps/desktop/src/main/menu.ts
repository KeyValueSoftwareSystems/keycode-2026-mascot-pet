/**
 * The impure menu shell: builds Electron menus from the pure template and shows them.
 *
 * The sprite menu is built fresh at popup time, so it can never be stale. The tray menu is retained
 * by the OS, so it must be explicitly refreshed when state changes — which is why `refresh()` exists
 * and why the settings subscription calls it.
 */

import { Menu } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { buildMenuTemplate, type MenuActions, type MenuViewModel } from './menu-template.js'

export interface MenuController {
  /** Show the menu at the cursor, over the pet. */
  popupOverPet(): void
  /** Rebuild the retained tray menu. */
  refresh(): void
  template(): MenuItemConstructorOptions[]
  dispose(): void
}

export interface MenuOptions {
  view: () => MenuViewModel
  actions: MenuActions
  petWindow: () => BrowserWindow | null
  onTemplateChanged: (template: MenuItemConstructorOptions[]) => void
  /** Fires when the sprite settings menu opens or closes. */
  onPopupChanged?: (open: boolean) => void
}

export function createMenuController(options: MenuOptions): MenuController {
  const template = (): MenuItemConstructorOptions[] =>
    buildMenuTemplate(options.view(), options.actions)

  let openMenu: Menu | null = null

  return {
    popupOverPet(): void {
      const win = options.petWindow()
      if (!win || win.isDestroyed()) return

      // Built fresh every time, so the checkboxes always reflect current settings.
      const menu = Menu.buildFromTemplate(template())
      openMenu = menu
      options.onPopupChanged?.(true)

      // No explicit x/y: Electron places it at the cursor. Converting the renderer's client
      // coordinates to screen coordinates by hand is exactly the DPI bug that bites on
      // multi-monitor setups with mixed scaling.
      menu.popup({
        window: win,
        callback: () => {
          if (openMenu === menu) openMenu = null
          options.onPopupChanged?.(false)
        },
      })
    },

    refresh(): void {
      options.onTemplateChanged(template())
    },

    template,

    dispose(): void {
      openMenu?.closePopup()
      openMenu = null
    },
  }
}
