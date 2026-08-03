import { describe, it, expect, vi } from 'vitest'
import {
  buildMenuTemplate,
  updateItemLabel,
  MENU_ITEM_ORDER,
  type MenuActions,
  type MenuViewModel,
} from '../../apps/desktop/src/main/menu-template.js'
import { createActions, RESET_POSITION_FRACTION } from '../../apps/desktop/src/main/actions.js'
import type { MotionTrigger } from '../../apps/desktop/src/motion/types.js'
import type { Settings } from '../../apps/desktop/src/main/settings-schema.js'
import { DEFAULT_SETTINGS } from '../../apps/desktop/src/main/settings-schema.js'
import { ALPHA_MASK } from '../../apps/desktop/src/sprite/alpha-mask.js'
import {
  PET_SIZES,
  PET_SIZE_SCALES,
  REMINDER_MINUTE_CHOICES,
  petScaleFor,
} from '../../apps/desktop/src/config/constants.js'

function view(overrides: Partial<MenuViewModel> = {}): MenuViewModel {
  return {
    movementEnabled: true,
    alwaysOnTop: true,
    petSize: 'large',
    water: { enabled: true, minutes: 45, isDefault: true },
    stretch: { enabled: true, minutes: 60, isDefault: true },
    update: { state: 'idle', latestVersion: null },
    ...overrides,
  }
}

function noopActions(): MenuActions {
  return {
    toggleMovement: () => {},
    toggleAlwaysOnTop: () => {},
    setPetSize: () => {},
    setReminder: () => {},
    resetPosition: () => {},
    checkForUpdates: () => {},
    showAbout: () => {},
    reportProblem: () => {},
    quit: () => {},
  }
}

