#!/usr/bin/env node
/**
 * Generate the sprite CSS and the AnimationState TypeScript union from pet/spritesheet.json.
 *
 *   node scripts/generate-sprite-css.mjs [--check] [--hold-strategy jump-none|explicit-last]
 *
 * `pet/spritesheet.json` is the only place animation geometry exists. Nobody hand-writes a
 * row offset, a frame count or a `steps()` anywhere — which is what makes "swap the art, change
 * no code" true rather than aspirational.
 *
 * ---------------------------------------------------------------------------------------
 * TWO CORRECTNESS DECISIONS, both of which look like style choices and are not.
 * ---------------------------------------------------------------------------------------
 *
 * 1. **Per-state @keyframes, duplicated per nonce — NOT one shared @keyframes driven by CSS
 *    custom properties.**
 *
 *    The tempting design (and the one openpets uses) is a single `@keyframes pet-frames` whose
 *    endpoints read `var(--sprite-frames)` etc., with per-state rules that only re-point those
 *    custom properties. It is compact, and it is wrong for us.
 *
 *    Per CSS Animations, a running animation is cancelled and recreated only when
 *    `animation-name` changes. Changing duration or iteration count — however expressed —
 *    mutates the animation's timing *in place* and preserves its current local time. So with
 *    one animation started once at load, local time grows monotonically for the whole session.
 *    Selecting a finite state (`waving`, 700ms x 2 = 1400ms) after five minutes of uptime means
 *    local time already vastly exceeds the active duration: the animation is immediately in its
 *    *finished* state and paints only the after-phase value — one static frame, not a play.
 *
 *    Giving every state its own `@keyframes` makes every state change an `animation-name`
 *    change, which is the one restart guarantee the spec actually offers. Re-triggering the
 *    *same* state still would not restart (the name is unchanged), so each state gets two
 *    byte-identical keyframe rules and main flips a nonce between them. Restart policy stays in
 *    main, where behaviour belongs, instead of becoming an imperative reflow hack in the
 *    renderer.
 *
 * 2. **`steps(n, jump-none)` with the `to` endpoint one frame short — NOT plain `steps(n)`.**
 *
 *    With `steps(n)` (i.e. `jump-end`) and `to: -n*frameWidth`, the after-phase computed value
 *    is column *n* — one past the last real frame. For `waving` (4 frames on row 3) that is
 *    column 4, and `freeCells` confirms it is fully transparent. With
 *    `animation-fill-mode: forwards`, THE PET WOULD VANISH at the end of every finite reaction.
 *
 *    `steps(n, jump-none)` with `to: -(n-1)*frameWidth` instead yields output progress
 *    `floor(input*n)/(n-1)`: exactly the values 0, 1/(n-1), ..., 1, each held for
 *    `duration/n`, mapping precisely onto columns 0..n-1. The after-phase value is column
 *    n-1 — the genuine last frame — so `forwards` holds the correct pose. Looping states are
 *    visually unchanged.
 *
 *    `--hold-strategy explicit-last` is a pre-built escape hatch: it emits plain `steps(n)`
 *    plus a 99.9%/100% keyframe pair pinned to the last real frame. Switching is one flag, not
 *    a rewrite, in case `jump-none` misbehaves in a specific Chromium.
 */

import { join } from 'node:path'
import { loadSpritesheet, ROOT } from './lib/spritesheet.mjs'
import { emitOrCheck, reportResults, cssBanner, tsBanner } from './lib/generated-file.mjs'

const CSS_OUT = join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'pet.generated.css')
const TS_OUT = join(ROOT, 'apps', 'desktop', 'src', 'pet-animations.generated.ts')

/** Both nonce values. Main alternates between them to force a restart of the same state. */
const NONCES = [0, 1]

function keyframesName(state, nonce) {
  return `kp-${state}-${nonce}`
}

