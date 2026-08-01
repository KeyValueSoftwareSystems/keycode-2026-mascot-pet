import { describe, it, expect, vi } from 'vitest'
import {
  initArbiter,
  submit,
  tick,
  clearAll,
  RANK,
  type ArbiterState,
  type CalloutRequest,
  dismissShowing,
} from '../../apps/desktop/src/callouts/callout-arbiter.js'
import {
  sanitizeBubbleText,
  sanitizeBubbleTextDetailed,
} from '../../apps/desktop/src/callouts/sanitize-text.js'
import {
  layoutToasts,
  clampToastDuration,
  hasToastCapacity,
} from '../../apps/desktop/src/main/toast-layout.js'
import {
  CALLOUT_DEFAULT_MS,
  CALLOUT_QUEUE_MAX,
  CALLOUT_TEXT_MAX,
  TOAST,
} from '../../apps/desktop/src/config/constants.js'

function request(overrides: Partial<CalloutRequest> = {}): CalloutRequest {
  return {
    sourceId: 'reminder',
    text: 'hello',
    tone: 'info',
    priority: 'normal',
    ...overrides,
  }
}

/** Submit then pump, which is what the host does. */
function show(state: ArbiterState, req: CalloutRequest, now: number): ArbiterState {
  return tick(submit(state, req, now), now).state
}

