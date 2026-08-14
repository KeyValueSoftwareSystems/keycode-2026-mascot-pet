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
