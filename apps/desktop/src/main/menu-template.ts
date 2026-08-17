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

/**
 * A setting whose value may have come from a team default rather than from a choice here.
 *
 * `isDefault` exists so the menu can say *why* — a pet that is small because the team publishes small
 * looks identical to one somebody shrank, and leaving that unexplained is how a setting becomes
 * spooky. The same reasoning already applies to reminder intervals; see `ReminderView`.
 */
export interface DefaultableView<T> {
  value: T
  isDefault: boolean
}

export interface MenuViewModel {
  movementEnabled: boolean
  alwaysOnTop: DefaultableView<boolean>
  petSize: DefaultableView<PetSize>
  water: ReminderView
  stretch: ReminderView
  coffee: boolean
  lunch: boolean
  update: { state: UpdateState; latestVersion: string | null }
  /**
   * Unpackaged builds only. Adds a Dev submenu that fires reminders immediately so they can be
   * checked without waiting for a clock slot or a 5-minute interval.
   */
  devTools?: boolean
}

export interface MenuActions {
  toggleMovement(): void
  toggleAlwaysOnTop(): void
  setPetSize(size: PetSize): void
  /** `minutes: null` means off. Anything else enables the reminder at that interval. */
  setReminder(kind: 'water' | 'stretch', minutes: number | null): void
  toggleClockReminder(kind: 'coffee' | 'lunch'): void
  /** Dev-only: play the reminder callout now, without touching deadlines. */
  fireReminderNow(kind: 'water' | 'stretch' | 'coffee' | 'lunch'): void
  /** Dev-only: play a time-of-day greeting now. */
  fireGreetingNow(period: 'morning' | 'afternoon' | 'evening'): void
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

  const items: MenuItemConstructorOptions[] = [
    { label: PRODUCT_NAME, enabled: false },
    { type: 'separator' },
    {
      label: 'Movement',
      type: 'checkbox',
      checked: view.movementEnabled,
      click: () => actions.toggleMovement(),
    },
    {
      label: view.alwaysOnTop.isDefault ? 'Always on top (default)' : 'Always on top',
      type: 'checkbox',
      checked: view.alwaysOnTop.value,
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
      label: 'Coffee reminder (11:00, 15:00)',
      type: 'checkbox',
      checked: view.coffee,
      click: () => actions.toggleClockReminder('coffee'),
    },
    {
      label: 'Lunch reminder (12:30)',
      type: 'checkbox',
      checked: view.lunch,
      click: () => actions.toggleClockReminder('lunch'),
    },
    {
      label: 'Size',
      submenu: PET_SIZES.map((size) => ({
        // Marked rather than hidden, so a team default is visible *as* one instead of looking like
        // something the user picked — the same choice `reminderSubmenu` makes.
        label:
          view.petSize.isDefault && view.petSize.value === size
            ? `${petSizeLabel(size)} (default)`
            : petSizeLabel(size),
        // `radio`, not `checkbox`: exactly one size is active, and Electron then handles the
        // mutual exclusion display for us.
        type: 'radio' as const,
        checked: view.petSize.value === size,
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

  if (view.devTools) {
    items.splice(items.length - 1, 0, {
      label: 'Dev',
      submenu: [
        { label: 'Fire drink now', click: () => actions.fireReminderNow('water') },
        { label: 'Fire stretch now', click: () => actions.fireReminderNow('stretch') },
        { label: 'Fire coffee now', click: () => actions.fireReminderNow('coffee') },
        { label: 'Fire lunch now', click: () => actions.fireReminderNow('lunch') },
        { type: 'separator' },
        { label: 'Fire good morning', click: () => actions.fireGreetingNow('morning') },
        { label: 'Fire good afternoon', click: () => actions.fireGreetingNow('afternoon') },
        { label: 'Fire good evening', click: () => actions.fireGreetingNow('evening') },
      ],
    })
  }

  return items
}

/** Index of each item, for tests and for anyone reasoning about the order. */
export const MENU_ITEM_ORDER = [
  'title',
  'separator',
  'movement',
  'alwaysOnTop',
  'water',
  'stretch',
  'coffee',
  'lunch',
  'size',
  'separator',
  'reset',
  'update',
  'about',
  'report',
  'separator',
  'quit',
] as const
