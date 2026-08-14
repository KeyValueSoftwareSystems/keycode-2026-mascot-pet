import { describe, it, expect } from 'vitest'
import {
  evaluateClockReminders,
  nextSlotAt,
  CLOCK_SLOTS,
  CLOCK_REMINDER_MESSAGES,
  CLOCK_REMINDER_KINDS,
  type ClockDeadlines,
} from '../../apps/desktop/src/reminders/clock-reminders.js'
import { CLOCK_REMINDER_GRACE_MS } from '../../apps/desktop/src/config/constants.js'

function at(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

function input(now: number, overrides: Partial<Parameters<typeof evaluateClockReminders>[0]> = {}) {
  return {
    now,
    enabled: { coffee: true, lunch: true },
    deadlines: { coffee: null, lunch: null } satisfies ClockDeadlines,
    ...overrides,
  }
}

describe('clock reminder scheduling', () => {
  it('schedules the next slot on first evaluation and does not fire', () => {
    const now = at(2026, 8, 14, 9, 0)
    const result = evaluateClockReminders(input(now))
    expect(result.fired).toEqual([])
    expect(result.deadlines.coffee).toBe(at(2026, 8, 14, 11, 0))
    expect(result.deadlines.lunch).toBe(at(2026, 8, 14, 12, 30))
    expect(result.changed).toBe(true)
  })

  it('picks afternoon coffee when the morning slot has already passed', () => {
    const now = at(2026, 8, 14, 12, 0)
    expect(nextSlotAt(now, CLOCK_SLOTS.coffee)).toBe(at(2026, 8, 14, 15, 0))
  })

  it('rolls to tomorrow when every slot today has passed', () => {
    const now = at(2026, 8, 14, 16, 0)
    expect(nextSlotAt(now, CLOCK_SLOTS.coffee)).toBe(at(2026, 8, 15, 11, 0))
    expect(nextSlotAt(now, CLOCK_SLOTS.lunch)).toBe(at(2026, 8, 15, 12, 30))
  })

  it('fires within the grace window and schedules the next slot', () => {
    const due = at(2026, 8, 14, 11, 0)
    const now = due + 60_000
    const result = evaluateClockReminders(
      input(now, { deadlines: { coffee: due, lunch: at(2026, 8, 14, 12, 30) } }),
    )
    expect(result.fired).toEqual(['coffee'])
    expect(result.deadlines.coffee).toBe(at(2026, 8, 14, 15, 0))
  })

  it('skips a slot slept through past the grace window', () => {
    const due = at(2026, 8, 14, 11, 0)
    const now = due + CLOCK_REMINDER_GRACE_MS
    const result = evaluateClockReminders(
      input(now, { deadlines: { coffee: due, lunch: at(2026, 8, 14, 12, 30) } }),
    )
    expect(result.fired).toEqual([])
    expect(result.deadlines.coffee).toBe(at(2026, 8, 14, 15, 0))
  })

  it('clears the deadline when disabled', () => {
    const result = evaluateClockReminders(
      input(at(2026, 8, 14, 9, 0), {
        enabled: { coffee: false, lunch: true },
        deadlines: { coffee: at(2026, 8, 14, 11, 0), lunch: at(2026, 8, 14, 12, 30) },
      }),
    )
    expect(result.deadlines.coffee).toBeNull()
    expect(result.deadlines.lunch).toBe(at(2026, 8, 14, 12, 30))
    expect(result.changed).toBe(true)
  })

  it('does not mutate its input', () => {
    const frozen = Object.freeze({
      now: at(2026, 8, 14, 9, 0),
      enabled: Object.freeze({ coffee: true, lunch: true }),
      deadlines: Object.freeze({ coffee: null, lunch: null }),
    })
    expect(() => evaluateClockReminders(frozen)).not.toThrow()
    expect(frozen.deadlines).toEqual({ coffee: null, lunch: null })
  })
})

describe('clock reminder copy', () => {
  it('has a message for every kind', () => {
    for (const kind of CLOCK_REMINDER_KINDS) {
      expect(CLOCK_REMINDER_MESSAGES[kind].length).toBeGreaterThan(0)
      expect(CLOCK_REMINDER_MESSAGES[kind]).toMatch(/\p{Extended_Pictographic}/u)
    }
  })
})
