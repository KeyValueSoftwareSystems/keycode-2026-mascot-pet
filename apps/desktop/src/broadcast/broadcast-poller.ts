/**
 * The broadcast poller: one static JSON file, polled over HTTPS, reaching every install.
 *
 * No push service, no sockets, no per-user registration, no backend. The whole capability is a GET on
 * a timer, which is why it can be hosted on anything that serves a file.
 *
 * Two properties the rest of the app depends on:
 *
 *   **Failure is silent.** Every error path produces one log line and nothing else — no dialog, no
 *   bubble, no animation, no interruption to the pet. A colleague on a plane must not be able to tell
 *   that polling is failing.
 *
 *   **Exactly once per install, ever.** That is a durability claim, so an id is persisted with a
 *   *forced* flush at the moment its callout is submitted. A crash 200ms after a bubble appears must
 *   not re-show it on next launch.
 */

import {
  HTTP_TIMEOUT_MS,
  MANIFEST_MAX_BYTES,
  MANIFEST_MAX_PER_POLL,
  MANIFEST_MAX_REDIRECTS,
  POLL,
} from '../config/constants.js'
import { getCapped, type CappedFetch, type FetchDeps, type HttpResult } from './http-capped.js'
import {
  parseManifest,
  selectDue,
  type SafeDefaults,
  type SafeNotification,
  type SafeRelease,
} from './manifest-schema.js'

export type PollReason = 'launch' | 'timer' | 'user' | 'resume'

export type PollOutcome =
  | { kind: 'ok'; surfaced: number; unchanged: boolean }
  | { kind: 'unchanged' }
  | { kind: 'error'; reason: string }

export interface PollerStatus {
  state: 'idle' | 'checking' | 'ok' | 'error'
  lastAt: number | null
  lastError: string | null
}

export interface PollerDeps {
  fetch: CappedFetch
  now?: () => number
  /** Injected so jitter is deterministic in tests. */
  random?: () => number
  getSeenIds: () => readonly string[]
  /** Must persist immediately, not on a debounce. See the module comment. */
  markSeen: (id: string) => Promise<void> | void
  onNotifications: (notifications: SafeNotification[]) => void
  onRelease: (release: SafeRelease | null) => void
  /** Team defaults from the manifest, or null when it carries none. */
  onDefaults?: (defaults: SafeDefaults | null) => void
  /**
   * The manifest-provided poll interval in minutes, or null. Read fresh on every reschedule, so a
   * changed value governs the next wait without restarting anything.
   */
  getPollMinutes?: () => number | null
  allowLoopbackHttp: boolean
  userAgent?: string
  log?: (message: string, meta?: unknown) => void
}

export interface Poller {
  start(): void
  stop(): void
  /** Poll now. Concurrent calls share the in-flight request rather than stacking. */
  pollNow(reason: PollReason): Promise<PollOutcome>
  status(): PollerStatus
  /**
   * Recompute the pending wait with the current interval.
   *
   * Without this, shortening the interval only takes effect after the *old* wait elapses — so setting
   * 1 minute while a 5-minute timer is pending still means waiting five.
   */
  rescheduleNow(): void
}

/** Resolve the manifest URL, env override first. */
export function resolveManifestUrl(env: NodeJS.ProcessEnv, fallback: string): string {
  const override = env.KEYCODE_PET_MANIFEST_URL
  return override && override.length > 0 ? override : fallback
}

/** Resolve the poll interval in minutes, clamped. A bad value falls back rather than disabling polling. */
export function resolvePollMinutes(
  env: NodeJS.ProcessEnv,
  /** Manifest-provided default, or null. The env override wins over it — it is a dev escape hatch. */
  fromManifest: number | null = null,
): number {
  const clamp = (n: number): number => Math.min(POLL.maxMinutes, Math.max(POLL.minMinutes, n))
  const raw = Number(env.KEYCODE_PET_POLL_MINUTES)
  if (Number.isFinite(raw) && raw > 0) return clamp(raw)
  if (fromManifest !== null && Number.isFinite(fromManifest) && fromManifest > 0) {
    return clamp(fromManifest)
  }
  return POLL.baseMinutes
}

/**
 * Next delay with jitter.
 *
 * ±20% so a fleet of clients that all started at the same time — say, after a company-wide
 * install — does not converge into a thundering herd against a static host.
 */
export function nextDelayMs(baseMs: number, random: () => number): number {
  const spread = 1 - POLL.jitter + random() * POLL.jitter * 2
  return Math.round(baseMs * spread)
}

