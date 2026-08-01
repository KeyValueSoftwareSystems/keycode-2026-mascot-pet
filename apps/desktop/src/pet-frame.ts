/**
 * THE SEAM. One serializable object main -> renderer; one boolean renderer -> main.
 *
 * Main owns every piece of truth: which animation is playing, which way the pet faces, where it
 * is, whether a bubble is showing, what the bubble says. The renderer owns geometry and nothing
 * else — it sets attributes, sets `textContent`, hit-tests against the alpha mask, and reports
 * whether the pointer is over the pet.
 *
 * This is enforced by a test that greps the renderer for timers, fetch, and behavioural
 * branching, not by good intentions.
 *
 * No Electron import here: this module is shared by main and by the sandboxed renderer bundle.
 */

import { z } from 'zod'
import { ANIMATION_STATES } from './pet-animations.generated.js'

export const TONES = ['info', 'success', 'warning', 'error'] as const
export type Tone = (typeof TONES)[number]

/** Bubble text is clamped in main before it ever reaches here. */
export const BUBBLE_TEXT_MAX = 200

export const petFrameSchema = z.strictObject({
  /**
   * Validated against the *generated* state list, so the set of legal animations has exactly
   * one definition. A broadcast payload naming an unknown animation is rejected by the same
   * source of truth that the CSS was generated from — there is no second hand-written list to
   * drift out of sync.
   */
  animation: z.enum(ANIMATION_STATES),

  /**
   * Flipped by main on every animation assignment, including re-assignment of the same state.
   *
   * A CSS animation restarts only when `animation-name` changes, so replaying the same state
   * needs a different name — hence two byte-identical keyframe rules per state, selected by
   * this nonce. Keeping it in main keeps "should this replay" as behaviour, which is main's job;
   * the renderer just copies it to an attribute.
   */
  animationNonce: z.union([z.literal(0), z.literal(1)]),

  facing: z.enum(['left', 'right']),

  /** Sprite cell's top-left inside the window, so the renderer never hardcodes layout. */
  sprite: z.strictObject({ x: z.number().int(), y: z.number().int() }),

  /**
   * Sprite scale — 0.5, 0.75 or 1. Applied as a CSS transform from the cell's top-left.
   *
   * Bounded rather than a free number: the renderer sets it as a custom property that multiplies
   * every geometric offset in the stylesheet, so a nonsense value there paints the pet somewhere
   * unrecoverable. Main is the only thing that picks it, and the seam re-validates it anyway.
   */
  scale: z.number().gt(0).lte(4),

  bubble: z
    .strictObject({
      /** Already sanitised and clamped by main. The renderer only ever `textContent`s it. */
      text: z.string().max(BUBBLE_TEXT_MAX),
      tone: z.enum(TONES),
      pinned: z.boolean(),
      /**
       * Whether the bubble has a link behind it.
       *
       * A boolean rather than the URL: the renderer shows an affordance and calls
       * `openCalloutUrl()`, and main looks up the URL it already validated. A renderer that
       * cannot name a URL cannot be talked into opening a bad one.
       */
      clickable: z.boolean(),
    })
    .nullable(),

  /** Pure-CSS overlays. `sleep-z` is what lets `sleep` ship with no new art. */
  overlay: z.enum(['none', 'sleep-z']),
})

export type PetFrame = z.infer<typeof petFrameSchema>

/** Main -> renderer: force a hit-test at coordinates main computed. See mouse-forwarding.ts. */
export const pointerProbeSchema = z.strictObject({
  clientX: z.number(),
  clientY: z.number(),
  inside: z.boolean(),
})

export type PointerProbe = z.infer<typeof pointerProbeSchema>

/** IPC channel names, in one place so main and preload cannot disagree about them. */
export const IPC = {
  frame: 'keycode-pet:frame',
  pointerProbe: 'keycode-pet:pointer-probe',
  pointerOverPet: 'keycode-pet:pointer-over-pet',
  rendererReady: 'keycode-pet:renderer-ready',
  contextMenu: 'keycode-pet:context-menu',
  dragStart: 'keycode-pet:drag-start',
  dragEnd: 'keycode-pet:drag-end',
  openCalloutUrl: 'keycode-pet:open-callout-url',
} as const
