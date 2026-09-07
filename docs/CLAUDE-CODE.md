# Claude Code status crown

The pet wears a crown that tells you what Claude Code is doing, so you can stop switching to the
terminal to find out.

| Crown | Meaning |
|---|---|
| 🔴 red | Claude Code is **waiting for you** to confirm something |
| 🟡 gold | Claude Code is **working** |
| 🟢 green | the task **finished**; ready for a new one |
| *bare-headed* | no Claude Code session, or the last signal is stale |

| 🔴 waiting | 🟡 running | 🟢 idle |
|---|---|---|
| ![red crown](demo/crown-waiting.png) | ![gold crown](demo/crown-running.png) | ![green crown](demo/crown-idle.png) |

Red is the one that matters. The other two are ambient.

---

## What you need

| | |
|---|---|
| **Argos** | running. Any recent build. |
| **Claude Code** | any version with hooks (`~/.claude/settings.json`) |
| **A shell** | `bash` or `zsh`. The hooks are one-liners using `mkdir`, `echo` and `rm`. |
| **Extra tools** | **none.** No `jq`, no Node script, no daemon, no port. |

macOS is verified. Linux should work — nothing in the mechanism is macOS-specific — but has not
been tested. Windows is unverified.

---

## How it works

```
Claude Code hook ──writes one word──▶  ~/.argos/claude-state
                                              │
                                        watch + poll
                                              ▼
                                        Argos (main)
                                              │  one field on the pet frame
                                              ▼
                                    crown painted on the pet's head
```

Claude Code fires a **hook** at each point in its lifecycle. Each hook writes a single word to a
file. Argos watches that file and paints the matching crown.

That is the whole mechanism. There is no server, no port, no polling of Claude Code, and no
dependency in either direction:

- **Argos not running?** The hooks write a file nothing reads. Nothing breaks.
- **Hooks not installed?** Argos watches a file nobody writes. The pet stays bare-headed.

The hook is `echo running > file` on purpose. A hook that cannot fail in an interesting way is
worth more than one carrying richer information — it runs on every prompt and every tool call, so
anything slow or fragile there would be felt constantly.

### Which hook means what

| Hook | Fires when | Writes |
|---|---|---|
| `Notification` | Claude Code needs a confirmation | `waiting` |
| `UserPromptSubmit` | you send a prompt | `running` |
| `PreToolUse` | before each tool call | `running` |
| `PostToolUse` | after each tool call | `running` |
| `Stop` | Claude Code finishes its turn | `idle` |
| `SessionEnd` | the session closes | *deletes the file* |

`PreToolUse` is what returns the crown to gold after you approve a prompt — answering a permission
request does not fire `Notification` again.

### Staleness

A session killed with `Ctrl+C` never fires `SessionEnd`, so its file lingers. Argos ignores any
state file whose mtime is over 15 minutes old. That is why the file holds only a word: the
timestamp already exists in the filesystem, and putting a second one in the payload would be two
sources of truth for one fact.

### How the crown is drawn

Worth knowing if you touch the art or the placement:

- The crown is a plain `<div>` with a background image, a sibling of the sprite — not part of the
  spritesheet. Colour changes are a stylesheet rule, not a re-rendered sheet.
- It tracks the head **per animation frame**. The pet's bounce is `background-position` stepping,
  so the sprite element itself never moves; anything anchored to a per-state constant would hang
  still while the character bobs underneath it. The crown gets its own generated keyframes on the
  sprite's clock, one `step-end` stop per frame holding that frame's real head anchor.
- Size, art and the gap above the head all come from `scripts/lib/crowns.mjs` through the
  generator into `pet.generated.css`. No crown geometry is hand-written.

---

## Integrating it

Argos merges these hooks into `~/.claude/settings.json` on launch (idempotent; existing hooks
are kept). You do not need to edit the file by hand.

