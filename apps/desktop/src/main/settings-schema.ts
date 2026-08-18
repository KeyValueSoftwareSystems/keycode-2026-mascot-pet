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

export const SETTINGS_SCHEMA_VERSION = 8 as const

/** Cap on remembered broadcast ids. See `seenBroadcastIds` below. */
export const SEEN_IDS_MAX = 500

export const settingsSchema = z.strictObject({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),

  movementEnabled: z.boolean(),
  waterReminderEnabled: z.boolean(),
  stretchReminderEnabled: z.boolean(),
  coffeeReminderEnabled: z.boolean(),
  lunchReminderEnabled: z.boolean(),

  /**
   * Whether the pet floats in front of everything, or **null for "never chosen here"**.
   *
   * Off sends it behind other windows, where it is a companion you glance at rather than something in
   * the way. A callout still raises it for as long as the bubble is up — see the keeper — because a
   * team broadcast delivered to a window nobody can see has not been delivered.
   *
   * Nullable since v1.10.0 so a manifest default can fill it. Null is load-bearing in exactly the way
   * the reminder intervals' null is: it is the difference between "this person wants the pet in front"
   * and "nobody has said", and only the second may be answered by a remote file.
   */
  alwaysOnTop: z.boolean().nullable(),

  /**
   * Sprite scale, or **null for "never chosen here"**. The bubble does not scale with it — see
   * PET_SIZE_SCALES.
   */
  petSize: z.enum(PET_SIZES as unknown as [PetSize, ...PetSize[]]).nullable(),

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
    coffeeNextDueAt: z.number().int().nullable(),
    lunchNextDueAt: z.number().int().nullable(),
    /**
     * Chosen intervals in minutes, or **null meaning "never chosen"**.
     *
     * Null is load-bearing rather than lazy: it is what lets a manifest-provided team default apply
     * without ever overriding a choice someone made locally. Storing the built-in default eagerly
     * would make every install look like it had opted in to 45 minutes, and a team default could then
     * never reach anybody.
     */
    waterMinutes: z.number().int().min(1).max(1_440).nullable(),
    stretchMinutes: z.number().int().min(1).max(1_440).nullable(),
  }),

  /**
   * Last greeting shown (`YYYY-MM-DD-morning` etc.), so each period greets once per local day.
   */
  lastGreetingKey: z.string().max(32).nullable(),

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

  /**
   * Whether anonymous usage data is sent. On by default, off by one menu click.
   *
   * Not nullable, and deliberately not eligible for a manifest default: "nobody has said" is not a
   * coherent state for a privacy choice, and a remote file that could switch analytics *on* for
   * someone who turned it off is exactly the thing the fill-versus-override rule exists to prevent.
   * The manifest can only disable it fleet-wide — see `analyticsMinutes` in the manifest schema.
   */
  analyticsEnabled: z.boolean(),

  /**
   * Random per-install id, or null until first launch mints one.
   *
   * A UUID rather than a machine fingerprint. A fingerprint would survive reinstalls, which is the
   * one thing it has going for it, and in exchange it changes under OS upgrades (inflating the
   * install count with ghosts), identifies the machine rather than the install, and needs a
   * dependency. Reinstalling therefore counts as a new install here. That is the honest trade.
   *
   * Written with a forced flush at the moment it is minted — see the note in app-shell.
   */
  installId: z.string().max(64).nullable(),
})

export type Settings = z.infer<typeof settingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  movementEnabled: true,
  waterReminderEnabled: true,
  stretchReminderEnabled: true,
  coffeeReminderEnabled: true,
  lunchReminderEnabled: true,
  // Null, not the built-in value. Writing the built-in eagerly is what made every install look like it
  // had *chosen* `large`, which is why v1.10.0 needs a migration to undo it — see below.
  alwaysOnTop: null,
  petSize: null,
  position: null,
  reminders: {
    waterNextDueAt: null,
    stretchNextDueAt: null,
    coffeeNextDueAt: null,
    lunchNextDueAt: null,
    waterMinutes: null,
    stretchMinutes: null,
  },
  lastGreetingKey: null,
  seenBroadcastIds: [],
  lastKnownRelease: null,
  analyticsEnabled: true,
  installId: null,
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

  // v3 → v4: reminder intervals became configurable. Existing installs never chose one, which is
  // exactly what null means — so they keep the built-in interval and stay eligible for a team default.
  if (out['schemaVersion'] === 3) {
    const reminders = out['reminders']
    out = {
      ...out,
      schemaVersion: 4,
      reminders:
        reminders && typeof reminders === 'object'
          ? { ...(reminders as Record<string, unknown>), waterMinutes: null, stretchMinutes: null }
          : reminders,
    }
  }

  // v4 → v5: always-on-top became a choice. It defaults to true because that is what every existing
  // install already does — an upgrade that silently sent everyone's pet behind their windows would
  // look exactly like the app having broken.
  if (out['schemaVersion'] === 4) {
    out = { ...out, schemaVersion: 5, alwaysOnTop: true }
  }

  // v5 → v6: `petSize` and `alwaysOnTop` became nullable so a team default can fill them.
  //
  // Both were written eagerly at their built-in values, so every existing file looks like a deliberate
  // choice and no default could ever reach anybody. They are treated differently on the way out, and
  // the difference is whether the stored value is *distinguishable* from never having chosen:
  //
  //   - `petSize` is nulled unconditionally. Every install has `large`, which was the built-in and the
  //     only size that existed before v1.3.0, so it carries no information. A deliberate `medium` or
  //     `small` is lost too — that was an explicit call, taken because the alternative was for the new
  //     `small` default to reach nobody at all.
  //   - `alwaysOnTop: false` is **kept**. Nobody arrives at it by accident; it takes a menu click. Only
  //     `true` is indistinguishable from the built-in, so only `true` becomes eligible.
  if (out['schemaVersion'] === 5) {
    out = {
      ...out,
      schemaVersion: 6,
      petSize: null,
      alwaysOnTop: out['alwaysOnTop'] === false ? false : null,
    }
  }

  // v6 → v7: coffee, lunch, and greetings. Existing installs never chose these, so they start on
  // with no deadline — the scheduler will pick the next clock slot without firing immediately.
  if (out['schemaVersion'] === 6) {
    const reminders = out['reminders']
    out = {
      ...out,
      schemaVersion: 7,
      coffeeReminderEnabled: true,
      lunchReminderEnabled: true,
      lastGreetingKey: null,
      reminders:
        reminders && typeof reminders === 'object'
          ? { ...(reminders as Record<string, unknown>), coffeeNextDueAt: null, lunchNextDueAt: null }
          : reminders,
    }
  }

  // v7 → v8: anonymous usage analytics. On, because an opt-out that ships off is an opt-in, and an
  // opt-in nobody sees answers none of the questions this was added to answer — see DECISIONS #103.
  //
  // `installId` stays null rather than being minted here: this function is pure and synchronous, and
  // the id has to be written back with a forced flush to be worth anything. First launch mints it.
  if (out['schemaVersion'] === 7) {
    out = { ...out, schemaVersion: 8, analyticsEnabled: true, installId: null }
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
