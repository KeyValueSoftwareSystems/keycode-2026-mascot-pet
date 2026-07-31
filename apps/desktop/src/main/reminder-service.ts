/**
 * The reminder shell: one short interval, the persistence, and the power hooks.
 *
 * All the rules live in `reminders/reminder-scheduler.ts`. This is the part that cannot be pure.
 */

import { powerMonitor } from 'electron'
import {
  evaluateReminders,
  REMINDER_KINDS,
  REMINDER_MESSAGES,
  type ReminderDeadlines,
  type ReminderKind,
} from '../reminders/reminder-scheduler.js'
import { REMINDER_TICK_MS } from '../config/constants.js'
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
  now?: () => number
  log?: (message: string, meta?: unknown) => void
}

export function createReminderService(options: ReminderServiceOptions): ReminderService {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const { settings } = options

  let timer: NodeJS.Timeout | null = null

  const evaluate = (): void => {
    const current = settings.get()
    const result = evaluateReminders({
      now: now(),
      enabled: {
        water: current.waterReminderEnabled,
        stretch: current.stretchReminderEnabled,
      },
      deadlines: current.reminders
        ? { water: current.reminders.waterNextDueAt, stretch: current.reminders.stretchNextDueAt }
        : { water: null, stretch: null },
    })

    // Gate the write on `changed`. The tick runs 5,760 times a day; marking settings dirty every
    // time would turn the debounce into a disk write every 15 seconds forever.
    if (result.changed) {
      settings.patch({
        reminders: {
          waterNextDueAt: result.deadlines.water,
          stretchNextDueAt: result.deadlines.stretch,
        },
      })
    }

    for (const kind of result.fired) {
      log('reminder fired', { kind })
      options.onFire(kind, REMINDER_MESSAGES[kind])
    }
  }

  const onResume = (): void => {
    // `evaluateReminders` is idempotent, so waking needs no separate code path — just re-evaluate and
    // let the miss rule decide whether the gap was a sleep.
    log('power resume: re-evaluating reminders')
    evaluate()
  }

  const onSuspend = (): void => {
    // Persist the deadline *before* the lid closes. This is the only reason the miss rule has data to
    // work with on the other side: a deadline still sitting in a debounce buffer is a deadline lost.
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
