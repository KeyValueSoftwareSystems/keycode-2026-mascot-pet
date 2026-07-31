/**
 * Every tunable that is not animation geometry or motion feel.
 *
 * Animation geometry lives in pet/spritesheet.json; motion feel lives in motion-config.ts. This
 * holds the rest — reminder intervals, callout limits, network bounds, toast layout — so that
 * "what number governs X" has one answer and a reviewer can read the app's policy in one file.
 */

// ---------------------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------------------

export const WATER_INTERVAL_MS = 45 * 60_000
export const STRETCH_INTERVAL_MS = 60 * 60_000

/**
 * How often deadlines are checked. Not the reminder interval — see reminder-scheduler.ts for why
 * durations are wall-clock deadlines rather than timers.
 */
export const REMINDER_TICK_MS = 15_000

/**
 * A deadline missed by more than this multiple of its interval means the machine was asleep, so the
 * reminder is rescheduled rather than fired. Firing would dump a backlog on wake.
 */
export const REMINDER_MISS_FACTOR = 2

// ---------------------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------------------

export const CALLOUT_DEFAULT_MS = 6_000
export const CALLOUT_QUEUE_MAX = 16
export const CALLOUT_TEXT_MAX = 200

export const TONE_COLORS = {
  info: '#38bdf8',
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
} as const

// ---------------------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------------------

export const TOAST = {
  width: 300,
  height: 64,
  margin: 16,
  gap: 8,
  /** Beyond this, extra toasts are dropped rather than stacked off the top of the screen. */
  max: 3,
  minMs: 1_000,
  maxMs: 15_000,
  defaultMs: 4_000,
} as const

// ---------------------------------------------------------------------------------------
// Broadcast manifest
// ---------------------------------------------------------------------------------------

export const HTTP_TIMEOUT_MS = 6_000
/** Streaming cap: the body is abandoned past this, never buffered and then measured. */
export const MANIFEST_MAX_BYTES = 64 * 1024
/** Redirects are followed manually so the HTTPS-only rule can be re-checked at every hop. */
export const MANIFEST_MAX_REDIRECTS = 3
export const MANIFEST_MAX_NOTIFICATIONS = 32

export const BROADCAST_DURATION_MS = { min: 2_000, max: 30_000 } as const

export const POLL = {
  baseMinutes: 5,
  /** ±20%, so a fleet of clients does not synchronise into a thundering herd. */
  jitter: 0.2,
  minMinutes: 1,
  maxMinutes: 1_440,
} as const

// ---------------------------------------------------------------------------------------
// Product identity
// ---------------------------------------------------------------------------------------

export const PRODUCT_NAME = 'Keycode Pet'
export const APP_ID = 'systems.keyvalue.keycodepet'
