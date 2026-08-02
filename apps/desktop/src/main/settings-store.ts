/**
 * Settings persistence. The IO half; the shape lives in `settings-schema.ts`.
 *
 * Three properties this has to hold, each earned from a specific failure:
 *
 * 1. **Atomic writes.** Write to a temp file, fsync, rename. A crash or a power loss
 *    mid-write must never leave a truncated JSON file, because the recovery path for that is
 *    "start from defaults", i.e. the user silently loses their position and toggles.
 *
 * 2. **A bad settings file must never stop the pet appearing.** Missing, truncated, wrong
 *    types, hand-edited garbage — all of it backs the file up and continues from defaults.
 *    The pet failing to launch because of its own preferences file would be the worst
 *    possible trade.
 *
 * 3. **Debounced writes.** A drag produces a position update on every 60ms tick. Writing
 *    each one would be ~17 disk writes a second. Trailing 500ms with a 2000ms max-wait, so a
 *    long drag still persists progressively rather than only on mouse-up.
 */

import { readFile, writeFile, rename, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  parseSettings,
  type Settings,
} from './settings-schema.js'

export const SETTINGS_FILENAME = 'settings.json'
export const WRITE_DEBOUNCE_MS = 500
export const WRITE_MAX_WAIT_MS = 2_000
/** Keep a few corrupt files for forensics, but do not accumulate forever. */
export const CORRUPT_BACKUPS_KEPT = 5

export interface RecoveryInfo {
  backupPath: string
  reason: string
}

export interface SettingsStoreOptions {
  dir: string
  debounceMs?: number
  maxWaitMs?: number
  now?: () => number
  log?: (message: string, meta?: unknown) => void
}

export type SettingsChangeListener = (
  next: Readonly<Settings>,
  previous: Readonly<Settings>,
  changed: readonly (keyof Settings)[],
) => void

export class SettingsStore {
  #dir: string
  #path: string
  #state: Settings
  #debounceMs: number
  #maxWaitMs: number
  #now: () => number
  #log: (message: string, meta?: unknown) => void

  #timer: NodeJS.Timeout | null = null
  #firstDirtyAt: number | null = null
  /**
   * Tail of the write chain — every write, queued or running. `flush` awaits this.
   *
   * The bug it fixes: writes were tracked by a single in-flight promise, and `flush` awaited *that*.
   * A write queued behind it was invisible. So `flush` could resolve, the caller could conclude
   * everything was on disk, and a moment later the queued write would start and create a temp file.
   * On `before-quit` that is a settings write racing process exit; in the test suite it was teardown
   * removing the directory while a write appeared inside it — `ENOTEMPTY`, at random, on unrelated
   * commits.
   *
   * The queue is reached by the max-wait path, which fires `void this.#write()` — nobody holds that
   * promise, so nothing else was ever going to wait for it. A long drag plus a `patchNow` is enough,
   * and `patchNow` is `seenBroadcastIds`, where "shown exactly once, ever" depends on the write
   * landing.
   */
  #tail: Promise<void> = Promise.resolve()
  /** A write that has been asked for but has not started; later asks join it instead of stacking. */
  #pending: Promise<void> | null = null
  /** Whether the state has changed since the last write took its snapshot. */
  #dirty = false
  /** Makes each temp filename unique. Belt and braces now that writes are serialised. */
  #tempSeq = 0
  #listeners = new Set<SettingsChangeListener>()

  readonly recovery: RecoveryInfo | null

  private constructor(
    options: Required<Pick<SettingsStoreOptions, 'dir'>> & {
      debounceMs: number
      maxWaitMs: number
      now: () => number
      log: (message: string, meta?: unknown) => void
    },
    state: Settings,
    recovery: RecoveryInfo | null,
  ) {
    this.#dir = options.dir
    this.#path = join(options.dir, SETTINGS_FILENAME)
    this.#state = state
    this.#debounceMs = options.debounceMs
    this.#maxWaitMs = options.maxWaitMs
    this.#now = options.now
    this.#log = options.log
    this.recovery = recovery
  }

