# Claude Code status crown

The pet wears a crown that follows what Claude Code is doing.

| Colour | Meaning |
|---|---|
| 🔴 red | Claude Code is waiting for you to confirm something |
| 🟡 amber | Claude Code is working |
| 🟢 green | the task finished; ready for a new one |
| *no cap* | no Claude Code session, or the last signal is over 15 minutes old |

Single session for now: two at once will fight over the colour.

| 🔴 waiting | 🟡 running | 🟢 idle |
|---|---|---|
| ![red crown](demo/crown-waiting.png) | ![gold crown](demo/crown-running.png) | ![green crown](demo/crown-idle.png) |

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
          {
            "type": "command",
            "command": "rm -f ~/.argos/claude-state",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

`PreToolUse` is what returns the crown to amber after you approve a prompt — answering a
permission request does not fire `Notification` again.

`PreToolUse` and `PostToolUse` carry no `matcher`, which matches every tool. `"*"` is
commonly written for this, but an omitted matcher is the form the settings schema guarantees.

Claude Code picks the hooks up without a restart — its settings watcher reloads the file.

## Testing it without Claude

With Argos running:

```bash
mkdir -p ~/.argos
echo waiting > ~/.argos/claude-state   # red crown
echo running > ~/.argos/claude-state   # gold crown
echo idle    > ~/.argos/claude-state   # green crown
rm ~/.argos/claude-state               # bare-headed
```

The colour changes within a second. This is the integration test worth running first: if these
work and the hooks do not, the hooks are the only remaining variable.

Point Argos at a different file with `ARGOS_CLAUDE_STATE_FILE`.

## Limits

- **One session.** The last hook to fire wins, whichever session it came from.
- **Stale state.** A session killed with `Ctrl+C` never fires `SessionEnd`. Its file lingers, and
  the crown stays until the file is 15 minutes old.
- **macOS only, so far.** The Linux shape-region handling is written but unverified.

## The art

`pet/crowns-source/` holds the full-size crowns; `pnpm generate` downsamples them to the size
they are worn at and writes `pet/crown-*.png`. Nothing hand-places them: the size, the gap above
the head and the per-animation-frame position all come out of `scripts/lib/crowns.mjs` and the
sprite art, into `pet.generated.css`.

To change a crown, replace its source PNG and run `pnpm generate`.
