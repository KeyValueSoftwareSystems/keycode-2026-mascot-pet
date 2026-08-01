# Architecture

One Electron process. One pet window, one tray icon, and a toast window when needed. No server.

The design is organised around a single idea: **push everything that can be a pure function out of
the impure shell, so the parts with rules in them can be tested without a screen.** The pet's
liveliness, its callout arbitration, its reminder scheduling and its manifest parsing are all pure.
Windows, timers, the filesystem and the network are not, and they are confined to `main/`.

```
                            main process
                                 │
   ┌─────────────────────────────┼──────────────────────────────┐
   │                             │                              │
main.ts                     pet-window.ts                    tray.ts
├ switches (sync, first)     ├ transparent, always-on-top     └ menu, and the ONLY
├ single-instance lock       ├ setIgnoreMouseEvents / setShape   settings surface on
├ dock.hide + accessory      ├ cursor-probe watchdog             Wayland
└ hand off to app-shell      └ IPC, provenance-checked
                                 │
        ┌────────────────────────┼─────────────────────────┐
        │                        │                         │
   ┌────┴─────┐          ┌───────┴────────┐       ┌────────┴────────┐
   │  PURE    │          │ impure shells  │       │ impure shells   │
   │  ──────  │          │ ────────────── │       │ ─────────────── │
   │ motion/  │◄─────────┤ pet-controller │       │ broadcast-      │
   │ callouts/│ triggers │ (the ONE tick) │       │  poller         │
   │ reminders│          │ reminder-svc   │       │ (net.fetch)     │
   │ broadcast│          │ callout-host   │       └────────┬────────┘
   │  /schema │          │ (the ONE timer)│                │
   └────┬─────┘          └───────┬────────┘                │
        │                        └─────────────┬───────────┘
        │                                      │
        │        PetFrame — one validated object, ~8 fields
        ▼
   pet-preload.cjs ──► renderer/pet.{html,css,ts}
        ▲                 (attributes and textContent; nothing else)
        │
        └──  { pointerOverPet: boolean }
```

---

## Seam 1: `PetFrame`

One serializable object flows main → renderer. One boolean flows back.

```ts
{ animation, animationNonce, facing, sprite: {x,y}, bubble: {...} | null, overlay }
```

The renderer's entire job is to set `data-state`, `data-nonce`, `data-facing` and `data-overlay`, set
`textContent` on the bubble, hit-test `mousemove` against the alpha mask, and report one boolean. It
holds no timers, makes no network calls, runs no state machine, and never sees a URL.

**Why this matters more than it looks.** Behaviour in a renderer cannot be unit-tested and now lives
in two processes. It also creeps in one convenient `setTimeout` at a time, so
`tests/renderer/discipline.spec.ts` greps the renderer source for timers, `fetch`, `innerHTML`, `eval`,
any `electron` import, and any string that looks like a URL. The rule is enforced, not trusted.

### `animationNonce`, and why it exists

A CSS animation is cancelled and recreated **only when `animation-name` changes**. Changing duration
or iteration count mutates the animation's timing in place and preserves its local time.

So the tempting design — one shared `@keyframes` whose endpoints read CSS custom properties, with
per-state rules that re-point those properties — is broken for finite animations. With one animation
started at load, local time grows monotonically for the whole session; selecting `waving` (700ms × 2)
after five minutes of uptime finds it already past its active duration, so it paints one static frame
instead of playing.

Giving every state its own `@keyframes` makes every state change a restart for free. Re-triggering the
*same* state still would not restart, so each state gets two byte-identical keyframe rules and main
flips a nonce between them. Keeping the nonce in main keeps *"should this replay"* — which is
behaviour — out of the view.

### The URL the renderer never sees

A clickable bubble reports `clickable: true` and calls `openCalloutUrl()`. Main looks up the URL it
already validated and re-validates it at the moment of use. A renderer that cannot name a URL cannot
be talked into opening a bad one.

---

## Seam 2: the pure motion core

```ts
advance(state: MotionState, input: MotionInput, config?: MotionConfig): MotionState
```