  static async open(options: SettingsStoreOptions): Promise<SettingsStore> {
    const resolved = {
      dir: options.dir,
      debounceMs: options.debounceMs ?? WRITE_DEBOUNCE_MS,
      maxWaitMs: options.maxWaitMs ?? WRITE_MAX_WAIT_MS,
      now: options.now ?? Date.now,
      log: options.log ?? (() => {}),
    }

    await mkdir(resolved.dir, { recursive: true })
    const path = join(resolved.dir, SETTINGS_FILENAME)

    let raw: string | null = null
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        resolved.log('settings: could not read file, using defaults', { code })
      }
    }

    if (raw === null) {
      // First run. Not a recovery — nothing was lost.
      return SettingsStore.#fresh(resolved, null)
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch (error) {
      const recovery = await quarantine(path, resolved, `invalid JSON: ${(error as Error).message}`)
      return SettingsStore.#fresh(resolved, recovery)
    }

    const result = parseSettings(parsedJson)
    if (!result.ok) {
      const recovery = await quarantine(path, resolved, result.reason)
      return SettingsStore.#fresh(resolved, recovery)
    }

    return new SettingsStore(resolved, result.value, null)
  }

  /**
   * Start from defaults and write them out immediately.
   *
   * Persisting eagerly rather than waiting for the first change means the file's existence is
   * a reliable signal — "no settings file" always means "never launched", never "launched but
   * nothing changed yet". It also gives a fresh install something inspectable on disk.
   */
  static async #fresh(
    options: {
      dir: string
      debounceMs: number
      maxWaitMs: number
      now: () => number
      log: (message: string, meta?: unknown) => void
    },
    recovery: RecoveryInfo | null,
  ): Promise<SettingsStore> {
    const store = new SettingsStore(options, structuredClone(DEFAULT_SETTINGS), recovery)
    await store.#write()
    return store
  }

  get(): Readonly<Settings> {
    return this.#state
  }

  onChange(listener: SettingsChangeListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Merge a patch and schedule a debounced write. */
  patch(patch: Partial<Settings>): void {
    if (!this.#apply(patch)) return
    this.#schedule()
  }

  /**
   * Merge a patch and write immediately, without the debounce.
   *
   * For claims that must survive a crash in the next few hundred milliseconds — chiefly
   * `seenBroadcastIds`, where "shown exactly once, ever" is the requirement and a crash
   * just after a bubble appears must not re-show it.
   */
  async patchNow(patch: Partial<Settings>): Promise<void> {
    this.#apply(patch)
    this.#cancelTimer()
    await this.#write()
  }

  /**
   * Flush any pending write. Awaited on `before-quit` and on `powerMonitor` suspend.
   *
   * Awaits the whole chain, not just its own write: if it returned while an earlier write was still
   * running, the process could exit mid-rename and leave a stray temp file — which is exactly the
   * failure `#tail` exists to prevent.
   */
  async flush(): Promise<void> {
    this.#cancelTimer()
    if (this.#dirty) await this.#write()
    await this.#tail
  }

  #apply(patch: Partial<Settings>): boolean {
    const previous = this.#state
    const next: Settings = { ...previous, ...patch }

    const changed = (Object.keys(patch) as (keyof Settings)[]).filter(
      (key) => !deepEqual(previous[key], next[key]),
    )
    if (changed.length === 0) return false

    this.#state = next
    // Set here rather than in `#schedule`, so `patchNow` marks it too — otherwise a `flush` following
    // a `patchNow` whose write had already started would decide there was nothing to do.
    this.#dirty = true
    for (const listener of this.#listeners) {
      try {
        listener(next, previous, changed)
      } catch (error) {
        this.#log('settings: a change listener threw', { error: String(error) })
      }
    }
    return true
  }

  #schedule(): void {
    const now = this.#now()
    this.#firstDirtyAt ??= now

    // Max-wait: a continuous stream of updates (a long drag) would otherwise keep pushing
    // the trailing debounce out forever and nothing would ever reach disk.
    if (now - this.#firstDirtyAt >= this.#maxWaitMs) {
      this.#cancelTimer()
      void this.#write()
      return
    }

    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#write()
    }, this.#debounceMs)
    this.#timer.unref?.()
  }

  #cancelTimer(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  /**
   * Queue a write. Resolves when the state as of *its* turn has reached disk.
   *
   * Two properties, and both are load-bearing:
   *
   *   - **Serialised.** A write only starts once every earlier one has finished, so there is never
   *     more than one temp file and never two renames racing for the same destination.
   *   - **Collapsed.** Asks that arrive before the queued write has started share it, because it will
   *     snapshot whatever the newest state is when it runs — a second waiter would write the same
   *     bytes again. An ask that arrives *after* it starts gets its own turn, because by then the
   *     snapshot is already taken and its change would otherwise be dropped.
   */
  #write(): Promise<void> {
    if (this.#pending) return this.#pending

    const pending = this.#tail.then(() => {
      // Cleared before writing, not after: from here on, a new ask is a genuinely later change and
      // must get its own turn rather than joining a write whose snapshot is about to be taken.
      this.#pending = null
      return this.#writeOnce()
    })

    this.#pending = pending
    // Swallowed on the tail only: one failed write must not poison every write after it. The caller's
    // own promise still rejects.
    this.#tail = pending.then(
      () => {},
      () => {},
    )
    return pending
  }

  async #writeOnce(): Promise<void> {
    this.#firstDirtyAt = null
    this.#dirty = false

    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`
    const temp = `${this.#path}.${process.pid}.${(this.#tempSeq += 1)}.tmp`

    try {
      const handle = await open(temp, 'w')
      try {
        await handle.writeFile(snapshot, 'utf8')
        // fsync before rename: rename is atomic with respect to the directory entry, but
        // without a flush the *contents* may not have reached the device yet, so a power
        // loss can leave a correctly-named, empty file.
        await handle.sync()
      } finally {
        await handle.close()
      }
      await renameWithRetry(temp, this.#path)
    } catch (error) {
      // Losing a settings write is annoying; crashing the pet over it is worse.
      this.#log('settings: write failed', { error: String(error) })
      await unlink(temp).catch(() => {})
    }
  }
}

