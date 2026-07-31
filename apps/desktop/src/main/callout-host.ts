/**
 * The callout shell: owns the single timer the pure arbiter deliberately does not.
 *
 * Also the only place a callout URL exists. The renderer gets `clickable: true` and can ask to open
 * "the current callout's link"; main looks up the URL it already validated. A renderer that cannot
 * name a URL cannot be talked into opening a bad one.
 */

import {
  initArbiter,
  submit,
  tick,
  clearAll,
  type ActiveCallout,
  type ArbiterState,
  type CalloutRequest,
} from '../callouts/callout-arbiter.js'
import { sanitizeBubbleText } from '../callouts/sanitize-text.js'
import { CALLOUT_TEXT_MAX } from '../config/constants.js'
import type { AnimationState } from '../pet-animations.generated.js'

export interface CalloutHost {
  /** Submit a callout. Text is sanitised here so no caller can forget. */
  show(request: CalloutRequest & { url?: string | null }): void
  /** The URL behind the callout currently showing, if any. */
  currentUrl(): string | null
  /** What the pet is saying right now. */
  showing(): ActiveCallout | null
  clear(): void
  dispose(): void
}

export interface CalloutHostOptions {
  /** Called whenever the visible callout changes. */
  onShowingChanged: (showing: ActiveCallout | null) => void
  /** Called when a callout asks for an animation. */
  onAnimation: (animation: AnimationState) => void
  /** Corner-toast fallback, for urgent messages or when the pet is not visible. */
  onToast?: (request: CalloutRequest) => void
  /** Whether the pet is currently on screen; drives the toast fallback. */
  isPetVisible?: () => boolean
  now?: () => number
  log?: (message: string, meta?: unknown) => void
}

export function createCalloutHost(options: CalloutHostOptions): CalloutHost {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})

  let state: ArbiterState = initArbiter()
  let timer: NodeJS.Timeout | null = null
  /** seq -> url. Kept out of the arbiter so its state stays plain data. */
  const urls = new Map<number, string>()
  let lastShowingSeq: number | null = null

  const reschedule = (wakeAt: number | null): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (wakeAt === null) return
    // At least a few ms: a zero-delay timer here would busy-loop if an entry expired exactly now.
    timer = setTimeout(pump, Math.max(8, wakeAt - now()))
    timer.unref?.()
  }

  function pump(): void {
    const result = tick(state, now())
    state = result.state

    // Forget URLs for callouts that are no longer reachable, so the map cannot grow unbounded.
    const live = new Set(
      [result.showing?.seq, state.current?.seq, state.pinned?.seq, ...state.queue.map((q) => q.seq)]
        .filter((seq): seq is number => seq !== undefined),
    )
    for (const seq of [...urls.keys()]) if (!live.has(seq)) urls.delete(seq)

    const seq = result.showing?.seq ?? null
    if (seq !== lastShowingSeq) {
      lastShowingSeq = seq
      options.onShowingChanged(result.showing)
      if (result.showing?.animation) options.onAnimation(result.showing.animation)
    }

    reschedule(result.wakeAt)
  }

  return {
    show(request): void {
      const text = sanitizeBubbleText(request.text, CALLOUT_TEXT_MAX)
      if (text.length === 0) {
        // Everything was control characters or whitespace. Showing an empty bubble would look broken.
        log('callout dropped: empty after sanitising', { sourceId: request.sourceId })
        return
      }

      const petVisible = options.isPetVisible?.() ?? true
      // The toast exists for the cases the bubble cannot serve: the pet is hidden, or the message is
      // urgent enough that it should survive the pet being somewhere the user is not looking.
      if (options.onToast && (!petVisible || request.priority === 'urgent')) {
        options.onToast({ ...request, text })
      }

      if (!petVisible) return

      const entry: CalloutRequest = { ...request, text }
      const before = state.nextSeq
      state = submit(state, entry, now())

      if (request.url) {
        // Only remember the URL if the entry actually took a slot or a queue place.
        const stored = [state.current, state.pinned, ...state.queue].find((c) => c?.seq === before)
        if (stored) urls.set(before, request.url)
      }

      pump()
    },

    currentUrl(): string | null {
      const seq = state.pinned?.seq ?? state.current?.seq
      return seq === undefined ? null : urls.get(seq) ?? null
    },

    showing(): ActiveCallout | null {
      return state.pinned ?? state.current
    },

    clear(): void {
      state = clearAll(state)
      urls.clear()
      lastShowingSeq = null
      options.onShowingChanged(null)
      reschedule(null)
    },

    dispose(): void {
      if (timer) clearTimeout(timer)
      timer = null
      urls.clear()
    },
  }
}