No `Date.now()`, no `Math.random()`, no Electron, no timers — asserted by a purity scan over the whole
directory. The clock arrives as `input.now`; randomness is a seed threaded through state (mulberry32,
integer ops only, so the sequence is identical on every platform).

That buys the test the design exists for: **10,000 ticks — ten minutes of pet life — in about 90ms**,
deterministically, asserting the pet never leaves the floor, never plays an unknown state, never
travels backwards relative to its facing, never sticks longer than an animation should last, explores
over half the screen, and never plays `sleep` or `drink` unasked. Held across twenty seeds, with a
committed golden hash so a behavioural regression is a one-line diff in review.

It also makes the awkward cases cheap to test: a three-hour suspend, a floor that shrinks mid-run (the
monitor-unplug case), a display narrower than the pet, a 10,000px/s config, a backwards clock.

### Animation completion is state, not a timer

`animationEndsAt` is a number in `MotionState`, and the existing tick observes `now >= endsAt`. The
obvious alternative — `setTimeout(durationMs × iterations)`, which openpets uses — drifts, leaks on
state change, and cannot be exercised by a headless simulation. Worst case here is one tick of
overshoot on a held final frame, which `animation-fill-mode: forwards` makes invisible.

### The `dt` clamp

`dt` is clamped to 250ms. Not defensiveness: after a lid close the first tick's delta is *hours*, and
an unclamped integration teleports the pet across several screens in a single step.

---

## Two clocks, deliberately unsynchronised

| Clock | Rate | Owner | Moves |
|---|---|---|---|
| Window motion | ~60ms, integer-pixel steps | `pet-controller.ts` | `setPosition` |
| Sprite frames | each state's own `durationMs` | CSS, in the renderer | `background-position` |

Moving a window on every animation frame stutters some compositors; stepping the sprite from main would
mean an IPC message per frame. Each clock lives where it is cheap. The only coupling is that a *state
change* crosses the boundary, which happens a few times a second at most — and the controller only
sends a frame when the serialized frame actually differs.

`setPosition` is never issued as a no-op, because some compositors do real work regardless.

---

## One window holds the pet and its bubble

The bubble follows the pet for free, there is one set of bounds to place, and one alpha mask to
hit-test. The cost is a window much larger than the visible character — 360 × 304 for a body that is
107 × 178 — which is exactly what the mask handles.

### The bubble is anchored to the character, not to the window

It is a comic speech bubble — near-white fill, hard dark outline, dark text, and an outlined tail
whose mouth opens into the bubble body. It hugs its text, is centred on the body's horizontal
centre, and the tail points down at the head. Anchoring it to the window instead — pinning it to the top corner and
stretching it across the full width — is the obvious thing to write and looks wrong, because the
window is 360px wide for a 107px body and the sprite cell has transparent padding above the hair. It
leaves the bubble around 84px clear of the head, where it reads as an unrelated notification that
happens to be nearby rather than as the pet speaking.

Two custom properties carry the anchor, set on `:root` by the renderer from the generated mask:
`--body-cx` and `--body-top`. The vertical one is the **per-state** head top, not the union bbox's.
The union is the minimum over every pose — on this art `review` reaches 23px higher than idle's hair
— so a union-anchored bubble floats that gap in the pose the pet spends most of its life in. Per
state rather than per frame, because a per-frame anchor makes the bubble bob with the animation.

Its height clamp is a whole number of text lines chosen to fit above the hair in the *highest* pose,
so the bubble can never be clipped by the top of the window and an over-long message loses a whole
line rather than half of one. A full 200-character message — the manifest schema's cap — wraps to
five lines and does not reach the clamp.

The fill is **opaque**, unlike the translucent panel it replaced: this bubble carries remote text
someone is meant to read and act on, floating over whatever they are working on, and translucency
over a busy window makes 13px text unreadable. Severity still rides on a coloured left edge rather
than on the fill, so the shape reads as a speech bubble first and a status indicator second. The
corner toast is a separate surface and stays dark — it is a notification, not the pet talking.

### Placement is measured, not assumed

`footInset` is the distance from the bottom of a sprite cell to its lowest opaque pixel: **16px** on
this art, identical across every state. From it:

```
windowHeight = bubbleAreaHeight + frameHeight - footInset      // 112 + 208 - 16 = 304
windowY      = floorY - (spriteOrigin.y + frameHeight - footInset)
```

