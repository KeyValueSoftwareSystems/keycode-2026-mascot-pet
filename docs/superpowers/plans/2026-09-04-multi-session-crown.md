# Multi-Session Crown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the crown report the loudest state across every running Claude Code session instead of whichever one moved last.

**Architecture:** Each session's hooks write `~/.argos/sessions/$PPID`. The state source reads the directory, drops sessions whose pid is dead and greens that have expired, and reduces the rest by `waiting > running > idle`. Nothing outside `claude-state-source.ts` changes.

**Tech Stack:** TypeScript, Node builtins only, vitest. No new dependencies.

## Global Constraints

- **Runtime dependencies stay exactly `["zod"]`.** Asserted by `tests/renderer/discipline.spec.ts`.
- **No source file may contain the words `plugin`, `plugins`, `marketplace`, `catalog`, `lan-`, `lease` or `leases` in code.**
- **Tests are Electron-free** (`vitest.config.ts` runs the `node` environment) and must not depend on real processes, real sleeping, or the developer's own `~/.argos`.
- **`PetFrame.claudeState` keeps its four values** — `none | waiting | running | idle`. If this plan makes you change the frame schema, the aggregation has leaked out of the state source and something is wrong.
- Platform target: **macOS**. `process.kill(pid, 0)` behaves the same on Linux; Windows is unverified either way.
- Tests live at `tests/**/*.spec.ts`. Run with `pnpm test`. `pnpm` is not installed globally on the dev machine — use `corepack pnpm`, or put a shim on `PATH` with `corepack enable --install-directory <dir> pnpm`.

## File Structure

**Modified:**

- `apps/desktop/src/claude/claude-state-source.ts` — the whole change. Gains a directory read, a liveness check, green expiry, the reduction, and pruning. Grows from ~130 to ~200 lines, which is still one responsibility: *how the state arrives*.
- `tests/claude/claude-state-source.spec.ts` — rewritten around a session directory.
- `docs/CLAUDE-CODE.md` — new hook block, new limits.
- `~/.claude/settings.json` — the user's hooks (Task 4, done by hand with a backup).

**Not modified, deliberately:** `pet-frame.ts`, `pet-controller.ts`, `pet-window.ts`, `app-shell.ts`, the renderer, the crown art and the generators. The aggregation is invisible above `current()`.

---

### Task 1: Read a directory of sessions and reduce it

**Files:**
- Modify: `apps/desktop/src/claude/claude-state-source.ts`
- Modify: `tests/claude/claude-state-source.spec.ts`

**Interfaces:**
- Consumes: `CLAUDE_STATES`, `ClaudeState` from `pet-frame.ts` (unchanged).
- Produces:
  - `defaultClaudeSessionDir(): string` — replaces `defaultClaudeStateFile()`.
  - `ClaudeStateSourceOptions` gains `dir?: string`, `isAlive?: (pid: number) => boolean`, `greenTtlMs?: number`; **loses** `file`.
  - `GREEN_TTL_MS`, `SESSION_MAX_AGE_MS` exported for the tests.
  - `ClaudeStateSource` keeps `start` / `stop` / `current` / `refresh` exactly as they are.

- [ ] **Step 1: Replace the test file**

