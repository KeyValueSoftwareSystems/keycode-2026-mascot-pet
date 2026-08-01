/**
 * Callout arbitration. Pure: `(state, now) -> { showing, nextState, wakeAt }`.
 *
 * Reminders, broadcasts and update notices will collide, so something has to decide which one the
 * pet says and which ones wait. This is ported from openpets' bubble arbiter with two deliberate
 * corrections and one structural change.
 *
 * **Structural change: no internal timers.** openpets' arbiter owns `setTimeout` handles, which
 * makes it untestable as a unit and impossible to reason about at a given instant. Here `tick`
 * returns a `wakeAt`, and the host keeps exactly one timer. The arbiter becomes a function of
 * (state, now), so every ordering rule below is directly testable.
 *
 * **Correction 1: overflow eviction.** openpets does `queue.shift()` on a queue it keeps sorted
 * rank-descending — which evicts the *highest*-priority pending entry, the opposite of what any
 * caller would expect, and the opposite of what docs/PROMPT.md §4.4 specifies ("drops oldest `low`
 * first"). Ours evicts the `(rank, seq)` minimum: lowest priority, earliest enqueued. If the
 * incoming entry is itself that minimum, it is rejected rather than churning the queue.
 *
 * **Correction 2: coalescing key.** openpets compares against the queue *tail*, but in a rank-sorted
 * queue the tail is whatever happens to sort last — semantically arbitrary. Ours compares against
 * the most recently enqueued entry by `seq`, which is what "back-to-back" actually means.
 */

import { CALLOUT_DEFAULT_MS, CALLOUT_QUEUE_MAX } from '../config/constants.js'
import type { Tone } from '../pet-frame.js'
import type { AnimationState } from '../pet-animations.generated.js'

export type Priority = 'low' | 'normal' | 'high' | 'urgent'

export const RANK: Readonly<Record<Priority, 0 | 1 | 2 | 3>> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
}

export type CalloutSource = 'reminder' | 'broadcast' | 'update' | 'system'

export interface CalloutRequest {
  sourceId: CalloutSource
  /** Already sanitised and clamped by the caller. */
  text: string
  tone: Tone
  priority: Priority
  durationMs?: number
  /** Sticky entries are not displaced by higher priority and do not auto-expire without a duration. */
  sticky?: boolean
  /** Take the pinned slot instead of the transient one. */
  pin?: boolean
  animation?: AnimationState
  /** Opaque handle; main resolves it to a validated URL. The renderer never sees a URL. */
  urlKey?: string
}

export interface ActiveCallout extends CalloutRequest {
  seq: number
  startedAt: number
  /** `Infinity` for a sticky entry with no duration. */
  expiresAt: number
}

export interface ArbiterState {
  current: ActiveCallout | null
  pinned: ActiveCallout | null
  /** Sorted rank-descending, stable by seq within a rank. */
  queue: ActiveCallout[]
  nextSeq: number
  /** Observability: entries discarded by coalescing, overflow or rejection. */
  dropped: number
}

export function initArbiter(): ArbiterState {
  return { current: null, pinned: null, queue: [], nextSeq: 1, dropped: 0 }
}

function expiryFor(request: CalloutRequest, now: number): number {
  if (request.durationMs !== undefined) return now + request.durationMs
  // Sticky with no duration means "until something replaces it".
  if (request.sticky) return Number.POSITIVE_INFINITY
  return now + CALLOUT_DEFAULT_MS
}

/** Rank-descending, then seq-ascending so equal ranks stay first-in-first-out. */
function sortQueue(queue: ActiveCallout[]): ActiveCallout[] {
  return [...queue].sort((a, b) => RANK[b.priority] - RANK[a.priority] || a.seq - b.seq)
}

/** The entry the overflow policy should drop: lowest rank, earliest enqueued. */
function evictionCandidate(queue: readonly ActiveCallout[]): ActiveCallout | null {
  let candidate: ActiveCallout | null = null
  for (const entry of queue) {
    if (
      candidate === null ||
      RANK[entry.priority] < RANK[candidate.priority] ||
      (RANK[entry.priority] === RANK[candidate.priority] && entry.seq < candidate.seq)
    ) {
      candidate = entry
    }
  }
  return candidate
}

/** Most recently enqueued entry, for coalescing. */
function newestEnqueued(state: ArbiterState): ActiveCallout | null {
  let newest: ActiveCallout | null = null
  for (const entry of state.queue) {
    if (newest === null || entry.seq > newest.seq) newest = entry
  }
  return newest ?? state.current
}