The window is sized to **end at the sprite's feet**. Sized to the full cell instead, its bottom 16 rows
are transparent, so feet-on-floor would require hanging below the work area — which macOS clamps back
inside the visible frame, silently lifting the pet by exactly `footInset`.

### Free placement, and why `floorLocked` is a separate flag

The pet can be dragged anywhere, not just along the floor. Two fields carry it: `feetY` (screen y of
the lowest opaque pixel) and `floorLocked`.

The flag is not redundant with `feetY === floor.y`, because the two states behave differently in a
way that matters:

| | `feetY` each tick |
|---|---|
| **Floor-locked** (default) | **Re-derived** from the floor, so a Dock resize or a resolution change moves the pet automatically — the same self-correcting property `x` has always had |
| **Freely placed** | **Clamped** into the envelope, never recomputed, because the height is the user's intent and recomputing it would discard it |

Dropping the pet within 24px of the floor re-locks it and snaps it flush, so dragging it back down is
how you undo a free placement — no menu item, and no need to land on an exact pixel.

There is no gravity: a dropped pet stays at that height and patrols left/right there. A simulation
invariant asserts that ten minutes of unattended running never changes `feetY` or clears
`floorLocked`, which is what would catch a plan quietly acquiring a vertical component.

**How high it can go** is bounded by the *window*, not the body: `feetY >= workArea.y +
spriteBottomOffset`, so the window's top edge stays inside the work area. That guarantees a speech
bubble is always fully visible, since above the work area it would render behind the menu bar. The
cost is that the pet's head cannot quite reach the top ~126px of the screen. Messages being readable
won that trade.

**Window bounds are not clamped to the work area; the pet's centre-x is.** The window is far wider than
the character, so clamping the window would stop the body ~126px short of the screen edge, and that gap
of nothing looks exactly like the bug it was meant to prevent. The window is allowed to hang partly
off-screen.

### Pet size is a transform, not a resize

Three sizes: `large` (1.0 — what the app always rendered at), `medium` (0.75), `small` (0.5).

**Scaling had to be a CSS `transform`, not a change of width/height or `background-size`.** The
generated keyframes step `background-position` in absolute pixels off the unscaled sheet, so resizing
the element would invalidate every one of them. A transform from `top left` leaves that arithmetic
untouched and scales the painted result, and `image-rendering: pixelated` still applies through it.

Everything else derives from one number. The mask is measured once at native size and *never*
rescaled — three masks could disagree — so the conversion happens at the two boundaries that touch
the screen: a hit-test divides by the scale on the way in, a screen rect multiplies by it on the way
out. Hit padding is divided too, which keeps the grab margin the same size on screen at every pet
size; a small pet would otherwise be proportionally as easy to grab but absolutely much harder.

The **window width does not scale.** Bubble text stays 13px at every size, because a bubble at half
size is not readable and being read is its whole job. Only the height follows the sprite.

`medium` is deliberately soft on a Retina display: 0.75 × 2 = 1.5 device pixels per source pixel, so
it resamples. The alternative was 1.5/1.0/0.5 — all exact — but that renames today's size to "medium".
Keeping the shipped size as `large` was the explicit choice.

### Hit-testing

The character fills ~21% of its cell, and the empty space is overwhelmingly horizontal — 44% of each
cell's width. Hit-testing window bounds would therefore eat clicks across a wide invisible band beside
the pet.

So the generated mask is a **union across all 63 frames** at 4px granularity, with 8px of padding so
thin limbs stay grabbable. Union rather than per-frame deliberately: a per-frame mask makes the
grabbable area pulse in time with the animation, so the pet becomes intermittently un-grabbable in a
way that feels broken. Slight over-grab is invisible; flicker is not.

The same mask serves three consumers: renderer hit-testing, Linux's `setShape` input region (26 rects
after run-merging), and floor placement.

---

## Per-platform click-through

