import { describe, it, expect } from 'vitest'
import {
  evaluateGreeting,
  periodAt,
  greetingKey,
  GREETING_MESSAGES,
} from '../../apps/desktop/src/reminders/greetings.js'

function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

describe('greeting periods', () => {
  it('is quiet before 5:00', () => {
    expect(periodAt(at(2026, 8, 14, 4, 59))).toBeNull()
  })

  it('is morning until noon', () => {
    expect(periodAt(at(2026, 8, 14, 5, 0))).toBe('morning')
    expect(periodAt(at(2026, 8, 14, 11, 59))).toBe('morning')
  })

  it('is afternoon until 17:00', () => {
    expect(periodAt(at(2026, 8, 14, 12, 0))).toBe('afternoon')
    expect(periodAt(at(2026, 8, 14, 16, 59))).toBe('afternoon')
  })

  it('is evening from 17:00', () => {
    expect(periodAt(at(2026, 8, 14, 17, 0))).toBe('evening')
    expect(periodAt(at(2026, 8, 14, 23, 59))).toBe('evening')
  })
})

describe('evaluateGreeting', () => {
  it('fires the current period once', () => {
    const now = at(2026, 8, 14, 9, 0)
    const first = evaluateGreeting({ now, lastKey: null })
    expect(first.fired).toBe('morning')
    expect(first.lastKey).toBe(greetingKey(now, 'morning'))
    expect(first.changed).toBe(true)

    const again = evaluateGreeting({ now: at(2026, 8, 14, 10, 0), lastKey: first.lastKey })
    expect(again.fired).toBeNull()
    expect(again.changed).toBe(false)
  })

  it('fires afternoon on crossing noon, without replaying morning', () => {
    const morning = evaluateGreeting({ now: at(2026, 8, 14, 9, 0), lastKey: null })
    const noon = evaluateGreeting({ now: at(2026, 8, 14, 12, 0), lastKey: morning.lastKey })
    expect(noon.fired).toBe('afternoon')
  })

  it('skips a slept-through period instead of dumping a backlog', () => {
    const now = at(2026, 8, 14, 14, 0)
    const result = evaluateGreeting({ now, lastKey: null })
    expect(result.fired).toBe('afternoon')
  })

  it('does not greet in the quiet hours', () => {
    const result = evaluateGreeting({ now: at(2026, 8, 14, 2, 0), lastKey: null })
    expect(result.fired).toBeNull()
    expect(result.changed).toBe(false)
  })
})

describe('greeting copy', () => {
  it('has a message for every period', () => {
    for (const period of ['morning', 'afternoon', 'evening'] as const) {
      expect(GREETING_MESSAGES[period].length).toBeGreaterThan(0)
      expect(GREETING_MESSAGES[period]).toMatch(/\p{Extended_Pictographic}/u)
    }
  })
})

describe('first-run greeting suppression', () => {
  /**
   * A brand-new install introduces itself ("Hi, I'm Argus — on duty!"), so app-shell seeds
   * `lastGreetingKey` with the current period before the reminder service first ticks. Without it a
   * new colleague gets two hellos in the same second — the introduction and "Good afternoon".
   */
  it('suppresses the time-of-day greeting for the period the intro stood in for', () => {
    const now = at(2026, 8, 19, 14, 30)
    const period = periodAt(now)
    expect(period).toBe('afternoon')

    const seeded = greetingKey(now, period!)
    expect(evaluateGreeting({ now, lastKey: seeded }).fired).toBeNull()
  })

  it('still greets in the next period, so suppression lasts one period and not the day', () => {
    const installedAt = at(2026, 8, 19, 14, 30)
    const seeded = greetingKey(installedAt, periodAt(installedAt)!)

    // Same day, evening: the introduction covered the afternoon only.
    const evening = at(2026, 8, 19, 18, 0)
    expect(evaluateGreeting({ now: evening, lastKey: seeded }).fired).toBe('evening')
  })

  it('still greets the next morning', () => {
    const installedAt = at(2026, 8, 19, 18, 0)
    const seeded = greetingKey(installedAt, periodAt(installedAt)!)

    const tomorrow = at(2026, 8, 20, 9, 0)
    expect(evaluateGreeting({ now: tomorrow, lastKey: seeded }).fired).toBe('morning')
  })

  it('seeds nothing during the quiet hours, because nothing would have fired anyway', () => {
    // Installing at 03:00 has no period to stand in for; app-shell writes no key, and the first
    // real greeting is the morning one.
    const night = at(2026, 8, 19, 3, 0)
    expect(periodAt(night)).toBeNull()
    expect(evaluateGreeting({ now: night, lastKey: null }).fired).toBeNull()
  })
})
