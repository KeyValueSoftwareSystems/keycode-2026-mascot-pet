/**
 * The reminder shell: one short interval, the persistence, and the power hooks.
 *
 * Interval rules live in reminder-scheduler.ts; clock slots in clock-reminders.ts; greetings in
 * greetings.ts. This is the part that cannot be pure.
 */

import { powerMonitor } from 'electron'
import {
  evaluateReminders,
  REMINDER_KINDS,
  REMINDER_MESSAGES,
  type ReminderDeadlines,
  type ReminderKind,
} from '../reminders/reminder-scheduler.js'
import {
  evaluateClockReminders,
  CLOCK_REMINDER_MESSAGES,
  type ClockReminderKind,
} from '../reminders/clock-reminders.js'
import {
  evaluateGreeting,
  GREETING_MESSAGES,
  type GreetingPeriod,
} from '../reminders/greetings.js'
import { REMINDER_TICK_MS } from '../config/constants.js'
import { REMINDER_INTERVALS } from '../reminders/reminder-scheduler.js'
import type { SettingsStore } from './settings-store.js'

export interface ReminderService {
  start(): void
  stop(): void
  /** Evaluate now. Called on wake, on unlock, and whenever a toggle changes. */
  evaluateNow(): void
  deadlines(): ReminderDeadlines
}

export interface ReminderServiceOptions {
  settings: SettingsStore
  onFire: (kind: ReminderKind, message: string) => void
  onClockFire: (kind: ClockReminderKind, message: string) => void
  onGreeting: (period: GreetingPeriod, message: string) => void
  now?: () => number
  log?: (message: string, meta?: unknown) => void
}

function minutesToMs(minutes: number | null | undefined): number | null {
  return minutes === null || minutes === undefined ? null : minutes * 60_000
}

export function createReminderService(options: ReminderServiceOptions): ReminderService {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const { settings } = options

  let timer: NodeJS.Timeout | null = null

  const evaluate = (): void => {
    const current = settings.get()
    const timestamp = now()
    const result = evaluateReminders({
      now: timestamp,
      enabled: {
        water: current.waterReminderEnabled,
        stretch: current.stretchReminderEnabled,
      },
      deadlines: current.reminders
        ? { water: current.reminders.waterNextDueAt, stretch: current.reminders.stretchNextDueAt }
        : { water: null, stretch: null },
      intervals: {
        water: minutesToMs(current.reminders?.waterMinutes) ?? REMINDER_INTERVALS.water,
        stretch: minutesToMs(current.reminders?.stretchMinutes) ?? REMINDER_INTERVALS.stretch,
      },
    })

    const clock = evaluateClockReminders({
      now: timestamp,
      enabled: {
        coffee: current.coffeeReminderEnabled,
        lunch: current.lunchReminderEnabled,
      },
      deadlines: {
        coffee: current.reminders?.coffeeNextDueAt ?? null,
        lunch: current.reminders?.lunchNextDueAt ?? null,
      },
    })

    const greeting = evaluateGreeting({
      now: timestamp,
      lastKey: current.lastGreetingKey,
    })

    if (result.changed || clock.changed || greeting.changed) {
      settings.patch({
        reminders: {
          ...current.reminders,
          waterNextDueAt: result.deadlines.water,
          stretchNextDueAt: result.deadlines.stretch,
          coffeeNextDueAt: clock.deadlines.coffee,
          lunchNextDueAt: clock.deadlines.lunch,
        },
        ...(greeting.changed ? { lastGreetingKey: greeting.lastKey } : {}),
      })
    }

    for (const kind of result.fired) {
      log('reminder fired', { kind })
      options.onFire(kind, REMINDER_MESSAGES[kind])
    }
    for (const kind of clock.fired) {
      log('clock reminder fired', { kind })
      options.onClockFire(kind, CLOCK_REMINDER_MESSAGES[kind])
    }
    if (greeting.fired) {
      log('greeting fired', { period: greeting.fired })
      options.onGreeting(greeting.fired, GREETING_MESSAGES[greeting.fired])
    }
  }

  const onResume = (): void => {
    log('power resume: re-evaluating reminders')
    evaluate()
  }

  const onSuspend = (): void => {
    log('power suspend: flushing reminder deadlines')
    void settings.flush()
  }

  return {
    start(): void {
      if (timer) return
      evaluate()
      timer = setInterval(evaluate, REMINDER_TICK_MS)
      timer.unref?.()

      powerMonitor.on('resume', onResume)
      powerMonitor.on('unlock-screen', onResume)
      powerMonitor.on('suspend', onSuspend)
      powerMonitor.on('lock-screen', onSuspend)
    },

    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
      powerMonitor.removeListener('resume', onResume)
      powerMonitor.removeListener('unlock-screen', onResume)
      powerMonitor.removeListener('suspend', onSuspend)
      powerMonitor.removeListener('lock-screen', onSuspend)
    },

    evaluateNow(): void {
      evaluate()
    },

    deadlines(): ReminderDeadlines {
      const current = settings.get()
      return {
        water: current.reminders?.waterNextDueAt ?? null,
        stretch: current.reminders?.stretchNextDueAt ?? null,
      }
    },
  }
}

export { REMINDER_KINDS }