| Platform | Mechanism |
|---|---|
| macOS, Windows | `setIgnoreMouseEvents(true, { forward: true })`. The window ignores clicks but still receives *move* events, which is the only way a click-through window learns the cursor arrived |
| Linux | Forwarding does not deliver hover at all, so a click-through Linux window is permanently ungrabbable. The window stays interactive and `setShape()` restricts its input region to the mask rects instead. X11-only, best effort, re-applied after navigation |

**Forwarding dies silently**, which is why there is a watchdog. On Windows, Chromium's forwarded-mouse
tracking goes stale after rapid reloads and fullscreen sweeps; on macOS the WindowServer stops
delivering forwarded moves after Space switches, display sleep and fullscreen transitions. The symptom
is a pet stuck click-through that cannot be grabbed at all. `screen.getCursorScreenPoint()` keeps
working when forwarding is dead, so main polls it every 750ms, re-arms, and pushes a probe with
main-translated coordinates so the renderer can re-hit-test without a mouse event it will never see.
Windows gets extra re-arms at +75/175/400/900/1500ms, because it sometimes re-registers only after
Chromium finishes late compositing work.

---

## Wall-clock durations

Every duration over a minute is a **persisted deadline compared against `Date.now()`**, never an
interval. Close a laptop for two hours and `setInterval` either fires nothing or fires a burst on wake,
depending on platform — both are the bug.

A 15s tick compares against the deadline. A deadline overdue by two or more whole intervals means the
machine was away, so it is rescheduled without firing. A deadline further out than one interval means
the clock jumped backwards, so it is reset. `powerMonitor` `suspend` flushes settings *before* the lid
closes, which is the only reason the miss rule has data on the other side.

---

## Untrusted input

The broadcast manifest is remote text rendered into a window floating above everything on someone's
machine, so it is treated as hostile end to end:

- **HTTPS only**, with redirects followed *manually* — max 3 hops, scheme re-validated at each. With
  `redirect: 'follow'` the rule would constrain only the initial URL, and a `302 https → http` would
  be taken silently.
- **64KB streaming cap.** Abandoned mid-read, never buffered then measured.
- **Strict envelope, forgiving entries.** A malformed envelope means trust nothing; a malformed *entry*
  costs only itself and is logged. The alternative — a naive strict array — means one typo'd field
  silences every announcement for every install.
- **Sanitising strips bidi overrides and isolates**, not just control characters. `textContent` closes
  script injection but not spoofing: those characters are inert and reorder everything after them, so
  the visible text can differ from what the manifest says. U+200D and U+FE0F are kept, because
  stripping them breaks emoji.
- **Failure is silent.** Every error path is one log line: no dialog, no bubble, no interruption. The
  single exception is a user-initiated "Check for updates…", where silence would read as a broken menu.

`shell.openExternal` has exactly one call site, and it re-validates at the moment of use even though
the schema already validated at parse time — the second check is the one that still holds if the value
was cached or restored from disk.

---

## What would break, and what would change

**Two app instances.** Prevented by `requestSingleInstanceLock()`. The loser calls `app.exit(0)` rather
than `app.quit()`, because `quit()` runs the before-quit chain, which flushes the settings file the
*first* instance owns.

`app.setName()` must precede the lock: the lock is a file inside `userData`, so taking it caches that
path, and `userData` derives from the app name. Setting the name afterwards is silently too late.

**Multiple displays.** The controller re-derives the floor every tick from the display nearest the pet,
so a monitor unplug or a Dock resize is self-correcting rather than needing a recovery path. Displays
are keyed by geometry string, not Electron's numeric id, because ids are not stable across reboots and
an id-keyed saved position silently resolves to "no saved position".

**Scaling out.** Nothing here scales — and nothing needs to. There is no server, no shared state, and
no coordination between clients. The broadcast manifest is a static file, so N clients cost N GETs
against a CDN. If that ever mattered, the poll interval already carries ±20% jitter specifically so a
fleet installed at the same moment does not converge into a thundering herd.

**asar.** Disabled. Electron 42 silently fails to load an ESM entry point from inside an asar archive:
the process starts, stays alive, and never runs its main script — no window, no log, no error. asar was
never a security boundary, so the cost is tidiness.

**A packaged app has no usable stdio**, which is why there is a file logger at
`<userData>/logs/main.log`, surfaced in About. The first packaging failure was completely opaque until
it existed.
