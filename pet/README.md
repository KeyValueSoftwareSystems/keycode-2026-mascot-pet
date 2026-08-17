# Pet asset — Argus (partial demo pack)

Keycode unicorn mascot in streetwear. Assembled from individual frames in
`~/Desktop/argus-mascot` via `scripts/assemble-argus-frames.mjs`.

## Files

| File | Purpose |
|---|---|
| `spritesheet.png` | 4800×2496 RGBA, 25 cols × 12 rows of 192×208 cells. |
| `spritesheet.json` | Animation state map — row/frames/duration per state, free cells, reaction map. |
| `pet.json` | Pet metadata (`id`, `displayName`, `description`, `spritesheetPath`). |

## Current rows

| Row | States | Frames |
|---|---|---|
| 0 | `idle`, `failed` | 2 |
| 1 | `running-right`, `running` | 6 |
| 2 | `running-left` (flipped from run-right) | 6 |
| 3 | `stretch`, `jumping`, `jumping-right` | 19 (jumping jacks, facing right) |
| 4 | `drink` | 11 |
| 5 | `jumping-left` (flipped from jumping-jacks) | 19 |
| 6 | `idle-left` (flipped from idle) | 2 |
| 7 | `waving` | 18 |
| 8 | `sleep-enter` / `sleep` / `sleep-exit` | 25 (phases on one row) |
| 9 | `review` (thinking, facing right) | 21 |
| 10 | `review-left` (flipped from thinking) | 21 |
| 11 | `electrocute` (WIP dummy) | 6 |

`failed` still shares the idle row until fail art lands. `running` (busy/drag) reuses the run
cycle. Electrocute stays last on purpose so real zap frames can replace that row without
reshuffling.

Sleep phases on row 8: frames 1–8 lie down, 9–18 quiet loop on the ground, 24–25 stand up.

## Rebuild

```bash
node scripts/assemble-argus-frames.mjs /Users/aleena/Desktop/argus-mascot
node scripts/generate-sprite-css.mjs
node scripts/generate-alpha-mask.mjs
node scripts/generate-tray-icon.mjs
```