export function submit(state: ArbiterState, request: CalloutRequest, now: number): ArbiterState {
  const entry: ActiveCallout = {
    ...request,
    seq: state.nextSeq,
    startedAt: now,
    expiresAt: expiryFor(request, now),
  }
  const base: ArbiterState = { ...state, nextSeq: state.nextSeq + 1 }

  if (request.pin) return takePinnedSlot(base, entry)

  // Coalesce identical back-to-back text from the same source. Two reminders firing in the same
  // evaluation, or a manifest re-announcing the same line, should not queue a duplicate.
  const newest = newestEnqueued(base)
  if (newest && newest.sourceId === entry.sourceId && newest.text === entry.text) {
    return { ...base, dropped: base.dropped + 1 }
  }

  if (base.current === null) {
    return { ...base, current: entry }
  }

  const interruptible = !(base.current.sticky === true || base.current.priority === 'urgent')
  if (RANK[entry.priority] > RANK[base.current.priority] && interruptible) {
    // Displace: the incoming entry shows now and the displaced one is discarded rather than
    // requeued, matching openpets. Requeuing would replay a message the user already saw start.
    return { ...base, current: entry, dropped: base.dropped + 1 }
  }

  let queue = [...base.queue, entry]
  let dropped = base.dropped

  if (queue.length > CALLOUT_QUEUE_MAX) {
    const victim = evictionCandidate(queue)
    if (victim && victim.seq === entry.seq) {
      // The newcomer is itself the lowest-value entry. Reject it instead of churning the queue.
      return { ...base, dropped: dropped + 1 }
    }
    if (victim) {
      queue = queue.filter((candidate) => candidate.seq !== victim.seq)
      dropped += 1
    }
  }

  return { ...base, queue: sortQueue(queue), dropped }
}

/** A pin replaces an existing pin only at equal or higher rank; a lower-rank pin is rejected. */
function takePinnedSlot(state: ArbiterState, entry: ActiveCallout): ArbiterState {
  if (state.pinned && RANK[entry.priority] < RANK[state.pinned.priority]) {
    return { ...state, dropped: state.dropped + 1 }
  }
  return {
    ...state,
    pinned: entry,
    dropped: state.dropped + (state.pinned ? 1 : 0),
  }
}

export interface TickResult {
  state: ArbiterState
  /** What the pet should be saying. The pinned slot wins the frame's single bubble. */
  showing: ActiveCallout | null
  /** When to call `tick` again, or null if nothing is pending. The host owns the only timer. */
  wakeAt: number | null
}

/**
 * Advance to `now`: expire what is due, promote from the queue, and report the next wake.
 *
 * Idempotent — calling twice at the same `now` yields the same state, so a host that both schedules
 * a wake and pumps on submit cannot double-advance.
 */
export function tick(state: ArbiterState, now: number): TickResult {
  let current = state.current
  let pinned = state.pinned
  let queue = state.queue

  if (pinned && now >= pinned.expiresAt) pinned = null

  if (current && now >= current.expiresAt) current = null

  if (current === null && queue.length > 0) {
    const [next, ...rest] = sortQueue(queue)
    current = next ?? null
    queue = rest
    // Re-base the expiry: a queued entry's duration should start when it is *shown*, not when it was
    // submitted, or a long wait would consume the whole time it was meant to be visible.
    if (current) {
      current = { ...current, startedAt: now, expiresAt: expiryFor(current, now) }
    }
  }

  const nextState: ArbiterState = { ...state, current, pinned, queue }

  const expiries = [current?.expiresAt, pinned?.expiresAt].filter(
    (value): value is number => value !== undefined && Number.isFinite(value),
  )

  return {
    state: nextState,
    showing: pinned ?? current,
    wakeAt: expiries.length === 0 ? null : Math.min(...expiries),
  }
}

/** Drop everything. Used on quit and when the pet is hidden. */
/**
 * Dismiss whatever is on screen, letting the queue advance.
 *
 * The showing entry is `pinned ?? current`, matching `tick`, so this clears the one the person is
 * actually looking at rather than whichever slot happens to be occupied.
 *
 * Pure and idempotent: dismissing with nothing showing returns the same state, so a stray click after
 * the bubble has gone cannot eat the next message.
 */
export function dismissShowing(state: ArbiterState): ArbiterState {
  if (state.pinned) return { ...state, pinned: null }
  if (state.current) return { ...state, current: null }
  return state
}

export function clearAll(state: ArbiterState): ArbiterState {
  return { ...state, current: null, pinned: null, queue: [] }
}
