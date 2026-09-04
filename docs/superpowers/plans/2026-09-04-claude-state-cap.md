# Claude Code State Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a coloured square on the pet's head that shows what Claude Code is doing — red waiting for confirmation, amber running, green done.

**Architecture:** Claude Code hooks write one word to `~/.argos/claude-state`. A pure-Node module in main watches that file and exposes the current word. The pet controller reads it into a new `PetFrame` field, the renderer copies that field to a `data-` attribute, and CSS paints a square anchored to the head using the custom properties the sleep Z's already use.

**Tech Stack:** TypeScript, Electron (main only), zod for the frame schema, vitest for tests, pnpm workspaces. No new dependencies.

## Global Constraints

Copied from the repo's own enforced rules — `tests/renderer/discipline.spec.ts` fails the build on each of these:

- **Runtime dependencies stay exactly `["zod"]`.** `apps/desktop/package.json` `dependencies` is asserted to equal that list. Node builtins only.
- **Every renderer file under `apps/desktop/src/renderer/` stays below 150 non-blank, non-comment code lines.** `pet.ts` is at 137 today.
- **The renderer gets no timers, no `fetch`, no `eval`, no `innerHTML`, and no `import ... from 'electron'`.** Set attributes and `textContent`, nothing else.
- **Hand-written CSS contains no `steps(`, no `192px`, no `208px`.** Animation geometry has one source, `pet/spritesheet.json`.
- **No source file may contain the words `plugin`, `plugins`, `marketplace`, `catalog`, `lan-`, `lease` or `leases` in code** (comments are stripped before the check, but avoid them anyway).
- **Tests are Electron-free.** `vitest.config.ts` runs in the `node` environment. Anything a test touches must not import `electron`.
- Tests live at `tests/**/*.spec.ts`. Run with `pnpm test`.
- Platform target for this spike: **macOS**. The Linux shape-region fix is included because it is one expression, but it is not verified here.

## File Structure

**Created:**

- `apps/desktop/src/claude/claude-state-source.ts` — owns the state file: reads it, watches it, reports changes. Pure Node, no Electron, so it unit-tests against a temp directory. This is the only file that changes when multi-session lands.
- `tests/claude/claude-state-source.spec.ts` — its tests.
- `tests/main/frame-region.spec.ts` — tests the frame schema's new field and the shape-region predicate.
- `docs/CLAUDE-CODE.md` — the hook snippet a user pastes into `~/.claude/settings.json`, and how to test without Claude.

**Modified:**

- `apps/desktop/src/pet-frame.ts` — adds `CLAUDE_STATES`, the `claudeState` frame field, and `frameNeedsCellRegion()`.
- `apps/desktop/src/main/pet-controller.ts` — a `getClaudeState` option, read in `buildFrame()`.
- `apps/desktop/src/main/pet-window.ts:186,338` — the shape region follows the cap as well as the sleep overlay.
- `apps/desktop/src/main/app-shell.ts:353,1018` — starts the source, feeds the controller, stops it on dispose.
- `apps/desktop/src/renderer/pet.html` — one `div`.
- `apps/desktop/src/renderer/pet.ts` — one attribute assignment.
- `apps/desktop/src/renderer/pet.css` — the square.
- `tests/renderer/discipline.spec.ts` — asserts the renderer publishes the attribute and the CSS consumes it.

**Not unit-tested, deliberately:** the `app-shell.ts` wiring. There is no `PetWindow` or `DisplayManager` fake in the repo today and building one for four lines of wiring is not worth it. Typecheck plus the manual test in Task 5 covers it. This is a real gap, stated rather than hidden.

---

### Task 1: The state source

