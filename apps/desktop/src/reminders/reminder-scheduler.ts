/**
 * Reminder scheduling. Pure, with an injected clock.
 *
 * ---------------------------------------------------------------------------------------
 * `setInterval` is not a clock.
 * ---------------------------------------------------------------------------------------
 *
 * Suspend a laptop for two hours and a 45-minute `setInterval` will either fire nothing or fire a
 * burst on wake, depending on platform and timing. Both are the bug: the pet either forgets to
 * remind you all afternoon, or greets you with four backlogged reminders the moment you open the lid.
 *
 * So a reminder is a persisted **wall-clock deadline**. A short interval ticks and compares
 * `Date.now()` against that deadline; the deadline itself survives suspend, reboot and clock changes
 * because it is a number on disk, not a timer in memory.
 *
 * This module is the rules. The timer, the persistence and the firing live in `reminder-service.ts`.
 */

import {
  WATER_INTERVAL_MS,
  STRETCH_INTERVAL_MS,
  REMINDER_MISS_FACTOR,
} from '../config/constants.js'

export type ReminderKind = 'water' | 'stretch'

export const REMINDER_KINDS: readonly ReminderKind[] = ['water', 'stretch']

export const REMINDER_INTERVALS: Readonly<Record<ReminderKind, number>> = {
  water: WATER_INTERVAL_MS,
  stretch: STRETCH_INTERVAL_MS,
}

export interface ReminderDeadlines {
  water: number | null
  stretch: number | null
}

export interface ReminderInput {
  now: number
  enabled: Readonly<Record<ReminderKind, boolean>>
  deadlines: Readonly<ReminderDeadlines>
}

export interface ReminderResult {
  deadlines: ReminderDeadlines
  fired: ReminderKind[]
  /**
   * Whether any deadline actually moved.
   *
   * Not cosmetic: the tick runs 5,760 times a day, and a host that marks settings dirty
   * unconditionally turns a 500ms debounce into a disk write every 15 seconds, forever. The host
   * gates its `patch` call on this.
   */
  changed: boolean
}

/**
 * Evaluate all reminders.
 *
 * Rules per kind, in order. Only rule 5 fires.
 *
 *   1. Disabled  -> clear the deadline. Toggling off must not leave a live deadline behind.
 *   2. No deadline -> schedule `now + interval`, do NOT fire. Covers first run and re-enabling;
 *      firing here would mean ticking the box instantly produces a reminder.
 *   3. Deadline further out than one interval -> the clock moved *backwards* (an NTP step, a manual
 *      change, a timezone edit). Reschedule from now. Not in the brief, and needed: without it the
 *      reminder is parked for however far the clock jumped.
 *   4. Overdue by REMINDER_MISS_FACTOR whole intervals or more -> the machine was asleep. Reschedule
 *      from now, do NOT fire. This is what stops a backlog dump on wake.
 *   5. Overdue -> fire once, reschedule from `now`.
 *
 * Rescheduling always from `now` rather than `deadline + interval` is what makes a burst
 * structurally impossible: at most one fire per kind per evaluation, however long the gap.
 */
export function evaluateReminders(input: ReminderInput): ReminderResult {
  const deadlines: ReminderDeadlines = { ...input.deadlines }
  const fired: ReminderKind[] = []
  let changed = false

  for (const kind of REMINDER_KINDS) {
    const interval = REMINDER_INTERVALS[kind]
    const due = input.deadlines[kind]

    if (!input.enabled[kind]) {
      if (due !== null) {
        deadlines[kind] = null
        changed = true
      }
      continue
    }

    if (due === null) {
      deadlines[kind] = input.now + interval
      changed = true
      continue
    }

    if (due - input.now > interval) {
      deadlines[kind] = input.now + interval
      changed = true
      continue
    }

    if (input.now < due) continue

    const overdueBy = input.now - due
    // `>=`, not `>`. Being overdue by two or more *whole* intervals means the machine was away, not
    // that a 15s tick ran late. The distinction is not academic: a 3-hour sleep leaves the 60-minute
    // stretch reminder overdue by exactly 2x its interval, so a strict comparison fires it — which is
    // precisely the wake-up backlog this rule exists to prevent.
    if (overdueBy >= REMINDER_MISS_FACTOR * interval) {
      deadlines[kind] = input.now + interval
      changed = true
      continue
    }

    fired.push(kind)
    deadlines[kind] = input.now + interval
    changed = true
  }

  return { deadlines, fired, changed }
}

/** The earliest live deadline, or null when nothing is scheduled. */
export function nextWakeAt(deadlines: Readonly<ReminderDeadlines>): number | null {
  const live = REMINDER_KINDS.map((kind) => deadlines[kind]).filter(
    (value): value is number => value !== null,
  )
  return live.length === 0 ? null : Math.min(...live)
}

/** Human-facing copy, kept beside the rules so the two cannot drift. */
export const REMINDER_MESSAGES: Readonly<Record<ReminderKind, string>> = {
  water: 'Time for some water 💧',
  stretch: 'Stand up and stretch 🤸',
}

/** Trigger names, resolved through the spritesheet's reaction map by the caller. */
export const REMINDER_TRIGGERS = {
  water: 'water-reminder',
  stretch: 'stretch-reminder',
} as const
