/*
 * GENERATED FILE — DO NOT EDIT.
 * Source of truth: pet/spritesheet.json
 * Regenerate with: pnpm generate
 */

/** Every animation state the current art actually provides. */
export type AnimationState =
  | 'drink'
  | 'failed'
  | 'idle'
  | 'jumping'
  | 'review'
  | 'running'
  | 'running-left'
  | 'running-right'
  | 'sleep'
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
  | 'thinking'
  | 'busy'
  | 'error'
  | 'movement-disabled'
  | 'movement-enabled'
  | 'drag-release'

export interface AnimationSpec {
  /** Row in the spritesheet. */
  readonly row: number
  /** Frame count; also the `steps()` count. */
  readonly frames: number
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
  'drink': { row: 6, frames: 6, durationMs: 1800, iterations: 2, totalMs: 3600 },
  'failed': { row: 5, frames: 8, durationMs: 1220, iterations: 2, totalMs: 2440 },
  'idle': { row: 0, frames: 6, durationMs: 5500, iterations: 'infinite', totalMs: null },
  'jumping': { row: 4, frames: 5, durationMs: 840, iterations: 2, totalMs: 1680 },
  'review': { row: 8, frames: 6, durationMs: 1030, iterations: 'infinite', totalMs: null },
  'running': { row: 7, frames: 6, durationMs: 820, iterations: 'infinite', totalMs: null },
  'running-left': { row: 2, frames: 8, durationMs: 1060, iterations: 'infinite', totalMs: null },
  'running-right': { row: 1, frames: 8, durationMs: 1060, iterations: 'infinite', totalMs: null },
  'sleep': { row: 0, frames: 6, durationMs: 16000, iterations: 'infinite', totalMs: null },
  'waving': { row: 3, frames: 4, durationMs: 700, iterations: 2, totalMs: 1400 },
}

/** Declaration order is sorted, so this is stable across regenerations. */
export const ANIMATION_STATES = [
  'drink',
  'failed',
  'idle',
  'jumping',
  'review',
  'running',
  'running-left',
  'running-right',
  'sleep',
  'waving',
] as const satisfies readonly AnimationState[]

export const SHEET = {
  frameWidth: 192,
  frameHeight: 208,
  columns: 8,
  rows: 9,
  width: 1536,
  height: 1872,
  fileName: "spritesheet.png",
} as const

/**
 * States the behaviour spec needs but the art does not contain yet, mapped to the closest
 * thing that does exist. When the art lands, the alias disappears from spritesheet.json and
 * this table empties — no other code changes.
 */
export const ANIMATION_ALIASES: Readonly<Record<string, AnimationState>> = {
  'stretch': 'jumping',
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
  'stretch-reminder': 'jumping',
  'thinking': 'review',
  'busy': 'running',
  'error': 'failed',
  'movement-disabled': 'sleep',
  'movement-enabled': 'idle',
  'drag-release': 'jumping',
}

export function isAnimationState(value: unknown): value is AnimationState {
  return typeof value === 'string' && Object.hasOwn(ANIMATIONS, value)
}

export function resolveTrigger(trigger: Trigger): AnimationState {
  return REACTION_MAP[trigger]
}
