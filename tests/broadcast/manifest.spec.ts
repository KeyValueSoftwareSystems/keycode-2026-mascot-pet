import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { safeUrl } from '../../apps/desktop/src/broadcast/url-guard.js'
import {
  parseManifest,
  parseNotification,
  selectDue,
  FALLBACK_ANIMATION,
  defaultsSchema,
} from '../../apps/desktop/src/broadcast/manifest-schema.js'
import {
  createPoller,
  nextDelayMs,
  resolveManifestUrl,
  resolvePollMinutes,
} from '../../apps/desktop/src/broadcast/broadcast-poller.js'
import type { CappedFetch } from '../../apps/desktop/src/broadcast/http-capped.js'
import {
  BROADCAST_DURATION_MS,
  CALLOUT_TEXT_MAX,
  MANIFEST_MAX_NOTIFICATIONS,
  MANIFEST_MAX_PER_POLL,
  POLL,
} from '../../apps/desktop/src/config/constants.js'

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'kickoff-2026',
    text: 'Keycode is on fire',
    startsAt: '2020-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    ...overrides,
  }
}

function manifest(notifications: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, notifications, ...extra })
}

describe('manifest envelope', () => {
  it('accepts a minimal valid manifest', () => {
    const parsed = parseManifest(manifest([entry()]))
    expect(parsed).not.toBeNull()
    expect(parsed!.notifications).toHaveLength(1)
    expect(parsed!.dropped).toEqual([])
  })

  it('rejects the whole envelope when version is not 1', () => {
    expect(parseManifest(JSON.stringify({ version: 2, notifications: [] }))).toBeNull()
  })

  it('rejects an unknown top-level field', () => {
    expect(parseManifest(JSON.stringify({ version: 1, notifications: [], surprise: true }))).toBeNull()
  })

  it('rejects unparseable JSON', () => {
    expect(parseManifest('{ not json')).toBeNull()
    expect(parseManifest('')).toBeNull()
  })

  it('accepts a manifest with no notifications', () => {
    const parsed = parseManifest(JSON.stringify({ version: 1 }))
    expect(parsed!.notifications).toEqual([])
  })

  it('drops ONE malformed entry and keeps its siblings', () => {
    // The gap the brief leaves open. With a naive `z.array(strictNotification)`, one typo'd field in
    // one announcement silences every announcement for every install — a global outage of the
    // headline feature caused by a typo.
    const parsed = parseManifest(
      manifest([
        entry({ id: 'good-1' }),
        entry({ id: 'bad-1', unknownField: true }),
        entry({ id: 'good-2' }),
      ]),
    )
    expect(parsed!.notifications.map((n) => n.id)).toEqual(['good-1', 'good-2'])
    expect(parsed!.dropped).toHaveLength(1)
    expect(parsed!.dropped[0]!.index).toBe(1)
  })

  it('drops a duplicate id within one manifest', () => {
    // Two entries with the same id would make "shown exactly once" ambiguous.
    const parsed = parseManifest(manifest([entry({ id: 'same' }), entry({ id: 'same' })]))
    expect(parsed!.notifications).toHaveLength(1)
    expect(parsed!.dropped[0]!.reason).toContain('duplicate id')
  })

  it('caps the number of entries it will consider', () => {
    const many = Array.from({ length: MANIFEST_MAX_NOTIFICATIONS + 20 }, (_, i) =>
      entry({ id: `n-${i}` }),
    )
    const parsed = parseManifest(manifest(many))
    expect(parsed!.notifications).toHaveLength(MANIFEST_MAX_NOTIFICATIONS)
  })

  it('parses the release block and validates its URL', () => {
    const parsed = parseManifest(
      manifest([], {
        release: { latestVersion: '0.9.0', notesUrl: 'https://example.com/notes', mandatory: true },
      }),
    )
    expect(parsed!.release).toEqual({
      latestVersion: '0.9.0',
      notesUrl: 'https://example.com/notes',
      mandatory: true,
    })
  })

  it('nulls a release notesUrl that is not https', () => {
    const parsed = parseManifest(
      manifest([], { release: { latestVersion: '1.0.0', notesUrl: 'file:///etc/passwd' } }),
    )
    expect(parsed!.release?.notesUrl).toBeNull()
  })
})

