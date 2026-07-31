import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseSettings,
  appendSeenId,
  DEFAULT_SETTINGS,
  SEEN_IDS_MAX,
  SETTINGS_SCHEMA_VERSION,
} from '../../apps/desktop/src/main/settings-schema.js'
import {
  SettingsStore,
  SETTINGS_FILENAME,
  CORRUPT_BACKUPS_KEPT,
} from '../../apps/desktop/src/main/settings-store.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keycode-settings-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const settingsPath = () => join(dir, SETTINGS_FILENAME)

async function openStore(overrides: Partial<Parameters<typeof SettingsStore.open>[0]> = {}) {
  return SettingsStore.open({ dir, debounceMs: 5, maxWaitMs: 50, ...overrides })
}

describe('settings schema', () => {
  it('accepts the defaults it ships', () => {
    const result = parseSettings(DEFAULT_SETTINGS)
    expect(result.ok).toBe(true)
  })

  it('rejects unknown keys rather than silently dropping them', () => {
    // Strict parsing means a typo'd key is a loud failure, not a setting that mysteriously
    // has no effect.
    const result = parseSettings({ ...DEFAULT_SETTINGS, movementEnabledd: true })
    expect(result.ok).toBe(false)
  })

  it('treats a wrong schemaVersion as corrupt, not as a field error', () => {
    const result = parseSettings({ ...DEFAULT_SETTINGS, schemaVersion: 2 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('schemaVersion')
  })

  it('rejects a non-object', () => {
    for (const bad of [null, 42, 'nope', [] as unknown]) {
      expect(parseSettings(bad).ok).toBe(false)
    }
  })

  it('rejects a position keyed by anything but a non-empty display key', () => {
    expect(
      parseSettings({ ...DEFAULT_SETTINGS, position: { displayKey: '', x: 10 } }).ok,
    ).toBe(false)
    expect(
      parseSettings({ ...DEFAULT_SETTINGS, position: { displayKey: 'k', x: Number.NaN } }).ok,
    ).toBe(false)
  })

  it('does not accept a persisted y — vertical placement is always derived', () => {
    const result = parseSettings({
      ...DEFAULT_SETTINGS,
      position: { displayKey: '0,0,100x100', x: 10, y: 20 },
    })
    expect(result.ok).toBe(false)
  })

  it('rejects more seen ids than the cap allows', () => {
    const tooMany = Array.from({ length: SEEN_IDS_MAX + 1 }, (_, i) => `id-${i}`)
    expect(parseSettings({ ...DEFAULT_SETTINGS, seenBroadcastIds: tooMany }).ok).toBe(false)
  })
})

describe('appendSeenId', () => {
  it('appends and is idempotent for an id already present', () => {
    expect(appendSeenId(['a'], 'b')).toEqual(['a', 'b'])
    expect(appendSeenId(['a', 'b'], 'b')).toEqual(['a', 'b'])
  })

  it('evicts oldest first at the cap', () => {
    const full = Array.from({ length: SEEN_IDS_MAX }, (_, i) => `id-${i}`)
    const next = appendSeenId(full, 'newest')
    expect(next).toHaveLength(SEEN_IDS_MAX)
    expect(next[0]).toBe('id-1') // id-0 evicted
    expect(next.at(-1)).toBe('newest')
  })

  it('does not mutate its input', () => {
    const input = Object.freeze(['a'])
    expect(() => appendSeenId(input, 'b')).not.toThrow()
    expect(input).toEqual(['a'])
  })
})

describe('SettingsStore', () => {
  it('starts from defaults on first run without reporting a recovery', async () => {
    const store = await openStore()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    // Nothing was lost on a first run, so flagging a recovery would be misleading.
    expect(store.recovery).toBeNull()
  })

  it('round-trips a patch through disk', async () => {
    const store = await openStore()
    store.patch({ movementEnabled: false, lastKnownRelease: '0.4.0' })
    await store.flush()

    const reopened = await openStore()
    expect(reopened.get().movementEnabled).toBe(false)
    expect(reopened.get().lastKnownRelease).toBe('0.4.0')
  })

  it('writes atomically, leaving no temp file behind', async () => {
    const store = await openStore()
    store.patch({ movementEnabled: false })
    await store.flush()

    const entries = await readdir(dir)
    expect(entries).toContain(SETTINGS_FILENAME)
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('backs up invalid JSON and continues from defaults', async () => {
    await writeFile(settingsPath(), '{ this is not json', 'utf8')
    const store = await openStore()

    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(store.recovery).not.toBeNull()
    expect(store.recovery?.reason).toContain('JSON')

    const entries = await readdir(dir)
    expect(entries.some((n) => n.includes('.corrupt.'))).toBe(true)
  })

  it('backs up a schema-invalid file and continues from defaults', async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, movementEnabled: 'yes' }),
      'utf8',
    )
    const store = await openStore()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(store.recovery).not.toBeNull()
  })

  it('never throws on a corrupt file — the pet must still appear', async () => {
    // The whole point: preferences are not worth failing to launch over.
    for (const content of ['', '   ', 'null', '[]', '{"schemaVersion":99}', '\u0000binary']) {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      await writeFile(settingsPath(), content, 'utf8')
      const store = await openStore()
      expect(store.get().schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    }
  })

  it(`keeps at most ${CORRUPT_BACKUPS_KEPT} corrupt backups`, async () => {
    let clock = 1_000
    for (let i = 0; i < CORRUPT_BACKUPS_KEPT + 3; i += 1) {
      await writeFile(settingsPath(), 'not json', 'utf8')
      clock += 1_000
      await openStore({ now: () => clock })
    }
    const backups = (await readdir(dir)).filter((n) => n.includes('.corrupt.'))
    expect(backups.length).toBeLessThanOrEqual(CORRUPT_BACKUPS_KEPT)
  })

  it('notifies listeners with only the keys that actually changed', async () => {
    const store = await openStore()
    const seen: (keyof typeof DEFAULT_SETTINGS)[][] = []
    store.onChange((_next, _prev, changed) => seen.push([...changed]))

    store.patch({ movementEnabled: false })
    // Same value again: nothing changed, so no notification and no disk write.
    store.patch({ movementEnabled: false })
    store.patch({ waterReminderEnabled: false, lastKnownRelease: null })

    expect(seen).toEqual([['movementEnabled'], ['waterReminderEnabled']])
    await store.flush()
  })

  it('compares nested values structurally so an equal object is not a change', async () => {
    const store = await openStore()
    store.patch({ reminders: { waterNextDueAt: 5, stretchNextDueAt: null } })
    const seen: string[] = []
    store.onChange((_n, _p, changed) => seen.push(...changed))
    store.patch({ reminders: { waterNextDueAt: 5, stretchNextDueAt: null } })
    expect(seen).toEqual([])
    await store.flush()
  })

  it('debounces a burst of updates into a single write', async () => {
    // A drag emits a position update every 60ms tick. Writing each one would be ~17 disk
    // writes a second; this is the guard against that.
    const store = await SettingsStore.open({ dir, debounceMs: 30, maxWaitMs: 10_000 })
    for (let i = 0; i < 25; i += 1) {
      store.patch({ position: { displayKey: '0,0,100x100', x: i } })
    }
    await store.flush()

    const written = JSON.parse(await readFile(settingsPath(), 'utf8')) as typeof DEFAULT_SETTINGS
    expect(written.position?.x).toBe(24)
  })

  it('honours the max-wait so a long continuous drag still reaches disk', async () => {
    vi.useFakeTimers()
    try {
      let clock = 0
      const store = await SettingsStore.open({
        dir,
        debounceMs: 500,
        maxWaitMs: 1_000,
        now: () => clock,
      })

      // Keep patching faster than the debounce, for longer than the max-wait. Without a
      // max-wait the trailing timer is pushed out forever and nothing is ever persisted.
      for (let i = 0; i < 10; i += 1) {
        clock += 200
        store.patch({ position: { displayKey: '0,0,100x100', x: i } })
      }

      await vi.runAllTimersAsync()
      await store.flush()

      const written = JSON.parse(await readFile(settingsPath(), 'utf8')) as typeof DEFAULT_SETTINGS
      expect(written.position).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('patchNow bypasses the debounce for durability-critical writes', async () => {
    // `seenBroadcastIds` is the caller that needs this: "shown exactly once, ever" must
    // survive a crash a few hundred ms after the bubble appears.
    const store = await SettingsStore.open({ dir, debounceMs: 10_000, maxWaitMs: 10_000 })
    await store.patchNow({ seenBroadcastIds: ['kickoff-2026'] })

    const written = JSON.parse(await readFile(settingsPath(), 'utf8')) as typeof DEFAULT_SETTINGS
    expect(written.seenBroadcastIds).toEqual(['kickoff-2026'])
  })

  it('serialises concurrent writes and persists the newest state', async () => {
    const store = await openStore()
    await Promise.all([
      store.patchNow({ lastKnownRelease: '0.1.0' }),
      store.patchNow({ lastKnownRelease: '0.2.0' }),
      store.patchNow({ lastKnownRelease: '0.3.0' }),
    ])
    await store.flush()

    const written = JSON.parse(await readFile(settingsPath(), 'utf8')) as typeof DEFAULT_SETTINGS
    expect(written.lastKnownRelease).toBe('0.3.0')
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('survives an unwritable directory without throwing', async () => {
    const store = await openStore({ dir })
    await rm(dir, { recursive: true, force: true })
    // The directory is gone; the write cannot succeed. It must be swallowed and logged.
    store.patch({ movementEnabled: false })
    await expect(store.flush()).resolves.toBeUndefined()
    expect(store.get().movementEnabled).toBe(false)
  })
})
