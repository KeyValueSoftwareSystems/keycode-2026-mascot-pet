# Pet asset — Argus (partial demo pack)

Keycode unicorn mascot in streetwear. Assembled from individual frames in
`~/Desktop/argus-mascot` via `scripts/assemble-argus-frames.mjs`.

## Files

| File | Purpose |
|---|---|
| `spritesheet.png` | 3648×1456 RGBA, 19 cols × 7 rows of 192×208 cells. |
| `spritesheet.json` | Animation state map — row/frames/duration per state, free cells, reaction map. |
| `pet.json` | Pet metadata (`id`, `displayName`, `description`, `spritesheetPath`). |

## Current rows

| Row | States | Frames |
|---|---|---|
| 0 | `idle`, `sleep`, `waving`, `failed`, `running`, `review` | 2 |
| 1 | `running-right` | 6 |
| 2 | `running-left` (flipped from run-right) | 6 |
| 3 | `stretch`, `jumping`, `jumping-right` | 19 (jumping jacks, facing right) |
| 4 | `drink` | 11 |
| 5 | `jumping-left` (flipped from jumping-jacks) | 19 |
| 6 | `idle-left` (flipped from idle) | 2 |

Undrawn behaviours share a drawn row (same pattern as `sleep`→idle) so the motion engine
stays complete until design delivers the rest.

## Rebuild

```bash
node scripts/assemble-argus-frames.mjs /Users/aleena/Desktop/argus-mascot
node scripts/generate-sprite-css.mjs
node scripts/generate-alpha-mask.mjs
node scripts/generate-tray-icon.mjs
```