describe('menu template', () => {
  it('has exactly the items and order the spec fixes', () => {
    // The menu is the entire settings surface, so its shape is a UI contract, not an internal detail.
    const template = buildMenuTemplate(view(), noopActions())
    expect(template).toHaveLength(MENU_ITEM_ORDER.length)

    const kinds = template.map((item) =>
      item.type === 'separator' ? 'separator' : (item.label ?? ''),
    )
    expect(kinds).toEqual([
      'Keycode Pet',
      'separator',
      'Movement',
      'Always on top',
      'Drink water reminder',
      'Stretch reminder',
      'Size',
      'separator',
      'Reset position',
      'Check for updates…',
      'About',
      'Report a problem…',
      'separator',
      'Quit',
    ])
  })

  it('renders Movement as a checkbox reflecting the view model', () => {
    const on = buildMenuTemplate(view(), noopActions())
    expect(on[2]).toMatchObject({ type: 'checkbox', checked: true })
    const off = buildMenuTemplate(view({ movementEnabled: false }), noopActions())
    expect(off[2]).toMatchObject({ checked: false })
  })

  it('disables the title so it reads as a header, not an action', () => {
    expect(buildMenuTemplate(view(), noopActions())[0]).toMatchObject({ enabled: false })
  })

  it('gives Quit a click handler rather than a role', () => {
    // `role: 'quit'` quits immediately and skips the before-quit handler — which is what flushes
    // settings. A silently unsaved position is exactly the bug that would cause.
    const quit = vi.fn()
    const template = buildMenuTemplate(view(), { ...noopActions(), quit })
    // Found by label, not by index: an index breaks every time an item is added above it, which is
    // exactly what happened when the Size submenu landed.
    const item = template.find((entry) => entry.label === 'Quit')!
    expect(item).not.toHaveProperty('role')
    ;(item.click as () => void)()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('does not mutate the view model', () => {
    const model = Object.freeze(view())
    expect(() => buildMenuTemplate(model, noopActions())).not.toThrow()
  })

  it('routes every click to its action exactly once', () => {
    const actions = {
      toggleMovement: vi.fn(),
      toggleAlwaysOnTop: vi.fn(),
      setPetSize: vi.fn(),
      setReminder: vi.fn(),
      resetPosition: vi.fn(),
      checkForUpdates: vi.fn(),
      showAbout: vi.fn(),
      reportProblem: vi.fn(),
      quit: vi.fn(),
    }
    const template = buildMenuTemplate(view(), actions)
    for (const item of template) {
      if (typeof item.click === 'function') (item.click as () => void)()
    }
    expect(actions.toggleMovement).toHaveBeenCalledOnce()
    expect(actions.toggleAlwaysOnTop).toHaveBeenCalledOnce()
    expect(actions.resetPosition).toHaveBeenCalledOnce()
    expect(actions.checkForUpdates).toHaveBeenCalledOnce()
    expect(actions.showAbout).toHaveBeenCalledOnce()
    expect(actions.reportProblem).toHaveBeenCalledOnce()
    expect(actions.quit).toHaveBeenCalledOnce()
  })
})

describe('update menu item', () => {
  it('is disabled and says so while checking', () => {
    expect(updateItemLabel({ state: 'checking', latestVersion: null })).toEqual({
      label: 'Checking for updates…',
      enabled: false,
    })
  })

  it('names the version when one is available', () => {
    expect(updateItemLabel({ state: 'available', latestVersion: '0.4.0' })).toEqual({
      label: 'Update available: 0.4.0',
      enabled: true,
    })
  })

  it('falls back to the neutral label after an error rather than showing a sticky failure', () => {
    // A background check that failed is not worth nagging about; clicking retries.
    expect(updateItemLabel({ state: 'error', latestVersion: null })).toEqual({
      label: 'Check for updates…',
      enabled: true,
    })
  })

  it('uses the neutral label when idle or already current', () => {
    for (const state of ['idle', 'current'] as const) {
      expect(updateItemLabel({ state, latestVersion: null }).label).toBe('Check for updates…')
    }
  })
})

// ---------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------

function fakeSettings(initial: Settings = DEFAULT_SETTINGS) {
  let current: Settings = { ...initial }
  const patches: Array<Partial<Settings>> = []
  return {
    patches,
    store: {
      get: () => current,
      patch(patch: Partial<Settings>) {
        patches.push(patch)
        current = { ...current, ...patch }
      },
    },
  }
}

function fakeController() {
  const enqueued: MotionTrigger[] = []
  let tickNowCalls = 0
  return {
    enqueued,
    get tickNowCalls() {
      return tickNowCalls
    },
    controller: {
      enqueue: (trigger: MotionTrigger) => enqueued.push(trigger),
      tickNow: () => {
        tickNowCalls += 1
      },
    },
  }
}

const displays = {
  nearest: () => ({
    index: 0,
    key: '0,0,1512x945',
    bounds: { x: 0, y: 0, width: 1512, height: 945 },
    workArea: { x: 0, y: 33, width: 1512, height: 907 },
    scaleFactor: 2,
  }),
}

let evaluations = 0

function makeActions(overrides: Partial<Parameters<typeof createActions>[0]> = {}) {
  evaluations = 0
  const settings = fakeSettings()
  const controller = fakeController()
  const actions = createActions({
    settings: settings.store as never,
    controller: controller.controller as never,
    displays: displays as never,
    getCursorPoint: () => ({ x: 700, y: 900 }),
    evaluateReminders: () => {
      evaluations += 1
    },
    showAbout: () => {},
    checkForUpdates: () => {},
    quit: () => {},
    ...overrides,
  })
  return { actions, settings, controller, evaluations: () => evaluations }
}

describe('actions', () => {
  it('toggling movement writes the inverse, enqueues a trigger and ticks immediately', () => {
    // The immediate tick is what makes movement stop mid-stride rather than at the next boundary.
    const { actions, settings, controller } = makeActions()
    actions.toggleMovement()

    expect(settings.patches).toEqual([{ movementEnabled: false }])
    expect(controller.enqueued).toEqual([{ kind: 'movement-changed', enabled: false }])
    expect(controller.tickNowCalls).toBe(1)
  })

  it('derives the new value from the store, never from a menu item', () => {
    // A menu item's `checked` is a rendering of state and can be stale if a rebuild raced a click.
    const { actions, settings } = makeActions()
    actions.toggleMovement()
    actions.toggleMovement()
    expect(settings.patches).toEqual([{ movementEnabled: false }, { movementEnabled: true }])
  })

  it('setting a reminder interval enables it, clears the deadline and re-evaluates', () => {
    const { actions, settings, controller, evaluations } = makeActions()
    actions.setReminder('water', 5)

    expect(settings.patches).toEqual([
      {
        waterReminderEnabled: true,
        reminders: {
          ...DEFAULT_SETTINGS.reminders,
          waterMinutes: 5,
          // Cleared, so the new interval runs from now. Without this, picking "every 5 min" inherits
          // the deadline computed from the old 45-minute interval and still waits 45.
          waterNextDueAt: null,
        },
      },
    ])
    // Immediately, not at the next 15s tick.
    expect(evaluations()).toBe(1)
    // Reminders are not motion.
    expect(controller.enqueued).toEqual([])
  })

  it('turning a reminder off keeps the interval the user picked', () => {
    const { actions, settings } = makeActions()
    actions.setReminder('stretch', 15)
    actions.setReminder('stretch', null)

    const last = settings.patches.at(-1)!
    expect(last.stretchReminderEnabled).toBe(false)
    // Turning it back on should restore 15, not silently revert to the default — so `off` must not
    // erase the chosen interval.
    expect(last.reminders).toMatchObject({ stretchMinutes: 15, stretchNextDueAt: null })
  })

  it('clamps a nonsense interval rather than storing it', () => {
    const { actions, settings } = makeActions()
    actions.setReminder('water', 99_999)
    expect(settings.patches.at(-1)?.reminders).toMatchObject({ waterMinutes: 1_440 })
  })

  it('resets position onto the display under the cursor and persists it', () => {
    const { actions, settings, controller } = makeActions()
    actions.resetPosition()

    const trigger = controller.enqueued[0]
    expect(trigger?.kind).toBe('reset-position')

    // 0.35 across a floor inset by half the pet's body width on each side. Taken from the mask rather
    // than written as a literal: it was 107 until the stretch art widened the union to 120.
    const halfBody = ALPHA_MASK.bbox.width / 2
    const minX = 0 + halfBody
    const maxX = 1512 - halfBody
    const expected = minX + (maxX - minX) * RESET_POSITION_FRACTION
    if (trigger?.kind === 'reset-position') {
      expect(trigger.petCentreX).toBeCloseTo(expected, 5)
    }

    expect(settings.patches[0]).toMatchObject({
      position: { displayKey: '0,0,1512x945' },
    })
    expect(controller.tickNowCalls).toBe(1)
  })

  it('delegates about, updates and quit to injected handlers', () => {
    const showAbout = vi.fn()
    const checkForUpdates = vi.fn()
    const quit = vi.fn()
    const { actions } = makeActions({ showAbout, checkForUpdates, quit })
    actions.showAbout()
    actions.checkForUpdates()
    actions.quit()
    expect(showAbout).toHaveBeenCalledOnce()
    expect(checkForUpdates).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })
})

describe('pet size menu', () => {
  const sizeSubmenu = (v: MenuViewModel = view()) => {
    const item = buildMenuTemplate(v, noopActions()).find((entry) => entry.label === 'Size')
    return (item?.submenu ?? []) as Array<{ label?: string; type?: string; checked?: boolean }>
  }

  it('offers every declared size, as radio items', () => {
    // Derived from PET_SIZES rather than a hand-written list, so adding a size cannot leave the menu
    // silently missing it.
    expect(sizeSubmenu().map((i) => i.label)).toEqual(['Small', 'Medium', 'Large'])
    for (const item of sizeSubmenu()) expect(item.type).toBe('radio')
  })

  it('ticks exactly the current size', () => {
    for (const size of PET_SIZES) {
      const ticked = sizeSubmenu(view({ petSize: size })).filter((i) => i.checked)
      expect(ticked).toHaveLength(1)
      expect(ticked[0]?.label?.toLowerCase()).toBe(size)
    }
  })

  it('names the size it wants instead of reading the item back', () => {
    // Same rule as the toggles: a handler that trusted `menuItem.checked` would act on a rendering
    // of state that can be stale if a rebuild raced the click.
    const setPetSize = vi.fn()
    const item = buildMenuTemplate(view(), { ...noopActions(), setPetSize }).find(
      (entry) => entry.label === 'Size',
    )
    const small = (item?.submenu as Array<{ label?: string; click?: () => void }>).find(
      (i) => i.label === 'Small',
    )
    small?.click?.()
    expect(setPetSize).toHaveBeenCalledWith('small')
  })

  it('scales are what the sprite can render sharply, with large unchanged from before sizes existed', () => {
    // `large` must stay 1.0 or every existing install's pet changes size on upgrade.
    expect(PET_SIZE_SCALES.large).toBe(1)
    expect(PET_SIZE_SCALES.small).toBe(0.5)
    // Documented as deliberately soft on a 2x display: 0.75 x 2 = 1.5 device pixels per source pixel.
    expect(PET_SIZE_SCALES.medium).toBe(0.75)
    expect(petScaleFor('small')).toBe(PET_SIZE_SCALES.small)
  })
})

describe('reminder interval submenus', () => {
  const submenu = (label: string, v: MenuViewModel = view()) => {
    const item = buildMenuTemplate(v, noopActions()).find((entry) => entry.label === label)
    return (item?.submenu ?? []) as Array<{ label?: string; type?: string; checked?: boolean }>
  }

  it('offers Off plus every declared interval', () => {
    const items = submenu('Drink water reminder')
    expect(items[0]).toMatchObject({ label: 'Off', type: 'radio' })
    expect(items[1]).toMatchObject({ type: 'separator' })
    // Only the interval currently in force is marked "(default)" — labelling all of them would say
    // nothing about which one is actually active.
    const intervals = items.slice(2).map((i) => i.label)
    expect(intervals).toEqual(
      REMINDER_MINUTE_CHOICES.map((m) => `Every ${m} min${m === 45 ? ' (default)' : ''}`),
    )
  })

  it('ticks Off when the reminder is disabled, and nothing else', () => {
    const items = submenu(
      'Drink water reminder',
      view({ water: { enabled: false, minutes: 45, isDefault: true } }),
    )
    expect(items.filter((i) => i.checked)).toHaveLength(1)
    expect(items.find((i) => i.checked)?.label).toBe('Off')
  })

  it('ticks the chosen interval and does not label it a default', () => {
    const items = submenu(
      'Stretch reminder',
      view({ stretch: { enabled: true, minutes: 30, isDefault: false } }),
    )
    const ticked = items.filter((i) => i.checked)
    expect(ticked).toHaveLength(1)
    // No "(default)" suffix: the user picked this, so labelling it a default would be a lie.
    expect(ticked[0]?.label).toBe('Every 30 min')
  })

  it('marks a default rather than hiding it', () => {
    // A team default that looked like a personal choice would be indistinguishable from one, which
    // makes "why is my reminder every 30 minutes" unanswerable from the UI.
    const items = submenu(
      'Stretch reminder',
      view({ stretch: { enabled: true, minutes: 30, isDefault: true } }),
    )
    expect(items.find((i) => i.checked)?.label).toBe('Every 30 min (default)')
  })

  it('offers a 5-minute interval, which is what makes reminders testable at all', () => {
    // Without it, verifying reminders means waiting 45 minutes or hand-editing the settings file.
    expect(REMINDER_MINUTE_CHOICES).toContain(5)
  })

  it('names the interval it wants instead of reading the item back', () => {
    const setReminder = vi.fn()
    const item = buildMenuTemplate(view(), { ...noopActions(), setReminder }).find(
      (entry) => entry.label === 'Drink water reminder',
    )
    const items = item?.submenu as Array<{ label?: string; click?: () => void }>
    items.find((i) => i.label?.startsWith('Every 15'))?.click?.()
    items.find((i) => i.label === 'Off')?.click?.()
    expect(setReminder).toHaveBeenNthCalledWith(1, 'water', 15)
    expect(setReminder).toHaveBeenNthCalledWith(2, 'water', null)
  })
})
