# Multi-session status crown — design

**Date:** 2026-09-04
**Branch:** `claude-integration`
**Status:** approved, not yet implemented
**Supersedes the single-session limit in:** `2026-09-04-claude-state-cap-design.md`

## Problem

The crown tracks one Claude Code session. Every session writes the same file, so the last hook to
fire wins and the crown reports whichever session moved most recently — not the one that needs
attention. Two sessions running at once make the crown actively misleading: the one waiting on a
permission prompt is invisible the moment the other one runs a tool.

This is not hypothetical on the target machine — two `claude` processes were running while this
was written.

## Solution

One state file per session, aggregated by **loudest wins**.

| Any session | Crown |
|---|---|
| waiting for confirmation | 🔴 red |
| else running | 🟡 gold |
| else recently finished | 🟢 green |
| else | bare-headed |

Red answers the only question worth answering at a glance — *does anything need me?* — regardless
of which terminal it came from.

## Identifying a session

The hook writes to `~/.argos/sessions/$PPID`.

A hook command's parent process is the session's own `claude` CLI process. Verified by probe: a
hook reporting `$PPID` gave a pid whose `ps -o comm=` is `claude`. So the session identity is
already in the shell, and the hook stays a one-liner with no `jq`, no JSON parsing, and no
dependency on either side — the property that made the original transport worth having.

The alternative was parsing `session_id` out of the hook's stdin JSON, which needs either `jq`
(not guaranteed present) or a script installed at a stable path (a second thing to keep in sync).

## Liveness, and a bug this fixes

A pid is a liveness handle, which the previous design lacked:

1. **`SessionEnd`** deletes the file. Covers a clean exit.
2. **`process.kill(pid, 0)`** covers everything else — `Ctrl+C`, a crash, a closed terminal.
   Sending signal 0 performs the permission and existence check without delivering a signal, so
   `ESRCH` means the session is gone. Exact, not a guess.
3. **A long mtime ceiling** (12h) is the only remaining backstop, against pid reuse: a dead
   session's file plus a recycled pid would otherwise read as alive forever.

**This corrects a real defect in the shipped version.** Today staleness is a 15-minute mtime TTL,
and a session sitting at a permission prompt does not touch its file while it waits. Leave a
prompt unanswered for 15 minutes and the red crown silently disappears — precisely when it is
most wanted. Pid liveness replaces the guess, so waiting and running states persist for as long
as the process does.

## Green decay

Green means *just finished, come look*. It expires 5 minutes after the finishing hook wrote it,
and the pet goes bare-headed while the session stays alive for red and gold purposes.

A signal that is always on is not a signal. Without decay, any long-lived session parks a green
crown on the pet all day and the crown stops carrying information.

Red and gold do not decay. They describe a live condition; green describes a moment that passes.

## Architecture

Only `claude-state-source.ts` changes, which is why the module boundary was drawn there.

```
Claude Code hooks ──▶ ~/.argos/sessions/<pid>     (one word each)
                              │
                        fs.watch + poll
                              ▼
                   claude-state-source.ts
                     read each file
                     drop dead pids  (kill(pid, 0))
                     drop expired green
                     reduce: waiting > running > idle > none
                              │  current(): ClaudeState
                              ▼
                      unchanged from here on
```

`PetFrame.claudeState` keeps its four values, so the controller, the frame seam, the renderer,
the crown art and the shape region are all untouched. The aggregation is entirely inside the one
module that already owns "how the state arrives".

### Pruning

Files whose pid is dead are unlinked as they are found, so the directory does not grow by one
file per session forever. A failed unlink is ignored — the file will be skipped on every read
regardless, and a source that throws into main over a leftover file would be worse than the
leftover file.

## Error handling

Unchanged in principle: every failure resolves to **no crown** rather than a wrong crown. A
missing directory, an unreadable file, a filename that is not a number, an unparseable word and a
dead pid are all simply absent from the reduction.

Injected seams for testing: `now()` (already present) and `isAlive(pid)`, so the unit tests need
no real processes and no sleeping.

## Non-goals

- **Showing how many sessions.** Loudest-wins reports the condition, not the queue depth. A count
  needs a second element and a numeral legible at 0.5× pet scale, which is about 5px tall.
- **Showing which session.** No project name, no hover detail.
- **Changing the crown art, the frame seam, or the renderer.** Nothing outside the state source.

## Testing

- Reduction: every ordering of waiting/running/idle/none across several sessions.
- Liveness: a dead pid is ignored, and its file is unlinked.
- Pid reuse: a live pid with an ancient mtime is ignored.
- Green decay: green older than the window is dropped; red and gold of the same age are kept.
- The waiting-prompt regression: a `waiting` file far older than the old 15-minute TTL still
  shows red while its pid lives.
- Junk: non-numeric filenames, empty files, unknown words, a missing directory.
- Manual: two terminals, one made to wait, confirm red while the other runs.