describe('callout arbiter', () => {
  it('shows the first callout immediately', () => {
    const result = tick(submit(initArbiter(), request({ text: 'first' }), 1_000), 1_000)
    expect(result.showing?.text).toBe('first')
    expect(result.wakeAt).toBe(1_000 + CALLOUT_DEFAULT_MS)
  })

  it('creates no timers of its own', () => {
    // The structural difference from openpets: the arbiter is a function of (state, now), so every
    // ordering rule below is directly testable. The host owns the single timer.
    vi.useFakeTimers()
    try {
      let state = initArbiter()
      state = show(state, request(), 0)
      state = show(state, request({ text: 'second' }), 10)
      tick(state, 20)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is idempotent at a given now', () => {
    // A host that both schedules a wake and pumps on submit must not double-advance.
    const state = show(initArbiter(), request(), 500)
    const once = tick(state, 600)
    const twice = tick(once.state, 600)
    expect(twice.state).toEqual(once.state)
    expect(twice.showing).toEqual(once.showing)
  })

  it('coalesces identical back-to-back text from one source', () => {
    let state = show(initArbiter(), request({ text: 'drink water' }), 0)
    state = submit(state, request({ text: 'drink water' }), 10)
    expect(state.queue).toHaveLength(0)
    expect(state.dropped).toBe(1)
  })

  it('does not coalesce identical text from a different source', () => {
    // A reminder and a broadcast that happen to say the same thing are two separate events.
    let state = show(initArbiter(), request({ sourceId: 'reminder', text: 'same' }), 0)
    state = submit(state, request({ sourceId: 'broadcast', text: 'same' }), 10)
    expect(state.queue).toHaveLength(1)
  })

  it('coalesces against the most recently enqueued entry, not the sort tail', () => {
    // openpets compares against the queue tail, but in a rank-sorted queue the tail is whatever
    // sorts last — semantically arbitrary. "Back-to-back" means newest by seq.
    // The showing entry is urgent so nothing displaces it and every submission reaches the queue —
    // otherwise the high-priority entry would take the slot instead and there would be no queue to
    // reason about.
    let state = show(initArbiter(), request({ priority: 'urgent', text: 'showing' }), 0)
    state = submit(state, request({ priority: 'low', text: 'low one' }), 10)
    state = submit(state, request({ priority: 'high', text: 'high one' }), 20)
    // 'high one' sorts first, 'low one' sorts last. Re-submitting the newest (high) must coalesce.
    const after = submit(state, request({ priority: 'high', text: 'high one' }), 30)
    expect(after.dropped).toBe(state.dropped + 1)
  })

  it('lets urgent displace a showing normal immediately', () => {
    let state = show(initArbiter(), request({ text: 'normal' }), 0)
    state = submit(state, request({ priority: 'urgent', text: 'urgent' }), 10)
    expect(state.current?.text).toBe('urgent')
    // Displaced, not requeued: replaying a message the user already saw start would be worse.
    expect(state.queue).toHaveLength(0)
  })

  it('does not displace a sticky callout', () => {
    let state = show(initArbiter(), request({ text: 'sticky', sticky: true }), 0)
    state = submit(state, request({ priority: 'urgent', text: 'urgent' }), 10)
    expect(state.current?.text).toBe('sticky')
    expect(state.queue).toHaveLength(1)
  })

  it('does not displace a showing urgent, even with another urgent', () => {
    let state = show(initArbiter(), request({ priority: 'urgent', text: 'first' }), 0)
    state = submit(state, request({ priority: 'urgent', text: 'second' }), 10)
    expect(state.current?.text).toBe('first')
    expect(state.queue).toHaveLength(1)
  })

  it('queues equal rank rather than displacing', () => {
    let state = show(initArbiter(), request({ text: 'first' }), 0)
    state = submit(state, request({ text: 'second' }), 10)
    expect(state.current?.text).toBe('first')
    expect(state.queue.map((entry) => entry.text)).toEqual(['second'])
  })

  it('sorts the queue rank-descending and keeps equal ranks FIFO', () => {
    let state = show(initArbiter(), request({ priority: 'urgent', text: 'showing' }), 0)
    state = submit(state, request({ priority: 'low', text: 'a-low' }), 10)
    state = submit(state, request({ priority: 'high', text: 'b-high' }), 20)
    state = submit(state, request({ priority: 'normal', text: 'c-normal' }), 30)
    state = submit(state, request({ priority: 'high', text: 'd-high' }), 40)
    expect(state.queue.map((entry) => entry.text)).toEqual(['b-high', 'd-high', 'c-normal', 'a-low'])
  })

  it('evicts the oldest lowest-rank entry on overflow, not the queue head', () => {
    // openpets does queue.shift() on a rank-descending queue, which evicts the HIGHEST priority
    // pending entry — the opposite of what the spec asks for and of what any caller would expect.
    let state = show(initArbiter(), request({ priority: 'urgent', text: 'showing' }), 0)

    state = submit(state, request({ priority: 'low', text: 'oldest-low' }), 1)
    state = submit(state, request({ priority: 'low', text: 'newer-low' }), 2)
    for (let i = 0; i < CALLOUT_QUEUE_MAX - 1; i += 1) {
      state = submit(state, request({ priority: 'high', text: `high-${i}` }), 10 + i)
    }

    expect(state.queue).toHaveLength(CALLOUT_QUEUE_MAX)
    const texts = state.queue.map((entry) => entry.text)
    expect(texts).not.toContain('oldest-low')
    expect(texts).toContain('newer-low')
    // The high-priority entries all survived, which is the whole point.
    expect(texts.filter((t) => t.startsWith('high-'))).toHaveLength(CALLOUT_QUEUE_MAX - 1)
  })

  it('rejects an incoming entry that is itself the eviction candidate', () => {
    let state = show(initArbiter(), request({ priority: 'urgent', text: 'showing' }), 0)
    for (let i = 0; i < CALLOUT_QUEUE_MAX; i += 1) {
      state = submit(state, request({ priority: 'high', text: `high-${i}` }), 10 + i)
    }
    const before = state.queue.map((entry) => entry.text)
    const after = submit(state, request({ priority: 'low', text: 'hopeless' }), 999)
    // Rejected outright rather than churning the queue to make room for the least useful entry.
    expect(after.queue.map((entry) => entry.text)).toEqual(before)
    expect(after.dropped).toBe(state.dropped + 1)
  })

  it('expires a callout and promotes the next one', () => {
    let state = show(initArbiter(), request({ text: 'first', durationMs: 1_000 }), 0)
    state = submit(state, request({ text: 'second', durationMs: 1_000 }), 100)

    const before = tick(state, 500)
    expect(before.showing?.text).toBe('first')

    const after = tick(before.state, 1_000)
    expect(after.showing?.text).toBe('second')
  })

  it('re-bases a queued entry’s duration to when it is shown', () => {
    // Otherwise a long wait consumes the time the message was meant to be visible for.
    let state = show(initArbiter(), request({ text: 'first', durationMs: 1_000 }), 0)
    state = submit(state, request({ text: 'second', durationMs: 5_000 }), 0)
    const promoted = tick(state, 1_000)
    expect(promoted.showing?.text).toBe('second')
    expect(promoted.showing?.expiresAt).toBe(1_000 + 5_000)
  })

  it('never expires a sticky callout without a duration', () => {
    const state = show(initArbiter(), request({ text: 'forever', sticky: true }), 0)
    const later = tick(state, 10_000_000)
    expect(later.showing?.text).toBe('forever')
    expect(later.wakeAt).toBeNull()
  })

  it('reports the earliest expiry as the wake time', () => {
    let state = show(initArbiter(), request({ text: 'transient', durationMs: 3_000 }), 0)
    state = submit(state, request({ text: 'pinned', pin: true, durationMs: 1_500 }), 0)
    const result = tick(state, 0)
    expect(result.wakeAt).toBe(1_500)
  })
})

describe('pinned slot', () => {
  it('prefers the pinned callout for the single visible bubble', () => {
    let state = show(initArbiter(), request({ text: 'transient' }), 0)
    state = submit(state, request({ text: 'pinned', pin: true, sticky: true }), 10)
    const result = tick(state, 10)
    expect(result.showing?.text).toBe('pinned')
    // The transient one is still there underneath, not discarded.
    expect(result.state.current?.text).toBe('transient')
  })

  it('replaces an existing pin at equal or higher rank', () => {
    let state = submit(initArbiter(), request({ text: 'first', pin: true, priority: 'normal' }), 0)
    state = submit(state, request({ text: 'equal', pin: true, priority: 'normal' }), 10)
    expect(state.pinned?.text).toBe('equal')
    state = submit(state, request({ text: 'higher', pin: true, priority: 'high' }), 20)
    expect(state.pinned?.text).toBe('higher')
  })

  it('rejects a lower-rank pin outright', () => {
    let state = submit(initArbiter(), request({ text: 'high', pin: true, priority: 'high' }), 0)
    state = submit(state, request({ text: 'low', pin: true, priority: 'low' }), 10)
    expect(state.pinned?.text).toBe('high')
    expect(state.dropped).toBe(1)
  })
})

describe('clearAll', () => {
  it('drops everything', () => {
    let state = show(initArbiter(), request({ text: 'a' }), 0)
    state = submit(state, request({ text: 'b', pin: true }), 0)
    state = submit(state, request({ text: 'c' }), 0)
    const cleared = clearAll(state)
    expect(cleared.current).toBeNull()
    expect(cleared.pinned).toBeNull()
    expect(cleared.queue).toEqual([])
  })
})

describe('rank table', () => {
  it('orders low < normal < high < urgent', () => {
    expect(RANK.low).toBeLessThan(RANK.normal)
    expect(RANK.normal).toBeLessThan(RANK.high)
    expect(RANK.high).toBeLessThan(RANK.urgent)
  })
})

// ---------------------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------------------

describe('bubble text sanitising', () => {
  it('leaves ordinary text alone', () => {
    expect(sanitizeBubbleText('Keycode is on fire')).toBe('Keycode is on fire')
  })

  it('strips a right-to-left override', () => {
    // The residual spoofing surface once XSS is closed: these characters are inert but reorder
    // everything after them, so the *visible* text can differ from what the manifest says.
    const result = sanitizeBubbleTextDetailed('safe‮gnorw si siht')
    expect(result.text).not.toContain('‮')
    expect(result.strippedControls).toBe(true)
  })

  it('strips bidi isolates as well as overrides', () => {
    for (const ch of ['‪', '‫', '‬', '‭', '⁦', '⁧', '⁨', '⁩']) {
      expect(sanitizeBubbleText(`a${ch}b`)).toBe('ab')
    }
  })

  it('strips line and paragraph separators', () => {
    expect(sanitizeBubbleText('a b c')).toBe('abc')
  })

  it('strips C0 and C1 controls', () => {
    expect(sanitizeBubbleText('a bcd')).toBe('abcd')
  })

  it('strips zero-width spaces and the BOM', () => {
    expect(sanitizeBubbleText('a​b‌c﻿d')).toBe('abcd')
  })

  it('KEEPS the zero-width joiner and variation selector, which emoji need', () => {
    // Stripping these breaks 👩‍💻 into separate glyphs and drops the colour from ❤️ — and emoji are
    // the entire reason the font bundle exists.
    const zwj = '👩‍💻'
    const vs16 = '❤️'
    expect(sanitizeBubbleText(zwj)).toBe(zwj)
    expect(sanitizeBubbleText(vs16)).toBe(vs16)
  })

  it('collapses newlines and whitespace runs to single spaces', () => {
    expect(sanitizeBubbleText('one\n\ntwo   \t three')).toBe('one two three')
  })

  it('trims', () => {
    expect(sanitizeBubbleText('   padded   ')).toBe('padded')
  })

  it('truncates at the cap, including the ellipsis', () => {
    const long = 'x'.repeat(CALLOUT_TEXT_MAX + 50)
    const result = sanitizeBubbleTextDetailed(long)
    expect(result.truncated).toBe(true)
    // Never longer than the cap the PetFrame schema promises.
    expect(result.text.length).toBeLessThanOrEqual(CALLOUT_TEXT_MAX)
    expect(result.text.endsWith('…')).toBe(true)
  })

  it('is idempotent', () => {
    const once = sanitizeBubbleText('  a‮b\n\nc  ')
    expect(sanitizeBubbleText(once)).toBe(once)
  })

  it('renders HTML as literal characters rather than markup', () => {
    // The XSS case. Sanitising deliberately does NOT escape or strip this: the renderer uses
    // textContent, so angle brackets are just characters. Asserting the string survives intact
    // proves nothing is being half-escaped into something a future innerHTML would execute.
    const payload = '<img src=x onerror=alert(1)>'
    expect(sanitizeBubbleText(payload)).toBe(payload)
  })

  it('returns empty for input that was entirely control characters', () => {
    expect(sanitizeBubbleText(' ‮​')).toBe('')
  })
})

// ---------------------------------------------------------------------------------------
// Toast layout
// ---------------------------------------------------------------------------------------

const workArea = { x: 0, y: 33, width: 1_512, height: 907 }

describe('toast layout', () => {
  it('stacks upward from the bottom-right of the work area', () => {
    const bounds = layoutToasts(3, workArea)
    const x = workArea.x + workArea.width - TOAST.width - TOAST.margin
    expect(bounds.map((b) => b.x)).toEqual([x, x, x])

    const bottom = workArea.y + workArea.height - TOAST.height - TOAST.margin
    expect(bounds[0]!.y).toBe(bottom)
    expect(bounds[1]!.y).toBe(bottom - (TOAST.height + TOAST.gap))
    expect(bounds[2]!.y).toBe(bottom - 2 * (TOAST.height + TOAST.gap))
  })

  it('anchors to the work area so a toast never slides under the Dock', () => {
    const bounds = layoutToasts(1, workArea)
    expect(bounds[0]!.y + bounds[0]!.height).toBeLessThanOrEqual(workArea.y + workArea.height)
  })

  it('leaves no gap after a middle toast is destroyed', () => {
    // openpets increments a slot counter it never compacts, so destroying a middle toast leaves the
    // ones above it at their original offsets and a visible hole behind. Recomputing from the
    // current count makes the hole impossible rather than merely unlikely.
    const three = layoutToasts(3, workArea)
    const twoAfterRemoval = layoutToasts(2, workArea)
    expect(twoAfterRemoval[0]!.y).toBe(three[0]!.y)
    expect(twoAfterRemoval[1]!.y).toBe(three[1]!.y)
    // Contiguous: no slot skipped.
    expect(twoAfterRemoval[0]!.y - twoAfterRemoval[1]!.y).toBe(TOAST.height + TOAST.gap)
  })

  it('respects a secondary display that is not at the origin', () => {
    const bounds = layoutToasts(1, { x: 1_512, y: 0, width: 1_920, height: 1_080 })
    expect(bounds[0]!.x).toBeGreaterThan(1_512)
    expect(bounds[0]!.y).toBe(1_080 - TOAST.height - TOAST.margin)
  })

  it('clamps durations into a serviceable range', () => {
    expect(clampToastDuration(undefined)).toBe(TOAST.defaultMs)
    expect(clampToastDuration(Number.NaN)).toBe(TOAST.defaultMs)
    expect(clampToastDuration(1)).toBe(TOAST.minMs)
    expect(clampToastDuration(999_999)).toBe(TOAST.maxMs)
    expect(clampToastDuration(5_000)).toBe(5_000)
  })

  it('caps concurrent toasts rather than stacking off-screen', () => {
    expect(hasToastCapacity(0)).toBe(true)
    expect(hasToastCapacity(TOAST.max - 1)).toBe(true)
    expect(hasToastCapacity(TOAST.max)).toBe(false)
  })
})

describe('sticky notifications and dismissal', () => {
  it('never expires a sticky entry on its own', () => {
    let state = submit(initArbiter(), { sourceId: 'broadcast', text: 'hi', sticky: true }, 0)
    // A year later, still showing. This is the whole point: it waits for a person.
    const later = tick(state, 365 * 24 * 60 * 60 * 1000)
    expect(later.showing?.text).toBe('hi')
    // And there is no wake-up to schedule, so the host holds no timer for it.
    expect(later.wakeAt).toBeNull()
  })

  it('an explicit duration still wins over stickiness', () => {
    // `durationMs` is the opt-out: set it and the message goes on its own.
    const state = submit(
      initArbiter(),
      { sourceId: 'broadcast', text: 'timed', sticky: true, durationMs: 5_000 },
      0,
    )
    expect(tick(state, 4_999).showing?.text).toBe('timed')
    expect(tick(state, 5_001).showing).toBeNull()
  })

  it('dismissShowing clears what is on screen and lets the queue advance', () => {
    let state = submit(initArbiter(), { sourceId: 'broadcast', text: 'first', sticky: true }, 0)
    state = submit(state, { sourceId: 'broadcast', text: 'second', sticky: true }, 1)
    expect(tick(state, 2).showing?.text).toBe('first')

    state = tick(state, 2).state
    state = dismissShowing(state)
    expect(tick(state, 3).showing?.text).toBe('second')
  })

  it('dismisses the pinned slot when one is showing, not the transient one underneath', () => {
    let state = submit(initArbiter(), { sourceId: 'a', text: 'transient', sticky: true }, 0)
    state = submit(state, { sourceId: 'b', text: 'pinned', sticky: true, pin: true }, 0)
    expect(tick(state, 1).showing?.text).toBe('pinned')

    state = dismissShowing(tick(state, 1).state)
    // The transient one is revealed rather than destroyed — dismissing what you can see should not
    // silently discard something you never saw.
    expect(tick(state, 2).showing?.text).toBe('transient')
  })

  it('is a no-op when nothing is showing, so a late click cannot eat the next message', () => {
    const empty = initArbiter()
    expect(dismissShowing(empty)).toEqual(empty)

    // Queued-but-not-yet-shown must survive a stray dismiss.
    let state = submit(empty, { sourceId: 'a', text: 'queued', sticky: true }, 0)
    state = tick(state, 1).state
    state = dismissShowing(state)
    state = dismissShowing(state)
    expect(tick(state, 2).showing).toBeNull()
  })
})
