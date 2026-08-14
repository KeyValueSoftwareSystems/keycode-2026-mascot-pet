/**
 * Clock-time reminders: coffee at 11:00 and 15:00, lunch at 12:30. Pure.
 *
 * Interval reminders (water, stretch) live in reminder-scheduler.ts. These are wall-clock *slots*
 * in the local timezone: the next occurrence is scheduled as a deadline, and the same miss rule
 * as interval reminders stops a backlog dump on wake — except the unit of "missed" is a grace
 * window after the slot, not a multiple of an interval.
 */

import { CLOCK_REMINDER_GRACE_MS } from '../config/constants.js'

export type ClockReminderKind = 'coffee' | 'lunch'

export const CLOCK_REMINDER_KINDS: readonly ClockReminderKind[] = ['coffee', 'lunch']

export interface ClockSlot {
  hour: number
  minute: number
}

/** Local-time slots. Coffee twice a day; lunch once. */
export const CLOCK_SLOTS: Readonly<Record<ClockReminderKind, readonly ClockSlot[]>> = {
  coffee: [
    { hour: 11, minute: 0 },
    { hour: 15, minute: 0 },
  ],
  lunch: [{ hour: 12, minute: 30 }],
}

export interface ClockDeadlines {
  coffee: number | null
  lunch: number | null
}

export interface ClockReminderInput {
  now: number
  enabled: Readonly<Record<ClockReminderKind, boolean>>
  deadlines: Readonly<ClockDeadlines>
}

export interface ClockReminderResult {
  deadlines: ClockDeadlines
  fired: ClockReminderKind[]
  changed: boolean
}

/** Next occurrence of any slot at or after `now`, in local time. */
export function nextSlotAt(now: number, slots: readonly ClockSlot[]): number {
  const sorted = [...slots].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))
  for (const slot of sorted) {
    const at = localAt(now, slot.hour, slot.minute)
    if (at >= now) return at
  }
  const first = sorted[0]!
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(first.hour, first.minute, 0, 0)
  return tomorrow.getTime()
}

export function evaluateClockReminders(input: ClockReminderInput): ClockReminderResult {
  const deadlines: ClockDeadlines = { ...input.deadlines }
  const fired: ClockReminderKind[] = []
  let changed = false

  for (const kind of CLOCK_REMINDER_KINDS) {
    const slots = CLOCK_SLOTS[kind]
    const due = input.deadlines[kind]

    if (!input.enabled[kind]) {
      if (due !== null) {
        deadlines[kind] = null
        changed = true
      }
      continue
    }

    if (due === null) {
      deadlines[kind] = nextSlotAt(input.now, slots)
      changed = true
      continue
    }

    if (input.now < due) continue

    const overdueBy = input.now - due
    if (overdueBy >= CLOCK_REMINDER_GRACE_MS) {
      deadlines[kind] = nextSlotAt(input.now, slots)
      changed = true
      continue
    }

    fired.push(kind)
    deadlines[kind] = nextSlotAt(input.now, slots)
    changed = true
  }

  return { deadlines, fired, changed }
}

export const CLOCK_REMINDER_MESSAGES: Readonly<Record<ClockReminderKind, string>> = {
  coffee: 'Coffee time ☕',
  lunch: 'Time for lunch 🍽️',
}

export const CLOCK_REMINDER_TRIGGERS = {
  coffee: 'coffee-reminder',
  lunch: 'lunch-reminder',
} as const

function localAt(now: number, hour: number, minute: number): number {
  const date = new Date(now)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}
