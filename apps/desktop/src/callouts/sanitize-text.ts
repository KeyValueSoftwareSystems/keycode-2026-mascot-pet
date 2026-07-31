/**
 * Sanitise text destined for a bubble.
 *
 * The bubble is remote input rendered into a window that floats above everything on someone's
 * machine. `textContent` closes script injection completely — but not spoofing, and that is the gap
 * this module exists for.
 *
 * A right-to-left override can make the *visible* text differ from what the manifest says. Nothing
 * about `textContent` prevents it: the characters are inert, they just reorder everything after them.
 * Zero-width characters can likewise hide content inside an apparently short string. In a bubble that
 * floats above every other window, that is the residual attack surface once XSS is dealt with.
 *
 * Kept out: C0/C1 controls, line/paragraph separators, bidi overrides and isolates, zero-width
 * space/non-joiner/marks and the BOM.
 *
 * Kept IN, deliberately: U+200D (zero-width joiner) and U+FE0F (variation selector-16). Stripping
 * those breaks emoji — 👩‍💻 becomes two separate glyphs and ❤️ loses its colour — and emoji are the
 * whole reason the bundled font exists.
 */

import { CALLOUT_TEXT_MAX } from '../config/constants.js'

/** Bidi overrides and isolates (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI): the spoofing mechanism. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g

/**
 * Zero-width characters — but NOT U+200D (ZWJ) or U+FE0F (VS16).
 *
 * Those two are load-bearing for emoji: without ZWJ, a family or profession emoji falls apart into
 * its component glyphs, and without VS16 a symbol renders monochrome instead of in colour.
 */
const ZERO_WIDTH = /[\u200B\u200C\u200E\u200F\uFEFF]/g

/** C0 and C1 controls, plus the line and paragraph separators. */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g

/** Any run of whitespace, including the newlines a multi-line message would carry. */
const WHITESPACE_RUN = /\s+/g

export interface SanitizeResult {
  text: string
  truncated: boolean
  /** True when anything was removed, so a caller can log a suspicious payload. */
  strippedControls: boolean
}

export function sanitizeBubbleTextDetailed(raw: string, max = CALLOUT_TEXT_MAX): SanitizeResult {
  // NFC first: composing before measuring means a decomposed string cannot smuggle extra length
  // past the cap, and comparisons downstream (coalescing, dedupe) see a canonical form.
  const normalized = raw.normalize('NFC')

  const cleaned = normalized
    .replace(CONTROLS, '')
    .replace(BIDI_CONTROLS, '')
    .replace(ZERO_WIDTH, '')

  const collapsed = cleaned.replace(WHITESPACE_RUN, ' ').trim()

  const truncated = collapsed.length > max
  // Slice to max-1 and append the ellipsis, so the result never exceeds the cap the schema promises.
  const text = truncated ? `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…` : collapsed

  return {
    text,
    truncated,
    strippedControls: cleaned.length !== normalized.length,
  }
}

export function sanitizeBubbleText(raw: string, max = CALLOUT_TEXT_MAX): string {
  return sanitizeBubbleTextDetailed(raw, max).text
}