The old tests are all about one file, so this replaces rather than extends. Write
`tests/claude/claude-state-source.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createClaudeStateSource,
  GREEN_TTL_MS,
  SESSION_MAX_AGE_MS,
} from '../../apps/desktop/src/claude/claude-state-source.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'argos-claude-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write one session's state. `ageMs` backdates it, for the expiry rules. */
function session(pid: number, word: string, ageMs = 0): void {
  const path = join(dir, String(pid))
  writeFileSync(path, `${word}\n`)
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs)
    utimesSync(path, when, when)
  }
}

/** Every pid alive unless the test says otherwise. No real processes are involved. */
function sourceFor(options: { dead?: number[]; onChange?: (s: string) => void } = {}) {
  const dead = new Set(options.dead ?? [])
  return createClaudeStateSource({
    dir,
    isAlive: (pid) => !dead.has(pid),
    onChange: options.onChange,
  })
}

describe('reducing sessions to one crown', () => {
  it('is bare-headed with no sessions at all', () => {
    expect(sourceFor().refresh()).toBe('none')
  })

  it('is bare-headed when the directory does not exist', () => {
    const source = createClaudeStateSource({ dir: join(dir, 'nope'), isAlive: () => true })
    expect(source.refresh()).toBe('none')
  })

  it.each(['waiting', 'running', 'idle'])('reports a lone %s session', (word) => {
    session(1, word)
    expect(sourceFor().refresh()).toBe(word)
  })

  it('lets waiting beat running, however many are running', () => {
    // The whole point: the one session that needs a human wins, whichever terminal it is in.
    session(1, 'running')
    session(2, 'running')
    session(3, 'waiting')
    expect(sourceFor().refresh()).toBe('waiting')
  })

  it('lets running beat idle', () => {
    session(1, 'idle')
    session(2, 'running')
    expect(sourceFor().refresh()).toBe('running')
  })

  it('does not care what order the sessions are read in', () => {
    session(9, 'idle')
    session(2, 'waiting')
    session(40, 'running')
    expect(sourceFor().refresh()).toBe('waiting')
  })
})

describe('liveness', () => {
  it('ignores a session whose process is gone', () => {
    session(1, 'waiting')
    session(2, 'running')
    expect(sourceFor({ dead: [1] }).refresh()).toBe('running')
  })

  it('is bare-headed when every session is dead', () => {
    session(1, 'waiting')
    expect(sourceFor({ dead: [1] }).refresh()).toBe('none')
  })

  it('deletes the dead session file rather than reading it forever', () => {
    session(1, 'waiting')
    sourceFor({ dead: [1] }).refresh()
    expect(existsSync(join(dir, '1'))).toBe(false)
  })

  it('keeps a live session file', () => {
    session(1, 'waiting')
    sourceFor().refresh()
    expect(existsSync(join(dir, '1'))).toBe(true)
  })

  it('ignores an ancient file even when something now holds that pid', () => {
    // A dead session's file plus a recycled pid would otherwise read as alive forever.
    session(1, 'waiting', SESSION_MAX_AGE_MS + 60_000)
    expect(sourceFor().refresh()).toBe('none')
  })
})

describe('green decay', () => {
  it('drops green once it has gone stale', () => {
    // Green means "just finished, come look". A signal that is always on is not a signal.
    session(1, 'idle', GREEN_TTL_MS + 60_000)
    expect(sourceFor().refresh()).toBe('none')
  })

  it('keeps green inside the window', () => {
    session(1, 'idle', Math.floor(GREEN_TTL_MS / 2))
    expect(sourceFor().refresh()).toBe('idle')
  })

  it('does not decay waiting, however long the prompt goes unanswered', () => {
    // The shipped single-session version dropped the red crown after 15 minutes, because a
    // session sitting at a permission prompt never touches its file while it waits. That is
    // exactly when the crown matters most.
    session(1, 'waiting', GREEN_TTL_MS * 10)
    expect(sourceFor().refresh()).toBe('waiting')
  })

  it('does not decay running', () => {
    session(1, 'running', GREEN_TTL_MS * 10)
    expect(sourceFor().refresh()).toBe('running')
  })

  it('still finds a waiting session behind a decayed green', () => {
    session(1, 'idle', GREEN_TTL_MS + 60_000)
    session(2, 'waiting')
    expect(sourceFor().refresh()).toBe('waiting')
  })
})

describe('junk in the session directory', () => {
  it('ignores a filename that is not a pid', () => {
    writeFileSync(join(dir, 'claude-state'), 'waiting')
    writeFileSync(join(dir, '.DS_Store'), 'waiting')
    expect(sourceFor().refresh()).toBe('none')
  })

  it('ignores a subdirectory', () => {
    mkdirSync(join(dir, '123'))
    expect(sourceFor().refresh()).toBe('none')
  })

  it('ignores an empty file and an unknown word', () => {
    session(1, '')
    session(2, 'thinking')
    expect(sourceFor().refresh()).toBe('none')
  })

  it('ignores a session claiming none', () => {
    session(1, 'none')
    session(2, 'running')
    expect(sourceFor().refresh()).toBe('running')
  })
})

describe('change reporting', () => {
  it('fires onChange once per distinct result, not once per read', () => {
    const seen: string[] = []
    const source = sourceFor({ onChange: (s) => seen.push(s) })
    session(1, 'running')
    source.refresh()
    source.refresh()
    session(2, 'running')
    source.refresh()
    session(3, 'waiting')
    source.refresh()
    expect(seen).toEqual(['running', 'waiting'])
  })

  it('exposes the last result through current() without touching the disk', () => {
    session(1, 'running')
    const source = sourceFor()
    source.refresh()
    rmSync(join(dir, '1'))
    expect(source.current()).toBe('running')
  })

  it('start() then stop() leaves no live handles', () => {
    const source = sourceFor()
    source.start()
    expect(() => source.stop()).not.toThrow()
    expect(() => source.stop()).not.toThrow()
  })

  it('creates the session directory on start so the watch has a target', () => {
    const nested = join(dir, 'made-by-start')
    const source = createClaudeStateSource({ dir: nested, isAlive: () => true })
    source.start()
    source.stop()
    expect(existsSync(nested)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
corepack pnpm test -- tests/claude/claude-state-source.spec.ts
```