/**
 * Windows antivirus and indexers transiently lock a destination file, which surfaces as
 * EPERM/EBUSY/EACCES from rename. Three quick retries turn a spurious failure into a
 * non-event; a persistent one still surfaces.
 */
async function renameWithRetry(from: string, to: string, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!retryable || attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

/**
 * Move a bad settings file aside so it can be inspected, then let the caller continue from
 * defaults. Epoch-ms rather than an ISO timestamp: sortable, and free of the `:` characters
 * that are illegal in Windows filenames.
 */
async function quarantine(
  path: string,
  options: { dir: string; now: () => number; log: (message: string, meta?: unknown) => void },
  reason: string,
): Promise<RecoveryInfo | null> {
  const backupPath = `${path}.corrupt.${options.now()}.json`
  try {
    await rename(path, backupPath)
  } catch (error) {
    options.log('settings: could not quarantine the corrupt file', { error: String(error) })
    return null
  }

  options.log('settings: file was unreadable; continuing from defaults', { reason, backupPath })
  await pruneBackups(options.dir).catch(() => {})
  return { backupPath, reason }
}

async function pruneBackups(dir: string): Promise<void> {
  const entries = await readdir(dir)
  const backups = entries
    .filter((name) => name.startsWith(`${SETTINGS_FILENAME}.corrupt.`))
    .sort() // epoch-ms in the name makes lexical order chronological
  const excess = backups.slice(0, Math.max(0, backups.length - CORRUPT_BACKUPS_KEPT))
  await Promise.all(excess.map((name) => unlink(join(dir, name)).catch(() => {})))
}

/** Structural equality, enough for the small JSON-shaped values in Settings. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aKeys = Object.keys(a as object)
  const bKeys = Object.keys(b as object)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}