export function createPoller(url: string, deps: PollerDeps): Poller {
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const log = deps.log ?? (() => {})

  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let inFlight: Promise<PollOutcome> | null = null
  let etag: string | null = null
  /**
   * Hash of the last body we successfully parsed.
   *
   * Change detection deliberately does not rely on 304. With `cache: 'no-store'` and a hand-set
   * `If-None-Match`, Chromium's net stack has no cache entry to revalidate against, and how it
   * surfaces a bare 304 is not something worth depending on. The ETag stays as bandwidth politeness;
   * correctness comes from comparing the body itself.
   */
  let lastBodyHash: string | null = null
  /**
   * The last body successfully fetched, kept only so held-back entries can be reconsidered after a
   * 304 — which carries no body of its own.
   */
  let lastBody: string | null = null
  /** True when the last poll capped the number it surfaced, so the next must look again. */
  let heldBack = false
  let status: PollerStatus = { state: 'idle', lastAt: null, lastError: null }

  /** Last interval reported, so a change is logged once rather than on every reschedule. */
  let lastLoggedMinutes: number | null = null

  const baseDelay = (): number => {
    const fromManifest = deps.getPollMinutes?.() ?? null
    const minutes = resolvePollMinutes(process.env, fromManifest)

    // Log the interval when it *changes*, not on every reschedule.
    //
    // Without this there is no way to tell what cadence the app is actually on. The startup line is a
    // snapshot taken before any manifest has been fetched, and a *successful* poll is deliberately
    // silent — so after the manifest shortened the interval, nothing said so. The behaviour was right
    // and completely unobservable, which is its own kind of bug: the first question anyone asks is
    // "is it actually polling every minute?" and the log could not answer it.
    if (minutes !== lastLoggedMinutes) {
      const source = Number(process.env.KEYCODE_PET_POLL_MINUTES) > 0
        ? 'env'
        : fromManifest !== null
          ? 'manifest'
          : 'built-in default'
      log('poll interval', { minutes, source, was: lastLoggedMinutes })
      lastLoggedMinutes = minutes
    }
    return minutes * 60_000
  }

  const scheduleNext = (): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    const delay = nextDelayMs(baseDelay(), random)
    timer = setTimeout(() => {
      void run('timer')
    }, delay)
    timer.unref?.()
  }

  const run = async (reason: PollReason): Promise<PollOutcome> => {
    // Share the in-flight request. A timer firing during a slow response must not stack a second
    // one, which is how a flaky network turns into a request storm.
    if (inFlight) return inFlight

    status = { ...status, state: 'checking' }

    inFlight = (async (): Promise<PollOutcome> => {
      const result: HttpResult = await getCapped(
        url,
        {
          etag,
          timeoutMs: HTTP_TIMEOUT_MS,
          maxBytes: MANIFEST_MAX_BYTES,
          allowLoopbackHttp: deps.allowLoopbackHttp,
          maxRedirects: MANIFEST_MAX_REDIRECTS,
          ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
        },
        { fetch: deps.fetch } satisfies FetchDeps,
      )

      if (result.kind === 'error') {
        // Silent by design: one log line, nothing user-visible.
        const detail = result.status ? `${result.reason} (${result.status})` : result.reason
        log('broadcast poll failed', { reason, detail: result.detail ?? detail })
        status = { state: 'error', lastAt: now(), lastError: detail }
        return { kind: 'error', reason: detail }
      }

      /*
       * The unchanged short-circuits are skipped while entries are held back.
       *
       * Without this, the per-poll cap does not defer the surplus — it discards it. Change detection
       * is on the body, and a manifest nobody has edited hashes the same forever, so the held entries
       * would never be reconsidered and would simply never arrive. Found by the test that asserts all
       * eight of eight eventually show up; it saw three.
       */
      // A 304 carries no body, so re-reading the manifest means re-using the last one fetched.
      const body = result.kind === 'not-modified' ? lastBody : result.body
      const unchanged =
        body === null ||
        (result.kind === 'not-modified' ? true : hashString(body) === lastBodyHash)

      if (result.kind !== 'not-modified') etag = result.etag

      if (unchanged && !heldBack) {
        status = { state: 'ok', lastAt: now(), lastError: null }
        return { kind: 'unchanged' }
      }
      if (body === null) {
        // Held back, but a 304 arrived before any body was ever fetched. Nothing to reconsider.
        status = { state: 'ok', lastAt: now(), lastError: null }
        return { kind: 'unchanged' }
      }

      const parsed = parseManifest(body)
      if (!parsed) {
        log('broadcast manifest was unusable', { reason })
        status = { state: 'error', lastAt: now(), lastError: 'unparseable manifest' }
        return { kind: 'error', reason: 'unparseable manifest' }
      }

      lastBody = body
      lastBodyHash = hashString(body)

      if (parsed.dropped.length > 0) {
        // Individually dropped entries are logged rather than swallowed: a typo in one announcement
        // should be findable without wondering why nobody saw it.
        log('broadcast manifest had unusable entries', { dropped: parsed.dropped })
      }

      deps.onRelease(parsed.release)
      deps.onDefaults?.(parsed.defaults)

      const seen = new Set(deps.getSeenIds())
      const allDue = selectDue(parsed.notifications, now(), seen)
      // Cap per poll. `selectDue` sorts by priority then id, so the cap keeps the most important ones
      // and the rest arrive next poll — they are left unseen rather than dropped.
      const due = allDue.slice(0, MANIFEST_MAX_PER_POLL)
      heldBack = allDue.length > due.length
      if (heldBack) {
        log('holding notifications for the next poll', {
          surfacing: due.length,
          held: allDue.length - due.length,
        })
      }

      for (const entry of due) {
        // Persist *before* surfacing. "Shown exactly once, ever" is a durability claim, and a crash
        // between the bubble appearing and the write landing would break it.
        await deps.markSeen(entry.id)
      }

      if (due.length > 0) deps.onNotifications(due)

      status = { state: 'ok', lastAt: now(), lastError: null }
      return { kind: 'ok', surfaced: due.length, unchanged: false }
    })()

    try {
      return await inFlight
    } finally {
      inFlight = null
      // Self-rescheduling rather than a fixed interval: the next delay is measured from when this
      // poll *finished*, so a slow response cannot cause overlapping polls.
      if (reason !== 'user') scheduleNext()
    }
  }

  return {
    start(): void {
      stopped = false
      // Poll once on launch, so a message posted while the app was closed appears promptly rather
      // than after a full interval.
      void run('launch')
    },

    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },

    pollNow(reason: PollReason): Promise<PollOutcome> {
      return run(reason)
    },

    rescheduleNow(): void {
      if (!stopped) scheduleNext()
    },

    status(): PollerStatus {
      return status
    },
  }
}

/**
 * FNV-1a over UTF-16 code units.
 *
 * Only needs to detect "this body differs from the last one"; a cryptographic hash would be
 * pointless here and would pull in a Node-only import that the test path does not want.
 */
function hashString(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}
