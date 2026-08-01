/**
 * The broadcast manifest, parsed and clamped. Pure.
 *
 * Every byte here is remote input that ends up rendered in a window floating above everything on
 * someone's machine, so the hardening *is* the feature.
 *
 * ---------------------------------------------------------------------------------------
 * Strict envelope, forgiving entries.
 * ---------------------------------------------------------------------------------------
 *
 * docs/PROMPT.md §4.5 says "Zod, `.strict()`. Unknown fields rejected" and "<=32 notifications" but
 * never says whether *one* malformed entry invalidates the batch. With a naive
 * `z.array(strictNotification)` it does — and that means a single typo'd field in one announcement
 * silences every announcement for every install, which is a global outage of the headline feature
 * caused by a typo.
 *
 * So: the envelope is strict (a malformed envelope means we cannot trust anything, and the poll
 * simply retries in five minutes), while entries are parsed individually and a bad one costs only
 * itself. Dropped entries are counted so the failure is visible in a log rather than silent.
 */

import { z } from 'zod'
import {
  BROADCAST_DURATION_MS,
  CALLOUT_DEFAULT_MS,
  CALLOUT_TEXT_MAX,
  MANIFEST_MAX_NOTIFICATIONS,
} from '../config/constants.js'
import { isAnimationState, type AnimationState } from '../pet-animations.generated.js'
import { sanitizeBubbleText } from '../callouts/sanitize-text.js'
import { safeUrl } from './url-guard.js'
import type { Tone } from '../pet-frame.js'
import type { Priority } from '../callouts/callout-arbiter.js'

/** Animation used when a manifest names one that does not exist. */
export const FALLBACK_ANIMATION: AnimationState = 'waving'

const TONES = ['info', 'success', 'warning', 'error'] as const
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

/**
 * `id` is a persistence key: it goes into `seenBroadcastIds` and decides "shown exactly once, ever".
 * Charset-restricted and length-capped, and deliberately not trimmed or normalised — a key that
 * changes shape between writes is a key that shows a message twice.
 */
export const notificationSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, 'id must be [A-Za-z0-9._-]'),
  // Generous here, clamped hard below: a long message should be truncated, not dropped.
  text: z.string().min(1).max(2_000),
  tone: z.enum(TONES).default('info'),
  priority: z.enum(PRIORITIES).default('normal'),
  animation: z.string().max(64).optional(),
  durationMs: z.number().finite().optional(),
  startsAt: z.string().max(40).optional(),
  expiresAt: z.string().max(40).optional(),
  url: z.string().max(2_048).optional(),
})

export const releaseSchema = z.strictObject({
  latestVersion: z.string().min(1).max(64),
  notesUrl: z.string().max(2_048),
  mandatory: z.boolean().default(false),
})

/**
 * Team-wide *defaults*, never overrides.
 *
 * These apply only where the user has never made the choice locally, which is what `null` means in
 * the settings file. Remote text must not be able to switch someone's reminders back on after they
 * turned them off, or change a setting they deliberately picked — that turns an untrusted file into
 * remote control of a machine.
 *
 * Deliberately intervals only. `petSize` was considered and left out: it is a cosmetic personal
 * preference, so a team default for it has no reason to exist, and supporting one would mean adding a
 * "never chosen" state to `petSize` purely to enable it.
 *
 * ⚠ **Adding this block to a published manifest breaks every client older than v1.4.0.** The envelope
 * is strict, so an older build rejects the whole file on an unknown top-level key and silently shows
 * nothing at all — not just the defaults. `pnpm manifest:publish` refuses to upload a manifest
 * containing `defaults` without an explicit flag for exactly this reason.
 */
/*
 * NOT a strictObject, unlike the envelope around it.
 *
 * The envelope is strict so a typo'd top-level key is a loud failure rather than a setting that
 * mysteriously has no effect. Inside a block that is *designed to grow*, strictness inverts into a
 * liability: every new default would make every already-installed client reject the whole manifest and
 * stop receiving announcements entirely. Unknown keys are dropped instead, so a client older than a
 * given default simply ignores it — which is what forward compatibility means here.
 *
 * The failure modes are not comparable. An ignored unknown key costs one default not applying. A
 * rejected envelope costs every announcement, for everyone, silently.
 */
export const defaultsSchema = z.object({
  waterMinutes: z.number().int().min(1).max(1_440).optional(),
  stretchMinutes: z.number().int().min(1).max(1_440).optional(),
  /**
   * How often to re-fetch this manifest, in minutes. Self-referential on purpose: each poll reads the
   * value that will govern the next one.
   *
   * Shortening it takes effect at the next poll. *Lengthening* it is the direction to be careful with —
   * a very long value is only recoverable after that long has elapsed, because clients have to fetch
   * the file to learn it changed.
   */
  pollMinutes: z.number().int().min(1).max(1_440).optional(),
})

export const envelopeSchema = z.strictObject({
  version: z.literal(1),
  // `unknown` so each element is parsed on its own — see the module comment.
  notifications: z.array(z.unknown()).max(256).default([]),
  release: releaseSchema.optional(),
  defaults: defaultsSchema.optional(),
})

export interface SafeDefaults {
  waterMinutes: number | null
  stretchMinutes: number | null
  pollMinutes: number | null
}