**Files:**
- Create: `apps/desktop/src/claude/claude-state-source.ts`
- Create: `tests/claude/claude-state-source.spec.ts`
- Modify: `apps/desktop/src/pet-frame.ts` (add `CLAUDE_STATES` only — the frame field comes in Task 2)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CLAUDE_STATES: readonly ['none', 'waiting', 'running', 'idle']` and `type ClaudeState`, both exported from `apps/desktop/src/pet-frame.ts`.
  - `defaultClaudeStateFile(): string`
  - `createClaudeStateSource(options: ClaudeStateSourceOptions): ClaudeStateSource`
  - `ClaudeStateSource = { start(): void; stop(): void; current(): ClaudeState; refresh(): ClaudeState }`
  - `ClaudeStateSourceOptions = { file?: string; now?: () => number; pollMs?: number; onChange?: (state: ClaudeState) => void; log?: (message: string, meta?: unknown) => void }`
  - `CLAUDE_STATE_STALE_MS: number`

- [ ] **Step 1: Add the state list to the shared frame module**

The list lives in `pet-frame.ts` rather than in the source module because both main and the renderer bundle need the type, and the renderer must never pull in `node:fs`. One list, two consumers.

Add near the top of `apps/desktop/src/pet-frame.ts`, just below the existing `TONES` declaration:

```ts
/**
 * Claude Code's state, as the pet displays it.
 *
 * `none` is the absence of a signal — no state file, an unreadable one, or one too old to
 * believe — and paints no cap at all. Every failure resolves here, because a status indicator
 * that lies is worse than one that is absent: an absent cap is visibly absent, a wrong cap is
 * silently wrong.
 */
export const CLAUDE_STATES = ['none', 'waiting', 'running', 'idle'] as const
export type ClaudeState = (typeof CLAUDE_STATES)[number]
```

- [ ] **Step 2: Write the failing tests**

Create `tests/claude/claude-state-source.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createClaudeStateSource,
  CLAUDE_STATE_STALE_MS,
} from '../../apps/desktop/src/claude/claude-state-source.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'argos-claude-'))
  file = join(dir, 'claude-state')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** `refresh()` rather than the poll, so no test depends on a timer firing. */
function sourceFor(onChange?: (s: string) => void) {
  return createClaudeStateSource({ file, onChange })
}

describe('claude state source', () => {
  it('reports none when the file does not exist', () => {
    expect(sourceFor().refresh()).toBe('none')
  })

  it('reports none when the whole directory is missing', () => {
    const source = createClaudeStateSource({ file: join(dir, 'nope', 'claude-state') })
    expect(source.refresh()).toBe('none')
  })

  it.each(['waiting', 'running', 'idle'])('reads %s', (word) => {
    writeFileSync(file, `${word}\n`)
    expect(sourceFor().refresh()).toBe(word)
  })

  it('ignores surrounding whitespace and case', () => {
    writeFileSync(file, '  WAITING  \n')
    expect(sourceFor().refresh()).toBe('waiting')
  })

  it('treats an unknown word as none', () => {
    writeFileSync(file, 'thinking')
    expect(sourceFor().refresh()).toBe('none')
  })

  it('treats an empty file as none', () => {
    writeFileSync(file, '')
    expect(sourceFor().refresh()).toBe('none')
  })

  it('treats a stale file as none, however good its contents', () => {
    // A session killed with Ctrl+C never fires SessionEnd, so the file outlives the session.
    writeFileSync(file, 'waiting')
    const old = new Date(Date.now() - CLAUDE_STATE_STALE_MS - 60_000)
    utimesSync(file, old, old)
    expect(sourceFor().refresh()).toBe('none')
  })

  it('picks up a change on the next refresh', () => {
    writeFileSync(file, 'running')
    const source = sourceFor()
    expect(source.refresh()).toBe('running')
    writeFileSync(file, 'waiting')
    expect(source.refresh()).toBe('waiting')
  })

  it('reports a deletion as none', () => {
    writeFileSync(file, 'running')
    const source = sourceFor()
    expect(source.refresh()).toBe('running')
    rmSync(file)
    expect(source.refresh()).toBe('none')
  })

  it('fires onChange once per distinct state, not once per read', () => {
    const seen: string[] = []
    const source = sourceFor((s) => seen.push(s))
    writeFileSync(file, 'running')
    source.refresh()
    source.refresh()
    writeFileSync(file, 'running\n')
    source.refresh()
    writeFileSync(file, 'waiting')
    source.refresh()
    expect(seen).toEqual(['running', 'waiting'])
  })

  it('exposes the last read through current() without touching the disk', () => {
    writeFileSync(file, 'idle')
    const source = sourceFor()
    source.refresh()
    rmSync(file)
    expect(source.current()).toBe('idle')
  })

  it('creates the directory on start so the watch has something to watch', () => {
    // Without this the watch silently does nothing until the first hook happens to create the
    // directory, which looks exactly like the feature not working.
    const nested = join(dir, 'made-by-start', 'claude-state')
    const source = createClaudeStateSource({ file: nested })
    source.start()
    source.stop()
    expect(existsSync(join(dir, 'made-by-start'))).toBe(true)
  })

  it('start() then stop() leaves no live handles', () => {
    const source = sourceFor()
    source.start()
    expect(() => source.stop()).not.toThrow()
    expect(() => source.stop()).not.toThrow()
  })
})
```

- [ ] **Step 3: Run the tests and watch them fail**

```bash
pnpm test -- tests/claude/claude-state-source.spec.ts
```

Expected: every test fails to even load — `Failed to resolve import ".../claude/claude-state-source.js"`.

- [ ] **Step 4: Write the implementation**

Create `apps/desktop/src/claude/claude-state-source.ts`:

```ts
/**
 * Claude Code's state, read off a file that Claude Code's hooks write.
 *
 * The transport is a file holding one word, because a hook that is `echo running > file` cannot
 * fail in an interesting way: no JSON to parse, no port to bind, no dependency on either side.
 *
 * No Electron import. This module is the one place that knows how the state arrives, so it is
 * also the only file that changes when multi-session support lands — at which point it reads a
 * directory of per-session files and aggregates them instead.
 */

import { mkdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CLAUDE_STATES, type ClaudeState } from '../pet-frame.js'

/**
 * How old a state file may be before it is disbelieved.
 *
 * A session killed with Ctrl+C may never fire its `SessionEnd` hook, leaving a file that would
 * otherwise pin the cap on for the rest of the day. The mtime is the guard, which is why the
 * file holds only a word: the timestamp already exists in the filesystem, and putting a second
 * one in the payload would be a second source of truth for the same fact.
 */
export const CLAUDE_STATE_STALE_MS = 15 * 60_000

/** How often to re-read regardless of the watch. See `start()`. */
const DEFAULT_POLL_MS = 5_000

export function defaultClaudeStateFile(): string {
  return process.env.ARGOS_CLAUDE_STATE_FILE ?? join(homedir(), '.argos', 'claude-state')
}

export interface ClaudeStateSourceOptions {
  /** Defaults to `defaultClaudeStateFile()`. */
  file?: string
  /** Injected so tests can drive staleness without waiting a quarter of an hour. */
  now?: () => number
  pollMs?: number
  onChange?: (state: ClaudeState) => void
  log?: (message: string, meta?: unknown) => void
}

export interface ClaudeStateSource {
  start(): void
  stop(): void
  /** The last state read. Cheap: no disk access. */
  current(): ClaudeState
  /** Re-read now and report a change if there is one. Returns the new state. */
  refresh(): ClaudeState
}

const KNOWN = new Set<string>(CLAUDE_STATES)

function readState(file: string, nowMs: number): ClaudeState {
  let raw: string
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
    raw = readFileSync(file, 'utf8')
  } catch {
    // Missing, unreadable, a directory, a permission error — all the same answer.
    return 'none'
  }
  if (nowMs - mtimeMs > CLAUDE_STATE_STALE_MS) return 'none'
  const word = raw.trim().toLowerCase()
  return KNOWN.has(word) ? (word as ClaudeState) : 'none'
}

