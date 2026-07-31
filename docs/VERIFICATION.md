# Verification

This app is an *appearance*. A frameless, transparent, always-on-top window is the one
category of software that unit tests structurally cannot confirm — a test can prove the
window was constructed with `transparent: true` and still miss that a compositor is painting
a grey box behind the sprite. So the loop is **build → launch → capture → look at the image**,
and the harness that does it was built before the pet existed.

## The two captures, and why there are two

`pnpm smoke` takes two different pictures because they answer different questions.

### 1. Window capture — always, no permission needed

`webContents.capturePage()`, in-process, written by the app itself on command from the
harness. It preserves the window's **alpha channel**.

This is what every automated assertion reads. For the question that matters most — *are this
window's own pixels transparent?* — reading alpha directly is a stronger signal than
sampling a composite, because a composite cannot distinguish a transparent window from an
opaque window painted the same colour as what is behind it.

It needs no Screen Recording permission, so it runs unattended, on a fresh machine, and in CI.

### 2. Composite screenshot — when permitted

`/usr/sbin/screencapture`, pinned to one display with `-D`. This is the picture a **human**
judges: the pet sitting on top of a real dark window, at the real z-order, composited by the
real compositor.

It requires a macOS Screen Recording grant. **If the grant is missing the run still passes on
the window capture and prints exactly what was skipped** — a missing permission must never be
mistaken for a passing gate.

#### Granting it

```
System Settings › Privacy & Security › Screen & System Audio Recording
```

Add the terminal or agent host that runs `pnpm smoke`, then **fully quit and relaunch that
app** — macOS only picks the permission up at process launch, so toggling it while the
terminal is open does nothing.

To confirm it took:

```bash
/usr/sbin/screencapture -x /tmp/tcc-probe.png && echo granted || echo "not granted"
```

## Running it

```bash
pnpm smoke --name m2-pet-over-dark --backdrop   # the standard evidence run
pnpm smoke --name debug --backdrop --keep-open  # leave the app up to poke at it
pnpm smoke:states                               # one image per animation state
pnpm smoke --name x --no-assert                 # capture without pixel checks
pnpm smoke --name x --no-composite              # skip the composite entirely
```

`pnpm smoke` builds first, always. Evidence is of built code, never of a Vite dev server with
HMR injected into the page.

Images land in `docs/demo/`: `<name>.window.png` (alpha, asserted) and `<name>.png`
(composite, for humans).

### Always use `--backdrop` for transparency evidence

The backdrop is an opaque `#101014` window with a 32px grid and a greyscale swatch strip.
It exists because **an opaque black or white box behind the sprite is invisible against a
white desktop** — the single most likely way a transparency bug ships unnoticed. The grid
also makes resampling artifacts visible: crisp 1px lines stay crisp, a rescaled capture blurs
them. The swatches expose colour-managed or bit-depth-reduced captures, where known values
shift.

## The assertions

| | Asserts | Fails when |
|---|---|---|
| **A1** sprite painted | ≥20% of the reported sprite rect has alpha > 32 | The sprite did not render, or rendered somewhere other than where main said it did. A single frame paints ~8360px into a 107×178 bbox ≈ 44%, so the 20% threshold is a 2× margin |
| **A2** window transparent | ≥98% of a ring outside the sprite but inside the window has alpha ≤ 8 | **This is P1, automated.** A background colour, halo, drop shadow or rounded-corner artifact all fail. The ring is entirely window pixels, so passing proves the window itself is see-through |
| **A3** not blank | ≥12 distinct quantised colours among opaque pixels | A denied-permission black frame, or a flat-fill regression |
| **A4** feet on floor | Sprite bottom is within 2px of the work-area floor | `footInset` or the placement formula is wrong — the pet floats above the Dock or sinks into it |
| **A5** composite shows pet | ≥15% of the sprite rect differs from the backdrop colour | Composite only. The pet is behind the backdrop — the relative always-on-top levels inverted |

## Exit codes

A CI log alone should be enough to diagnose a failure.

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | a pixel assertion failed |
| 2 | the app exited before a window appeared (stderr tail included) |
| 3 | timed out waiting for the app |
| 4 | the in-process window capture failed |
| 5 | a capture could not be decoded (16-bit / HDR) |