Expected: the file fails to load — `GREEN_TTL_MS` and `SESSION_MAX_AGE_MS` are not exported, and
`createClaudeStateSource` has no `dir` option.

- [ ] **Step 3: Rewrite the state source**

Replace the whole body of `apps/desktop/src/claude/claude-state-source.ts`:

```ts
/**
 * Claude Code's state, read off the files its hooks write — one per session.
 *
 * Each session writes `<dir>/<pid>`, where the pid is the hook's `$PPID`: a hook command's
 * parent process is that session's own `claude` CLI process. That keeps the hook a one-liner
 * with no `jq` and no JSON parsing — the property that made this transport worth having — and
 * hands us a liveness handle for free.
 *
 * The many sessions are reduced to one crown by "loudest wins", because the only question the
 * pet needs to answer at a glance is whether anything needs a human, not which terminal it is in.
 *
 * No Electron import. This module is the one place that knows how the state arrives, which is
 * why going from one session to many touches nothing else.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_STATES, type ClaudeState } from '../pet-frame.js'

/**
 * How long a finished session keeps its green crown.
 *
 * Green means "just finished, come look", and a signal that is always on is not a signal —
 * without this, any long-lived session parks a green crown on the pet all day. Red and gold
 * describe a live condition and do not decay; green describes a moment, and moments pass.
 */
export const GREEN_TTL_MS = 5 * 60_000

/**
 * The ceiling on a session file's age, whatever its pid says.
 *
 * Liveness is `kill(pid, 0)`, not a timeout, so this is not the staleness guard — it is the
 * backstop against pid reuse. A dead session's leftover file plus a recycled pid would otherwise
 * read as alive forever. Long enough that a real session is never mistaken for a recycled one.
 */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60_000

/** How often to re-read regardless of the watch. See `start()`. */
const DEFAULT_POLL_MS = 5_000

/** Loudest first. The reduction is "the first of these any session is in". */
const BY_LOUDNESS: readonly ClaudeState[] = ['waiting', 'running', 'idle']

export function defaultClaudeSessionDir(): string {
  return process.env.ARGOS_CLAUDE_SESSION_DIR ?? join(homedir(), '.argos', 'sessions')
}

/**
 * Is this process still running?
 *
 * Signal 0 runs the existence and permission checks without delivering anything. `ESRCH` means
 * the process is gone; `EPERM` means it exists but belongs to someone else, which still counts
 * as alive.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface ClaudeStateSourceOptions {
  /** Defaults to `defaultClaudeSessionDir()`. */
  dir?: string
  /** Injected so tests can drive expiry without waiting. */
  now?: () => number
  /** Injected so tests need no real processes. */
  isAlive?: (pid: number) => boolean
  pollMs?: number
  greenTtlMs?: number
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

export function createClaudeStateSource(
  options: ClaudeStateSourceOptions = {},
): ClaudeStateSource {
  const dir = options.dir ?? defaultClaudeSessionDir()
  const now = options.now ?? Date.now
  const isAlive = options.isAlive ?? processIsAlive
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const greenTtl = options.greenTtlMs ?? GREEN_TTL_MS
  const onChange = options.onChange ?? ((): void => {})
  const log = options.log ?? ((): void => {})

  let state: ClaudeState = 'none'
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null

  /** One session's contribution, or `none` if it does not get a vote. */
  const readSession = (name: string, nowMs: number): ClaudeState => {
    // A pid, or it is not ours: an editor's dotfile, a leftover from the single-session
    // version, a directory. Anything unrecognised simply does not vote.
    if (!/^\d+$/.test(name)) return 'none'
    const pid = Number(name)
    const path = join(dir, name)

    let raw: string
    let mtimeMs: number
    try {
      const stat = statSync(path)
      if (!stat.isFile()) return 'none'
      mtimeMs = stat.mtimeMs
      raw = readFileSync(path, 'utf8')
    } catch {
      return 'none'
    }

    const age = nowMs - mtimeMs
    if (age > SESSION_MAX_AGE_MS) return 'none'

    if (!isAlive(pid)) {
      // Ctrl+C and closed terminals never fire SessionEnd. Drop the file as we find it, or the
      // directory grows by one per session forever.
      try {
        unlinkSync(path)
      } catch {
        // Already gone, or not ours to remove. It reads as dead either way.
      }
      return 'none'
    }

    const word = raw.trim().toLowerCase()
    if (!KNOWN.has(word)) return 'none'
    if (word === 'idle' && age > greenTtl) return 'none'
    return word as ClaudeState
  }

  const read = (): ClaudeState => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      // No directory yet: Argos started before any session did.
      return 'none'
    }

    const nowMs = now()
    const seen = new Set<ClaudeState>()
    for (const name of names) seen.add(readSession(name, nowMs))
    return BY_LOUDNESS.find((candidate) => seen.has(candidate)) ?? 'none'
  }

  const refresh = (): ClaudeState => {
    const next = read()
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
        mkdirSync(dir, { recursive: true })
      } catch (error) {
        log('claude-state: could not create the session directory', error)
      }

      refresh()

      try {
        watcher = watch(dir, { persistent: false }, () => {
          refresh()
        })
      } catch (error) {
        log('claude-state: session watch unavailable, polling only', error)
      }

      // Backstop, and the only thing that expires a green crown or notices a process dying:
      // neither writes to the directory, so neither produces a watch event.
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

- [ ] **Step 4: Run the tests and watch them pass**

```bash
corepack pnpm test -- tests/claude/claude-state-source.spec.ts
```

Expected: PASS, 26 tests.

- [ ] **Step 5: Typecheck**

```bash
corepack pnpm typecheck
```

Expected: a single error in `app-shell.ts` if it still passes `file:`. It does not — it passes
only `log` and `onChange` — so expect this to be clean. If it is not, the call site is using an
option this task removed; fix it there and note it.

- [ ] **Step 6: Run the whole suite**

```bash
corepack pnpm test
```

Expected: PASS. No test outside `tests/claude/` should even notice this change — if one does, the
aggregation has leaked past `current()`.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/claude/claude-state-source.ts tests/claude/claude-state-source.spec.ts
git commit -m "feat: aggregate every Claude Code session into one crown

One file per session at ~/.argos/sessions/<pid>, reduced by loudest
wins: any session waiting turns the crown red whichever terminal it is
in, which is the only question the pet needs to answer at a glance.

The pid comes from the hook's \$PPID -- a hook command's parent is that
session's own claude process -- so the hook stays a one-liner with no jq
and no JSON parsing, and we get a liveness handle for free.

That handle fixes a real defect. Staleness was a 15-minute mtime TTL,
and a session sitting at a permission prompt never touches its file
while it waits, so the red crown silently vanished after 15 minutes of
waiting -- exactly when it mattered most. kill(pid, 0) replaces the
guess; the mtime ceiling is now only a backstop against pid reuse.

Green expires after five minutes because it means 'just finished, come
look'. Red and gold describe a live condition and do not decay."
```

