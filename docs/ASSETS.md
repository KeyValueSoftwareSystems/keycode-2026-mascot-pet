# Swapping the pet art

The character currently shipping is **`pixel-coder`**, a placeholder: a pixel-art chibi human with
spiky brown hair, a green hoodie and blue jeans. It is not the Keycode mascot.

Replacing it is a **file swap plus a JSON edit — no code changes.** This document is how, and the
mechanisms that make it true.

Brand palette for whoever authors the replacement: purple `#A16AE8`, near-black `#141111`.

## What the art must be

| Property | Requirement |
|---|---|
| Format | PNG, RGBA, **alpha required** |
| Grid | Uniform cells, N columns × M rows. Currently 8 × 9 of 192 × 208 |
| Geometry | `columns × frameWidth` must equal the image width, and `rows × frameHeight` the height. The generator refuses inconsistent geometry rather than producing a subtly wrong sprite |
| Frames per state | At least 2. `steps(n, jump-none)` is undefined below that |
| Direction | **Two separate run rows**, one facing each way. There is no CSS mirroring anywhere — mirroring pixel art also mirrors its lighting and any asymmetric detail, which reads as a different character |
| Feet | Drawn at a consistent height across poses, or `footInset` is taken from the *minimum* so no pose clips below the floor |

The cell size need not match the current one. Everything downstream is derived.

## The swap, step by step

```bash
# 1. Replace the sheet.
cp your-new-sheet.png pet/spritesheet.png

# 2. Update the metadata.
$EDITOR pet/pet.json          # id, displayName, description

# 3. Update the animation map if the grid changed.
$EDITOR pet/spritesheet.json  # sheet dimensions, and each state's row/frames/durationMs

# 4. Regenerate everything derived from it.
pnpm generate

# 5. Verify.
pnpm test
pnpm smoke --name new-art --backdrop
pnpm smoke:states                # one screenshot per state
```

`pnpm generate` rewrites five committed artifacts:

| Artifact | Contents |
|---|---|
| `apps/desktop/src/renderer/pet.generated.css` | `@keyframes` and per-state rules, two nonce variants each |
| `apps/desktop/src/pet-animations.generated.ts` | The `AnimationState` union, `ANIMATIONS`, `REACTION_MAP`, `ANIMATION_ALIASES` |
| `apps/desktop/src/sprite/alpha-mask.generated.ts` | Coverage bits, `bbox`, `footInset`, per-state head tops, `setShape` rects |
| `apps/desktop/assets/pet/alpha-mask.json` | The same data, for tests and humans |
| `apps/desktop/assets/tray/trayIconTemplate.png` (+`@2x`) | Run `pnpm exec node scripts/generate-tray-icon.mjs` — a silhouette of the new character |

App icons are a separate, macOS-only step whose output is also committed:

```bash
node scripts/generate-icons.mjs   # build/icon.icns, icon.ico, icons/*.png from pet/preview.png
```

## Why no code changes are needed

Three mechanisms, each load-bearing:

**Geometry is generated, never typed.** `pet/spritesheet.json` is the only place a row index, frame
count or duration exists. A test asserts the hand-written CSS contains no `steps(` and no `192px`
or `208px`, so a pixel offset cannot creep back in. A second test regenerates and compares against
the committed output, so stale generated files fail the build.

**`AnimationState` is a generated union.** A typo in a state name is a *type error*, and the broadcast
manifest's "is this a known animation" check is derived from the same union rather than a second
hand-written list.

**Placement is measured, not assumed.** `footInset` — the distance from the bottom of a cell to the
lowest opaque pixel — comes from the generated mask, and the window's height and position are derived
from it. Art with different padding re-derives its own placement. The same mask drives hit-testing and
Linux's `setShape` input region, so all three stay consistent by construction.

## The `aliases` block

The behaviour spec needs a `stretch` animation the current art does not contain. Rather than repoint
the reaction map at a substitute, `spritesheet.json` carries:

```jsonc
"aliases": { "stretch": "jumping" }
```

The reaction map keeps saying `stretch-reminder → stretch`, which is what it *means*. When the art
lands, delete the alias entry and add the real state — nothing else changes.

The generator enforces two rules here: an alias target must be a real declared state, and an alias may
not shadow a state that exists. The second is what stops a stale alias silently masking new art.

## Adding a state to the current sheet

There is room without resizing. Fully transparent cells are free in rows 0, 3, 4, 6, 7 and 8 — see
`freeCells` in `spritesheet.json`.

Two states may share a row: `idle` and `sleep` are the same six frames at different speeds, which is
how `sleep` ships with no new art at all.

To extend instead, add rows and update `sheet.rows` and `sheet.height` together. The generator's
geometry check will reject a mismatch. An extended 12-row sheet with a real `stretch` at row 9 is
covered by a test, so that path is known to work.

## Known state of the current art

| Row | State | Frames | Note |
|---|---|---|---|
| 0 | `idle`, `sleep` | 6 | Includes a blink. `sleep` is the same row, re-timed to 16s |
| 1 | `running-right` | 8 | True run cycle |
| 2 | `running-left` | 8 | True run cycle |
| 3 | `waving` | 4 | Plays twice, then holds |
| 4 | `jumping` | 5 | Plays twice, then holds |
| 5 | `failed` | 8 | **8 declared, 6 distinct** — the last three repeat, which is what holds the slumped pose. Do not "optimise" to 6: it changes the timing and loses the beat |
| 6 | `drink` | 6 | **Reclaimed.** Was `waiting`, byte-identical to row 0 and therefore never an animation. Plays the idle frames until real art is drawn |
| 7 | `running` | 6 | **In-place busy loop, NOT locomotion.** Naming collision inherited from the source art; never wire it to movement |
| 8 | `review` | 6 | Hand-to-chin thinking pose |

Measured, by decoding the sheet rather than trusting `validation.json`:

- Per-frame opaque pixels: 7,393–9,725, mean **8,349 (20.9%** of a 192×208 cell)
- Union across all 63 frames: **14,111 (35.3%)**
- Union bounding box: `{ x: 42, y: 14, width: 107, height: 178 }`
- `footInset`: **16**, identical for every state
- Head top (cell top to the highest opaque pixel), per state: `review` 14, `running` 28, `idle`/
  `sleep`/`drink`/`waving` 37, `jumping`/`running-left` 46, `running-right` 51, `failed` 52. The
  speech bubble hangs off these, which is why they are measured per state rather than taken from the
  union bbox — a union anchor would sit 23px clear of the head in the idle pose
- `setShape` rects after run-merging: **26**, covering the mask area exactly

The body is 107 of 192 columns, so **44% of each cell's width is empty space beside the character**.
That is why hit-testing uses the mask and not the window bounds.

## What ships, and what does not

Only three files from `pet/` reach an installer, and the sheet is not one of them — Vite bundles it
into the renderer output, so shipping the original too would pay for it twice.

| File | In the repo | In an installer |
|---|---|---|
| `spritesheet.png` | yes | no (bundled into `dist/renderer/`) |
| `spritesheet.json` | yes | yes |
| `pet.json` | yes | yes |
| `source-sheet.png` | yes | no |
| `preview.png` | yes | no (source for the app icons) |
| `validation.json` | yes | no |
| `README.md` | yes | no |

`tests/packaging/packaging-config.spec.ts` asserts each of these, because an untested `files` filter
is exactly how 3MB of reference art ends up in every download.
