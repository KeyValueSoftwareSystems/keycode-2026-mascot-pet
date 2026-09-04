# Claude Code state cap — design

**Date:** 2026-09-04
**Branch:** `claude-integration`
**Status:** approved, not yet implemented

## Problem

While Claude Code works, the user has no ambient signal for what it is doing. Checking means
switching to the terminal and reading it. The three states that matter are:

- **waiting for confirmation** — Claude is blocked on the user. This is the only state that
  demands attention.
- **running** — Claude is working. Nothing to do.
- **idle** — the task finished; ready for a new one.

Argos already lives on screen over whatever the user is working on, so it is a free carrier for
that signal.

## Solution

The pet wears a coloured cap. The colour is driven by Claude Code's state.

This spike ships a **coloured square** on the head rather than cap art, so the transport, the
frame seam and the head anchoring can all be proven before any art is drawn. The square occupies
the exact slot the real cap will occupy, so the geometry validated here is the geometry kept.

**Scope of this spike:** one Claude Code session, macOS first, local only.

## Non-goals

Explicitly out of scope, listed so they are not smuggled in:

- **Multi-session aggregation.** Deferred to iteration 2. Single session, last writer wins.
- **Real cap art.** Square only.
- **Animation or bubble changes.** The pet's motion and speech are untouched. The cap is
  additive.
- **A settings toggle.** No user-facing on/off switch yet.
- **Windows and Linux verification.** The code is written to not break them (see "Shape region"
  below), but only macOS is tested.

## Architecture

```
Claude Code hook  ──writes word──▶  ~/.argos/claude-state
                                          │
                                    fs.watch + poll
                                          ▼
                              claude-state-source.ts        (new, no Electron)
                                          │  current(): ClaudeState
                                          ▼
                                  pet-controller.ts         (buildFrame)
                                          │  PetFrame.claudeState
                                          ▼
                                     pet.ts                 (one attribute set)
                                          │  html[data-claude-state]
                                          ▼
                                     pet.css                (#claude-crown square)
```

Each arrow is one-directional and each box has one job. The renderer stays dumb, which
`tests/renderer/discipline.spec.ts` enforces by grepping it.

### Transport: a file, written by hooks

Claude Code hooks write a single word to a state file.

| Hook | Writes | Cap colour |
|---|---|---|
| `Notification` | `waiting` | red |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | `running` | amber |
| `Stop` | `idle` | green |
| `SessionEnd` | *deletes the file* | no cap |

Path: `~/.argos/claude-state`, overridable via `$ARGOS_CLAUDE_STATE_FILE` for tests.

The hook body is `echo running > ~/.argos/claude-state`. No `jq`, no stdin parsing, no localhost
port, no new dependency on either side. A hook that cannot fail in an interesting way is worth
more in a spike than one that carries more information.

**Staleness.** A session killed with `Ctrl+C` may never fire `SessionEnd`, leaving a file that
pins the cap on forever. The file's mtime is the guard: older than 15 minutes counts as no state.
This is why the file holds only a word — the timestamp already exists in the filesystem, so
putting one in the payload would be a second source of truth for the same fact.

### Seam: a new frame field

`petFrameSchema` in `apps/desktop/src/pet-frame.ts` gains:

```ts
claudeState: z.enum(['none', 'waiting', 'running', 'idle'])
```

This is a **new field rather than a new value on `overlay`**. `overlay` is single-valued and
already owned by the sleep Z's, and a sleeping pet must still be able to wear the cap. Two
independent axes need two fields; folding them into one would make "asleep and waiting"
unrepresentable.

### Shape region — the platform trap

`pet-window.ts` sets the window shape region from the alpha mask. Electron's `setShape`
determines where the system permits *drawing*, not merely where clicks land: outside the region
**no pixels are painted at all**. This already bit the speech bubble and the sleep Z's, and is
documented at length in `apps/desktop/src/sprite/alpha-mask.ts`.

A square drawn over the hair sits in transparent mask cells. Left alone it would be invisible on
Linux, and the screenshot harness would not catch it, because `webContents.capturePage()` renders
the web contents and never consults the window shape.

Fix: the existing overlay branch already pushes a whole-sprite-cell rect, so the cap reuses it —
the condition becomes `overlay !== 'none' || claudeState !== 'none'`. No new geometry, one
changed expression.

## Components

**`apps/desktop/src/claude/claude-state-source.ts`** (new)

Owns the state file and nothing else. Watches the *directory*, not the file: an atomic write
replaces the inode and a file-level watch goes dead against the old one. A 5-second poll backs
`fs.watch` up, because it is unreliable on some platforms and a missed event here means a stuck
cap.

Interface: `current(): ClaudeState`, `onChange(cb)`, `stop()`. Pure Node — no Electron import —
so it can be unit-tested against a temp directory.

This is also the single file that changes when multi-session lands, which is the reason the file
boundary is drawn here.

**`apps/desktop/src/main/pet-controller.ts`** (changed)

`buildFrame()` reads the source and sets `claudeState`. The existing `sendFrameIfChanged`
signature check means a colour change pushes exactly one frame and a steady colour pushes none.

**`apps/desktop/src/renderer/pet.ts`** (changed)

One line: `root.dataset.claudeState = frame.claudeState`. A pure attribute set, so it passes the
renderer-discipline test.

**`apps/desktop/src/renderer/pet.css`** (changed)

`#claude-crown`, built on the `#zzz` pattern: absolutely positioned from `--body-cx` and
`--body-top`, offset by a scaled amount. Those custom properties are already per-animation-state
and scale-aware, so the square tracks the head through every pose and every pet size without any
new arithmetic.

Colours: red `#e5484d`, amber `#f5a524`, green `#30a46c`.

## Error handling

Every failure resolves to **no cap** rather than a wrong cap. A missing file, an unreadable file,
an unparseable word, and a stale mtime are all `none`. A status indicator that lies is worse than
one that is absent, because an absent cap is visibly absent while a wrong cap is silently wrong.

The state source never throws into main. A watch that cannot be established falls back to the
poll alone.

## Testing

- **Unit — state source:** against a temp directory. Reads a word; sees a change; sees a delete;
  treats a stale mtime as `none`; treats garbage content as `none`; survives a missing directory.
- **Unit — frame builder:** each `ClaudeState` reaches `PetFrame.claudeState`.
- **Schema:** the frame round-trips through zod with the new field.
- **Manual, and this is the actual integration test:** with Argos running,
  `echo waiting > ~/.argos/claude-state` turns the square red, with Claude not involved at all. If
  that works and the hooks do not, the hooks are the only remaining variable.

## Iteration 2 (not now)

Multi-session: hooks write `<dir>/<session_id>.json` instead, and the source aggregates by
loudest-wins (any waiting → red, else any running → amber, else green). Only
`claude-state-source.ts` changes. Then the real cap art replaces the square.
