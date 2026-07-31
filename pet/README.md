# Pet asset — `pixel-coder` (placeholder)

Reference spritesheet for the Keycode desktop Pet POC. Copied from `~/Downloads/pixel-coder`.

**This is a placeholder character, not the final Keycode mascot.** It's a pixel-art chibi human
(spiky brown hair, blue eyes, green hoodie, blue jeans, brown shoes) — not the purple Keycode robot
mascot. It will be replaced by a Keycode-branded sheet later. Because the format is fixed, swapping
the art is a file swap plus a `pet.json` edit — no code change.

## Files

| File | Purpose |
|---|---|
| `spritesheet.png` | 1536×1872 RGBA, 8 cols × 9 rows of 192×208 cells. The asset the renderer consumes. |
| `spritesheet.json` | Animation state map — row/frames/duration per state, free cells, reaction map. Authored here. |
| `pet.json` | openpets-format pet metadata (`id`, `displayName`, `description`, `spritesheetPath`). |
| `source-sheet.png` | 1182×1330, **no alpha** — pre-processing source art before slicing/alpha cut. Reference only. |
| `preview.png` | 1024×1024 single-pose character render. |
| `validation.json` | Grid validation output: `ok: true`, per-cell non-transparent pixel counts. |

## Why this format matters

The geometry is an **exact match** for openpets' `defaultPetSprite` — 192×208 frames, 8×9 grid, and
the per-row frame counts line up with their default durations one-for-one. So openpets' CSS sprite
renderer and `reaction-animation-mapping.ts` work against this sheet **unchanged**. No conversion,
no re-timing.

## Verified state of the sheet

Decoded and per-cell hashed (not just read from `validation.json`):

- **8 genuinely distinct animations**, not 9. **Row 6 (`waiting`) is byte-identical to row 0 (`idle`)**
  across all 6 frames — it's a copy, so the row is free to reclaim.
- **Row 5 (`failed`) has 8 frames but 6 distinct** — the last three repeat, holding the final slumped
  pose. Intentional-looking; leave as is.
- Every other row is fully distinct frame to frame.

## Missing for the behaviour spec

`drink` (water reminder), `stretch` (stretch reminder), `sleep` (movement disabled).

- `drink` → reclaim row 6.
- `stretch`, `sleep` → extend the sheet to 12 rows (1536×2496).
- `sleep` can ship **without new art**: idle re-timed very slow plus a CSS "Z" bubble.

## Notes

- Consider converting to **WebP** (keeping alpha) before bundling — the PNG is 1.18 MB.
- Character fill is ~20% of each cell (~8,000 non-transparent px of 39,936), so the pet window has
  generous transparent margin. Good for mouse-passthrough hit testing, but means the window is
  larger than the visible sprite — hit-test against actual pixels, not window bounds.