describe('notification entries', () => {
  it('rejects an id outside the permitted charset', () => {
    for (const id of ['has space', 'has/slash', 'has:colon', 'emoji🔥', '']) {
      expect(parseNotification(entry({ id }))).toHaveProperty('error')
    }
  })

  it('rejects an id over 128 characters', () => {
    expect(parseNotification(entry({ id: 'a'.repeat(129) }))).toHaveProperty('error')
  })

  it('clamps durationMs into the permitted range', () => {
    const short = parseNotification(entry({ durationMs: 10 }))
    const long = parseNotification(entry({ durationMs: 9_999_999 }))
    expect(short).toMatchObject({ durationMs: BROADCAST_DURATION_MS.min })
    expect(long).toMatchObject({ durationMs: BROADCAST_DURATION_MS.max })
  })

  it('falls back to a default duration for a non-finite value', () => {
    const result = parseNotification(entry({ durationMs: 'soon' }))
    // A wrong *type* is a schema violation, so the entry is dropped rather than defaulted.
    expect(result).toHaveProperty('error')
  })

  it('falls back to a known animation for an unknown name', () => {
    // The message still matters even if whoever wrote it guessed at a state name.
    expect(parseNotification(entry({ animation: 'moonwalk' }))).toMatchObject({
      animation: FALLBACK_ANIMATION,
    })
  })

  it('accepts `stretch`, which had to fall back until its art landed', () => {
    // This assertion used to be the opposite. `stretch` was aliased to `jumping` and a manifest naming
    // it resolved to the stand-in; v1.9.0 drew the art, the alias was deleted, and the same name now
    // resolves to itself. Kept rather than removed because it is the acceptance test for the alias
    // indirection: a broadcast could always name the state it wanted, before and after.
    expect(parseNotification(entry({ animation: 'stretch' }))).toMatchObject({
      animation: 'stretch',
    })
  })

  it('still falls back for a name no state or alias covers', () => {
    expect(parseNotification(entry({ animation: 'moonwalk' }))).toMatchObject({
      animation: FALLBACK_ANIMATION,
    })
  })

  it('accepts a real animation name', () => {
    expect(parseNotification(entry({ animation: 'jumping' }))).toMatchObject({ animation: 'jumping' })
  })

  it('keeps the entry but drops a non-https url', () => {
    // A bad link costs the link, not the message.
    for (const url of ['http://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', '//host/x']) {
      const result = parseNotification(entry({ url }))
      expect(result, url).not.toHaveProperty('error')
      expect(result).toMatchObject({ url: null })
    }
  })

  it('keeps an https url', () => {
    expect(parseNotification(entry({ url: 'https://example.com/x' }))).toMatchObject({
      url: 'https://example.com/x',
    })
  })

  it('requires an explicit offset on timestamps', () => {
    // `2026-08-01T09:00:00` means different instants in different timezones, and a broadcast window
    // that shifts by the reader's location is not a schedule.
    expect(parseNotification(entry({ startsAt: '2026-08-01T09:00:00' }))).toHaveProperty('error')
    expect(parseNotification(entry({ startsAt: '2026-08-01T09:00:00Z' }))).not.toHaveProperty('error')
    expect(parseNotification(entry({ startsAt: '2026-08-01T09:00:00+05:30' }))).not.toHaveProperty(
      'error',
    )
  })

  it('rejects an unparseable timestamp', () => {
    expect(parseNotification(entry({ expiresAt: 'next Fridayz' }))).toHaveProperty('error')
  })

  it('rejects a window that starts after it ends', () => {
    expect(
      parseNotification(
        entry({ startsAt: '2030-01-01T00:00:00Z', expiresAt: '2020-01-01T00:00:00Z' }),
      ),
    ).toHaveProperty('error')
  })

  it('treats absent timestamps as an unbounded window', () => {
    const result = parseNotification({ id: 'always', text: 'always on' })
    expect(result).toMatchObject({ startsAtMs: -Infinity, expiresAtMs: Infinity })
  })

  it('truncates long text rather than dropping the entry', () => {
    const result = parseNotification(entry({ text: 'x'.repeat(1_500) }))
    expect(result).not.toHaveProperty('error')
    if (!('error' in result)) {
      expect(result.text.length).toBeLessThanOrEqual(CALLOUT_TEXT_MAX)
    }
  })

  it('drops an entry whose text is empty once sanitised', () => {
    expect(parseNotification(entry({ text: '‮​ ' }))).toHaveProperty('error')
  })

  it('strips a bidi override from text', () => {
    const result = parseNotification(entry({ text: 'safe‮txet desrever' }))
    if (!('error' in result)) expect(result.text).not.toContain('‮')
  })

  // -------------------------------------------------------------------------------------
  // P4's XSS case
  // -------------------------------------------------------------------------------------

  it('carries HTML through as literal characters', () => {
    // The renderer uses textContent, so angle brackets are just characters. Asserting the payload
    // survives byte-for-byte proves nothing is being half-escaped into something a future innerHTML
    // would happily execute.
    const payload = '<img src=x onerror=alert(1)>'
    const result = parseNotification(entry({ text: payload }))
    expect(result).toMatchObject({ text: payload })
  })

  it('carries a script tag through as literal characters', () => {
    const payload = '<script>fetch("https://evil")</script>'
    const result = parseNotification(entry({ text: payload }))
    expect(result).toMatchObject({ text: payload })
  })
})

