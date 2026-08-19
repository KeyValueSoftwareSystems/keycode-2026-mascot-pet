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

/**
 * Size a pet starts at when nobody has chosen and no team default has arrived.
 *
 * `small` since v1.10.0. It is also the value published in the manifest, and the two matching is what
 * keeps launch quiet: manifest defaults are held in memory and never persisted, so the window is
 * created at *this* size and only learns the team's a second later at the first poll. Were they to
 * differ, the pet would visibly resize once on every launch.
 */
export const DEFAULT_PET_SIZE: PetSize = 'small'

/** Whether a pet floats in front of everything when nobody has chosen. */
export const DEFAULT_ALWAYS_ON_TOP = true

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

/** How long a water snooze waits before reminding again. */
export const WATER_SNOOZE_MS = 60_000

/** Idle pause between drink-animation replays while the water bubble is up. */
export const DRINK_LOOP_GAP_MS = 800

/**
 * How late a clock-time reminder (coffee, lunch) may still fire. Past this it was slept through
 * and is skipped rather than dumped on wake.
 */
export const CLOCK_REMINDER_GRACE_MS = 20 * 60_000

/** How often a hover may start a reaction, so waving does not loop under a parked cursor. */
export const HOVER_REACTION_COOLDOWN_MS = 8_000

// ---------------------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------------------

export const CALLOUT_DEFAULT_MS = 6_000
export const CALLOUT_QUEUE_MAX = 16
export const CALLOUT_TEXT_MAX = 200

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

/**
 * How long the first-run analytics notice stays up.
 *
 * Long enough to read twice without hurrying, short enough that it clears itself. It follows the
 * greeting, and making a second bubble demand its own click is how a welcome turns into a queue.
 */
export const FIRST_RUN_NOTICE_MS = 12_000

export const POLL = {
  /*
   * 1 minute.
   *
   * This was 5, and the manifest was set to 10 on the assumption that GitHub Pages' `max-age=600`
   * would serve stale content for ten minutes and make anything shorter pure waste. Measured instead
   * of assumed: Pages **purges its CDN on deploy** (`x-cache: MISS`, `age: 0`, new content visible
   * with no cache-buster immediately after a deploy), so `max-age` only governs how long an
   * *unchanged* file is served from the edge. A short poll therefore does deliver quickly.
   *
   * The bandwidth is negligible: the manifest is ~500 bytes and most polls answer 304, so a client
   * costs under a megabyte a day.
   */
  baseMinutes: 1,
  /** ±20%, so a fleet of clients does not synchronise into a thundering herd. */
  jitter: 0.2,
  minMinutes: 1,
  maxMinutes: 1_440,
} as const

// ---------------------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------------------

/**
 * PostHog ingest. The key is a **public, write-only** project token — it can append events and read
 * nothing back, which is why it ships in a public repo without ceremony.
 */
export const ANALYTICS_ENDPOINT = 'https://us.i.posthog.com/batch'
export const ANALYTICS_PROJECT_KEY = 'phc_rWg6r2hAyu7Y8chiHv7aLhtmLSCTdvChSUecWPCfZAvr'

export const ANALYTICS = {
  /**
   * Minutes between heartbeats.
   *
   * The heartbeat is what "how many are running it right now" is counted from, and what distinguishes
   * a dormant install from an uninstalled one. Thirty minutes is a deliberate compromise: a pet that
   * runs all day costs ~1,440 events a month, so the free tier's million holds roughly 660 installs.
   * Shortening it buys resolution nobody needs and spends that headroom fast.
   *
   * Overridable per-fleet from the manifest (`defaults.analyticsMinutes`), including `0` to switch
   * analytics off for everyone without shipping a build.
   */
  heartbeatMinutes: 30,
  /** ±20%, so a fleet does not synchronise into a thundering herd. Same reasoning as POLL.jitter. */
  jitter: 0.2,
  minMinutes: 5,
  maxMinutes: 1_440,
  /** Events kept on disk when sending fails. Oldest evicted first. */
  queueMax: 500,
  /**
   * How long a queued event stays worth sending.
   *
   * Four days, so a laptop closed over a long weekend still reports what it did. Past that the event
   * is more likely to distort a retention chart than to inform one.
   */
  queueMaxAgeMs: 4 * 24 * 60 * 60 * 1_000,
  /** Events per request. Well under PostHog's 20MB body limit at this event size. */
  batchMax: 100,
  /** The response is read only so the socket can be released; it is never used. */
  responseMaxBytes: 8 * 1024,
} as const

// ---------------------------------------------------------------------------------------
// Product identity
// ---------------------------------------------------------------------------------------

export const PRODUCT_NAME = 'Argos'
/** Previous `app.setName()` value; used to copy settings into the new userData folder. */
export const LEGACY_PRODUCT_NAME = 'Keycode Pet'

export const DEFAULT_MANIFEST_URL =
  'https://keyvaluesoftwaresystems.github.io/keycode-2026-mascot-pet/manifest.json'

/** Squirrel.Mac JSON feeds, one per architecture. Overridable via KEYCODE_PET_UPDATE_FEED_URL. */
export const DEFAULT_MAC_UPDATE_FEED_URL = {
  arm64: 'https://keyvaluesoftwaresystems.github.io/keycode-2026-mascot-pet/updates/darwin-arm64.json',
  x64: 'https://keyvaluesoftwaresystems.github.io/keycode-2026-mascot-pet/updates/darwin-x64.json',
} as const

/** Where the code lives, and where a problem report goes. */
export const REPO_URL = 'https://github.com/KeyValueSoftwareSystems/keycode-2026-mascot-pet'
export const ISSUES_URL = `${REPO_URL}/issues/new`
export const APP_ID = 'systems.keyvalue.keycodepet'