---

### Task 2: Point the app at the session directory

**Files:**
- Modify: `apps/desktop/src/main/app-shell.ts`

**Interfaces:**
- Consumes: `createClaudeStateSource` from Task 1.
- Produces: nothing.

- [ ] **Step 1: Check whether anything needs changing at all**

```bash
grep -n "createClaudeStateSource" -A 8 apps/desktop/src/main/app-shell.ts
```

The call passes only `log` and `onChange`, both of which survive Task 1, so the default
`dir` now resolves to the session directory with no edit. Verified while writing this plan:
`defaultClaudeStateFile` has no callers outside its own module either, so removing it breaks
nothing. **If that grep confirms it, this task
is already done — record that and move to Task 3 rather than inventing a change.**

- [ ] **Step 2: Confirm by building**

```bash
corepack pnpm typecheck && corepack pnpm build
```

Expected: both clean.

---

### Task 3: New hooks and documentation

**Files:**
- Modify: `docs/CLAUDE-CODE.md`

**Interfaces:**
- Consumes: the session directory layout from Task 1.
- Produces: the hook block Task 4 installs.

- [ ] **Step 1: Replace the hook block**

The state path changes and every command gains `$PPID`. `mkdir -p` stays so the hooks work
whether or not Argos has ever run. Replace the JSON block in `docs/CLAUDE-CODE.md` with:

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.argos/sessions && echo waiting > ~/.argos/sessions/$PPID",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.argos/sessions && echo running > ~/.argos/sessions/$PPID",
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.argos/sessions && echo running > ~/.argos/sessions/$PPID",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.argos/sessions && echo running > ~/.argos/sessions/$PPID",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.argos/sessions && echo idle > ~/.argos/sessions/$PPID",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "rm -f ~/.argos/sessions/$PPID", "timeout": 5 }]
      }
    ]
  }
}
```

- [ ] **Step 2: Explain the pid, and rewrite the testing and limits sections**

Replace the "Testing it without Claude" and "Limits" sections with:

````markdown
`$PPID` is the session: a hook command's parent process is that session's own `claude` CLI
process. That is what keeps these one-liners — no `jq`, no JSON parsing — and it is also how
Argos knows a session has gone away without being told.

## Testing it without Claude

With Argos running, a made-up pid stands in for a session — any live one will do, and your own
shell is the easiest:

```bash
mkdir -p ~/.argos/sessions
echo waiting > ~/.argos/sessions/$$    # red crown
echo running > ~/.argos/sessions/$$    # gold crown
echo idle    > ~/.argos/sessions/$$    # green crown, for five minutes
rm ~/.argos/sessions/$$                # bare-headed
```

Two at once, to see loudest-wins:

```bash
echo running > ~/.argos/sessions/$$
echo waiting > ~/.argos/sessions/1     # pid 1 is always alive
# red: one session waiting outvotes one running
rm ~/.argos/sessions/1
# back to gold
```

Point Argos at a different directory with `ARGOS_CLAUDE_SESSION_DIR`.

## Limits

- **The crown says what, not how many or which.** Three sessions waiting look like one.
- **Green lasts five minutes.** It means "just finished, come look", not "this session is idle".
- **A pid could in principle be recycled** onto a leftover file. Files older than 12 hours are
  ignored for that reason; inside that window a recycled pid would show a stale crown.
- **macOS only, so far.** `process.kill(pid, 0)` behaves the same on Linux; Windows is
  unverified, as is the Linux shape-region handling.
````

- [ ] **Step 3: Verify and commit**

```bash
corepack pnpm test && corepack pnpm typecheck
git add docs/CLAUDE-CODE.md
git commit -m "docs: hooks for one file per session

