/**
 * Anonymous usage analytics: capture, queue, send on a jittered timer.
 *
 * ---------------------------------------------------------------------------------------
 * What this is allowed to know
 * ---------------------------------------------------------------------------------------
 *
 * A random install id, the app version, the OS and architecture, the locale and timezone, how long
 * a session lasted, which features are switched on, and which broadcasts were shown. No file paths,
 * no usernames, no machine name, no window titles, no IP retained by us — nothing that identifies a
 * person rather than an install. Switching it off in the menu stops all of it.
 *
 * ---------------------------------------------------------------------------------------
 * Failure is invisible, always
 * ---------------------------------------------------------------------------------------
 *
 * Same contract as the broadcast poller: one log line, nothing user-visible, never a throw. An
 * analytics feature that can degrade the pet is strictly worse than no analytics feature — it would
 * be trading the thing users have for a number we want.
 *
 * ---------------------------------------------------------------------------------------
 * The timer
 * ---------------------------------------------------------------------------------------
 *
 * Copied deliberately from `broadcast/broadcast-poller.ts`: re-armed after the work finishes rather
 * than on a fixed interval (so a slow send cannot overlap the next), jittered ±20% (so a fleet does
 * not synchronise), `unref`'d (so a pending timer cannot hold the process open at quit), and driven
 * by injected `now`/`random` so tests are deterministic.
 */

import { ANALYTICS } from '../config/constants.js'
import { postCapped, type FetchDeps } from '../broadcast/http-capped.js'
import { buildBatch, type AnalyticsContext } from './analytics-client.js'
import { EventQueue } from './event-queue.js'

export interface AnalyticsDeps extends FetchDeps {
  endpoint: string
  dir: string
  context: AnalyticsContext
  /** Live read, so switching the menu item off takes effect on the next capture, not the next launch. */
  isEnabled: () => boolean
  /** Manifest override in minutes; `0` disables analytics fleet-wide. Null means "use the built-in". */
  getIntervalMinutes?: () => number | null
  /** Session-scoped facts folded into every heartbeat. */
  getHeartbeatProperties?: () => Record<string, unknown>
  allowLoopbackHttp?: boolean
  userAgent?: string
  now?: () => number
  random?: () => number
  log?: (message: string, meta?: unknown) => void
}

export interface AnalyticsService {
  /**
   * Set the install id once it has been minted and durably written.
   *
   * The service is constructed before first launch has written an id, and the id is the
   * `distinct_id` every event is attributed to — so it is set here rather than fixed at
   * construction, and nothing is captured until it has been.
   */
  setInstallId(installId: string): void
  start(): Promise<void>
  /** Record an event. Resolves once it is durably queued, not once it is sent. */
  capture(event: string, properties?: Record<string, unknown>): Promise<void>
  /** Send whatever is queued, best-effort. */
  flush(): Promise<void>
  stop(): void
  /** Test seam: how many events are waiting. */
  pending(): number
}

/**
 * Resolve the heartbeat interval.
 *
 * `0` from the manifest is the fleet-wide kill switch and is passed through as 0 rather than clamped
 * — the caller checks for it. Anything else is clamped into a sane band, because a manifest is a
 * remote file and a typo in it should not mean an event every second or one a year.
 */
export function resolveIntervalMinutes(fromManifest: number | null): number {
  if (fromManifest === null) return ANALYTICS.heartbeatMinutes
  if (fromManifest === 0) return 0
  return Math.min(ANALYTICS.maxMinutes, Math.max(ANALYTICS.minMinutes, fromManifest))
}

export function nextDelayMs(baseMs: number, random: () => number): number {
  const spread = 1 - ANALYTICS.jitter + random() * ANALYTICS.jitter * 2
  return Math.round(baseMs * spread)
}