describe('selectDue', () => {
  const now = Date.parse('2026-08-01T12:00:00Z')

  function safe(overrides: Record<string, unknown>) {
    const result = parseNotification(entry(overrides))
    if ('error' in result) throw new Error(`fixture invalid: ${result.error}`)
    return result
  }

  it('includes an entry inside its window', () => {
    const due = selectDue([safe({ id: 'live' })], now, new Set())
    expect(due.map((n) => n.id)).toEqual(['live'])
  })

  it('excludes an expired entry', () => {
    const expired = safe({
      id: 'old',
      startsAt: '2020-01-01T00:00:00Z',
      expiresAt: '2020-01-02T00:00:00Z',
    })
    expect(selectDue([expired], now, new Set())).toEqual([])
  })

  it('excludes an entry that is not live yet', () => {
    const future = safe({
      id: 'future',
      startsAt: '2030-01-01T00:00:00Z',
      expiresAt: '2031-01-01T00:00:00Z',
    })
    expect(selectDue([future], now, new Set())).toEqual([])
  })

  it('excludes an already-seen id', () => {
    expect(selectDue([safe({ id: 'seen-before' })], now, new Set(['seen-before']))).toEqual([])
  })

  it('orders by priority then id, deterministically', () => {
    const entries = [
      safe({ id: 'b-normal', priority: 'normal' }),
      safe({ id: 'a-urgent', priority: 'urgent' }),
      safe({ id: 'c-low', priority: 'low' }),
      safe({ id: 'a-normal', priority: 'normal' }),
    ]
    expect(selectDue(entries, now, new Set()).map((n) => n.id)).toEqual([
      'a-urgent',
      'a-normal',
      'b-normal',
      'c-low',
    ])
  })
})

// ---------------------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------------------

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

interface Harness {
  poller: ReturnType<typeof createPoller>
  surfaced: string[][]
  seen: string[]
  releases: Array<string | null>
  calls: number
}

function harness(
  responder: (call: number) => Response | Promise<Response>,
  overrides: Partial<Parameters<typeof createPoller>[1]> = {},
): Harness {
  const surfaced: string[][] = []
  const seen: string[] = []
  const releases: Array<string | null> = []
  let calls = 0

  const fetchImpl: CappedFetch = async () => {
    calls += 1
    return responder(calls)
  }

  const poller = createPoller('https://example.com/manifest.json', {
    fetch: fetchImpl,
    allowLoopbackHttp: false,
    random: () => 0.5,
    getSeenIds: () => seen,
    markSeen: (id) => {
      seen.push(id)
    },
    onNotifications: (entries) => surfaced.push(entries.map((e) => e.id)),
    onRelease: (release) => releases.push(release?.latestVersion ?? null),
    ...overrides,
  })

  return {
    poller,
    surfaced,
    seen,
    releases,
    get calls() {
      return calls
    },
  }
}