The hooks Argos installs:

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mkdir -p ~/.argos && echo waiting > ~/.argos/claude-state",
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
            "command": "mkdir -p ~/.argos && echo running > ~/.argos/claude-state",
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
            "command": "mkdir -p ~/.argos && echo running > ~/.argos/claude-state",
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
            "command": "mkdir -p ~/.argos && echo running > ~/.argos/claude-state",
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
            "command": "mkdir -p ~/.argos && echo idle > ~/.argos/claude-state",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "rm -f ~/.argos/claude-state", "timeout": 5 }
        ]
      }
    ]
  }
}
```

`PreToolUse` and `PostToolUse` carry no `matcher`, which matches every tool. `"*"` is commonly
written for this, but an omitted matcher is the form the settings schema guarantees.

Claude Code reloads `settings.json` on its own — no restart. Start a task and the crown appears.

Check what is installed at any time with `/hooks`.

---

## Verifying it

**Test the transport first, without Claude Code in the picture.** With Argos running:

```bash
mkdir -p ~/.argos
echo waiting > ~/.argos/claude-state   # red crown
echo running > ~/.argos/claude-state   # gold crown
echo idle    > ~/.argos/claude-state   # green crown
rm ~/.argos/claude-state               # bare-headed
```

The crown changes within a second. This is the test worth running first: if these work and the
hooks do not, the hooks are the only remaining variable.

**Then test the hooks.** Give Claude Code a task that needs a permission prompt. Expected: gold
while it works, red at the prompt, gold again once you approve, green when it stops.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No crown ever | Argos is not running, or Claude Code has not fired a hook yet. Run the `echo` test above to confirm the transport. |
| `echo` test works, real sessions do not | Claude Code is not loading hooks. Check `/hooks`, and that `~/.claude/settings.json` is valid JSON — an invalid file silently disables **every** setting in it (Argos will not overwrite a broken file). |
| Crown stuck on one colour | A session died without `SessionEnd`. It clears itself after 15 minutes, or `rm ~/.argos/claude-state` now. |
| Crown flickers gold ↔ green | Expected. Every tool call writes `running` and every turn end writes `idle`. |
| Crown is wrong with two sessions open | Known. See Limits. |

Point Argos at a different file with `ARGOS_CLAUDE_STATE_FILE`, which is also how the screenshot
harness drives it.

---

## Limits

- **One session.** Every session writes the same file, so the last hook to fire wins. With two
  sessions open, the one waiting on you goes invisible the moment the other runs a tool. Fixing
  this is designed and planned — see
  [the multi-session spec](superpowers/specs/2026-09-04-multi-session-crown-design.md) and
  [its plan](superpowers/plans/2026-09-04-multi-session-crown.md).
- **A long wait loses its crown.** Staleness is a 15-minute mtime check, and a session parked at a
  permission prompt does not touch its file while it waits. Leave a prompt unanswered for 15
  minutes and the red crown disappears — exactly when it is most wanted. The multi-session work
  fixes this too, by using the session's pid as a liveness handle instead of a timeout.
- **Green never expires** while a session is alive, so a finished session parks a green crown
  indefinitely. Also addressed in that plan.
- **macOS only, so far.**

---

## Working on it

```bash
pnpm install
pnpm generate      # crowns, sprite CSS, alpha mask
pnpm test
pnpm build && pnpm dev
```

`pnpm generate:check` runs in CI and fails if any generated file is stale.

**To change a crown:** replace its PNG in `pet/crowns-source/` and run `pnpm generate`. The
downsample to worn size, the stylesheet rules and the asset copying all follow.

**To capture screenshots** of the crown at a given state:

```bash
ARGOS_CLAUDE_STATE_FILE=/tmp/state sh -c 'echo waiting > /tmp/state && \
  node scripts/smoke.mjs --name crown --no-composite --state idle --size large'
```

The harness skips its window-transparency assertion (A2) while a crown is worn, because the crown
legitimately paints in the ring that assertion requires to be empty.

### Where the code lives

| Path | What |
|---|---|
| `apps/desktop/src/claude/claude-state-source.ts` | Owns the state file. The only module that knows how state arrives. |
| `apps/desktop/src/pet-frame.ts` | `claudeState` on the main→renderer seam, plus `frameNeedsCellRegion` |
| `apps/desktop/src/renderer/pet.css` | Parks the crown on the sprite cell. No geometry. |
| `scripts/lib/crowns.mjs` | Crown size, art list, gap. One definition. |
| `scripts/generate-crowns.mjs` | Downsamples the source art |
| `scripts/generate-sprite-css.mjs` | Emits the per-frame crown keyframes |
