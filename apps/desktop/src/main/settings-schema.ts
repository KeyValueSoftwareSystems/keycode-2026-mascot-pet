/**
 * The persisted settings shape — pure. No `fs`, no `electron`, so it unit-tests directly.
 *
 * Two shape decisions worth explaining, both learned from how openpets gets bitten:
 *
 * 1. **`position` is keyed by display *geometry*, not by Electron's numeric display id.**
 *    Display ids are not stable across reboots on some platforms. An id-keyed saved position
 *    silently resolves to "no saved position", so the pet quietly forgets where it was every
 *    time the machine restarts — a bug that looks like the persistence never worked at all.
 *
 * 2. **`position` stores only `x`.** The vertical placement is always derived from the
 *    current work area and the sprite's measured `footInset`. A persisted `y` could only
 *    ever be a stale value fighting the correct one — after a resolution change, a Dock
 *    resize, or a monitor swap it is wrong, and there is no case where it is more right than
 *    a fresh derivation.
 */

import { z } from 'zod'

export const SETTINGS_SCHEMA_VERSION = 1 as const

/** Cap on remembered broadcast ids. See `seenBroadcastIds` below. */
export const SEEN_IDS_MAX = 500

export const settingsSchema = z.strictObject({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),

  movementEnabled: z.boolean(),
  waterReminderEnabled: z.boolean(),
  stretchReminderEnabled: z.boolean(),

  position: z
    .strictObject({
      /** `"x,y,WxH"` — see the note above on why this is not a display id. */
      displayKey: z.string().min(1).max(64),
      /** Screen x of the sprite's visible-body centre. */
      x: z.number().finite(),
    })
    .nullable(),

  reminders: z.strictObject({
    /** Epoch ms deadlines. Wall-clock, not intervals — see reminders/reminder-scheduler.ts. */
    waterNextDueAt: z.number().int().nullable(),
    stretchNextDueAt: z.number().int().nullable(),
  }),

  /**
   * Broadcast ids already shown. "Exactly once per install, ever" is a durability claim, so
   * this is written with a forced flush at the moment a callout is submitted rather than on
   * the usual debounce.
   *
   * Capped because an unbounded array in a settings file is a slow leak, and a too-small one
   * re-shows an old announcement. FIFO eviction.
   */
  seenBroadcastIds: z.array(z.string().min(1).max(128)).max(SEEN_IDS_MAX),

  /** Latest release version already announced, so a version announces once, not once per poll. */
  lastKnownRelease: z.string().max(32).nullable(),
})

export type Settings = z.infer<typeof settingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  movementEnabled: true,
  waterReminderEnabled: true,
  stretchReminderEnabled: true,
  position: null,
  reminders: { waterNextDueAt: null, stretchNextDueAt: null },
  seenBroadcastIds: [],
  lastKnownRelease: null,
}

export type ParseResult =
  | { ok: true; value: Settings }
  | { ok: false; reason: string }

/**
 * Parse untrusted settings data.
 *
 * A wrong `schemaVersion` is treated as corrupt rather than as a parse error, so the caller
 * takes the same back-up-and-continue path. When a real migration is needed this is where it
 * goes — read the old version, transform, return ok.
 */
export function parseSettings(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: `expected an object, got ${raw === null ? 'null' : typeof raw}` }
  }

  const version = (raw as { schemaVersion?: unknown }).schemaVersion
  if (version !== SETTINGS_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unsupported schemaVersion ${JSON.stringify(version)} (expected ${SETTINGS_SCHEMA_VERSION})`,
    }
  }

  const parsed = settingsSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const path = first?.path.join('.') || '(root)'
    return { ok: false, reason: `${path}: ${first?.message ?? 'invalid'}` }
  }

  return { ok: true, value: parsed.data }
}

/** Append an id to the seen list, evicting oldest first. Pure; returns a new array. */
export function appendSeenId(ids: readonly string[], id: string): string[] {
  if (ids.includes(id)) return [...ids]
  const next = [...ids, id]
  return next.length > SEEN_IDS_MAX ? next.slice(next.length - SEEN_IDS_MAX) : next
}