describe('broadcast poller', () => {
  it('surfaces a live notification and records it as seen before showing it', async () => {
    const h = harness(() => jsonResponse(manifest([entry({ id: 'live-1' })])))
    const outcome = await h.poller.pollNow('launch')
    expect(outcome).toMatchObject({ kind: 'ok', surfaced: 1 })
    expect(h.surfaced).toEqual([['live-1']])
    // Persisted before surfacing: a crash between the bubble appearing and the write landing must
    // not re-show the message.
    expect(h.seen).toEqual(['live-1'])
    h.poller.stop()
  })

  it('never surfaces the same id twice, across polls', async () => {
    const h = harness(() => jsonResponse(manifest([entry({ id: 'once' })])))
    await h.poller.pollNow('launch')
    // A changed body so the hash check does not short-circuit; the id dedupe is what must hold.
    const h2 = harness(() => jsonResponse(manifest([entry({ id: 'once', text: 'edited' })])), {
      getSeenIds: () => ['once'],
    })
    await h2.poller.pollNow('timer')
    expect(h.surfaced).toEqual([['once']])
    expect(h2.surfaced).toEqual([])
    h.poller.stop()
    h2.poller.stop()
  })

  it('surfaces nothing when the body has not changed, even without an ETag', async () => {
    // Correctness comes from the body hash, not from 304 — see the comment in broadcast-poller.ts.
    const body = manifest([entry({ id: 'stable' })])
    const h = harness(() => jsonResponse(body))
    await h.poller.pollNow('launch')
    const second = await h.poller.pollNow('timer')
    expect(second).toEqual({ kind: 'unchanged' })
    expect(h.surfaced).toHaveLength(1)
    h.poller.stop()
  })

  it('treats 304 as unchanged', async () => {
    const h = harness(() => new Response(null, { status: 304 }))
    expect(await h.poller.pollNow('timer')).toEqual({ kind: 'unchanged' })
    h.poller.stop()
  })

  it('shares an in-flight request rather than stacking polls', async () => {
    // A timer firing during a slow response must not queue a second request; that is how a flaky
    // network becomes a request storm.
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness(async () => {
      await gate
      return jsonResponse(manifest([]))
    })

    const first = h.poller.pollNow('timer')
    const second = h.poller.pollNow('timer')
    release!()
    await Promise.all([first, second])
    expect(h.calls).toBe(1)
    h.poller.stop()
  })

  it('reports an error and surfaces nothing on a 500', async () => {
    const h = harness(() => new Response('boom', { status: 500 }))
    const outcome = await h.poller.pollNow('timer')
    expect(outcome.kind).toBe('error')
    expect(h.surfaced).toEqual([])
    expect(h.poller.status().state).toBe('error')
    h.poller.stop()
  })

  it('recovers after a failure', async () => {
    const h = harness((call) =>
      call === 1
        ? new Response('boom', { status: 500 })
        : jsonResponse(manifest([entry({ id: 'after-recovery' })])),
    )
    expect((await h.poller.pollNow('timer')).kind).toBe('error')
    expect((await h.poller.pollNow('timer')).kind).toBe('ok')
    expect(h.surfaced).toEqual([['after-recovery']])
    h.poller.stop()
  })

  it('reports an error for an unusable manifest without surfacing anything', async () => {
    const h = harness(() => jsonResponse('{ not json'))
    expect(await h.poller.pollNow('timer')).toMatchObject({ kind: 'error' })
    expect(h.surfaced).toEqual([])
    h.poller.stop()
  })

  it('never throws, whatever comes back', async () => {
    // The property that makes "failure is silent" true: nothing here can crash the pet.
    for (const responder of [
      () => {
        throw new Error('network exploded')
      },
      () => jsonResponse('null'),
      () => jsonResponse('[]'),
      () => jsonResponse('{"version":1,"notifications":"not an array"}'),
      () => new Response(null, { status: 500 }),
    ]) {
      const h = harness(responder as (call: number) => Response)
      await expect(h.poller.pollNow('timer')).resolves.toBeDefined()
      expect(h.surfaced).toEqual([])
      h.poller.stop()
    }
  })

  it('passes the release block through', async () => {
    const h = harness(() =>
      jsonResponse(
        manifest([], { release: { latestVersion: '2.0.0', notesUrl: 'https://example.com/n' } }),
      ),
    )
    await h.poller.pollNow('launch')
    expect(h.releases).toEqual(['2.0.0'])
    h.poller.stop()
  })

  it('logs dropped entries rather than swallowing them', async () => {
    const log = vi.fn()
    const h = harness(
      () => jsonResponse(manifest([entry({ id: 'ok-1' }), entry({ id: 'bad', nope: 1 })])),
      { log },
    )
    await h.poller.pollNow('launch')
    expect(log).toHaveBeenCalledWith(
      'broadcast manifest had unusable entries',
      expect.objectContaining({ dropped: expect.any(Array) }),
    )
    h.poller.stop()
  })
})