export interface SafeNotification {
  id: string
  text: string
  tone: Tone
  priority: Priority
  animation: AnimationState
  /**
   * Explicit display duration in ms, or **null when the entry did not set one**.
   *
   * Null is not "use the default" — it means the notification stays until the person clicks it. An
   * announcement worth broadcasting to everybody is worth acknowledging, and a bubble that vanishes
   * after six seconds is one you can miss entirely by looking away.
   */
  durationMs: number | null
  /** -Infinity when absent, so comparisons need no special case. */
  startsAtMs: number
  /** +Infinity when absent. */
  expiresAtMs: number
  url: string | null
}

export interface SafeRelease {
  latestVersion: string
  notesUrl: string | null
  mandatory: boolean
}

export interface ParsedManifest {
  notifications: SafeNotification[]
  release: SafeRelease | null
  /** Team defaults, or null when the manifest carries none. */
  defaults: SafeDefaults | null
  /** Entries rejected individually, with reasons, so a bad manifest is diagnosable. */
  dropped: Array<{ index: number; reason: string }>
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Parse an ISO-8601 timestamp *with* an offset.
 *
 * Requiring an explicit offset is what makes the comparison unambiguous: `2026-08-01T09:00:00` means
 * different instants in different timezones, and a broadcast window that shifts by the reader's
 * location is not a schedule.
 */
function parseInstant(raw: string): number | null {
  if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw)) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/** Parse and clamp one entry. Returns a reason string instead of throwing. */
export function parseNotification(raw: unknown): SafeNotification | { error: string } {
  const parsed = notificationSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { error: `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}` }
  }
  const entry = parsed.data

  const text = sanitizeBubbleText(entry.text, CALLOUT_TEXT_MAX)
  if (text.length === 0) return { error: 'text is empty after sanitising' }

  const startsAtMs = entry.startsAt === undefined ? -Infinity : parseInstant(entry.startsAt)
  if (startsAtMs === null) return { error: `startsAt is not an ISO timestamp with an offset` }

  const expiresAtMs = entry.expiresAt === undefined ? Infinity : parseInstant(entry.expiresAt)
  if (expiresAtMs === null) return { error: `expiresAt is not an ISO timestamp with an offset` }

  if (startsAtMs >= expiresAtMs) return { error: 'startsAt is not before expiresAt' }

  // An unknown animation falls back rather than dropping the entry: the message still matters even if
  // whoever wrote it guessed at a state name. `isAnimationState` is derived from the generated union,
  // so there is no second hand-written list to drift.
  const animation =
    entry.animation !== undefined && isAnimationState(entry.animation)
      ? entry.animation
      : FALLBACK_ANIMATION

  // Null when the entry set no duration, which means "stays until clicked" rather than "use the
  // default". Set one only when the message genuinely should disappear on its own.
  const durationMs = Number.isFinite(entry.durationMs)
    ? clamp(entry.durationMs as number, BROADCAST_DURATION_MS.min, BROADCAST_DURATION_MS.max)
    : null

  // A bad URL costs the link, not the message: the callout is simply not clickable.
  const url = entry.url === undefined ? null : (safeUrl(entry.url)?.toString() ?? null)

  return {
    id: entry.id,
    text,
    tone: entry.tone,
    priority: entry.priority,
    animation,
    durationMs,
    startsAtMs,
    expiresAtMs,
    url,
  }
}

/**
 * Parse a manifest body. Returns null when the *envelope* is unusable.
 *
 * Null means "trust nothing from this response"; an empty notification list with entries in `dropped`
 * means "the manifest was fine, these particular messages were not".
 */
export function parseManifest(body: string): ParsedManifest | null {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }

  const envelope = envelopeSchema.safeParse(json)
  if (!envelope.success) return null

  const notifications: SafeNotification[] = []
  const dropped: ParsedManifest['dropped'] = []

  // Cap before parsing, so the bound is on work done rather than on survivors — a manifest with 200
  // entries must not cost 200 parses.
  const candidates = envelope.data.notifications.slice(0, MANIFEST_MAX_NOTIFICATIONS)

  const seenIds = new Set<string>()
  candidates.forEach((candidate, index) => {
    const result = parseNotification(candidate)
    if ('error' in result) {
      dropped.push({ index, reason: result.error })
      return
    }
    if (seenIds.has(result.id)) {
      // A duplicate id inside one manifest would make "shown once" ambiguous.
      dropped.push({ index, reason: `duplicate id ${result.id}` })
      return
    }
    seenIds.add(result.id)
    notifications.push(result)
  })

  let release: SafeRelease | null = null
  if (envelope.data.release) {
    const raw = envelope.data.release
    release = {
      latestVersion: raw.latestVersion,
      notesUrl: safeUrl(raw.notesUrl)?.toString() ?? null,
      mandatory: raw.mandatory,
    }
  }

  const defaults: SafeDefaults | null = envelope.data.defaults
    ? {
        waterMinutes: envelope.data.defaults.waterMinutes ?? null,
        stretchMinutes: envelope.data.defaults.stretchMinutes ?? null,
        pollMinutes: envelope.data.defaults.pollMinutes ?? null,
      }
    : null

  return { notifications, release, defaults, dropped }
}

/**
 * The entries that should be shown now: live, in window, and not already seen.
 *
 * Sorted by rank then id so that several going live at once appear in a deterministic order rather
 * than in whatever order the file happened to list them.
 */
export function selectDue(
  notifications: readonly SafeNotification[],
  now: number,
  seen: ReadonlySet<string>,
): SafeNotification[] {
  const rank: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 }
  return notifications
    .filter(
      (entry) => entry.startsAtMs <= now && now < entry.expiresAtMs && !seen.has(entry.id),
    )
    .sort((a, b) => rank[b.priority] - rank[a.priority] || a.id.localeCompare(b.id))
}
