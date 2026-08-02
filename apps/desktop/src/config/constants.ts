/**
 * Every tunable that is not animation geometry or motion feel.
 *
 * Animation geometry lives in pet/spritesheet.json; motion feel lives in motion-config.ts. This
 * holds the rest — reminder intervals, callout limits, network bounds, toast layout — so that
 * "what number governs X" has one answer and a reviewer can read the app's policy in one file.
 */

// ---------------------------------------------------------------------------------------
// Pet size
// ---------------------------------------------------------------------------------------

/**
 * Scale factors, applied to the sprite only — the speech bubble's text does not shrink with the pet,
 * because 13px at half size is not readable and the bubble's whole job is to be read.
 *
 * `large` is 1.0: the size the app shipped at before sizes existed, so nobody's pet changes size on
 * upgrade.
 *
 * **`medium` is deliberately soft on a 2× display.** Pixel art stays sharp only at whole-device-pixel
 * scales, and 0.75 × 2 = 1.5 device pixels per source pixel, which resamples. The alternative was to
 * pick 1.5/1.0/0.5 so all three are exact — but that renames the current size to "medium" and makes
 * "large" bigger than anything shipped so far. Keeping the existing size as `large` was the explicit
 * choice; the crispness assertion measures lower for `medium` alone and that is expected, not a bug.
 */
export const PET_SIZE_SCALES = { small: 0.5, medium: 0.75, large: 1 } as const

export type PetSize = keyof typeof PET_SIZE_SCALES

export const PET_SIZES = Object.keys(PET_SIZE_SCALES) as readonly PetSize[]

export const DEFAULT_PET_SIZE: PetSize = 'large'

export function isPetSize(value: unknown): value is PetSize {
  return typeof value === 'string' && value in PET_SIZE_SCALES
}

export function petScaleFor(size: PetSize): number {
  return PET_SIZE_SCALES[size]
}

// ---------------------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------------------

export const WATER_INTERVAL_MS = 45 * 60_000
export const STRETCH_INTERVAL_MS = 60 * 60_000

/**
 * Intervals offered in the menu, in minutes.
 *
 * 5 is here for testing as much as for use: without it, checking that reminders work at all means
 * waiting 45 minutes or hand-editing the settings file, which is how they had to be tested before.
 */
export const REMINDER_MINUTE_CHOICES = [5, 15, 30, 45, 60, 90] as const

/** Bounds for any interval arriving from outside — the menu, or a manifest default. */
export const REMINDER_MINUTES_MIN = 1
export const REMINDER_MINUTES_MAX = 24 * 60

export function clampReminderMinutes(minutes: number): number {
  return Math.min(REMINDER_MINUTES_MAX, Math.max(REMINDER_MINUTES_MIN, Math.round(minutes)))
}

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

/**
 * How many *new* notifications may be surfaced by one poll.
 *
 * Every live entry is shown once per install, so a fresh install fetches all of them at once — and
 * since a notification with no `durationMs` waits to be clicked, ten live entries would mean ten
 * stacked bubbles each needing a click before the next appears. Capping per poll spreads them over
 * successive polls instead. The remainder are simply not marked seen, so nothing is lost.
 */
export const MANIFEST_MAX_PER_POLL = 3

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

/** Where the code lives, and where a problem report goes. */
export const REPO_URL = 'https://github.com/doylefermi-kv/keycode-2026-mascot-pet'
export const ISSUES_URL = `${REPO_URL}/issues/new`
export const APP_ID = 'systems.keyvalue.keycodepet'
