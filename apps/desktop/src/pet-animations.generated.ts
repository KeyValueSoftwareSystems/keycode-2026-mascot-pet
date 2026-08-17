/*
 * GENERATED FILE — DO NOT EDIT.
 * Source of truth: pet/spritesheet.json
 * Regenerate with: pnpm generate
 */

/** Every animation state the current art actually provides. */
export type AnimationState =
  | 'drink'
  | 'electrocute'
  | 'failed'
  | 'idle'
  | 'idle-left'
  | 'jumping'
  | 'jumping-left'
  | 'jumping-right'
  | 'review'
  | 'review-left'
  | 'running'
  | 'running-left'
  | 'running-right'
  | 'sleep'
  | 'sleep-enter'
  | 'sleep-exit'
  | 'stretch'
  | 'waving'

/** Every trigger the reaction map knows how to answer. */
export type Trigger =
  | 'idle'
  | 'run-left'
  | 'run-right'
  | 'broadcast-notification'
  | 'update-available'
  | 'celebrating'
  | 'water-reminder'
  | 'stretch-reminder'
  | 'coffee-reminder'
  | 'lunch-reminder'
  | 'greeting-morning'
  | 'greeting-afternoon'
  | 'greeting-evening'
  | 'hover-wave'
  | 'hover-look'
  | 'thinking'
  | 'busy'
  | 'error'
  | 'movement-disabled'
  | 'movement-enabled'
  | 'drag-release'
  | 'zap'

export interface AnimationSpec {
  /** Row in the spritesheet. */
  readonly row: number
  /** Frame count; also the `steps()` count. */
  readonly frames: number
  /** First column on the row. Non-zero for mid-row phases (e.g. sleep loop / exit). */
  readonly startColumn: number
  /** Length of one iteration. */
  readonly durationMs: number
  readonly iterations: number | 'infinite'
  /**
   * Total wall-clock length, or null when it loops forever. This is the input to the
   * animation-completion check in the motion engine — held as data on MotionState and
   * observed by the existing tick, never a setTimeout.
   */
  readonly totalMs: number | null
}

export const ANIMATIONS: { readonly [K in AnimationState]: AnimationSpec } = {
  'drink': { row: 4, frames: 11, startColumn: 0, durationMs: 2200, iterations: 2, totalMs: 4400 },
  'electrocute': { row: 11, frames: 6, startColumn: 0, durationMs: 720, iterations: 2, totalMs: 1440 },
  'failed': { row: 0, frames: 2, startColumn: 0, durationMs: 1220, iterations: 2, totalMs: 2440 },
  'idle': { row: 0, frames: 2, startColumn: 0, durationMs: 2000, iterations: 'infinite', totalMs: null },
  'idle-left': { row: 6, frames: 2, startColumn: 0, durationMs: 2000, iterations: 'infinite', totalMs: null },
  'jumping': { row: 3, frames: 19, startColumn: 0, durationMs: 4800, iterations: 1, totalMs: 4800 },
  'jumping-left': { row: 5, frames: 19, startColumn: 0, durationMs: 4800, iterations: 1, totalMs: 4800 },
  'jumping-right': { row: 3, frames: 19, startColumn: 0, durationMs: 4800, iterations: 1, totalMs: 4800 },
  'review': { row: 9, frames: 21, startColumn: 0, durationMs: 4200, iterations: 'infinite', totalMs: null },
  'review-left': { row: 10, frames: 21, startColumn: 0, durationMs: 4200, iterations: 'infinite', totalMs: null },
  'running': { row: 1, frames: 6, startColumn: 0, durationMs: 800, iterations: 'infinite', totalMs: null },
  'running-left': { row: 2, frames: 6, startColumn: 0, durationMs: 800, iterations: 'infinite', totalMs: null },
  'running-right': { row: 1, frames: 6, startColumn: 0, durationMs: 800, iterations: 'infinite', totalMs: null },
  'sleep': { row: 8, frames: 10, startColumn: 8, durationMs: 4000, iterations: 'infinite', totalMs: null },
  'sleep-enter': { row: 8, frames: 8, startColumn: 0, durationMs: 1600, iterations: 1, totalMs: 1600 },
  'sleep-exit': { row: 8, frames: 2, startColumn: 23, durationMs: 500, iterations: 1, totalMs: 500 },
  'stretch': { row: 3, frames: 19, startColumn: 0, durationMs: 5600, iterations: 1, totalMs: 5600 },
  'waving': { row: 7, frames: 18, startColumn: 0, durationMs: 2700, iterations: 1, totalMs: 2700 },
}

/** Declaration order is sorted, so this is stable across regenerations. */
export const ANIMATION_STATES = [
  'drink',
  'electrocute',
  'failed',
  'idle',
  'idle-left',
  'jumping',
  'jumping-left',
  'jumping-right',
  'review',
  'review-left',
  'running',
  'running-left',
  'running-right',
  'sleep',
  'sleep-enter',
  'sleep-exit',
  'stretch',
  'waving',
] as const satisfies readonly AnimationState[]

export const SHEET = {
  frameWidth: 192,
  frameHeight: 208,
  columns: 25,
  rows: 12,
  width: 4800,
  height: 2496,
  fileName: "spritesheet.png",
} as const

/**
 * States the behaviour spec needs but the art does not contain yet, mapped to the closest
 * thing that does exist. When the art lands, the alias disappears from spritesheet.json and
 * this table empties — no other code changes.
 */
export const ANIMATION_ALIASES: Readonly<Record<string, AnimationState>> = {
  // none — every state the reaction map names is real art
}

/**
 * trigger -> animation state, already resolved through the aliases above so callers never
 * have to think about whether a state is real art or a stand-in.
 */
export const REACTION_MAP: { readonly [K in Trigger]: AnimationState } = {
  'idle': 'idle',
  'run-left': 'running-left',
  'run-right': 'running-right',
  'broadcast-notification': 'waving',
  'update-available': 'jumping',
  'celebrating': 'jumping',
  'water-reminder': 'drink',
  'stretch-reminder': 'stretch',
  'coffee-reminder': 'drink',
  'lunch-reminder': 'waving',
  'greeting-morning': 'waving',
  'greeting-afternoon': 'waving',
  'greeting-evening': 'waving',
  'hover-wave': 'waving',
  'hover-look': 'review',
  'thinking': 'review',
  'busy': 'running',
  'error': 'failed',
  'movement-disabled': 'sleep-enter',
  'movement-enabled': 'sleep-exit',
  'drag-release': 'waving',
  'zap': 'electrocute',
}

export function isAnimationState(value: unknown): value is AnimationState {
  return typeof value === 'string' && Object.hasOwn(ANIMATIONS, value)
}

export function resolveTrigger(trigger: Trigger): AnimationState {
  return REACTION_MAP[trigger]
}
