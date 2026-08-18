import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EventQueue,
  prune,
  QUEUE_FILENAME,
  type QueuedEvent,
} from '../../apps/desktop/src/analytics/event-queue.js'
import {
  createAnalytics,
  nextDelayMs,
  resolveIntervalMinutes,
} from '../../apps/desktop/src/analytics/analytics-service.js'
import { buildBatch, osName } from '../../apps/desktop/src/analytics/analytics-client.js'
import { ANALYTICS } from '../../apps/desktop/src/config/constants.js'
import type { CappedFetch } from '../../apps/desktop/src/broadcast/http-capped.js'

const CONTEXT = {
  installId: 'install-1',
  appVersion: '1.13.0',
  os: 'Mac OS X',
  osVersion: '25.3.0',
  arch: 'arm64',
  electronVersion: '43.0.0',
  locale: 'en-GB',
  timezone: 'Asia/Kolkata',
  displayCount: 2,
  petId: 'pixel-coder',
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'argos-analytics-'))
}

function event(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return { event: 'app_heartbeat', at: 1_000, properties: {}, ...overrides }
}

/** A fetch that records what it was asked to send and answers with whatever is queued up. */
function recordingFetch(responses: Array<{ status: number }>) {
  const calls: Array<{ url: string; body: string }> = []
  const fetch: CappedFetch = (url, init) => {
    calls.push({ url, body: String(init?.body ?? '') })
    const next = responses.shift() ?? { status: 200 }
    return Promise.resolve(
      new Response('{"status":1}', {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  return { fetch, calls }
}

describe('event queue eviction', () => {
  it('drops events older than the age cap', () => {
    const now = 10 * 24 * 60 * 60 * 1_000
    const kept = prune(
      [
        event({ at: now - ANALYTICS.queueMaxAgeMs - 1 }),
        event({ at: now - 1_000 }),
      ],
      now,
    )
    expect(kept).toHaveLength(1)
    expect(kept[0]?.at).toBe(now - 1_000)
  })

  it('evicts oldest first when over the count cap', () => {
    const events = Array.from({ length: ANALYTICS.queueMax + 10 }, (_, i) =>
      event({ at: 1_000 + i, properties: { i } }),
    )
    const kept = prune(events, 1_000)

    expect(kept).toHaveLength(ANALYTICS.queueMax)
    // The newest survive — a stale heartbeat is worth less than a fresh one.
    expect(kept[kept.length - 1]?.properties['i']).toBe(ANALYTICS.queueMax + 9)
  })

  it('applies the age cap before the count cap', () => {
    // Otherwise expired events consume the count budget and evict live ones to make room for dead.
    const now = 10 * 24 * 60 * 60 * 1_000
    const expired = Array.from({ length: ANALYTICS.queueMax }, () =>
      event({ at: now - ANALYTICS.queueMaxAgeMs - 1 }),
    )
    const live = [event({ at: now, properties: { keep: true } })]

    const kept = prune([...expired, ...live], now)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.properties['keep']).toBe(true)
  })
})

describe('event queue persistence', () => {
  it('survives a restart with timestamps intact', async () => {
    const dir = await tempDir()
    // Both clocks are fake and close together: with a real `now`, an event stamped at 42 is four
    // days stale on arrival and the age cap correctly eats it before the assertion can run.
    const first = new EventQueue({ dir, now: () => 50 })
    await first.load()
    await first.append(event({ event: 'app_launched', at: 42 }))

    const second = new EventQueue({ dir, now: () => 100 })
    await second.load()

    expect(second.size()).toBe(1)
    // The original time, not the time it was reloaded. This is what makes an offline backlog
    // land where it belongs on a retention chart.
    expect(second.peek(10)[0]?.at).toBe(42)
  })

  it('removes the file once the queue drains, rather than leaving an empty array', async () => {
    const dir = await tempDir()
    const queue = new EventQueue({ dir })
    await queue.load()
    await queue.append(event())
    await queue.drop(1)

    expect(await readdir(dir)).not.toContain(QUEUE_FILENAME)
  })

  it('discards a corrupt queue instead of failing to start', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, QUEUE_FILENAME), '{ not json at all', 'utf8')

    const queue = new EventQueue({ dir })
    await queue.load()

    expect(queue.size()).toBe(0)
  })

  it('ignores entries that are not events', async () => {
    const dir = await tempDir()
    await writeFile(
      join(dir, QUEUE_FILENAME),
      JSON.stringify([{ nonsense: true }, event({ at: 5 }), 'string']),
      'utf8',
    )

    const queue = new EventQueue({ dir, now: () => 5 })
    await queue.load()

    expect(queue.size()).toBe(1)
  })

  it('leaves no temp file behind', async () => {
    const dir = await tempDir()
    const queue = new EventQueue({ dir })
    await queue.load()
    await queue.append(event())

    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('batch payload', () => {
  it('sends the event’s own timestamp, not the send time', () => {
    const body = JSON.parse(buildBatch([event({ at: 1_700_000_000_000 })], CONTEXT)) as {
      api_key: string
      batch: Array<{ timestamp: string; distinct_id: string; properties: Record<string, unknown> }>
    }

    expect(body.batch[0]?.timestamp).toBe(new Date(1_700_000_000_000).toISOString())
    expect(body.batch[0]?.distinct_id).toBe('install-1')
    expect(body.api_key).toMatch(/^phc_/)
  })

  it('attaches the properties PostHog’s built-in charts key off', () => {
    const body = JSON.parse(buildBatch([event()], CONTEXT)) as {
      batch: Array<{ properties: Record<string, unknown> }>
    }
    const properties = body.batch[0]?.properties ?? {}

    expect(properties['$os']).toBe('Mac OS X')
    expect(properties['$app_version']).toBe('1.13.0')
    expect(properties['$device_type']).toBe('Desktop')
  })

  it('lets event properties win over context', () => {
    const body = JSON.parse(
      buildBatch([event({ properties: { session_minutes: 12 } })], CONTEXT),
    ) as { batch: Array<{ properties: Record<string, unknown> }> }

    expect(body.batch[0]?.properties['session_minutes']).toBe(12)
  })

  it('names platforms the way the charts do', () => {
    expect(osName('darwin')).toBe('Mac OS X')
    expect(osName('win32')).toBe('Windows')
    expect(osName('linux')).toBe('Linux')
    expect(osName('freebsd')).toBe('freebsd')
  })
})

describe('interval resolution', () => {
  it('falls back to the built-in when the manifest says nothing', () => {
    expect(resolveIntervalMinutes(null)).toBe(ANALYTICS.heartbeatMinutes)
  })

  it('passes zero through as the fleet-wide off switch', () => {
    // Not clamped to minMinutes — 0 is a distinct instruction, not a small number.
    expect(resolveIntervalMinutes(0)).toBe(0)
  })

  it('clamps a nonsense manifest value into a sane band', () => {
    expect(resolveIntervalMinutes(1)).toBe(ANALYTICS.minMinutes)
    expect(resolveIntervalMinutes(99_999)).toBe(ANALYTICS.maxMinutes)
  })

  it('keeps jitter inside ±20%', () => {
    expect(nextDelayMs(1_000, () => 0)).toBe(800)
    expect(nextDelayMs(1_000, () => 1)).toBe(1_200)
    expect(nextDelayMs(1_000, () => 0.5)).toBe(1_000)
  })
})

describe('analytics service', () => {
  function service(overrides: Partial<Parameters<typeof createAnalytics>[0]> = {}) {
    const recorder = recordingFetch([])
    const analytics = createAnalytics({
      endpoint: 'https://example.invalid/batch',
      dir: '/tmp/unused',
      context: CONTEXT,
      isEnabled: () => true,
      fetch: recorder.fetch,
      now: () => 1_000,
      random: () => 0.5,
      ...overrides,
    })
    return { analytics, calls: recorder.calls }
  }

  it('captures nothing at all while opted out', async () => {
    const dir = await tempDir()
    const { analytics, calls } = service({ dir, isEnabled: () => false })

    await analytics.start()
    await analytics.capture('app_launched')
    await analytics.flush()

    expect(analytics.pending()).toBe(0)
    expect(calls).toEqual([])
    // Nothing on disk either: opting out must not leave a trail of what would have been sent.
    expect(await readdir(dir)).not.toContain(QUEUE_FILENAME)
  })

  it('can still send the opt-out event after the flag has flipped', async () => {
    // The exact sequence the menu action produces: capture while enabled, flip the flag, then flush.
    // If flush were gated on the flag, the one event that measures the opt-out rate would sit in a
    // queue that is never drained again.
    const dir = await tempDir()
    let enabled = true
    const { analytics, calls } = service({ dir, isEnabled: () => enabled })

    await analytics.start()
    await analytics.capture('analytics_opted_out')
    enabled = false
    await analytics.flush()

    expect(calls).toHaveLength(1)
    expect(analytics.pending()).toBe(0)
  })

  it('does not deliver a backlog on a launch where analytics are already off', async () => {
    const dir = await tempDir()

    const offline = recordingFetch([{ status: 503 }])
    const first = service({ dir, fetch: offline.fetch }).analytics
    await first.start()
    await first.capture('app_launched')
    await first.flush()
    first.stop()
    expect(first.pending()).toBe(1)

    const later = service({ dir, isEnabled: () => false })
    await later.analytics.start()
    later.analytics.stop()

    // Held, not sent: opting out has to cover what was already queued, not just what comes next.
    expect(later.calls).toEqual([])
    expect(later.analytics.pending()).toBe(1)
  })

  it('captures nothing when the manifest disables analytics fleet-wide', async () => {
    const dir = await tempDir()
    const { analytics, calls } = service({ dir, getIntervalMinutes: () => 0 })

    await analytics.start()
    await analytics.capture('app_launched')

    expect(analytics.pending()).toBe(0)
    expect(calls).toEqual([])
  })

  it('sends queued events and clears them', async () => {
    const dir = await tempDir()
    const { analytics, calls } = service({ dir })

    await analytics.start()
    await analytics.capture('app_launched', { unclean_shutdown: false })
    await analytics.flush()

    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0]?.body ?? '{}') as { batch: Array<{ event: string }> }
    expect(body.batch[0]?.event).toBe('app_launched')
    expect(analytics.pending()).toBe(0)
  })

  it('still sends after a start() that found an empty queue', async () => {
    // The regression this pins: `start()` flushes, and with nothing queued that flush completes
    // *synchronously* — no await is reached. Clearing the in-flight guard inside the async body's
    // own `finally` therefore ran before the guard was assigned, leaving it permanently set, and
    // every subsequent flush returned immediately. Analytics went quiet after the first launch and
    // nothing anywhere reported an error.
    const dir = await tempDir()
    const { analytics, calls } = service({ dir })

    await analytics.start()
    await analytics.capture('app_launched')
    await analytics.flush()

    expect(calls).toHaveLength(1)
    expect(analytics.pending()).toBe(0)
  })

  it('keeps events queued when the send fails, and resends them later', async () => {
    const dir = await tempDir()
    const failing = recordingFetch([{ status: 503 }])
    const { analytics } = service({ dir, fetch: failing.fetch })

    await analytics.start()
    await analytics.capture('app_launched')
    await analytics.flush()

    // Held, not lost — a server having a bad afternoon must not cost us the data.
    expect(analytics.pending()).toBe(1)

    await analytics.flush()
    expect(analytics.pending()).toBe(0)
  })

  it('survives a restart while offline and sends the backlog on the next launch', async () => {
    const dir = await tempDir()

    const offline = recordingFetch([{ status: 503 }])
    const first = createAnalytics({
      endpoint: 'https://example.invalid/batch',
      dir,
      context: CONTEXT,
      isEnabled: () => true,
      fetch: offline.fetch,
      now: () => 5_000,
      random: () => 0.5,
    })
    await first.start()
    await first.capture('app_launched')
    await first.flush()
    first.stop()

    const online = recordingFetch([])
    const second = createAnalytics({
      endpoint: 'https://example.invalid/batch',
      dir,
      context: CONTEXT,
      isEnabled: () => true,
      fetch: online.fetch,
      now: () => 6_000,
      random: () => 0.5,
    })
    // `start` flushes before arming the timer, so the backlog does not wait for a heartbeat.
    await second.start()
    second.stop()

    expect(second.pending()).toBe(0)
    const body = JSON.parse(online.calls[0]?.body ?? '{}') as {
      batch: Array<{ event: string; timestamp: string }>
    }
    expect(body.batch[0]?.event).toBe('app_launched')
    // The time it happened, not the time it was finally accepted.
    expect(body.batch[0]?.timestamp).toBe(new Date(5_000).toISOString())
  })

  it('drops a batch the server refuses outright rather than retrying it forever', async () => {
    const dir = await tempDir()
    const refusing = recordingFetch([{ status: 400 }])
    const { analytics } = service({ dir, fetch: refusing.fetch })

    await analytics.start()
    await analytics.capture('app_launched')
    await analytics.flush()

    // A 4xx will be a 4xx next time too, and one unsendable event must not block every later one.
    expect(analytics.pending()).toBe(0)
  })

  it('never throws when the network explodes', async () => {
    const dir = await tempDir()
    const exploding: CappedFetch = () => Promise.reject(new Error('socket exploded'))
    const { analytics } = service({ dir, fetch: exploding })

    await analytics.start()
    await analytics.capture('app_launched')
    await expect(analytics.flush()).resolves.toBeUndefined()
    expect(analytics.pending()).toBe(1)
  })

  it('writes the queue where the settings live, under a predictable name', async () => {
    const dir = await tempDir()
    const { analytics } = service({ dir, fetch: (() => Promise.reject(new Error('offline'))) as CappedFetch })

    await analytics.start()
    await analytics.capture('app_launched')

    const raw = await readFile(join(dir, QUEUE_FILENAME), 'utf8')
    expect(JSON.parse(raw)).toHaveLength(1)
  })
})
