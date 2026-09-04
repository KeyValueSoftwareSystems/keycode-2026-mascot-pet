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

![The pet wearing a red status square, with a speech bubble above it](demo/claude-cap-waiting.png)

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

`PreToolUse` is what returns the cap to amber after you approve a prompt — answering a
permission request does not fire `Notification` again.

`PreToolUse` and `PostToolUse` carry no `matcher`, which matches every tool. `"*"` is
commonly written for this, but an omitted matcher is the form the settings schema guarantees.

Claude Code picks the hooks up without a restart — its settings watcher reloads the file.

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
- **The cap drifts sideways in some poses.** It hangs off `--body-cx`, which is the centre of the
  character's *bounding box*, not the centre of its head. In `idle` and `running` the two agree
  closely enough; in `jumping` the pet leans and the cap is visibly left of the head. The alpha
  mask publishes `headTopByState` but no matching head centre, so fixing this properly means
  generating one — worth doing before the real cap art lands, pointless before then.
- **macOS only, so far.** The Linux shape-region handling is written but unverified.
