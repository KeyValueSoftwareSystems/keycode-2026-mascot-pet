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
import { floorForWorkArea, placementForScale } from './floor-placement.js'
import { clampReminderMinutes, petScaleFor, type PetSize } from '../config/constants.js'
import type { MenuActions } from './menu-template.js'

export interface ActionDeps {
  settings: SettingsStore
  controller: PetController
  displays: DisplayManager
  getCursorPoint: () => { x: number; y: number }
  showAbout: () => void
  checkForUpdates: () => void
  reportProblem: () => void
  /** Re-evaluate reminders now, so a changed interval takes effect immediately. */
  evaluateReminders: () => void
  /** Put the pet window in or out of the always-on-top band. */
  setAlwaysOnTop: (enabled: boolean) => void
  /**
   * The values in force right now, resolving a local choice over a team default over the built-in.
   *
   * Injected rather than recomputed here: `app-shell` holds the manifest defaults, and a second copy of
   * the precedence rule is a second place for it to be wrong.
   */
  effectivePetSize: () => PetSize
  effectiveAlwaysOnTop: () => boolean
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
  const toggle = (key: 'movementEnabled'): boolean => {
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

    toggleAlwaysOnTop(): void {
      // Inverts the **effective** value, not the stored one. `alwaysOnTop` is nullable now, and
      // `!null` is `true` — so a pet that is already in front because of a team default would have
      // stayed in front on the first click and only obeyed on the second. Reading the effective value
      // makes one click do what it looks like it does, and writing a non-null value is what makes the
      // choice stick against any future default.
      const enabled = !deps.effectiveAlwaysOnTop()
      settings.patch({ alwaysOnTop: enabled })
      // Applied here rather than through the settings subscription, so the window changes band on the
      // click instead of on the next menu rebuild. The subscription still refreshes the tick.
      deps.setAlwaysOnTop(enabled)
      log('always on top toggled', { enabled })
    },

    setPetSize(size): void {
      // Compared against the *stored* size, so picking the size the pet already is still records the
      // choice. Picking `small` when it is small only because the team publishes small is a meaningful
      // act — it is how somebody pins it against a default that may change tomorrow.
      const already = settings.get().petSize === size
      if (already) return
      const previousScale = petScaleFor(deps.effectivePetSize())
      settings.patch({ petSize: size })
      const nextScale = petScaleFor(size)
      // Apply immediately. The previous condition compared *after* the patch, when stored and
      // effective already matched `size`, so the window never resized until the next launch.
      if (nextScale !== previousScale) controller.setScale(nextScale)
      log('pet size changed', { size })
    },

    setReminder(kind, minutes): void {
      const current = settings.get()
      const enabledKey = kind === 'water' ? 'waterReminderEnabled' : 'stretchReminderEnabled'
      const minutesKey = kind === 'water' ? 'waterMinutes' : 'stretchMinutes'
      const deadlineKey = kind === 'water' ? 'waterNextDueAt' : 'stretchNextDueAt'

      settings.patch({
        [enabledKey]: minutes !== null,
        reminders: {
          ...current.reminders,
          // Off leaves the chosen interval alone, so turning a reminder back on restores the interval
          // the user picked rather than silently reverting to the default.
          ...(minutes === null ? {} : { [minutesKey]: clampReminderMinutes(minutes) }),
          // Clear the deadline so the new interval takes effect from now rather than inheriting a
          // deadline computed from the old one — otherwise picking "every 5 min" can still wait 45.
          [deadlineKey]: null,
        },
      })

      // Evaluate immediately: rule 2 reschedules from now, so the next reminder is one new interval
      // away instead of arriving whenever the next 15s tick happens to notice.
      deps.evaluateReminders()
      log('reminder set', { kind, minutes })
    },

    toggleClockReminder(kind): void {
      const current = settings.get()
      const enabledKey = kind === 'coffee' ? 'coffeeReminderEnabled' : 'lunchReminderEnabled'
      const deadlineKey = kind === 'coffee' ? 'coffeeNextDueAt' : 'lunchNextDueAt'
      const enabled = !current[enabledKey]
      settings.patch({
        [enabledKey]: enabled,
        reminders: {
          ...current.reminders,
          // Clear so re-enable schedules the next clock slot from now, rather than inheriting a
          // deadline computed while the reminder was off.
          [deadlineKey]: null,
        },
      })
      deps.evaluateReminders()
      log('clock reminder set', { kind, enabled })
    },

    resetPosition(): void {
      // The display under the cursor, not the primary one: "reset" means "bring it back to me", and
      // on a multi-monitor desk the primary display may not be the one being looked at.
      const display = displays.nearest(deps.getCursorPoint())
      // The current placement, so the reset target respects the pet's size — a small pet may stand
      // closer to the screen edge than a large one.
      const floor = floorForWorkArea(
        display.workArea,
        display.key,
        undefined,
        placementForScale(petScaleFor(deps.effectivePetSize())),
      )
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

    reportProblem(): void {
      deps.reportProblem()
    },

    quit(): void {
      deps.quit()
    },
  }
}