Every command gains \$PPID, which is the session's own claude process, so
the hooks stay one-liners with no jq. Adds a two-session recipe for
seeing loudest-wins without running a second Claude."
```

---

### Task 4: Install the new hooks and prove it end to end

**Files:**
- Modify: `~/.claude/settings.json` (the user's, not the repo's)

**Interfaces:**
- Consumes: the hook block from Task 3.
- Produces: nothing in the repo.

- [ ] **Step 1: Back up first**

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak-$(date +%Y%m%d-%H%M%S)
```

- [ ] **Step 2: Replace the Argos hooks, keeping everything else**

The file already contains unrelated hooks (`SessionStart` and a second `UserPromptSubmit` entry).
**Merge — do not overwrite the `hooks` key.** Replace only the groups whose command mentions
`.argos`:

```bash
python3 - <<'PY'
import json, pathlib, collections

p = pathlib.Path.home() / '.claude' / 'settings.json'
s = json.loads(p.read_text(), object_pairs_hook=collections.OrderedDict)
hooks = s.setdefault('hooks', collections.OrderedDict())

DIR = '~/.argos/sessions'
def cmd(word):
    return f'mkdir -p {DIR} && echo {word} > {DIR}/$PPID'

WORDS = {
    'Notification': cmd('waiting'),
    'UserPromptSubmit': cmd('running'),
    'PreToolUse': cmd('running'),
    'PostToolUse': cmd('running'),
    'Stop': cmd('idle'),
    'SessionEnd': f'rm -f {DIR}/$PPID',
}

def is_argos(group):
    return any('.argos' in h.get('command', '') for h in group.get('hooks', []))

for event, command in WORDS.items():
    groups = [g for g in hooks.get(event, []) if not is_argos(g)]
    groups.append(collections.OrderedDict([
        ('hooks', [collections.OrderedDict([
            ('type', 'command'), ('command', command), ('timeout', 5),
        ])]),
    ]))
    hooks[event] = groups

p.write_text(json.dumps(s, indent=2) + '\n')
print('argos hooks replaced')
PY
```