export function createClaudeStateSource(
  options: ClaudeStateSourceOptions = {},
): ClaudeStateSource {
  const file = options.file ?? defaultClaudeStateFile()
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const onChange = options.onChange ?? ((): void => {})
  const log = options.log ?? ((): void => {})

  let state: ClaudeState = 'none'
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null

  const refresh = (): ClaudeState => {
    const next = readState(file, now())
    if (next !== state) {
      state = next
      onChange(state)
    }
    return state
  }

  return {
    current: () => state,
    refresh,

    start(): void {
      // Make the directory ourselves so the watch has a target from the first launch, rather
      // than silently doing nothing until the first hook happens to create it.
      try {
        mkdirSync(dirname(file), { recursive: true })
      } catch (error) {
        log('claude-state: could not create the state directory', error)
      }

      refresh()

      // Watch the *directory*, not the file: a writer that replaces the file swaps the inode,
      // and a file-level watch is then pointed at something nothing will ever touch again.
      try {
        watcher = watch(dirname(file), { persistent: false }, () => {
          refresh()
        })
      } catch (error) {
        log('claude-state: directory watch unavailable, polling only', error)
      }

      // Backstop. fs.watch misses events on some platforms and filesystems, and a missed event
      // here means a cap stuck on the wrong colour — the one failure the whole feature is
      // supposed to prevent.
      timer = setInterval(refresh, pollMs)
      timer.unref?.()
    },

    stop(): void {
      watcher?.close()
      watcher = null
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
pnpm test -- tests/claude/claude-state-source.spec.ts
```

Expected: PASS, 15 tests.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/claude/claude-state-source.ts apps/desktop/src/pet-frame.ts tests/claude/claude-state-source.spec.ts
git commit -m "feat: read Claude Code's state from a file

One word in ~/.argos/claude-state, written by Claude Code hooks. The
hook is 'echo running > file' so it cannot fail in an interesting way.

The file's mtime is the staleness guard, which is why the payload is a
bare word: a session killed with Ctrl+C never fires SessionEnd, and the
timestamp the guard needs already exists in the filesystem.

Watches the directory rather than the file, because a writer that
replaces the file swaps the inode and leaves a file-level watch pointed
at nothing."
```

---

### Task 2: The frame field and the square

**Files:**
- Modify: `apps/desktop/src/pet-frame.ts`
- Modify: `apps/desktop/src/renderer/pet.html`
- Modify: `apps/desktop/src/renderer/pet.ts`
- Modify: `apps/desktop/src/renderer/pet.css`
- Create: `tests/main/frame-region.spec.ts`
- Modify: `tests/renderer/discipline.spec.ts`

**Interfaces:**
- Consumes: `CLAUDE_STATES`, `ClaudeState` from Task 1.
- Produces:
  - `PetFrame.claudeState: ClaudeState` — a required field, so every existing frame construction site must set it (there is exactly one, in Task 3).
  - `frameNeedsCellRegion(frame: Pick<PetFrame, 'overlay' | 'claudeState'>): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/main/frame-region.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  petFrameSchema,
  frameNeedsCellRegion,
  type PetFrame,
} from '../../apps/desktop/src/pet-frame.js'

function frame(overrides: Partial<PetFrame> = {}): PetFrame {
  return {
    animation: 'idle',
    animationNonce: 0,
    facing: 'right',
    sprite: { x: 0, y: 0 },
    bubbleSide: 'above',
    scale: 1,
    bubble: null,
    quickActions: [],
    overlay: 'none',
    claudeState: 'none',
    ...overrides,
  }
}

describe('claudeState on the frame', () => {
  it.each(['none', 'waiting', 'running', 'idle'] as const)('round-trips %s', (state) => {
    const parsed = petFrameSchema.safeParse(frame({ claudeState: state }))
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.claudeState).toBe(state)
  })

  it('rejects a state the renderer has no colour for', () => {
    expect(petFrameSchema.safeParse(frame({ claudeState: 'busy' as never })).success).toBe(false)
  })

  it('is required, so no frame can reach the renderer without one', () => {
    const { claudeState: _dropped, ...without } = frame()
    expect(petFrameSchema.safeParse(without).success).toBe(false)
  })
})

describe('frameNeedsCellRegion', () => {
  // Electron's setShape decides where the system permits *drawing*, not just where clicks land.
  // Anything outside the region is never painted. The cap sits over the hair, which is
  // transparent in the alpha mask, so without this it would be invisible on Linux — and the
  // screenshot harness would not catch it, because capturePage() ignores the window shape.
  it('is false for a plain frame', () => {
    expect(frameNeedsCellRegion(frame())).toBe(false)
  })

  it('is true while the sleep Z-s are up', () => {
    expect(frameNeedsCellRegion(frame({ overlay: 'sleep-z' }))).toBe(true)
  })

  it.each(['waiting', 'running', 'idle'] as const)('is true while the cap is %s', (state) => {
    expect(frameNeedsCellRegion(frame({ claudeState: state }))).toBe(true)
  })

  it('is true when both are up at once', () => {
    // A sleeping pet still wears the cap. This is why claudeState is its own field rather than
    // another value on `overlay`.
    expect(frameNeedsCellRegion(frame({ overlay: 'sleep-z', claudeState: 'waiting' }))).toBe(true)
  })
})
```

Then add to `tests/renderer/discipline.spec.ts`, inside the existing
`describe('hand-written CSS carries no generated geometry', ...)` block, after the
`anchors the bubble to the character` test:

```ts
  it('anchors the status cap to the character through the same custom properties', () => {
    // Two halves in two files again: the renderer publishes the state, the CSS paints it. Either
    // half being dropped leaves a cap that is silently never shown, which looks exactly like
    // "Claude is not running" and so would not be noticed.
    const pet = read(join(RENDERER_DIR, 'pet.ts'))
    expect(pet).toContain('claudeState')

    const css = read(join(RENDERER_DIR, 'pet.css'))
    expect(css).toMatch(/#claude-cap/)
    expect(css).toMatch(/\[data-claude-state='waiting'\]/)
    expect(css).toMatch(/\[data-claude-state='running'\]/)
    expect(css).toMatch(/\[data-claude-state='idle'\]/)
    // The cap tracks the head, not the window corner.
    expect(css).toMatch(/#claude-cap[\s\S]*?var\(--body-cx/)
  })
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
pnpm test -- tests/main/frame-region.spec.ts tests/renderer/discipline.spec.ts
```

Expected: `frame-region.spec.ts` fails to import `frameNeedsCellRegion`; the discipline test fails on `expect(pet).toContain('claudeState')`.

- [ ] **Step 3: Add the field and the predicate**

In `apps/desktop/src/pet-frame.ts`, inside `petFrameSchema`, directly after the `overlay` field:

```ts
  /**
   * Claude Code's state, painted as a coloured cap on the pet's head.
   *
   * Its own field rather than another value on `overlay`, because the two are independent axes:
   * `overlay` is single-valued and already owned by the sleep Z's, and a sleeping pet must still
   * be able to wear the cap. Folding them together would make "asleep and waiting"
   * unrepresentable.
   */
  claudeState: z.enum(CLAUDE_STATES),
```

Then, at the end of the file, after the `IPC` declaration:

```ts
/**
 * Does this frame paint anything outside the character's own mask but inside the sprite cell?
 *
 * `setShape` determines the area where the system permits *drawing* — outside it, no pixels are
 * drawn at all. The sleep Z's sit above the hair and the status cap sits on it, both in mask
 * cells that are transparent, so both need the region widened to the whole cell or they are
 * silently invisible on Linux. See the long note in `sprite/alpha-mask.ts`.
 *
 * A function here rather than an expression at the call site so it can be tested without a
 * window: `pet-window.ts` is Electron all the way down.
 */
export function frameNeedsCellRegion(
  frame: Pick<PetFrame, 'overlay' | 'claudeState'>,
): boolean {
  return frame.overlay !== 'none' || frame.claudeState !== 'none'
}
```

- [ ] **Step 4: Add the element**

In `apps/desktop/src/renderer/pet.html`, directly after the `#zzz` div:

```html
    <!-- Claude Code status cap. A square for now; the real cap art will inherit this anchor. -->
    <div id="claude-cap" aria-hidden="true"></div>
```

- [ ] **Step 5: Publish the state from the renderer**

In `apps/desktop/src/renderer/pet.ts`, in `applyFrame`, directly after the existing
`root.dataset.overlay = frame.overlay` line:

```ts
  root.dataset.claudeState = frame.claudeState
```

One attribute assignment and no branch, which is the only shape of change this file accepts.

- [ ] **Step 6: Paint the square**

Append to `apps/desktop/src/renderer/pet.css`:

```css
/*
  Claude Code status cap.

  A plain square standing in for cap art, positioned exactly where the art will go so the
  anchoring proven here is the anchoring the art inherits. `--body-cx` and `--body-top` are
  published per animation state and already multiplied by the scale, so this tracks the head
  through every pose and every pet size without any arithmetic of its own.
*/
#claude-cap {
  position: absolute;
  left: var(--body-cx, 50%);
  top: calc(var(--body-top, 0px) - 3px * var(--pet-scale, 1));
  width: calc(26px * var(--pet-scale, 1));
  height: calc(13px * var(--pet-scale, 1));
  transform: translateX(-50%);
  display: none;
  pointer-events: none;
  border-radius: 3px;
  /* A dark keyline so the square reads against light wallpaper as well as dark. */
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.5),
    0 1px 3px rgba(0, 0, 0, 0.35);
}

html[data-claude-state='waiting'] #claude-cap {
  display: block;
  background: #e5484d;
}

html[data-claude-state='running'] #claude-cap {
  display: block;
  background: #f5a524;
}

html[data-claude-state='idle'] #claude-cap {
  display: block;
  background: #30a46c;
}
```

- [ ] **Step 7: Run the tests**

```bash
pnpm test -- tests/main/frame-region.spec.ts tests/renderer/discipline.spec.ts
```

Expected: PASS. If `stays small enough to read in one sitting` fails, `pet.ts` has crossed 150 code lines — it was at 137 and this adds one, so a failure means something else grew.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/pet-frame.ts apps/desktop/src/renderer/pet.html apps/desktop/src/renderer/pet.ts apps/desktop/src/renderer/pet.css tests/main/frame-region.spec.ts tests/renderer/discipline.spec.ts
git commit -m "feat: carry Claude Code's state across the frame seam

Adds PetFrame.claudeState and a coloured square anchored to the pet's
head through --body-cx / --body-top, the same properties the sleep Z's
use, so it tracks the head through every pose and every pet size.

A separate field from overlay because the two are independent axes: a
sleeping pet must still be able to wear the cap.

frameNeedsCellRegion() exists as a function rather than an expression in
pet-window so it can be tested without Electron. It matters because
setShape governs painting, not just hit-testing, and the cap sits in
transparent mask cells."
```

---

### Task 3: Feed the state into the frame

**Files:**
- Modify: `apps/desktop/src/main/pet-controller.ts`
- Modify: `apps/desktop/src/main/pet-window.ts`

**Interfaces:**
- Consumes: `ClaudeState` and `frameNeedsCellRegion` from Task 2.
- Produces: `PetControllerOptions.getClaudeState?: () => ClaudeState`, defaulting to `() => 'none'`.

- [ ] **Step 1: Add the controller option**

In `apps/desktop/src/main/pet-controller.ts`, change the frame-type import to bring in the state type:

```ts
import type { ClaudeState, PetFrame, Tone } from '../pet-frame.js'
```

Add to `PetControllerOptions`, after `getMovementEnabled`:

```ts
  /**
   * Claude Code's state, for the status cap.
   *
   * Injected as a getter, like `getMovementEnabled`, so the controller stays ignorant of where
   * the state comes from and the tests need no filesystem.
   */
  getClaudeState?: () => ClaudeState
```

- [ ] **Step 2: Default it and read it**

In `createPetController`, beside the other option defaults (next to `const now = options.now ?? Date.now`):

```ts
  const getClaudeState = options.getClaudeState ?? ((): ClaudeState => 'none')
```

In `buildFrame()`, after the `overlay:` line:

```ts
      claudeState: getClaudeState(),
```

- [ ] **Step 3: Widen the shape region for the cap**

In `apps/desktop/src/main/pet-window.ts`, add to the existing frame-module import:

```ts
import { frameNeedsCellRegion } from '../pet-frame.js'
```

(If `pet-window.ts` already imports named values from `../pet-frame.js`, add `frameNeedsCellRegion` to that import rather than writing a second one.)

Replace the comment on the `lastOverlayVisible` declaration near line 186:

```ts
  /**
   * Whether the last frame painted inside the sprite cell but outside the character mask — the
   * sleep Z's, or the Claude status cap. Drives the shape region, which on Linux governs what is
   * painted at all.
   */
```

And replace the assignment near line 338:

```ts
      lastOverlayVisible = frameNeedsCellRegion(parsed.data)
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: clean. A `claudeState` missing from an object literal here means a second frame construction site exists that this plan did not account for — set it to `'none'` and note it.

- [ ] **Step 5: Run the whole suite**

```bash
pnpm test
```

Expected: PASS, including everything that existed before.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/pet-controller.ts apps/desktop/src/main/pet-window.ts
git commit -m "feat: put the Claude status cap on the frame and in the shape region

getClaudeState is injected like getMovementEnabled, so the controller
stays ignorant of where the state came from.

The shape region now follows the cap as well as the sleep overlay. On
Linux that region governs painting, not just hit-testing, and the cap
sits over the hair in mask cells that are transparent - so without this
it would be invisible there, and the screenshot harness would not catch
it because capturePage() never consults the window shape."
```

---

### Task 4: Wire it into the app

**Files:**
- Modify: `apps/desktop/src/main/app-shell.ts`

**Interfaces:**
- Consumes: `createClaudeStateSource` from Task 1, `getClaudeState` from Task 3.
- Produces: nothing further.

- [ ] **Step 1: Import the source**

In `apps/desktop/src/main/app-shell.ts`, beside the other main-process imports (near the `createPetController` import at line 27):

```ts
import { createClaudeStateSource } from '../claude/claude-state-source.js'
```

- [ ] **Step 2: Start it before the controller**

Immediately before the `controller = createPetController({` call (around line 353):

```ts
  // Claude Code's state, for the cap. `tickNow` rather than waiting for the next tick: a colour
  // that lags the terminal by a tick is not worth having, and `tickNow` is the existing seam for
  // exactly this — it runs the tick body out of phase without resetting the interval.
  const claudeState = createClaudeStateSource({
    log,
    onChange() {
      controller?.tickNow()
    },
  })
  claudeState.start()
```

- [ ] **Step 3: Hand it to the controller**

In the `createPetController({ ... })` options object, after `getMovementEnabled`:

```ts
    getClaudeState: () => claudeState.current(),
```

- [ ] **Step 4: Stop it on dispose**

In `dispose()`, beside `controller?.stop()` (around line 1018):

```ts
      claudeState.stop()
```

- [ ] **Step 5: Typecheck and run the suite**

```bash
pnpm typecheck && pnpm test
```

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/app-shell.ts
git commit -m "feat: start the Claude state source with the app

A state change calls tickNow() rather than waiting for the next tick, so
the cap changes colour when the terminal does. tickNow is the existing
seam for out-of-phase updates and does not reset the interval."
```

---

### Task 5: The hooks, and proving it works

**Files:**
- Create: `docs/CLAUDE-CODE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing in code.

- [ ] **Step 1: Write the documentation**

Create `docs/CLAUDE-CODE.md`:

````markdown
# Claude Code status cap

The pet wears a coloured square that follows what Claude Code is doing.

| Colour | Meaning |
|---|---|
| 🔴 red | Claude Code is waiting for you to confirm something |
| 🟡 amber | Claude Code is working |
| 🟢 green | the task finished; ready for a new one |
| *no cap* | no Claude Code session, or the last signal is over 15 minutes old |

This is a spike: a square, not cap art, and a single session. Two sessions at once will fight
over the colour.

## How it works

Claude Code hooks write one word to `~/.argos/claude-state`. Argos watches that file. That is
the whole mechanism — no port, no daemon, no dependency in either direction. If Argos is not
running, the hooks write a file nothing reads, and nothing breaks.

## Setup

Add this to `~/.claude/settings.json`. If the file already has a `hooks` key, merge into it
rather than replacing it.

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.argos && echo waiting > ~/.argos/claude-state"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.argos && echo running > ~/.argos/claude-state"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.argos && echo running > ~/.argos/claude-state"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.argos && echo running > ~/.argos/claude-state"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.argos && echo idle > ~/.argos/claude-state"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "rm -f ~/.argos/claude-state" }]
      }
    ]
  }
}
```

`PreToolUse` is what returns the cap to amber after you approve a prompt — answering a
permission request does not fire `Notification` again.

## Testing it without Claude

With Argos running:

```bash
mkdir -p ~/.argos
echo waiting > ~/.argos/claude-state   # red
echo running > ~/.argos/claude-state   # amber
echo idle    > ~/.argos/claude-state   # green
rm ~/.argos/claude-state               # gone
```

The colour changes within a second. This is the integration test worth running first: if these
work and the hooks do not, the hooks are the only remaining variable.

Point Argos at a different file with `ARGOS_CLAUDE_STATE_FILE`.

## Limits

- **One session.** The last hook to fire wins, whichever session it came from.
- **Stale state.** A session killed with `Ctrl+C` never fires `SessionEnd`. Its file lingers, and
  the cap stays until the file is 15 minutes old.
- **macOS only, so far.** The Linux shape-region handling is written but unverified.
````

- [ ] **Step 2: Link it from the README**

In `README.md`, add a row to the feature table or a line in the docs list pointing at
`docs/CLAUDE-CODE.md`:

```markdown
**It watches Claude Code.** Wire up a few hooks and the pet wears a coloured cap: red when Claude
Code needs a confirmation, amber while it works, green when it is done. See
[docs/CLAUDE-CODE.md](docs/CLAUDE-CODE.md).
```

- [ ] **Step 3: Build and run**

```bash
pnpm build && pnpm dev
```

Expected: the pet appears with no cap.

- [ ] **Step 4: Prove the integration by hand**

In a second terminal, with the pet on screen:

```bash
mkdir -p ~/.argos
echo waiting > ~/.argos/claude-state
```

Expected: a red square appears on the pet's head within a second. Then:

```bash
echo running > ~/.argos/claude-state   # turns amber
echo idle    > ~/.argos/claude-state   # turns green
rm ~/.argos/claude-state               # disappears
```

Check the cap stays on the head while the pet **walks**, **jumps** and **sleeps** (leave it
alone, or turn movement off). A cap that detaches during a pose means `--body-top` is not being
tracked per state.

Check it at all three sizes — right-click → Size. The square should scale with the pet.

- [ ] **Step 5: Prove the hooks**

Add the hooks from Step 1 to `~/.claude/settings.json`, start a Claude Code session, and give it
a task that needs a permission prompt. Expected: amber while it works, red at the prompt, amber
again once approved, green when it stops.

- [ ] **Step 6: Full verification, then commit**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: all three clean.

```bash
git add docs/CLAUDE-CODE.md README.md
git commit -m "docs: how to wire Claude Code's state to the pet

Includes the settings.json hook block and, more usefully, how to drive
the cap with echo so the transport can be proven before the hooks are
the variable under test."
```

---

## Done when

- `pnpm typecheck`, `pnpm test` and `pnpm build` are all clean.
- `echo waiting > ~/.argos/claude-state` turns the square red on a running pet, and `rm` removes it.
- The square stays on the head while the pet walks, jumps and sleeps, at all three sizes.
- A real Claude Code session drives the colour through amber → red → amber → green.
- Nothing is pushed. The work sits on the local `claude-integration` branch.
