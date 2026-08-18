/**
 * Time-of-day greetings. Pure.
 *
 * One greeting per period per local day: morning, afternoon, evening. Sleeping through a period
 * skips it rather than dumping a backlog — waking at 14:00 greets with afternoon, not morning.
 */

export type GreetingPeriod = 'morning' | 'afternoon' | 'evening'

export interface GreetingInput {
  now: number
  /** Last greeting shown, e.g. `2026-08-14-afternoon`, or null if none yet. */
  lastKey: string | null
}

export interface GreetingResult {
  lastKey: string | null
  fired: GreetingPeriod | null
  changed: boolean
}

/** Local civil period, or null in the quiet hours (midnight–5:00). */
export function periodAt(now: number): GreetingPeriod | null {
  const hour = new Date(now).getHours()
  if (hour < 5) return null
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

export function greetingKey(now: number, period: GreetingPeriod): string {
  const date = new Date(now)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}-${period}`
}

export function evaluateGreeting(input: GreetingInput): GreetingResult {
  const period = periodAt(input.now)
  if (period === null) {
    return { lastKey: input.lastKey, fired: null, changed: false }
  }

  const key = greetingKey(input.now, period)
  if (input.lastKey === key) {
    return { lastKey: input.lastKey, fired: null, changed: false }
  }

  return { lastKey: key, fired: period, changed: true }
}

export const GREETING_MESSAGES: Readonly<Record<GreetingPeriod, string>> = {
  morning: 'Good morning ☀️',
  afternoon: 'Good afternoon ☀️',
  evening: 'Good evening 👋',
}

export const GREETING_TRIGGERS = {
  morning: 'greeting-morning',
  afternoon: 'greeting-afternoon',
  evening: 'greeting-evening',
} as const
