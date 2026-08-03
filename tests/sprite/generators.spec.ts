import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error — untyped .mjs helper shared with the generators
import { loadSpritesheet } from '../../scripts/lib/spritesheet.mjs'
import {
  ANIMATIONS,
  ANIMATION_STATES,
  ANIMATION_ALIASES,
  REACTION_MAP,
  SHEET,
  isAnimationState,
  resolveTrigger,
} from '../../apps/desktop/src/pet-animations.generated.js'

const REPO = resolve(import.meta.dirname, '..', '..')
const CSS = readFileSync(resolve(REPO, 'apps/desktop/src/renderer/pet.generated.css'), 'utf8')
const SPEC = JSON.parse(readFileSync(resolve(REPO, 'pet/spritesheet.json'), 'utf8')) as {
  states: Record<string, { row: number; frames: number; durationMs: number; iterations?: unknown }>
  reactionMap: Record<string, string>
}

/** Run a generator in --check mode. Exit 0 means the committed output is fresh. */
function checkGenerator(script: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync('node', [resolve(REPO, 'scripts', script), '--check'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, output }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('generated artifacts are fresh', () => {
  // The one failure mode of committing generated files: they drift from the generator. This is
  // the same check `pnpm build` and CI run, expressed as a test so a local run catches it too.
  it('sprite CSS and TS match a fresh generation', () => {
    const result = checkGenerator('generate-sprite-css.mjs')
    expect(result.ok, result.output).toBe(true)
  })

  it('the alpha mask matches a fresh generation', () => {
    const result = checkGenerator('generate-alpha-mask.mjs')
    expect(result.ok, result.output).toBe(true)
  })

  it('the tray icon matches a fresh generation', () => {
    const result = checkGenerator('generate-tray-icon.mjs')
    expect(result.ok, result.output).toBe(true)
  })
})

describe('generated sprite CSS', () => {
  it('derives every state geometry independently of the generator', () => {
    // Recomputed here from spritesheet.json rather than copied from the generator, so a bug in
    // the generator's arithmetic cannot be mirrored by a matching bug in the test.
    for (const state of ANIMATION_STATES) {
      const spec = SPEC.states[state]!
      const y = -spec.row * SHEET.frameHeight
      const lastFrameX = -(spec.frames - 1) * SHEET.frameWidth
      const iterations = spec.iterations === undefined ? 'infinite' : String(spec.iterations)

      for (const nonce of [0, 1]) {
        expect(CSS, `${state} keyframes y offset`).toContain(
          `@keyframes kp-${state}-${nonce} {\n  from { background-position: 0 ${y}px; }\n  to { background-position: ${lastFrameX}px ${y}px; }\n}`,
        )
        expect(CSS, `${state} rule`).toContain(
          `.pet-sprite[data-state="${state}"][data-nonce="${nonce}"] {\n  animation: kp-${state}-${nonce} ${spec.durationMs}ms steps(${spec.frames}, jump-none) ${iterations} forwards;\n}`,
        )
      }
    }
  })

  it('ends each state one frame short of the past-the-end column', () => {
    // The bug this prevents: with steps(n) and `to: -n*frameWidth`, the after-phase value is
    // column n — one past the last real frame, and a confirmed-transparent free cell for both
    // `waving` (row 3) and `jumping` (row 4). With `forwards`, the pet would vanish at the end
    // of every finite reaction.
    //
    // Scoped per state, deliberately: a global search cannot work here, because one state's
    // legitimate endpoint is another's past-the-end value. `jumping` (5 frames) correctly ends at
    // -768px, which is exactly `waving`'s (4 frames) forbidden value.
    for (const state of ANIMATION_STATES) {
      const { frames } = ANIMATIONS[state]
      // Non-greedy to the closing brace on its own line: a keyframes block contains nested
      // `from { … }` braces, so a `[^}]*` character class stops at the wrong one.
      const block = CSS.match(new RegExp(`@keyframes kp-${state}-0 \\{([\\s\\S]*?)\\n\\}`))
      expect(block, `no keyframes block for ${state}`).not.toBeNull()

      const to = block![1]!.match(/to \{ background-position: (-?\d+)px/)
      expect(to, `no \`to\` endpoint for ${state}`).not.toBeNull()

      const endX = Number(to![1])
      expect(endX, `${state} must end on its last real frame`).toBe(-(frames - 1) * SHEET.frameWidth)
      expect(endX, `${state} must not reach the past-the-end column`).not.toBe(
        -frames * SHEET.frameWidth,
      )

      const rule = CSS.match(
        new RegExp(`\\[data-state="${state}"\\]\\[data-nonce="0"\\] \\{([^}]*)\\}`),
      )
      expect(rule![1]).toContain(`steps(${frames}, jump-none)`)
    }
  })

  it('keeps `failed` at 8 steps even though only 6 frames are distinct', () => {
    // The repeated tail frames are what hold the final slumped pose; "optimising" to 6 changes
    // the timing and loses the beat.
    expect(ANIMATIONS.failed.frames).toBe(8)
    expect(CSS).toContain('steps(8, jump-none)')
  })

  it('requires image-rendering: pixelated', () => {
    // Not stylistic: the default smoothing turns pixel art to mush, worst on HiDPI.
    expect(CSS).toContain('image-rendering: pixelated')
  })

  it('emits two nonce variants per state so the same state can replay', () => {
    for (const state of ANIMATION_STATES) {
      expect(CSS).toContain(`@keyframes kp-${state}-0`)
      expect(CSS).toContain(`@keyframes kp-${state}-1`)
    }
  })

  it('lets two states share a row', () => {
    // `idle` and `sleep` are the same frames at different speeds. Requiring unique rows would
    // have forced new art for a state that needs none.
    expect(ANIMATIONS.sleep.row).toBe(ANIMATIONS.idle.row)
    expect(ANIMATIONS.sleep.durationMs).toBeGreaterThan(ANIMATIONS.idle.durationMs)
  })
})

describe('generated animation module', () => {
  it('exposes totalMs only for finite animations', () => {
    for (const state of ANIMATION_STATES) {
      const spec = ANIMATIONS[state]
      if (spec.iterations === 'infinite') expect(spec.totalMs).toBeNull()
      else expect(spec.totalMs).toBe(spec.durationMs * spec.iterations)
    }
  })

  it('resolves every reaction-map trigger to a real state', () => {
    // This is what catches an art swap, or a spritesheet.json edit, that leaves a trigger
    // pointing at nothing. Before the alias table existed, `stretch-reminder` did exactly that.
    for (const trigger of Object.keys(REACTION_MAP) as Array<keyof typeof REACTION_MAP>) {
      const state = resolveTrigger(trigger)
      expect(isAnimationState(state), `${trigger} -> ${state}`).toBe(true)
    }
  })

  it('resolved `stretch` through an alias until its art landed, and now resolves it directly', () => {
    // The indirection, collected. `stretch` was specified before it was drawn, `ANIMATION_ALIASES`
    // pointed it at `jumping`, and the reaction map named `stretch` throughout. v1.9.0 drew the art, and
    // the entire wiring change was deleting one line of spritesheet.json — no code, no mapping edit.
    // These four assertions are the same four as before with two of them inverted, which is the cheapest
    // possible record of that having worked.
    expect(SPEC.reactionMap['stretch-reminder']).toBe('stretch')
    expect(ANIMATION_ALIASES.stretch).toBeUndefined()
    expect(isAnimationState('stretch')).toBe(true)
    expect(resolveTrigger('stretch-reminder')).toBe('stretch')
  })

  it('has no aliases left, and still resolves a trigger that names a real state', () => {
    expect(Object.keys(ANIMATION_ALIASES)).toEqual([])
    expect(resolveTrigger('water-reminder')).toBe('drink')
  })

  it('recognises real states and rejects invented ones', () => {
    expect(isAnimationState('idle')).toBe(true)
    expect(isAnimationState('waiting')).toBe(false) // deleted: was a duplicate of idle
    expect(isAnimationState('nonsense')).toBe(false)
    expect(isAnimationState(42)).toBe(false)
  })

  it('no longer declares the duplicate `waiting` row', () => {
    // Row 6 was byte-identical to row 0, so it was never an animation. `drink` reclaimed it, and
    // leaving both would have had `waiting` silently play a drinking animation.
    expect(ANIMATION_STATES).not.toContain('waiting')
    expect(ANIMATIONS.drink.row).toBe(6)
  })
})

describe('spritesheet validation', () => {
  const temps: string[] = []

  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function loadWith(mutate: (spec: Record<string, any>) => void): () => unknown {
    const dir = mkdtempSync(join(tmpdir(), 'keycode-sheet-'))
    temps.push(dir)
    const spec = JSON.parse(readFileSync(resolve(REPO, 'pet/spritesheet.json'), 'utf8'))
    mutate(spec)
    const path = join(dir, 'spritesheet.json')
    writeFileSync(path, JSON.stringify(spec), 'utf8')
    return () => loadSpritesheet(path)
  }

  it('rejects a row outside the sheet', () => {
    expect(loadWith((s) => (s.states.idle.row = 99))).toThrow(/row 99 is outside/)
  })

  it('rejects more frames than there are columns', () => {
    expect(loadWith((s) => (s.states.idle.frames = 99))).toThrow(/only has 8 columns/)
  })

  it('rejects fewer than two frames', () => {
    // steps(n, jump-none) is undefined for n < 2.
    expect(loadWith((s) => (s.states.idle.frames = 1))).toThrow(/at least 2 frames/)
  })

  it('rejects a non-positive duration', () => {
    expect(loadWith((s) => (s.states.idle.durationMs = 0))).toThrow(/durationMs must be positive/)
  })

  it('rejects a reaction-map target that is neither a state nor an alias', () => {
    expect(
      loadWith((s) => {
        s.reactionMap['water-reminder'] = 'nonexistent'
      }),
    ).toThrow(/neither a declared state nor an alias/)
  })

  it('rejects an alias whose target does not exist', () => {
    expect(
      loadWith((s) => {
        // A name no state uses — `stretch` was the fixture here until it became real art, at which point
        // this test started failing on the *shadowing* error instead of the one it is about.
        s.aliases.moonwalk = 'imaginary'
      }),
    ).toThrow(/points at "imaginary"/)
  })

  it('rejects an alias that shadows a real state', () => {
    // Once the art lands, the alias must be deleted rather than left to mask the real state.
    expect(
      loadWith((s) => {
        s.aliases.idle = 'jumping'
      }),
    ).toThrow(/shadows a real state/)
  })

  it('rejects inconsistent sheet geometry', () => {
    expect(loadWith((s) => (s.sheet.width = 1000))).toThrow(/geometry is inconsistent/)
  })

  it('rejects a state name that is not kebab-case', () => {
    expect(
      loadWith((s) => {
        s.states.Idle_Bad = { row: 0, frames: 4, durationMs: 100 }
      }),
    ).toThrow(/kebab-case/)
  })

  it('accepts an extended 12-row sheet with a real `stretch` state', () => {
    // The art-swap path, tested: adding rows and deleting the alias must need no code change.
    const load = loadWith((s) => {
      s.sheet.rows = 12
      s.sheet.height = 12 * 208
      s.states.stretch = { row: 9, frames: 6, durationMs: 2200, iterations: 2 }
      delete s.aliases.stretch
    })
    const result = load() as { states: Array<{ name: string; row: number }> }
    const stretch = result.states.find((st) => st.name === 'stretch')
    expect(stretch?.row).toBe(9)
  })
})