## Known heuristics and limits

- **The settle delay before capture is a heuristic.** `sprite-ready` (the renderer has
  `decode()`d the spritesheet) removes the dominant race, but *"has the compositor presented
  a frame"* has no portable signal. Default 400ms, override with
  `KEYCODE_PET_SMOKE_SETTLE_MS`. A3 is what stops a too-short delay silently passing on a
  blank window.
- **Relative always-on-top levels** between the backdrop (`normal`) and the pet (`floating`)
  are the least specified corner of the design. If the ordering ever inverts, A5 fails loudly
  rather than producing a quietly wrong screenshot.
- **The capture decoder assumes 8-bit sRGB.** On an HDR display `screencapture` may emit
  16-bit, which raises exit code 5 rather than mis-decoding. Use `--no-assert` to still
  collect the image.

## What is NOT verified, and cannot be from this machine

Stated plainly because a green checklist that silently means "macOS only" is worse than an honest gap.

| Area | Status |
|---|---|
| macOS window transparency, always-on-top, sprite rendering, motion | **Verified.** Screenshots in `docs/demo/`, plus a 100%-transparent alpha ring around the sprite and a live position sample showing 440px of travel with a direction reversal |
| macOS install from a **quarantined** `.dmg` | **Verified.** This is the step everyone skips: a locally built dmg carries no quarantine bit, so simply opening it proves nothing about ad-hoc signing. The attribute was applied by hand, inherited by the installed app, which then ran under App Translocation and rendered the pet over a real terminal window. `spctl` rejects it — expected without a Developer ID — but it launches rather than showing "damaged and can't be opened", which is exactly what `identity: '-'` buys |
| macOS packaged build refusing loopback HTTP | **Verified** in the packaged app's own log — the `app.isPackaged` half of the two-condition broadcast gate |
| **Launching from `/Applications`** | **FAILS on this machine, unexplained.** The byte-identical bundle works from the build directory and from `~/Applications`, including quarantined and translocated. From `/Applications` it produces no log, no stdout and no crash report, via `open` or direct exec, before and after an `lsregister` refresh. It could not be instrumented because macOS App Management blocks writing into bundles there. Most likely a machine-level policy interacting with an ad-hoc signature rather than a defect in the app — but that is **not proven**, and a human double-clicking in Finder is the test that would settle it |
| Right-click menu on the sprite | **Not directly verified.** The shared template is exercised by 15 tests and builds successfully in a real Electron process (the tray menu is constructed from it at boot), but no synthetic right-click was delivered — that needs cursor control the harness does not have |
| Click-through and drag | **Not directly verified.** The alpha mask, its rect derivation and the placement maths have 20 tests; the forwarding predicates and watchdog are ported from openpets. Delivering a real click at a real coordinate was not automated |
| **All Windows behaviour** | **Not verified.** The occlusion-tracker fix, the `HWND_TOPMOST` re-assert interval and the mouse-forwarding retry ladder are ported from openpets on trust. Their constants live in one named object so a Windows session can tune them without archaeology |
| **All Linux behaviour** | **Not verified.** Includes `window.setShape()` for click-through, the XWayland forcing, the bundled emoji font path (macOS used Apple Color Emoji in every test here), and the tray-menu fallback for Wayland's swallowed right-click |
| Windows `.exe`, Linux `.AppImage`/`.deb`/`.rpm` | **Never built.** The CI workflow exists but has never run — there is no git remote. `deb`/`rpm` must come from the Ubuntu leg only: fpm on an Apple Silicon host is documented to produce broken packages, which is why `pnpm package` is restricted to `--mac` |
| Broadcast reaching real clients | **Not done.** P4 is proven end to end against the local dev server — the callout appeared once, a restart showed nothing, and all nine fault modes were exercised live — but no host is chosen, so it has not crossed the internet |
| The bundled emoji font | **Not verified.** Every emoji test here rendered via Apple Color Emoji, which comes first in the font stack by design. The bundled COLRv1 file is the Linux backstop and only a Linux run exercises it |