describe('poll scheduling', () => {
  it('keeps jitter within ±20% of the base', () => {
    const base = 5 * 60_000
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const delay = nextDelayMs(base, () => r)
      expect(delay).toBeGreaterThanOrEqual(base * (1 - POLL.jitter) - 1)
      expect(delay).toBeLessThanOrEqual(base * (1 + POLL.jitter) + 1)
    }
  })

  it('spreads across the whole jitter window over many draws', () => {
    const base = 300_000
    const values = Array.from({ length: 5_000 }, (_, i) => nextDelayMs(base, () => i / 5_000))
    expect(Math.min(...values)).toBeLessThan(base * 0.85)
    expect(Math.max(...values)).toBeGreaterThan(base * 1.15)
  })

  it('clamps the interval override and falls back on nonsense', () => {
    expect(resolvePollMinutes({ KEYCODE_PET_POLL_MINUTES: '0.1' })).toBe(POLL.minMinutes)
    expect(resolvePollMinutes({ KEYCODE_PET_POLL_MINUTES: '99999' })).toBe(POLL.maxMinutes)
    expect(resolvePollMinutes({ KEYCODE_PET_POLL_MINUTES: 'abc' })).toBe(POLL.baseMinutes)
    expect(resolvePollMinutes({ KEYCODE_PET_POLL_MINUTES: '-5' })).toBe(POLL.baseMinutes)
    expect(resolvePollMinutes({})).toBe(POLL.baseMinutes)
    expect(resolvePollMinutes({ KEYCODE_PET_POLL_MINUTES: '10' })).toBe(10)
  })

  it('uses the env manifest URL when set', () => {
    expect(resolveManifestUrl({ KEYCODE_PET_MANIFEST_URL: 'https://x/y' }, 'https://fallback')).toBe(
      'https://x/y',
    )
    expect(resolveManifestUrl({}, 'https://fallback')).toBe('https://fallback')
    expect(resolveManifestUrl({ KEYCODE_PET_MANIFEST_URL: '' }, 'https://fallback')).toBe(
      'https://fallback',
    )
  })

  it('ships a default manifest URL that a packaged build can actually fetch', () => {
    // The shipped default lives in app-shell.ts, which imports electron and so cannot be imported
    // here — read the source instead, the same way tests/renderer/discipline.spec.ts does.
    //
    // Worth locking: a loopback or http:// default is refused outright by a packaged build, because
    // `allowLoopbackHttp` requires `!app.isPackaged`. Nothing would crash and no test would fail —
    // every install would just silently never receive an announcement, which is the failure mode
    // that takes a week to notice.
    const source = readFileSync(
      resolve(import.meta.dirname, '../../apps/desktop/src/main/app-shell.ts'),
      'utf8',
    )
    const match = source.match(/resolveManifestUrl\(\s*process\.env,\s*'([^']+)'/)
    expect(match, 'could not find the resolveManifestUrl fallback in app-shell.ts').not.toBeNull()

    const fallback = match![1]!
    expect(fallback).toMatch(/^https:\/\//)
    expect(fallback).not.toMatch(/127\.0\.0\.1|localhost|\[::1\]/)
    // And the guard the client applies at runtime must accept it with no dev flags set.
    expect(safeUrl(fallback)).not.toBeNull()
  })
})

