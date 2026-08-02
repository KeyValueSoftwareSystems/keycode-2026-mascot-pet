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
pnpm smoke --name x --place 900,420            # drop the pet at a screen position first
pnpm smoke --name x --size small               # switch pet size first
pnpm smoke --name x --sticky --callout "hi"    # a bubble that waits to be clicked
pnpm smoke --name x --fresh-profile            # wipe the harness profile for a clean first run
```

`--place x,feetY` drives the same path a real drop ends at — the same clamping and the same
snap-to-floor rule — so free placement is assertable from a screenshot. It is *not* a synthetic mouse
drag: the harness has no cursor, so the pointer plumbing itself stays a manual check.

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
| **A2** window transparent | ≥98% of a ring outside the sprite but inside the window has alpha ≤ 8 | **This is P1, automated.** A background colour, halo, drop shadow or rounded-corner artifact all fail. The ring is entirely window pixels, so passing proves the window itself is see-through. With `--callout`, the ring starts at the character's hair — see below |
| **A3** not blank | ≥12 distinct quantised colours among opaque pixels | A denied-permission black frame, or a flat-fill regression |
| **A4** placement | Floor-locked: sprite bottom within 2px of the work-area floor. Freely placed: the whole sprite is inside the work area | `footInset` or the placement formula is wrong — the pet floats above the Dock or sinks into it. For a freely placed pet the floor check would fail on *correct* behaviour, so main reports `floorLocked` and the assertion switches to the bound that still holds: a pet parked off-screen |
| **A6** pixel art crisp | Every source pixel forms a uniform block of device pixels — but only when there *is* a whole block | Smoothing has crept in. The block size is the display scale times the *pet's* scale, so it is 2 at `large`, 1.5 at `medium` and 1 at `small`; the assertion runs only when that is a whole number >= 2. Before sizes existed it was always 2, and leaving it that way made `small` report 18% uniform and look like a smoothing regression when the sprite was pixel-exact |
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

### A2 and the speech bubble

The bubble is anchored just above the character's hair and is wider than the body, so when one is
on screen the app is legitimately painting inside A2's ring — above it *and to both sides*.

Rather than loosen the threshold or skip the assertion, main reports `bubbleFloorY`: the screen y of
the current pose's topmost opaque pixel, which is by construction below every bubble pixel. On a
`--callout` run A2 excludes everything above that line and checks the rest, and the log says
`from the hair down` so a partial ring can never be mistaken for a full one. It comes from the same
generated per-state head top the renderer anchors the bubble to, so there is no second copy of the
geometry to drift.

Every run *without* `--callout` — which is every standard evidence run, including
`m2-pet-over-dark` — still checks the complete ring, so the unqualified transparency claim is still
made and still measured at 100%.

### The harness has its own profile

Runs launch with `--user-data-dir` pointing at `docs/demo/tmp/profile`, for two reasons that both cost
real time before it existed:

- The single-instance lock lives in `userData`, so a packaged pet running on the same machine made
  every smoke run **exit instantly and silently** — the child lost the lock, and because the wait
  timeout was `unref`'d there was nothing left to keep node alive, so it printed the banner and exited
  0. A run that did nothing looked like a run that passed. A child exit now rejects the pending waits
  with exit code 2 and names the likely cause.
- Evidence was being shaped by leftover manual state. One screenshot came out at `small` because a
  menu click hours earlier had persisted, and a broadcast test consumed the very message id it was
  meant to demonstrate.

The profile persists between runs, because some checks are *about* persistence — drag the pet, restart,
is it still there. `--fresh-profile` wipes it.

## Known heuristics and limits

- **The sprite rect is sampled at the moment of capture**, not at `window-ready`. It used to be
  read from the startup event, which meant that once the pet walked, the assertions indexed the
  region it had left — failing on a correct build when you were lucky and checking the wrong pixels
  when you were not. `capture-written` now carries a fresh rect. Set
  `KEYCODE_PET_SMOKE_DEBUG=1` to print the region, the window bounds and whether the rect was fresh.
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
| macOS pet sizes | **Verified.** All three captured (`docs/demo/v13-size-{small,medium,large}.window.png`), each with the sprite fill at ~43% of its own bbox — the same proportion at every scale, which is what shows the reported rect and the rendering agree. `large` measures 100% crisp; `medium` and `small` are skipped for the reasons in the A6 row. A bubble on a `small` pet is in `v13-size-small-bubble.window.png` |
| macOS free placement | **Verified.** Placed at feet-y 420, captured there (`docs/demo/v12-free-placement.png`), and a relaunch with no arguments came back at exactly y=420 from the persisted settings. What is *not* covered is the pointer plumbing — that the mouse-down/move/up sequence tracks the cursor — because the harness cannot move the cursor |
| macOS window transparency, always-on-top, sprite rendering, motion | **Verified.** Screenshots in `docs/demo/`, plus a 100%-transparent alpha ring around the sprite and a live position sample showing 440px of travel with a direction reversal |
| macOS install from a **quarantined** `.dmg` | **Partly verified, and the limit is now known.** A locally built dmg carries no quarantine bit, so simply opening it proves nothing; the attribute was applied by hand and was correctly inherited by the installed app, which launched under App Translocation. It does **not** get past Gatekeeper unattended — see the row below. What is proven is that the dmg builds, mounts, installs, and inherits quarantine, and that the bundle itself is sound: run from a non-Applications path the packaged app logs `packaged: true, version 1.4.0`, polls the real HTTPS host, and renders the pet (`docs/demo/v14-packaged-1.4.0.png`) |
| macOS packaged build refusing loopback HTTP | **Verified** in the packaged app's own log — the `app.isPackaged` half of the two-condition broadcast gate |
| **Launching from an Applications folder** | **Blocked on this machine — now explained.** Gatekeeper, not a defect. Installing the quarantined `.dmg` and launching produced the macOS dialog *"Keycode Pet" Not Opened — Apple could not verify Keycode Pet is free of malware*, with Done / Move to Bin. That is the modern form of the failure originally logged as unexplained: the process starts, stays alive, and never runs its main script, with no stdout, no log and no crash report. Isolated by running one **byte-identical** bundle (copied with `ditto`, `codesign -v` valid) from three places: build output — **runs**; a scratch directory — **runs**; `~/Applications` — **blocked**. So the variable is the Applications folder, not quarantine, not the copy method, not the signature: macOS assesses apps registered there strictly, and `spctl -a` rejects this one because it is ad-hoc signed (`identity: '-'`) and unnotarized. The real fix is a Developer ID plus notarization. Until then a human approves it once — right-click → Open, or System Settings › Privacy & Security › Open Anyway — or runs it from a folder that is not an Applications folder |
| Right-click menu on the sprite | **Not directly verified.** The shared template is exercised by 15 tests and builds successfully in a real Electron process (the tray menu is constructed from it at boot), but no synthetic right-click was delivered — that needs cursor control the harness does not have |
| Click-through and drag | **Not directly verified.** The alpha mask, its rect derivation and the placement maths have 20 tests; the forwarding predicates and watchdog are ported from openpets. Delivering a real click at a real coordinate was not automated |
| **Linux rendering** | **Verified in CI**, first time ever, on the v1.7.0 release run: `A1 sprite painted (43.2%)` and `A2 window transparent around the sprite (100.0% of ring)` under `xvfb` on `ubuntu-22.04`. The pet renders, and the window really is see-through. Still unverified there: `setShape` click-through (needs a pointer), the tray-menu fallback for Wayland's swallowed right-click, and the bundled emoji font — xvfb is X11, so the XWayland path was not exercised either |
| **Windows: boots and runs** | **Verified in CI.** The app reached `app-ready`, `window-ready` and `sprite-ready`, emitted a stream of `frame` events — so the motion engine is ticking — and fetched the Pages manifest, applying `pollMinutes` from it. That is the launch path, the window, the spritesheet decode, the renderer seam and the whole broadcast path, all working on Windows |
| **Windows: the pixels** | **Not verified.** `webContents.capturePage()` did not return within 8s on the runner, so the run ended at exit 3 with every assertion unrun. The app was demonstrably alive at that point, so this reads as the capture stalling on a session with no real compositor rather than an app fault — but it is the next thing to chase, and until it passes the transparency, always-on-top and click-through claims are macOS-and-Linux only |
| **Windows/Linux input** | **Not verified.** The occlusion-tracker fix, the `HWND_TOPMOST` re-assert interval, the mouse-forwarding retry ladder and Linux's `setShape` are ported from openpets on trust. Their constants live in one named object so a session on either platform can tune them without archaeology |
| Windows `.exe`, Linux `.AppImage`/`.deb`/`.rpm` | **Built and published.** The v1.7.0 release carries all nine artifacts from the three-OS matrix. `deb`/`rpm` must come from the Ubuntu leg only: fpm on an Apple Silicon host is documented to produce broken packages, which is why `pnpm package` is restricted to `--mac` |
| Broadcast reaching real clients | **Verified against a real host**, over the internet, with no env vars set. That evidence was gathered against the nginx box the manifest was originally served from; the host has since moved to GitHub Pages, which is **not** yet verified end to end — the first release rehearsal is what confirms it. A message published to the then-live host appeared in the pet (`docs/demo/m6-broadcast-live-host.window.png`), and a restart against the same file showed nothing — A2 reported the *full* transparency ring with no "a bubble is up" qualifier, which is the machine-checkable form of "the message did not re-appear". All nine fault modes were exercised against the dev server, which is where they can be injected |
| The bundled emoji font | **Not verified.** Every emoji test here rendered via Apple Color Emoji, which comes first in the font stack by design. The bundled COLRv1 file is the Linux backstop and only a Linux run exercises it |