function buildCss(sheet, states, holdStrategy) {
  const lines = [cssBanner()]

  lines.push(
    '.pet-sprite {',
    `  width: ${sheet.frameWidth}px;`,
    `  height: ${sheet.frameHeight}px;`,
    '  background-repeat: no-repeat;',
    `  background-size: ${sheet.width}px ${sheet.height}px;`,
    '  background-position: 0 0;',
    '  /* REQUIRED, not stylistic: without it the browser smooths the pixel art into mush,',
    '     and it is worst on exactly the HiDPI displays this is developed on. */',
    '  image-rendering: pixelated;',
    '}',
    '',
  )

  for (const state of states) {
    const y = -state.row * sheet.frameHeight
    const lastFrameX = -(state.frames - 1) * sheet.frameWidth
    const pastEndX = -state.frames * sheet.frameWidth
    const iterations = state.iterations === 'infinite' ? 'infinite' : String(state.iterations)

    for (const nonce of NONCES) {
      const name = keyframesName(state.name, nonce)
      if (holdStrategy === 'explicit-last') {
        lines.push(
          `@keyframes ${name} {`,
          `  from { background-position: 0 ${y}px; }`,
          `  99.9% { background-position: ${pastEndX}px ${y}px; }`,
          `  to { background-position: ${lastFrameX}px ${y}px; }`,
          '}',
        )
      } else {
        lines.push(
          `@keyframes ${name} {`,
          `  from { background-position: 0 ${y}px; }`,
          `  to { background-position: ${lastFrameX}px ${y}px; }`,
          '}',
        )
      }
    }

    const timing = holdStrategy === 'explicit-last' ? `steps(${state.frames})` : `steps(${state.frames}, jump-none)`
    for (const nonce of NONCES) {
      lines.push(
        `.pet-sprite[data-state="${state.name}"][data-nonce="${nonce}"] {`,
        `  animation: ${keyframesName(state.name, nonce)} ${state.durationMs}ms ${timing} ${iterations} forwards;`,
        '}',
      )
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function buildTs(sheet, states, aliases, reactionMap) {
  const names = states.map((s) => s.name)
  const union = names.map((n) => `'${n}'`).join('\n  | ')
  const triggers = Object.keys(reactionMap)

  const specEntries = states
    .map(
      (s) =>
        `  '${s.name}': { row: ${s.row}, frames: ${s.frames}, durationMs: ${s.durationMs}, ` +
        `iterations: ${s.iterations === 'infinite' ? "'infinite'" : s.iterations}, ` +
        `totalMs: ${s.totalMs === null ? 'null' : s.totalMs} },`,
    )
    .join('\n')

  const aliasEntries = Object.entries(aliases)
    .map(([from, to]) => `  '${from}': '${to}',`)
    .join('\n')

  const reactionEntries = Object.entries(reactionMap)
    .map(([trigger, state]) => `  '${trigger}': '${state}',`)
    .join('\n')

  return `${tsBanner()}
/** Every animation state the current art actually provides. */
export type AnimationState =
  | ${union}

/** Every trigger the reaction map knows how to answer. */
export type Trigger =
${triggers.map((t) => `  | '${t}'`).join('\n')}

export interface AnimationSpec {
  /** Row in the spritesheet. */
  readonly row: number
  /** Frame count; also the \`steps()\` count. */
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
${specEntries}
}

/** Declaration order is sorted, so this is stable across regenerations. */
export const ANIMATION_STATES = [
${names.map((n) => `  '${n}',`).join('\n')}
] as const satisfies readonly AnimationState[]

export const SHEET = {
  frameWidth: ${sheet.frameWidth},
  frameHeight: ${sheet.frameHeight},
  columns: ${sheet.columns},
  rows: ${sheet.rows},
  width: ${sheet.width},
  height: ${sheet.height},
  fileName: ${JSON.stringify(sheet.fileName)},
} as const

/**
 * States the behaviour spec needs but the art does not contain yet, mapped to the closest
 * thing that does exist. When the art lands, the alias disappears from spritesheet.json and
 * this table empties — no other code changes.
 */
export const ANIMATION_ALIASES: Readonly<Record<string, AnimationState>> = {
${aliasEntries || '  // none — every state the reaction map names is real art'}
}

/**
 * trigger -> animation state, already resolved through the aliases above so callers never
 * have to think about whether a state is real art or a stand-in.
 */
export const REACTION_MAP: { readonly [K in Trigger]: AnimationState } = {
${reactionEntries}
}

export function isAnimationState(value: unknown): value is AnimationState {
  return typeof value === 'string' && Object.hasOwn(ANIMATIONS, value)
}

export function resolveTrigger(trigger: Trigger): AnimationState {
  return REACTION_MAP[trigger]
}
`
}

function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const strategyIndex = argv.indexOf('--hold-strategy')
  const holdStrategy = strategyIndex === -1 ? 'jump-none' : argv[strategyIndex + 1]
  if (!['jump-none', 'explicit-last'].includes(holdStrategy)) {
    console.error(`Unknown --hold-strategy ${holdStrategy}; expected jump-none or explicit-last.`)
    process.exit(2)
  }

  const { sheet, states, aliases, reactionMap } = loadSpritesheet()

  const results = [
    emitOrCheck(CSS_OUT, buildCss(sheet, states, holdStrategy), { check }),
    emitOrCheck(TS_OUT, buildTs(sheet, states, aliases, reactionMap), { check }),
  ]

  reportResults(`sprite css/ts (${states.length} states, hold=${holdStrategy})`, results, { check })
}

main()
