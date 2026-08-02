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
import {
  PET_SIZES,
  PRODUCT_NAME,
  REMINDER_MINUTE_CHOICES,
  type PetSize,
} from '../config/constants.js'

export type UpdateState = 'idle' | 'checking' | 'available' | 'current' | 'error'

export interface ReminderView {
  enabled: boolean
  /** Effective interval in minutes — the chosen one, or the default in force if none was chosen. */
  minutes: number
  /** True when the interval came from a default rather than a local choice. */
  isDefault: boolean
}

export interface MenuViewModel {
  movementEnabled: boolean
  alwaysOnTop: boolean
  petSize: PetSize
  water: ReminderView
  stretch: ReminderView
  update: { state: UpdateState; latestVersion: string | null }
}

export interface MenuActions {
  toggleMovement(): void
  toggleAlwaysOnTop(): void
  setPetSize(size: PetSize): void
  /** `minutes: null` means off. Anything else enables the reminder at that interval. */
  setReminder(kind: 'water' | 'stretch', minutes: number | null): void
  resetPosition(): void
  checkForUpdates(): void
  showAbout(): void
  reportProblem(): void
  quit(): void
}

/**
 * One reminder's submenu: Off, then every offered interval.
 *
 * Off and the intervals are one radio group rather than a checkbox plus a separate interval list,
 * because "enabled" and "how often" are one decision from the user's side — and because a checkbox
 * cannot carry a submenu, so the alternative was two menu entries per reminder.
 */
function reminderSubmenu(
  kind: 'water' | 'stretch',
  view: ReminderView,
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Off',
      type: 'radio',
      checked: !view.enabled,
      click: () => actions.setReminder(kind, null),
    },
    { type: 'separator' },
    ...REMINDER_MINUTE_CHOICES.map((minutes) => ({
      // The default is marked rather than hidden, so a team default is visible as one instead of
      // looking like something the user picked.
      label: `Every ${minutes} min${view.isDefault && view.minutes === minutes ? ' (default)' : ''}`,
      type: 'radio' as const,
      checked: view.enabled && view.minutes === minutes,
      click: () => actions.setReminder(kind, minutes),
    })),
  ]
}

/** Title-case a size key for display, so the labels are not a second hand-written list. */
export function petSizeLabel(size: PetSize): string {
  return size.charAt(0).toUpperCase() + size.slice(1)
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
      label: 'Always on top',
      type: 'checkbox',
      checked: view.alwaysOnTop,
      click: () => actions.toggleAlwaysOnTop(),
    },
    {
      label: 'Drink water reminder',
      submenu: reminderSubmenu('water', view.water, actions),
    },
    {
      label: 'Stretch reminder',
      submenu: reminderSubmenu('stretch', view.stretch, actions),
    },
    {
      label: 'Size',
      submenu: PET_SIZES.map((size) => ({
        label: petSizeLabel(size),
        // `radio`, not `checkbox`: exactly one size is active, and Electron then handles the
        // mutual exclusion display for us.
        type: 'radio' as const,
        checked: view.petSize === size,
        // Same rule as the toggles: the handler names the size it wants rather than reading
        // `menuItem.checked`, so the tick is a display of state and never a second source of truth.
        click: () => actions.setPetSize(size),
      })),
    },
    { type: 'separator' },
    { label: 'Reset position', click: () => actions.resetPosition() },
    { label: update.label, enabled: update.enabled, click: () => actions.checkForUpdates() },
    { label: 'About', click: () => actions.showAbout() },
    // The whole of "crash reporting": nothing is uploaded automatically, so a problem only reaches us
    // if a person chooses to send it. This makes that one click instead of finding a log by hand.
    { label: 'Report a problem…', click: () => actions.reportProblem() },
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
  'alwaysOnTop',
  'water',
  'stretch',
  'size',
  'separator',
  'reset',
  'update',
  'about',
  'report',
  'separator',
  'quit',
] as const