describe('manifest team defaults', () => {
  const wrap = (defaults: unknown) =>
    parseManifest(JSON.stringify({ version: 1, notifications: [], defaults }))

  /** Every field null — the shape a caller gets when the manifest set none of them. */
  const none = {
    waterMinutes: null,
    stretchMinutes: null,
    pollMinutes: null,
    petSize: null,
    alwaysOnTop: null,
  }

  it('parses every default when present', () => {
    const parsed = wrap({
      waterMinutes: 30,
      stretchMinutes: 90,
      pollMinutes: 1,
      petSize: 'medium',
      alwaysOnTop: false,
    })
    expect(parsed?.defaults).toEqual({
      waterMinutes: 30,
      stretchMinutes: 90,
      pollMinutes: 1,
      petSize: 'medium',
      alwaysOnTop: false,
    })
  })

  it('is null when the manifest carries none, so nothing is implied', () => {
    expect(parseManifest(JSON.stringify({ version: 1, notifications: [] }))?.defaults).toBeNull()
  })

  it('allows any subset on its own', () => {
    expect(wrap({ waterMinutes: 20 })?.defaults).toEqual({ ...none, waterMinutes: 20 })
    expect(wrap({ pollMinutes: 1 })?.defaults).toEqual({ ...none, pollMinutes: 1 })
    expect(wrap({ petSize: 'small' })?.defaults).toEqual({ ...none, petSize: 'small' })
    expect(wrap({ alwaysOnTop: true })?.defaults).toEqual({ ...none, alwaysOnTop: true })
  })

  it('drops an unusable value on a declared key instead of rejecting the whole manifest', () => {
    // ---------------------------------------------------------------------------------------
    // This assertion is the exact inverse of the one it replaces, and the reversal is deliberate.
    // ---------------------------------------------------------------------------------------
    //
    // The original read `expect(wrap({ waterMinutes: 0 })).toBeNull()`, reasoning that "a declared key
    // still validates: a default that silently clamped would be a policy nobody chose." The intent was
    // right and the mechanism was not, for two reasons:
    //
    //   1. **Dropping is not clamping.** Clamping `0` to `1` would invent a policy. Dropping it falls
    //      back to the built-in, which is exactly what happens when the key is absent — no invention.
    //   2. **The loudness pointed at the wrong audience.** A rejected envelope is silent for the
    //      publisher, whose deploy succeeds, and catastrophic for every client, which loses *every
    //      announcement in the file*. That is the same asymmetry this block already cites as its reason
    //      for tolerating unknown keys; it simply had not been applied to bad values on known ones.
    //
    // The loudness now lives where it belongs: `pnpm manifest:check` fails the build when a published
    // default is unusable, so the publisher finds out before clients do.
    for (const bad of [
      { waterMinutes: 0 },
      { waterMinutes: 100_000 },
      { waterMinutes: 30.5 },
      { pollMinutes: 0 },
      { petSize: 'Small' },
      { petSize: 'huge' },
      { alwaysOnTop: 'yes' },
    ]) {
      const parsed = wrap(bad)
      expect(parsed, `${JSON.stringify(bad)} must not reject the manifest`).not.toBeNull()
      expect(parsed?.defaults).toEqual(none)
      // And it is reported rather than silently absent, so a typo is findable.
      expect(parsed?.droppedDefaults).toEqual(Object.keys(bad))
    }
  })

  it('keeps the good defaults in a block that also has a bad one', () => {
    const parsed = wrap({ waterMinutes: 0, stretchMinutes: 15, petSize: 'small' })
    expect(parsed?.defaults).toEqual({ ...none, stretchMinutes: 15, petSize: 'small' })
    expect(parsed?.droppedDefaults).toEqual(['waterMinutes'])
  })

  it('reports nothing dropped when every default is usable', () => {
    expect(wrap({ waterMinutes: 5, petSize: 'small' })?.droppedDefaults).toEqual([])
    expect(parseManifest(JSON.stringify({ version: 1, notifications: [] }))?.droppedDefaults).toEqual(
      [],
    )
  })

  it('still delivers announcements when the defaults block is unusable', () => {
    // The failure this whole change is about, stated as the thing a user would notice.
    const body = JSON.stringify({
      version: 1,
      notifications: [{ id: 'a', text: 'hello', expiresAt: '2099-01-01T00:00:00Z' }],
      defaults: { waterMinutes: 0, petSize: 'Small' },
    })
    expect(parseManifest(body)?.notifications).toHaveLength(1)
  })

  it('IGNORES unknown keys instead of rejecting the manifest — this block must stay extensible', () => {
    // Deliberately not strict, unlike the envelope. `defaults` is designed to grow, and strictness
    // there means every new default makes every older client reject the whole file and stop receiving
    // announcements. The failure modes are not comparable: an ignored key costs one default; a
    // rejected envelope costs every announcement, for everyone, silently.
    //
    // `petSize` used to be the example of a future key here. It is a real one now, so this uses a name
    // that is still imaginary — the property under test is about *unknown* keys, and it would quietly
    // stop testing anything the moment its example became real.
    const parsed = wrap({ waterMinutes: 20, somethingFromTheFuture: 'x' })
    expect(parsed).not.toBeNull()
    expect(parsed?.defaults).toEqual({ ...none, waterMinutes: 20 })
    // An unknown key is not a *dropped* default either — nothing was published that we understood.
    expect(parsed?.droppedDefaults).toEqual([])
  })

  it('carries no way to force a reminder on', () => {
    // The trust boundary, restated. It used to read "defaults may suggest *how often*, never *whether*",
    // and `alwaysOnTop` is plainly a whether — so that phrasing did not survive v1.10.0. The property
    // that does, and that this test now pins, is stronger and structural:
    //
    //   a default may fill in a choice nobody made; it may never override one somebody did.
    //
    // Reminders on/off is excluded not by category but because `enabled` has no unchosen state in the
    // settings file, so a default there could only ever be an override.
    const parsed = wrap({ waterEnabled: true, waterMinutes: 20 })
    expect(parsed?.defaults).toEqual({ ...none, waterMinutes: 20 })
    // And the contract itself has no enable-like key to grow into one by accident.
    expect(Object.keys(defaultsSchema.shape).sort()).toEqual([
      'alwaysOnTop',
      'petSize',
      'pollMinutes',
      'stretchMinutes',
      'waterMinutes',
    ])
  })

  it('lets the manifest set the poll interval, with the env override winning', () => {
    // The env var is a dev escape hatch, so it must beat a remote value — otherwise a manifest could
    // override the one knob used to debug the manifest.
    expect(resolvePollMinutes({}, 1)).toBe(1)
    expect(resolvePollMinutes({}, null)).toBe(POLL.baseMinutes)
    expect(resolvePollMinutes({ KEYCODE_PET_POLL_MINUTES: '7' }, 1)).toBe(7)
    // Clamped like everything else arriving from outside.
    expect(resolvePollMinutes({}, 99_999)).toBe(POLL.maxMinutes)
    expect(resolvePollMinutes({}, 0)).toBe(POLL.baseMinutes)
  })
})

