/**
 * The menu, as data. Pure — `import type` only, so it unit-tests with no Electron.
 *
 * ONE template feeds BOTH surfaces: the sprite's right-click menu and the tray menu. That is not
 * DRY for its own sake — on Linux under Wayland the compositor swallows right-click on the sprite
 * as system input, so the tray is the *only* way to reach settings there. Two hand-maintained
 * copies would mean the platform that depends on the fallback is the one running the stale menu.
 *
 * Two rules that keep it honest:
 *
 *   1. Click handlers never read `menuItem.checked`. They call `toggleX()`, which reads the settings
 *      store and writes the inverse. The checkbox is a *display* of state, never a second source of
 *      truth — otherwise a failed write leaves the tick and the setting disagreeing.
 *   2. The menu is rebuilt, never mutated. Mutating items in place is how a checkbox ends up
 *      disagreeing with the state it is supposed to show.
 */

import type { MenuItemConstructorOptions } from 'electron'
import { PRODUCT_NAME } from '../config/constants.js'

export type UpdateState = 'idle' | 'checking' | 'available' | 'current' | 'error'

export interface MenuViewModel {
  movementEnabled: boolean
  waterReminderEnabled: boolean
  stretchReminderEnabled: boolean
  update: { state: UpdateState; latestVersion: string | null }
}

export interface MenuActions {
  toggleMovement(): void
  toggleWaterReminder(): void
  toggleStretchReminder(): void
  resetPosition(): void
  checkForUpdates(): void
  showAbout(): void
  quit(): void
}

/** Label and enabled-ness for the update item, which is the only item that varies. */
export function updateItemLabel(update: MenuViewModel['update']): { label: string; enabled: boolean } {
  switch (update.state) {
    case 'checking':
      return { label: 'Checking for updates…', enabled: false }
    case 'available':
      return {
        label: `Update available: ${update.latestVersion ?? 'newer version'}`,
        enabled: true,
      }
    // 'error' deliberately falls back to the neutral label rather than showing a sticky failure.
    // A background check that failed is not something to nag about; the user can retry by clicking.
    case 'idle':
    case 'current':
    case 'error':
      return { label: 'Check for updates…', enabled: true }
  }
}

/**
 * Build the menu template.
 *
 * The item order is fixed by docs/PROMPT.md §4.8 and asserted by tests, because the menu is the
 * entire settings surface — its shape is the product's UI contract.
 */
export function buildMenuTemplate(
  view: MenuViewModel,
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  const update = updateItemLabel(view.update)

  return [
    { label: PRODUCT_NAME, enabled: false },
    { type: 'separator' },
    {
      label: 'Movement',
      type: 'checkbox',
      checked: view.movementEnabled,
      click: () => actions.toggleMovement(),
    },
    {
      label: 'Drink water reminder',
      type: 'checkbox',
      checked: view.waterReminderEnabled,
      click: () => actions.toggleWaterReminder(),
    },
    {
      label: 'Stretch reminder',
      type: 'checkbox',
      checked: view.stretchReminderEnabled,
      click: () => actions.toggleStretchReminder(),
    },
    { type: 'separator' },
    { label: 'Reset position', click: () => actions.resetPosition() },
    { label: update.label, enabled: update.enabled, click: () => actions.checkForUpdates() },
    { label: 'About', click: () => actions.showAbout() },
    { type: 'separator' },
    // No `role: 'quit'`. The role quits immediately, skipping our before-quit handler — which is
    // what flushes the settings file. An explicit click keeps the flush in the path.
    { label: 'Quit', click: () => actions.quit() },
  ]
}

/** Index of each item, for tests and for anyone reasoning about the order. */
export const MENU_ITEM_ORDER = [
  'title',
  'separator',
  'movement',
  'water',
  'stretch',
  'separator',
  'reset',
  'update',
  'about',
  'separator',
  'quit',
] as const
