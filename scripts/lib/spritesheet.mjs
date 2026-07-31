/**
 * Load and validate `pet/spritesheet.json`.
 *
 * Shared by both generators so validation happens once and neither can drift from the other's
 * idea of what the file means.
 */

import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..', '..')
export const SPRITESHEET_JSON = join(ROOT, 'pet', 'spritesheet.json')
export const SPRITESHEET_PNG = join(ROOT, 'pet', 'spritesheet.png')

/** Minimum frames per state. `steps(n, jump-none)` is undefined for n < 2. */
const MIN_FRAMES = 2

export class SpritesheetError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SpritesheetError'
  }
}

/**
 * @typedef {object} StateSpec
 * @property {string} name
 * @property {number} row
 * @property {number} frames
 * @property {number} durationMs
 * @property {number | 'infinite'} iterations
 * @property {number | null} totalMs Wall-clock length, or null when it loops forever.
 */

export function loadSpritesheet(path = SPRITESHEET_JSON) {
  const spec = JSON.parse(readFileSync(path, 'utf8'))
  const sheet = spec.sheet
  if (!sheet) throw new SpritesheetError('spritesheet.json has no `sheet` block.')

  for (const key of ['width', 'height', 'frameWidth', 'frameHeight', 'columns', 'rows']) {
    if (!Number.isInteger(sheet[key]) || sheet[key] <= 0) {
      throw new SpritesheetError(`sheet.${key} must be a positive integer, got ${sheet[key]}.`)
    }
  }
  if (sheet.columns * sheet.frameWidth !== sheet.width) {
    throw new SpritesheetError(
      `sheet geometry is inconsistent: columns*frameWidth = ${sheet.columns * sheet.frameWidth} but width = ${sheet.width}.`,
    )
  }
  if (sheet.rows * sheet.frameHeight !== sheet.height) {
    throw new SpritesheetError(
      `sheet geometry is inconsistent: rows*frameHeight = ${sheet.rows * sheet.frameHeight} but height = ${sheet.height}.`,
    )
  }

  const rawStates = spec.states ?? {}
  const names = Object.keys(rawStates).filter((n) => !n.startsWith('$'))
  if (names.length === 0) throw new SpritesheetError('spritesheet.json declares no states.')

  /** @type {StateSpec[]} */
  const states = []
  for (const name of names) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new SpritesheetError(
        `state "${name}" must be lowercase kebab-case — it becomes a CSS attribute value and a TS union member.`,
      )
    }
    const raw = rawStates[name]
    const { row, frames, durationMs } = raw

    if (!Number.isInteger(row) || row < 0 || row >= sheet.rows) {
      throw new SpritesheetError(`state "${name}" row ${row} is outside 0..${sheet.rows - 1}.`)
    }
    if (!Number.isInteger(frames) || frames < MIN_FRAMES) {
      throw new SpritesheetError(
        `state "${name}" needs at least ${MIN_FRAMES} frames (got ${frames}); steps(n, jump-none) is undefined below that.`,
      )
    }
    if (frames > sheet.columns) {
      throw new SpritesheetError(
        `state "${name}" declares ${frames} frames but the sheet only has ${sheet.columns} columns.`,
      )
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new SpritesheetError(`state "${name}" durationMs must be positive, got ${durationMs}.`)
    }

    // Absent `iterations` means a sustained loop. Only an explicit integer is finite.
    const iterations = raw.iterations === undefined ? 'infinite' : raw.iterations
    if (iterations !== 'infinite' && (!Number.isInteger(iterations) || iterations < 1)) {
      throw new SpritesheetError(
        `state "${name}" iterations must be a positive integer or "infinite", got ${JSON.stringify(iterations)}.`,
      )
    }

    states.push({
      name,
      row,
      frames,
      durationMs,
      iterations,
      totalMs: iterations === 'infinite' ? null : durationMs * iterations,
    })
  }

  states.sort((a, b) => a.name.localeCompare(b.name))
  const stateNames = new Set(states.map((s) => s.name))

  // Two states sharing a row is legitimate — `idle` and `sleep` are the same frames at
  // different speeds — so rows are deliberately NOT checked for uniqueness.

  const aliases = {}
  for (const [from, to] of Object.entries(spec.aliases ?? {})) {
    if (from.startsWith('$')) continue
    if (stateNames.has(from)) {
      throw new SpritesheetError(
        `alias "${from}" shadows a real state; delete the alias now that the art exists.`,
      )
    }
    if (!stateNames.has(to)) {
      throw new SpritesheetError(`alias "${from}" points at "${to}", which is not a declared state.`)
    }
    aliases[from] = to
  }

  const reactionMap = {}
  for (const [trigger, target] of Object.entries(spec.reactionMap ?? {})) {
    if (trigger.startsWith('$')) continue
    if (!/^[a-z][a-z0-9-]*$/.test(trigger)) {
      throw new SpritesheetError(`trigger "${trigger}" must be lowercase kebab-case.`)
    }
    const resolved = stateNames.has(target) ? target : aliases[target]
    if (!resolved) {
      // The failure this catches: a reactionMap entry naming a state nobody ever drew. Left
      // unchecked it is a runtime dead end that only shows up when that trigger fires.
      throw new SpritesheetError(
        `trigger "${trigger}" maps to "${target}", which is neither a declared state nor an alias. ` +
          `Declare the state, or add an alias for it in the \`aliases\` block.`,
      )
    }
    reactionMap[trigger] = resolved
  }

  return { sheet, states, aliases, reactionMap, raw: spec }
}