describe('per-poll cap on new notifications', () => {
  const entry = (id: string, priority = 'normal') => ({
    id,
    text: id,
    priority,
    startsAt: '2020-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
  })

  it('holds the surplus for the next poll instead of dropping it', async () => {
    // A fresh install with many live entries would otherwise get one stacked bubble per entry, each
    // waiting to be clicked. The held ones must NOT be marked seen, or they are lost for good.
    const many = Array.from({ length: 8 }, (_, i) => entry(`e${i}`))
    const body = JSON.stringify({ version: 1, notifications: many })
    // A changing ETag each call, so the body-hash short-circuit does not treat the second poll as
    // unchanged and skip surfacing entirely.
    const h = harness((call) => jsonResponse(body, { headers: { etag: `"v${call}"` } }))

    await h.poller.pollNow('user')
    expect(h.surfaced[0]).toHaveLength(MANIFEST_MAX_PER_POLL)
    expect(h.seen).toHaveLength(MANIFEST_MAX_PER_POLL)

    // Successive polls pick up where the last left off, and everything eventually arrives.
    await h.poller.pollNow('user')
    await h.poller.pollNow('user')
    await h.poller.pollNow('user')
    expect(new Set(h.seen).size).toBe(many.length)
  })

  it('keeps the highest priority first when it has to choose', () => {
    // `selectDue` sorts by rank then id, so slicing keeps the ones that matter most.
    const parsed = parseManifest(
      JSON.stringify({
        version: 1,
        notifications: [entry('low-one', 'low'), entry('urgent-one', 'urgent'), entry('mid', 'normal')],
      }),
    )
    const due = selectDue(parsed!.notifications, Date.parse('2026-01-01T00:00:00Z'), new Set())
    expect(due.slice(0, 1).map((d) => d.id)).toEqual(['urgent-one'])
  })
})