- [ ] **Step 3: Verify the merge did not eat anything**

```bash
jq -e '[.hooks[][].hooks[] | select(.command | test("caveman"))] | length' ~/.claude/settings.json
jq -r '.hooks | to_entries[] | .key as $e | .value[].hooks[] | select(.command | test("argos")) | "\($e): \(.command)"' ~/.claude/settings.json
```

Expected: the caveman count is unchanged from before the edit (2 at the time of writing), and
exactly six `argos` lines, one per event, all naming `$PPID`.

- [ ] **Step 4: Retire the old single-session file**

```bash
rm -f ~/.argos/claude-state
```

Nothing reads it any more — the state source only considers filenames that are entirely digits,
so it would be ignored regardless, but leaving it invites confusion later.

- [ ] **Step 5: Restart Argos and watch it work**

```bash
corepack pnpm build
node -e "console.log(require('electron'))"   # the binary path
```

Launch it with that binary and `apps/desktop` as the argument. Then, in a second terminal:

```bash
echo waiting > ~/.argos/sessions/$$
```

Expected: a red crown within a second, on top of whatever this Claude session's own hooks are
already writing — which is the loudest-wins reduction working on two real sessions.

- [ ] **Step 6: Prove the fix that motivated the liveness change**

Backdate a waiting session well past the old 15-minute TTL and confirm the crown stays red:

```bash
echo waiting > ~/.argos/sessions/$$
touch -A -003000 ~/.argos/sessions/$$   # 30 minutes ago
```

Expected: still red. On the shipped single-session version this went bare-headed.

- [ ] **Step 7: Clean up**

```bash
rm -f ~/.argos/sessions/$$
```

---

## Done when

- `corepack pnpm test`, `corepack pnpm typecheck` and `corepack pnpm build` are all clean.
- One session waiting and two running shows red.
- Killing a waiting session with `Ctrl+C` clears its crown without a `SessionEnd`, and its file
  disappears from `~/.argos/sessions/`.
- A 30-minute-old waiting session still shows red.
- A finished session's green is gone five minutes later, while the session stays alive.
- Nothing outside `claude-state-source.ts` changed in the app.
