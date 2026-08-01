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
 * 2. **`position.feetY` is nullable, and null is the normal case.** It was originally absent
 *    altogether, on the reasoning that a persisted `y` could only ever be a stale value fighting
 *    a fresh derivation. That reasoning held exactly as long as the floor was the only place the
 *    pet could be. Now that it can be dragged anywhere, a non-null `feetY` is the user's *intent*,
 *    which is not the same kind of thing as a cached derivation — so it is stored, while a
 *    floor-locked pet still stores nothing and is still re-derived on launch.
 */

import { z } from 'zod'
import { DEFAULT_PET_SIZE, PET_SIZES, type PetSize } from '../config/constants.js'

export const SETTINGS_SCHEMA_VERSION = 3 as const

/** Cap on remembered broadcast ids. See `seenBroadcastIds` below. */
export const SEEN_IDS_MAX = 500

export const settingsSchema = z.strictObject({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),

  movementEnabled: z.boolean(),
  waterReminderEnabled: z.boolean(),
  stretchReminderEnabled: z.boolean(),

  /** Sprite scale. The bubble does not scale with it — see PET_SIZE_SCALES. */
  petSize: z.enum(PET_SIZES as unknown as [PetSize, ...PetSize[]]),

  position: z
    .strictObject({
      /** `"x,y,WxH"` — see the note above on why this is not a display id. */
      displayKey: z.string().min(1).max(64),
      /** Screen x of the sprite's visible-body centre. */
      x: z.number().finite(),
      /**
       * Screen y of the sprite's lowest opaque pixel, or null when the pet is floor-locked.
       *
       * Null is not "unknown" — it is "on the floor, wherever the floor turns out to be", which is
       * the answer that survives a resolution change.
       */
      feetY: z.number().finite().nullable(),
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
  petSize: DEFAULT_PET_SIZE,
  position: null,
  reminders: { waterNextDueAt: null, stretchNextDueAt: null },
  seenBroadcastIds: [],
  lastKnownRelease: null,
}

export type ParseResult =
  | { ok: true; value: Settings }
  | { ok: false; reason: string }

/**
 * Migrate an older settings object forward, one version at a time.
 *
 * This exists because the schema is a `strictObject`: adding a field means every file written by an
 * older build fails validation, gets treated as corrupt, and is replaced by defaults. Silently
 * resetting someone's toggles and their pet's position because a *new* field appeared is not
 * acceptable, and it is the failure mode that arrives with any additive change.
 *
 * Each step is deliberately dumb — add the new field at its default and bump the version. Chained,
 * so a v1 file from the first release still lands on the current shape.
 */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  let out = { ...raw }

  // v1 → v2: `position` gained `feetY` when the pet became freely placeable. An existing position
  // was necessarily on the floor, which is exactly what null means.
  if (out['schemaVersion'] === 1) {
    const position = out['position']
    out = {
      ...out,
      schemaVersion: 2,
      position:
        position && typeof position === 'object'
          ? { ...(position as Record<string, unknown>), feetY: null }
          : position,
    }
  }

  // v2 → v3: `petSize` arrived. Existing installs were all at what is now `large`, so defaulting to
  // it is what keeps a pet the same size across the upgrade.
  if (out['schemaVersion'] === 2) {
    out = { ...out, schemaVersion: 3, petSize: DEFAULT_PET_SIZE }
  }

  return out
}

/**
 * Parse untrusted settings data, migrating older versions forward first.
 *
 * A version *newer* than this build understands is still treated as corrupt: it means the user ran a
 * later build, and guessing at a shape from the future would corrupt it further.
 */
export function parseSettings(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: `expected an object, got ${raw === null ? 'null' : typeof raw}` }
  }

  const migrated = migrate(raw as Record<string, unknown>)

  const version = migrated['schemaVersion']
  if (version !== SETTINGS_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unsupported schemaVersion ${JSON.stringify(version)} (expected ${SETTINGS_SCHEMA_VERSION})`,
    }
  }

  const parsed = settingsSchema.safeParse(migrated)
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
