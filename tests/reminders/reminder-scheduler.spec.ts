import { describe, it, expect } from 'vitest'
import {
  evaluateReminders,
  nextWakeAt,
  REMINDER_INTERVALS,
  REMINDER_MESSAGES,
  REMINDER_KINDS,
  type ReminderDeadlines,
  type ReminderInput,
} from '../../apps/desktop/src/reminders/reminder-scheduler.js'
import { REMINDER_MISS_FACTOR, REMINDER_TICK_MS } from '../../apps/desktop/src/config/constants.js'

const WATER = REMINDER_INTERVALS.water
const STRETCH = REMINDER_INTERVALS.stretch

function input(overrides: Partial<ReminderInput> = {}): ReminderInput {
  return {
    now: 1_000_000,
    enabled: { water: true, stretch: true },
    deadlines: { water: null, stretch: null },
    ...overrides,
  }
}

describe('reminder scheduling', () => {
  it('schedules from now on first evaluation and does not fire', () => {
    // Ticking the box must not instantly produce a reminder.
    const result = evaluateReminders(input())
    expect(result.fired).toEqual([])
    expect(result.deadlines).toEqual({ water: 1_000_000 + WATER, stretch: 1_000_000 + STRETCH })
    expect(result.changed).toBe(true)
  })

  it('does nothing on a tick where nothing is due', () => {
    // The write-storm guard. This tick runs 5,760 times a day; an unconditional dirty flag would
    // turn the 500ms settings debounce into a disk write every 15 seconds, forever.
    const result = evaluateReminders(
      input({ deadlines: { water: 1_000_000 + 60_000, stretch: 1_000_000 + 60_000 } }),
    )
    expect(result.fired).toEqual([])
    expect(result.changed).toBe(false)
  })

  it('fires exactly once when a deadline passes, and reschedules from now', () => {
    const now = 1_000_000
    const result = evaluateReminders(
      input({ now, deadlines: { water: now - 1, stretch: now + STRETCH } }),
    )
    expect(result.fired).toEqual(['water'])
    expect(result.deadlines.water).toBe(now + WATER)
    expect(result.deadlines.stretch).toBe(now + STRETCH)
  })

  it('fires both kinds at most once each in a single evaluation', () => {
    const now = 5_000_000
    const result = evaluateReminders(input({ now, deadlines: { water: now - 5, stretch: now - 5 } }))
    expect(result.fired.sort()).toEqual(['stretch', 'water'])
  })

  // -------------------------------------------------------------------------------------
  // The centre of gravity: sleeping through reminders.
  // -------------------------------------------------------------------------------------

  it('fires zero reminders after a three-hour sleep and schedules the next a full interval out', () => {
    // The requirement from docs/PROMPT.md §4.6 / P5. `setInterval` would either fire nothing or dump
    // a backlog here; a wall-clock deadline plus the miss rule does neither.
    const before = 1_000_000
    const scheduled = evaluateReminders(input({ now: before }))

    const wake = before + 3 * 60 * 60 * 1_000
    const onWake = evaluateReminders(
      input({ now: wake, deadlines: scheduled.deadlines }),
    )

    expect(onWake.fired).toEqual([])
    expect(onWake.deadlines.water).toBe(wake + WATER)
    expect(onWake.deadlines.stretch).toBe(wake + STRETCH)
  })

  it('treats exactly two whole intervals overdue as slept-through, and one millisecond less as late', () => {
    // The boundary is asserted from both sides because "overdue" and "slept through" differ by one
    // comparison, and getting it wrong is invisible until someone closes their laptop for exactly
    // the wrong length of time. A 3-hour sleep lands precisely here for the 60-minute reminder.
    const now = 9_000_000

    const atBoundary = evaluateReminders(
      input({ now, deadlines: { water: now - REMINDER_MISS_FACTOR * WATER, stretch: null } }),
    )
    expect(atBoundary.fired).toEqual([])
    expect(atBoundary.deadlines.water).toBe(now + WATER)

    const justInside = evaluateReminders(
      input({ now, deadlines: { water: now - REMINDER_MISS_FACTOR * WATER + 1, stretch: null } }),
    )
    expect(justInside.fired).toEqual(['water'])
  })

  it('does not fire after a short lock-screen gap that is still within one interval', () => {
    const now = 2_000_000
    const result = evaluateReminders(
      input({ now, deadlines: { water: now + 10_000, stretch: now + 10_000 } }),
    )
    expect(result.fired).toEqual([])
    expect(result.changed).toBe(false)
  })

  // -------------------------------------------------------------------------------------
  // Clock changes
  // -------------------------------------------------------------------------------------

  it('resets a deadline that is implausibly far in the future', () => {
    // A backwards clock jump — an NTP step, a manual change, a timezone edit — leaves the deadline
    // beyond one interval. Not in the brief: without this rule the reminder is parked for however
    // far the clock moved.
    const now = 1_000_000
    const result = evaluateReminders(
      input({ now, deadlines: { water: now + WATER * 10, stretch: null } }),
    )
    expect(result.fired).toEqual([])
    expect(result.deadlines.water).toBe(now + WATER)
    expect(result.changed).toBe(true)
  })

  it('leaves a deadline exactly one interval out alone', () => {
    // The boundary of the rule above: a freshly scheduled deadline must not be seen as suspicious.
    const now = 1_000_000
    const result = evaluateReminders(
      input({ now, deadlines: { water: now + WATER, stretch: now + STRETCH } }),
    )
    expect(result.changed).toBe(false)
  })

  // -------------------------------------------------------------------------------------
  // Toggles
  // -------------------------------------------------------------------------------------

  it('clears the deadline when a reminder is disabled', () => {
    const result = evaluateReminders(
      input({
        enabled: { water: false, stretch: true },
        deadlines: { water: 1_500_000, stretch: 1_500_000 },
      }),
    )
    expect(result.deadlines.water).toBeNull()
    expect(result.deadlines.stretch).toBe(1_500_000)
    expect(result.changed).toBe(true)
  })

  it('is idempotent once disabled', () => {
    const result = evaluateReminders(
      input({ enabled: { water: false, stretch: false }, deadlines: { water: null, stretch: null } }),
    )
    expect(result.changed).toBe(false)
    expect(result.fired).toEqual([])
  })

  it('schedules a fresh interval on re-enable without firing', () => {
    const now = 3_000_000
    const off = evaluateReminders(
      input({ now, enabled: { water: false, stretch: false }, deadlines: { water: now - 1, stretch: now - 1 } }),
    )
    expect(off.deadlines).toEqual({ water: null, stretch: null })

    const on = evaluateReminders(input({ now: now + 5_000, deadlines: off.deadlines }))
    expect(on.fired).toEqual([])
    expect(on.deadlines.water).toBe(now + 5_000 + WATER)
  })

  it('never fires a disabled reminder even when overdue', () => {
    const now = 4_000_000
    const result = evaluateReminders(
      input({ enabled: { water: false, stretch: false }, now, deadlines: { water: now - 1, stretch: now - 1 } }),
    )
    expect(result.fired).toEqual([])
  })

  // -------------------------------------------------------------------------------------
  // Long-run behaviour
  // -------------------------------------------------------------------------------------

  it('fires the expected count over ten simulated days at the real tick rate', () => {
    // The end-to-end sanity check: 45-minute and 60-minute cadences over 240 hours, driven at the
    // actual 15s tick, with no drift accumulating.
    const days = 10
    const totalMs = days * 24 * 60 * 60 * 1_000
    let deadlines: ReminderDeadlines = { water: null, stretch: null }
    const counts = { water: 0, stretch: 0 }

    for (let now = 0; now <= totalMs; now += REMINDER_TICK_MS) {
      const result = evaluateReminders({
        now,
        enabled: { water: true, stretch: true },
        deadlines,
      })
      deadlines = result.deadlines
      for (const kind of result.fired) counts[kind] += 1
    }

    const expectedWater = Math.floor(totalMs / WATER)
    const expectedStretch = Math.floor(totalMs / STRETCH)
    expect(Math.abs(counts.water - expectedWater)).toBeLessThanOrEqual(1)
    expect(Math.abs(counts.stretch - expectedStretch)).toBeLessThanOrEqual(1)
  })

  it('does not mutate its input', () => {
    const frozen = Object.freeze({
      now: 1_000,
      enabled: Object.freeze({ water: true, stretch: true }),
      deadlines: Object.freeze({ water: null, stretch: null }),
    }) as ReminderInput
    expect(() => evaluateReminders(frozen)).not.toThrow()
    expect(frozen.deadlines).toEqual({ water: null, stretch: null })
  })
})

describe('nextWakeAt', () => {
  it('returns the earlier of two deadlines', () => {
    expect(nextWakeAt({ water: 500, stretch: 900 })).toBe(500)
    expect(nextWakeAt({ water: 900, stretch: 500 })).toBe(500)
  })

  it('ignores a disabled kind', () => {
    expect(nextWakeAt({ water: null, stretch: 700 })).toBe(700)
  })

  it('is null when nothing is scheduled', () => {
    expect(nextWakeAt({ water: null, stretch: null })).toBeNull()
  })
})

describe('reminder copy', () => {
  it('has a message for every kind', () => {
    for (const kind of REMINDER_KINDS) {
      expect(REMINDER_MESSAGES[kind].length).toBeGreaterThan(0)
    }
  })

  it('carries the emoji the bundled font exists for', () => {
    // If these ever became plain text, the font bundle would be dead weight — and the reverse, a
    // message with emoji and no font, is the tofu-box bug.
    expect(REMINDER_MESSAGES.water).toMatch(/\p{Extended_Pictographic}/u)
    expect(REMINDER_MESSAGES.stretch).toMatch(/\p{Extended_Pictographic}/u)
  })
})