export function createAnalytics(deps: AnalyticsDeps): AnalyticsService {
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const log = deps.log ?? (() => {})
  const queue = new EventQueue({ dir: deps.dir, now, log })
  let context = deps.context

  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let inFlight: Promise<void> | null = null

  const intervalMinutes = (): number =>
    resolveIntervalMinutes(deps.getIntervalMinutes?.() ?? null)

  function scheduleNext(): void {
    if (stopped) return
    const minutes = intervalMinutes()
    // 0 is the fleet-wide off switch: stop scheduling entirely rather than spinning on a zero delay.
    if (minutes === 0) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void tick()
    }, nextDelayMs(minutes * 60_000, random))
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  async function tick(): Promise<void> {
    try {
      await capture('app_heartbeat', deps.getHeartbeatProperties?.() ?? {})
      await flush()
    } finally {
      if (!stopped) scheduleNext()
    }
  }

  async function capture(
    event: string,
    properties: Record<string, unknown> = {},
  ): Promise<void> {
    if (!deps.isEnabled()) return
    if (intervalMinutes() === 0) return
    try {
      await queue.append({ event, at: now(), properties })
    } catch (error) {
      log('analytics: could not queue event', { event, error: String(error) })
    }
  }

  /**
   * Send queued events oldest-first, dropping only what the server accepted.
   *
   * Concurrent calls share the in-flight promise — the heartbeat and a quit can otherwise race, and
   * two senders draining the same queue would double-report.
   */
  /**
   * Deliberately **not** gated on `isEnabled`. Capture is the gate; this is only delivery, and
   * everything in the queue was captured while analytics were on.
   *
   * The gate has to be absent for the opt-out event to work at all: that event is captured, then the
   * flag flips, then this runs — so a check here would strand the one event that measures opt-outs
   * in a queue that is never drained again. `start()` checks the flag instead, which keeps a
   * leftover backlog from being sent by an install that has since opted out.
   */
  async function flush(): Promise<void> {
    if (inFlight) return inFlight

    // The bookkeeping is out here, and deliberately so. Clearing `inFlight` inside the async
    // function's own `finally` looks equivalent and is not: with an empty queue there is no `await`
    // on the path, so the body runs to completion *synchronously*, its `finally` sets `inFlight` to
    // null, and only then does the assignment below overwrite it with a settled promise. `inFlight`
    // is then permanently non-null and every later flush returns immediately — analytics silently
    // stop after the first launch. A `.finally` callback is always a microtask, so it cannot run
    // before the assignment; the identity check keeps a later flush from being cleared by an
    // earlier one.
    const run = sendAll()
    inFlight = run
    void run.finally(() => {
      if (inFlight === run) inFlight = null
    })
    return run
  }

  async function sendAll(): Promise<void> {
    {
      try {
        for (;;) {
          const batch = queue.peek(ANALYTICS.batchMax)
          if (batch.length === 0) return

          const result = await postCapped(
            deps.endpoint,
            {
              body: buildBatch(batch, context),
              timeoutMs: 6_000,
              maxBytes: ANALYTICS.responseMaxBytes,
              allowLoopbackHttp: deps.allowLoopbackHttp ?? false,
              ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
            },
            { fetch: deps.fetch },
          )

          if (result.kind !== 'ok') {
            // Keep the batch and try again next tick — that is the whole point of the queue. A 4xx
            // would retry forever, so it is dropped: a batch the server refuses once it will refuse
            // again, and an unsendable event blocking every later one is worse than losing it.
            if (result.kind === 'error' && result.reason === 'status') {
              const status = result.status ?? 0
              if (status >= 400 && status < 500) {
                log('analytics: batch refused, dropping', { status, count: batch.length })
                await queue.drop(batch.length)
                continue
              }
            }
            log('analytics: send failed', {
              reason: result.kind === 'error' ? result.reason : result.kind,
              queued: queue.size(),
            })
            return
          }

          await queue.drop(batch.length)
        }
      } catch (error) {
        log('analytics: send threw', { error: String(error) })
      }
    }
  }

  return {
    setInstallId(installId: string): void {
      context = { ...context, installId }
    },
    async start(): Promise<void> {
      stopped = false
      await queue.load()
      // Send anything stranded by the last session before arming the timer, so a backlog is not
      // held hostage by an install that is only ever open for ten minutes at a time.
      //
      // Gated on the flag here — and only here — so an install that opted out last session does not
      // quietly deliver the backlog it had already queued.
      if (deps.isEnabled()) await flush()
      scheduleNext()
    },
    capture,
    flush,
    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    pending: () => queue.size(),
  }
}
