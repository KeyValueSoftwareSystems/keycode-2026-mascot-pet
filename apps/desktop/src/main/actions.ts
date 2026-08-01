/**
 * Where a menu click becomes a state change.
 *
 * This is the answer to "how does a toggle reach the motion engine". A toggle takes three paths at
 * once, and all three matter:
 *
 *   1. `settings.patch` — the durable truth, debounced to disk.
 *   2. A trigger plus `tickNow()` — the *immediate* effect. docs/PROMPT.md §4.8 requires movement to
 *      stop mid-stride, not at the next tick boundary, and `tickNow()` runs the same tick body out
 *      of phase to make that literal.
 *   3. The settings `onChange` subscription — refreshes the menus and re-evaluates reminders.
 *
 * The engine also reads `movementEnabled` from `MotionInput` every tick, so the steady state stays
 * correct even if a trigger were missed. Belt and braces on purpose: the trigger drives the
 * *reaction* (the sleep animation), the input drives the *rule*.
 *
 * No Electron import. Every platform capability arrives as an injected function, which is what lets
 * the toggle logic — the part with rules in it — be unit-tested directly.
 */

import type { SettingsStore } from './settings-store.js'
import type { PetController } from './pet-controller.js'
import type { DisplayManager } from './display-manager.js'
import { floorForWorkArea } from './floor-placement.js'
import type { MenuActions } from './menu-template.js'

export interface ActionDeps {
  settings: SettingsStore
  controller: PetController
  displays: DisplayManager
  getCursorPoint: () => { x: number; y: number }
  showAbout: () => void
  checkForUpdates: () => void
  quit: () => void
  log?: (message: string, meta?: unknown) => void
}

/** Where the pet lands on a reset, as a fraction across the floor. */
export const RESET_POSITION_FRACTION = 0.35

export function createActions(deps: ActionDeps): MenuActions {
  const { settings, controller, displays } = deps
  const log = deps.log ?? (() => {})

  /**
   * Flip a boolean setting.
   *
   * Reads the store and writes the inverse — never trusts the menu item's own `checked`, which is a
   * rendering of state and can be stale if a menu rebuild raced a click.
   */
  const toggle = (
    key: 'movementEnabled' | 'waterReminderEnabled' | 'stretchReminderEnabled',
  ): boolean => {
    const next = !settings.get()[key]
    settings.patch({ [key]: next })
    return next
  }

  return {
    toggleMovement(): void {
      const enabled = toggle('movementEnabled')
      controller.enqueue({ kind: 'movement-changed', enabled })
      // Mid-stride, not next tick.
      controller.tickNow()
      log('movement toggled', { enabled })
    },

    toggleWaterReminder(): void {
      log('water reminder toggled', { enabled: toggle('waterReminderEnabled') })
    },

    toggleStretchReminder(): void {
      log('stretch reminder toggled', { enabled: toggle('stretchReminderEnabled') })
    },

    resetPosition(): void {
      // The display under the cursor, not the primary one: "reset" means "bring it back to me", and
      // on a multi-monitor desk the primary display may not be the one being looked at.
      const display = displays.nearest(deps.getCursorPoint())
      const floor = floorForWorkArea(display.workArea, display.key)
      const target = floor.minX + (floor.maxX - floor.minX) * RESET_POSITION_FRACTION

      controller.enqueue({ kind: 'reset-position', petCentreX: target })
      controller.tickNow()
      // Reset returns the pet to the floor, so no free-placement height is persisted.
      settings.patch({ position: { displayKey: display.key, x: target, feetY: null } })
      log('position reset', { displayKey: display.key, x: Math.round(target) })
    },

    checkForUpdates(): void {
      deps.checkForUpdates()
    },

    showAbout(): void {
      deps.showAbout()
    },

    quit(): void {
      deps.quit()
    },
  }
}
