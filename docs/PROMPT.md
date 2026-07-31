# KEYCODE PET — Desktop Companion Proof of Concept · Implementation Brief

You are the sole engineer on a cross-platform desktop application. Build it end to end. This document is the spec, the architecture, and the acceptance criteria.

---

## 0. Prime directive

**The illusion is the product.**

A colleague installs this, and a small pixel character is suddenly *living on their desktop* — running along the bottom of the screen, over their editor, over a fullscreen video call, grabbable with the mouse, reminding them to drink water, and occasionally turning to the whole company to say "Keycode is on fire 🔥". Nothing about it reads as a window. Nothing about it reads as a bug.

That single impression is the deliverable. Everything below serves it.

The failure modes are all visual and all specific: a grey box behind the sprite, a smudged non-pixel-crisp character, a pet that vanishes when an app takes focus, a pet that can't be grabbed because mouse forwarding silently died, a pet that jitters because someone called `setBounds` sixty times a second, a pet stuck half-off the screen after unplugging a monitor. **These are the bugs. They are not edge cases; they are the work.**

Four rules that override everything else in this document:

**Look at the thing.** This is a visual feature on a transparent always-on-top window — the one category of software that unit tests structurally cannot confirm. So the loop is **build → launch → screenshot → look at the PNG**, and it is built in **M0, before the pet exists** (§6). Never claim a visual milestone works on the strength of code reading. Screenshot it, over a dark window, and look.

**Main owns truth; the renderer is a dumb view.** One serializable `PetFrame` flows main → renderer. One boolean flows back. The renderer decides nothing about behaviour. This is the seam the whole build rests on, it makes the pet's liveliness unit-testable with zero Electron, and it is a hard gate in M3 (§4.2).

**One source of truth for the sprite geometry: `pet/spritesheet.json`.** Frame counts, row indices, durations and state names are declared there once and **generated** into CSS and TypeScript. Nobody types `-208px` or `steps(8)` by hand, anywhere. This is what makes locked decision #10 — "swapping the art is a file swap plus a `pet.json` edit, zero code change" — actually true instead of aspirational (§5.3).

**Never trust a timer to measure a long duration.** A laptop lid closes and `setInterval` lies. Every duration over a minute is a persisted wall-clock deadline compared against `Date.now()`, not an interval you started and hoped about (§4.6). This is the correctness rule of this project the way decimal money was for a payments system: easy to get wrong, invisible in testing, obvious in the wild.

Do not stop at "it runs." Stop when the six proofs in §2 are each demonstrated by a committed screenshot or a passing test.

---

## 1. What we are building, and the source material

### The two authorities

| Source | Read it as | Do NOT read it as |
|---|---|---|
| **GitHub issue [`doylefermi-kv/cos-claude#12`](https://github.com/doylefermi-kv/cos-claude/issues/12)** | **Product truth and locked decisions.** The behaviour spec, the right-click menu, the broadcast mechanism, the platform gotchas, the ten locked decisions. Read it in full before writing code. | An architecture. It names files; it does not design the seams. |
| **[`alvinunreal/openpets`](https://github.com/alvinunreal/openpets) (MIT)** | **Solved-problem archive.** 995 stars, actively pushed, and it has already paid for the discovery of every platform failure mode listed in §7. Mine `apps/desktop/src/` and `docs/`. | A codebase to fork or vendor. This is a **fresh repo** (locked decision #1). |

Where this brief and the issue conflict, **this brief wins on engineering** and the **issue wins on locked decisions and product behaviour**. Where this brief and openpets' actual source conflict, **openpets' source wins on platform behaviour** — it was written against real compositors, this was written from its documentation. Record every such divergence in `DECISIONS.md`, one line each.

There is exactly one deliberate deviation from the issue, declared up front: the issue's M5 bundles reminders and broadcast together. **This brief splits them** — broadcast is the headline capability and earns its own milestone and its own gate (§6). Everything else tracks the issue.

### What openpets is for, and what it is not

openpets is a large product: a plugin SDK, a pet marketplace, LAN multiplayer, agent integrations for four coding tools, a React control centre. **Roughly 40 of its ~110 desktop source files are plugin infrastructure.** You want almost none of it.

Clone it once as read-only reference material outside the repo (or into a gitignored `reference/openpets/`), read the four docs that matter — `docs/pets.md`, `docs/desktop.md`, `docs/wayland.md`, `docs/release.md` — and then take exactly this:

| openpets file | Take | Why |
|---|---|---|
| `pet-window.ts` | **Adapt — core** | Transparent always-on-top creation, passthrough, drag, display clamping |
| `mouse-forwarding.ts` | **Adapt — core** | Per-platform forwarding predicates. This file is the distilled cost of the bugs in §7 |
| `pet-motion-engine.ts` | **Study, then rewrite** | Their state machine is coupled to plugins and 2D roaming. Steal the shape, write ours pure (§4.3) |
| `pet-roaming-controller.ts` | **Study, then rewrite** | 2D gravity/bounce → our horizontal floor run |
| `reaction-animation-mapping.ts` | **Take the indirection** | `trigger → reaction → animation state`. Our `reactionMap` already lives in `spritesheet.json` |
| `plugin-bubble-arbiter.ts` | **Adapt** | Transient priority queue + pinned slot, coalescing, max-queue. Strip plugin coupling |
| `plugin-toast.ts` | **Adapt** | Corner-toast fallback window, tone accents, locked-down CSP |
| `update-checker.ts` | **Adapt** | HTTPS poll, in-flight dedupe, version compare, 6s timeout, env-overridable URL |
| `tray.ts`, `display.ts`, `lifecycle.ts`, `app-state.ts` | **Adapt** | Tray shell, multi-monitor, persisted state, clean quit |
| `electron-builder.yml` | **Take, then cut** | Ready-made three-OS target matrix |
| `wayland-backend.ts` | **Read carefully** | Native draggable regions. Do not rediscover this |
| Everything `plugin-*`, `lan-*`, `catalog*`, `pet-pool.ts`, `lease-manager.ts`, `codex-pets*`, `packages/*`, `web/`, `plugins/`, the React control centre | **No** | Out of scope by locked decisions #2 and #3 |
| Their sprite art | **Absolutely not** | We have our own asset (§5) |

**Licence obligation, and it is not optional.** openpets is MIT. Adapted code requires the copyright notice retained. Create `THIRD-PARTY-NOTICES.md` in the first commit that adapts a file, containing openpets' full MIT text and a list of which of our files derive from which of theirs. Internal-only distribution removes signing and attestation obligations (locked decision #4) — it does not remove this one.

---

## 2. The six proofs

This is the acceptance thesis. Each proof needs either a **committed screenshot** in `docs/demo/` or a **named test**. Nothing else in this brief matters if these do not hold.

**P1 — The window is invisible; only the pet is visible.**
Frameless, `transparent: true`, `#00000000`, `hasShadow: false`. Launch the app over a **dark, non-white** application window, `screencapture` the screen, and open the PNG: the pixel character sits on the dark background with no box, no halo, no grey rectangle, no drop shadow, and no rounded-corner artifact. *A white desktop hides exactly this bug — screenshotting against white proves nothing and is not accepted as evidence.*
Then focus another app, then fullscreen it, then switch Spaces/workspaces: the pet is still there, still on top.

**P2 — Clicks pass through everything except the pet's own pixels.**
The character fills ~20% of its 192×208 cell (§5.2), so window-bounds hit-testing would eat clicks in a large invisible rectangle around it. Hit-test against the **generated alpha mask** (§5.4). Click 20px to the left of the sprite's shoulder → the app underneath receives it. Click the sprite's chest → the pet receives it.
Then prove it *stays* true: switch Spaces, sleep and wake the display, reload the window, sweep a fullscreen app across it — and the pet is still grabbable, because the cursor-probe watchdog re-armed forwarding (§7).

**P3 — It reads as alive.**
Movement **on**: the pet runs left↔right along the display's work-area floor, flips at edges using the `running-left` / `running-right` rows, and breaks up the traversal with jumps, skid-stops, turn-arounds and idle dwells on a randomised timer. Frame counts and durations match `spritesheet.json` exactly. The pixel art is **crisp, not smoothed**, including on a HiDPI display.
Movement **off**: the pet stays put and still animates in place. **Dragging works in both modes** (locked decision #7), and dropping sets the new resting position.
And the same behaviour is proven headlessly: `pnpm test` simulates ten minutes of pet life in milliseconds and asserts it never leaves the work area, never sticks in a state, and always faces its direction of travel (§4.3).

**P4 — One static JSON file talks to every installed client. ⭐**
Add an entry to the hosted manifest. Within one poll interval, a running client shows it as a callout bubble anchored to the pet, with the pet playing the entry's animation. It shows **exactly once per install**, ever. No push service, no socket, no per-user registration, no backend — a static file on a static host.
Then the negative cases, all of which are the actual work: an expired entry never shows; an entry with `startsAt` in the future never shows; a 500, a timeout, a truncated body, malformed JSON, and no network at all each produce **zero** user-visible output and zero interruption to the pet; and `<img src=x onerror=alert(1)>` in the `text` field renders as literal characters in the bubble.

**P5 — It survives being a real desktop app.**
Position, all three toggles, and the set of seen broadcast ids persist across quit and relaunch. Close the laptop lid for an hour and reopen: reminders do **not** dump a backlog (§4.6). Unplug a monitor while the pet is on it: the pet is clamped back into a visible work area, not orphaned off-screen. Launch twice: the second launch focuses the first, it does not spawn a second pet. Quit from the tray: no orphaned windows, no orphaned process.

**P6 — One codebase, three installers.**
macOS `dmg`+`zip` (ad-hoc signed, `identity: "-"`), Windows `nsis` (`perMachine: false`), Linux `AppImage`+`deb`+`rpm`+`tar.gz`. Built from one `pnpm package`.

### Anti-proofs — these must also hold

```bash
# CORRECTED during the build. The original commands had two false positives and one guaranteed
# failure: unanchored `lease` matches "please", `lan-` matches "plan-", and the CSS grep matched the
# *generated* stylesheet living in the same directory as the hand-written one.
grep -rniE '\bplugins?\b|\bmarketplace\b|\bcatalog\b|\blan-|\bleases?\b' apps/desktop/src/   # → 0
grep -rn 'innerHTML\|outerHTML\|insertAdjacentHTML' apps/desktop/src/renderer/   # → 0
grep -rn 'react\|tailwind' apps/desktop/package.json   # → 0
grep -rnE '\b208px\b|steps\([0-9]' --exclude='*.generated.*' apps/desktop/src/renderer/*.css   # → 0
grep -rn 'requestAnimationFrame' apps/desktop/src/renderer/   # → 0 (CSS drives frames, not JS)
```

These are enforced as tests in `tests/renderer/discipline.spec.ts` rather than left as commands to
remember to run.

No hand-authored animation geometry. No framework in the pet renderer. No per-frame JavaScript. No HTML-string interpolation anywhere the manifest's text can reach.

---

## 3. Stack and hard constraints

| | |
|---|---|
| Runtime | **Electron `^42.0.0`** — main process (Node) + one renderer per window |
| Language | **TypeScript `^6`, strict mode, ESM** (`"type": "module"`). The preload is the sole exception and is `.cjs` |
| Node | `>=20` |
| Package manager | **pnpm** workspace. `pnpm-lock.yaml` committed; version pinned in `packageManager` |
| Build | **Vite `^8`** for the renderer bundle, **`tsc`** for the main process. `concurrently` + `cross-env` + `wait-on` for dev |
| Packaging | **`electron-builder` `^26`**, `asar: true`, x64 + arm64 where applicable |
| Pet rendering | **CSS sprite-sheet stepping.** One `div`, `background-position` `steps()` keyframes, `image-rendering: pixelated`. No canvas. No game engine. No per-frame JS |
| UI framework | **None.** Zero-dependency renderer: one HTML file, generated CSS, one small TS module |
| Validation | **Zod** for the broadcast manifest, the settings file, and the IPC payloads |
| Tests | **Vitest** — headless, no Electron, over the pure modules (§4.3) |
| Persistence | One JSON file in `app.getPath('userData')`, atomic write, Zod-validated read |

**Security posture — non-negotiable, these are the defaults and they stay:**

```ts
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  preload: /* pet-preload.cjs */,
}
```

Plus: `setWindowOpenHandler` → always deny. `will-navigate` → always prevent. A strict `Content-Security-Policy` on every renderer HTML (`default-src 'none'`, explicit `img-src`/`style-src`, no `'unsafe-inline'` for scripts). The preload exposes a **narrow, enumerated** API over `contextBridge` and **never** calls an Electron window API itself — it forwards to main and main decides. Manifest text is untrusted input all the way to the DOM: `textContent` only.

### Dependency budget

Runtime dependencies, target count: **zero to two.**

- `zod` — yes. Validating untrusted network and disk input is the point.
- `get-windows` — **no.** It exists in openpets for foreground-window occlusion. We are not implementing occlusion. Defer.
- `sharp` — **no.** The PNG→WebP conversion and the alpha-mask generation are one-off/build-time scripts; run them with a devDependency or a committed generated artifact, and keep `sharp` out of the shipped app.
- `yauzl` — **no.** No downloadable pets.
- `electron-updater` — **not before M8**, and probably not at all (§6 M8).

### Explicitly forbidden

A plugin system. A pet catalog, marketplace, or installer. Multiple pets. Pet selection or customization. A settings window or "control centre" of any kind — the right-click menu is the *only* settings surface (locked decision #3). React, Vue, Svelte, Tailwind, or any UI framework in the pet renderer. Canvas or WebGL sprite rendering. `requestAnimationFrame`-driven sprite frames. Agent/CLI integrations. LAN mode, sockets, WebSockets, a push service, or any backend. Code signing, notarization, or store attestation. A login, account, or telemetry system. openpets' sprite art.

---

## 4. Architecture

One Electron app. One pet window. One tray icon. No server.

```
                          main process  (Node, owns all truth)
                                 │
  ┌──────────────────────────────┼────────────────────────────────┐
  │                              │                                │
lifecycle.ts                pet-window.ts                    tray.ts
├─ single-instance lock     ├─ transparent always-on-top      └─ menu fallback
├─ dock.hide() on macOS     ├─ setIgnoreMouseEvents(fwd)         for Wayland
├─ powerMonitor hooks       ├─ drag / native draggable
└─ clean quit               └─ display clamping
                                 │
        ┌────────────────────────┼─────────────────────────┐
        │                        │                         │
  ┌─────┴──────┐        ┌────────┴─────────┐      ┌────────┴─────────┐
  │  PURE      │        │  side-effecting  │      │  side-effecting  │
  │  ─────     │        │  ──────────────  │      │  ──────────────  │
  │ motion-    │        │ reminders.ts     │      │ broadcast-       │
  │  engine.ts │◄───────┤ (wall-clock)     │      │  poller.ts       │
  │ run-       │trigger │                  │      │ (HTTPS + Zod)    │
  │  planner.ts│        └────────┬─────────┘      └────────┬─────────┘
  │ callout-   │                 │                         │
  │  arbiter.ts│◄────────────────┴─────────────────────────┘
  │ hit-test.ts│                    triggers
  └─────┬──────┘
        │  PetFrame  (one serializable object, ~30 bytes of truth)
        ▼
   pet-preload.cjs  ──►  renderer/pet.html + generated pet.css
        ▲                 (dumb view: sets data-state, sets bubble textContent)
        │
        └───  { pointerOverPet: boolean }   ← the only thing flowing back
```

### 4.1 Process and window inventory

| Window | When | Size | Purpose |
|---|---|---|---|
| **pet** | always | 360×320 logical px | The sprite (192×208, anchored bottom-centre) plus the bubble area above it |
| **toast** | on demand | 300×64 | Corner-toast fallback for `urgent` broadcasts, or when the pet is hidden |

Both are `frame: false`, `transparent: true`, `hasShadow: false`, `resizable: false`, `skipTaskbar: true`, `show: false` until ready.

**Why one window and not two for the pet+bubble:** the bubble follows the pet for free, there is one set of bounds to clamp, and one alpha mask to hit-test. The cost is a larger transparent window, which P2's alpha hit-testing already handles. Locked; note it in `ARCHITECTURE.md`.

**Always-on-top is asserted, not set once:**

```ts
win.setAlwaysOnTop(false)                                  // the toggle matters — see §7
win.setAlwaysOnTop(true, process.platform === 'linux' ? 'screen-saver' : 'floating')
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
```

**Scale:** render the sprite at **1×**, 192×208 logical pixels. If a scale factor is ever added it must be an **integer** — non-integer scaling destroys pixel art no matter what `image-rendering` says. For the POC, 1× only.

### 4.2 The seam: `PetFrame` and the dumb renderer — HARD GATE (M3)

This is the decision everything else hangs off. Get it right and the rest is mechanical; get it wrong and behaviour ends up smeared across two processes where it can neither be tested nor reasoned about.

**The main process owns every piece of truth.** Animation state, facing, position, floor, whether movement is enabled, which callout is showing, what the reminders are waiting on. The renderer owns nothing but geometry.

Define the contract once, in one file both sides import:

```ts
// src/pet-frame.ts  — the ONLY thing main tells the renderer
export type AnimationState = /* generated from spritesheet.json — see §5.3 */

export const petFrameSchema = z.object({
  animation: z.string(),                    // narrowed to AnimationState by the generated type
  facing: z.enum(['left', 'right']),
  bubble: z.object({
    text: z.string(),                       // already sanitised & clamped in main
    tone: z.enum(['info', 'success', 'warning', 'error']),
    pinned: z.boolean(),
  }).nullable(),
  overlay: z.enum(['none', 'sleep-z']),     // the no-new-art sleep affordance (§5.5)
})
export type PetFrame = z.infer<typeof petFrameSchema>
```

And the one thing that flows back:

```ts
// pet-preload.cjs exposes exactly this — nothing more
window.keycodePet = {
  onFrame(cb: (f: PetFrame) => void): void,
  reportPointerOverPet(over: boolean): void,
  requestContextMenu(x: number, y: number): void,
  beginDrag(): void,          // no-op where native draggable regions are used
  openCalloutUrl(): void,     // main holds the URL; the renderer never sees it
}
```

The renderer's *entire* job: set `data-state` and `data-facing` on one div, set `textContent` on the bubble, run a mousemove hit-test against the alpha mask, and report the boolean. **No behavioural decision. No timers. No state machine. No network. No URL.**

Note the deliberate design in `openCalloutUrl`: main keeps the broadcast's `url` and validates it; the renderer asks to open "the current callout's link" without ever holding a string it could be tricked into changing. A renderer that cannot name a URL cannot be talked into opening a bad one.

*Gate for M3:* the renderer is under ~150 lines, contains no `setTimeout`, no `fetch`, and no `if` statement about pet behaviour. If behaviour is leaking into the renderer, stop and move it back.

### 4.3 Motion: pure functions, and a pet you can test without a screen

The liveliness logic — where the pet is going, when it jumps, when it dwells, when it turns around — is the most interesting code in the project and the code most likely to be quietly broken. So it is **pure**, and it is **tested headlessly**.

```ts
// src/motion/run-planner.ts        — decides intent
// src/motion/motion-engine.ts     — advances state
export interface MotionInput {
  now: number                       // injected. never Date.now() inside
  floor: { minX: number; maxX: number; y: number }   // from display work area
  settings: { movementEnabled: boolean }
  pending: Trigger[]                // reminders, broadcasts, drag-release, …
}
export interface MotionState {
  x: number; facing: 'left' | 'right'
  animation: AnimationState
  animationEndsAt: number | null
  plan: { kind: 'run'; targetX: number } | { kind: 'dwell'; untilMs: number } | { kind: 'act'; state: AnimationState }
  rngSeed: number                   // injected & threaded. never Math.random() inside
}
export function advance(state: MotionState, input: MotionInput): MotionState
```

Both `now` and randomness are **injected**. That is what makes the test possible:

```ts
it('lives for ten minutes without leaving the floor or sticking', () => {
  let s = initialState({ seed: 42 })
  for (let t = 0; t < 600_000; t += TICK_MS) s = advance(s, { now: t, floor, settings, pending: [] })
  // asserts: x always within [minX, maxX]; facing always matches direction of travel;
  // no state held longer than its declared duration × 2; every state visited is a real
  // state in spritesheet.json; at least N direction flips and N playful moves occurred.
})
```

Ten minutes of pet life in a few milliseconds, deterministic, on CI, with no display. **This is the M3 hard gate.** If `advance` needs an Electron import, a real clock, or `Math.random()`, it is wrong — fix it before continuing, because every later milestone adds triggers that feed it.

**The tick contract — two independent rates, deliberately:**

| Clock | Rate | Owner | Moves |
|---|---|---|---|
| Window motion | one tick per **~60ms** (≈16/s), integer-pixel steps | main | `setBounds` / `setPosition` |
| Sprite frames | each state's own `durationMs` from `spritesheet.json` | **CSS, in the renderer** | `background-position` |

They are not synchronized and must not be. Moving a window on every animation frame is expensive enough to stutter some compositors (§7); stepping the sprite in main would mean an IPC message per frame. Each clock lives where it is cheap. Coalesce position updates and never issue a `setBounds` that changes nothing.

**The floor, and the pet's actual feet.** The floor is the bottom of `screen.getDisplayNearestPoint(...).workArea` — above the Dock, above the taskbar. But the sprite's feet are *not* at the bottom of its 192×208 cell; there is transparent padding, and the amount is a property of the art. Derive `footInset` from the **generated alpha mask** (§5.4) as the distance from cell bottom to the lowest opaque pixel.

> **CORRECTED during the build.** This section originally gave `y = floor.y - windowHeight + bubbleAreaHeight + footInset`, which double-counts: the bubble area is at the *top* of the window, above the sprite, so adding it lifts the pet by the full bubble height. The correct term is the sprite's *bottom* offset inside the window:
>
> ```
> windowY = floor.y - (spriteOrigin.y + frameHeight - footInset)
> ```
>
> And a second correction found by assertion: the window must be sized to **end at the sprite's lowest opaque row**, not at the bottom of its cell. Sized to the full cell, its bottom `footInset` rows are transparent, so feet-on-floor requires the window to hang below the work area — which macOS clamps back inside the visible frame, silently lifting the pet by exactly `footInset`. See `floor-placement.ts`.

Hardcoding these numbers is how the pet ends up floating above the taskbar or with its shoes buried in it — and how it breaks the moment the art is swapped.

### 4.4 Callouts: one arbiter, two slots

Reminders, broadcasts, update notices and drag reactions will collide. Port openpets' arbitration rather than inventing worse:

- **`transient`** — priority queue (`low | normal | high | urgent`), 6s default, coalesces identical back-to-back text, max queue depth 16, drops oldest `low` first when full.
- **`pinned`** — one persistent slot, replaced only by equal-or-higher priority.

The arbiter is **pure**: `(queue, now) → { showing, nextQueue, wakeAt }`. Unit-test coalescing, priority ordering, expiry and queue overflow. It never touches a window; main renders its output into the `PetFrame`.

Bubble text is **plain text, clamped** — ≤200 characters, newlines stripped, set via `textContent`. `tone` selects an accent colour from a fixed map (`info #38bdf8`, `success #10b981`, `warning #f59e0b`, `error #ef4444`).

**Bundle an emoji font** (`NotoColorEmoji.ttf`, as openpets ships) and reference it in the bubble's font stack. Broadcast text will contain emoji, and a fresh Linux install cannot be assumed to have a colour emoji font — the alternative is tofu boxes in the one message everyone sees.

### 4.5 Broadcast: a static file that talks to every install ⭐

The whole capability is: **poll one JSON file over HTTPS.** No push, no sockets, no registration (locked decision #5). One fetch serves both broadcast notifications and the OTA version check.

**Manifest shape** (as specified in the issue; treat it as the contract and document it in `docs/BROADCAST.md`):

```json
{
  "version": 1,
  "notifications": [{
    "id": "keycode-2026-kickoff",
    "text": "Keycode is on fire 🔥 Submissions close Friday!",
    "tone": "info",
    "priority": "normal",
    "animation": "waving",
    "durationMs": 8000,
    "startsAt": "2026-08-01T09:00:00Z",
    "expiresAt": "2026-08-05T18:00:00Z",
    "url": "https://keycode.internal/announcements/kickoff"
  }],
  "release": { "latestVersion": "0.3.0", "notesUrl": "https://…", "mandatory": false }
}
```

**Treat every byte of it as hostile.** It is remote input rendered into a window that floats above everything else on someone's machine. The hardening is the feature, not paperwork:

| Rule | Value |
|---|---|
| Scheme | **HTTPS only.** Reject `http:`, `file:`, everything else, before the request |
| Timeout | 6s, hard |
| Body cap | 64 KB — abort the stream past it, do not buffer and then check |
| Schema | Zod, `.strict()`. Unknown fields rejected, not ignored |
| Count cap | ≤32 notifications; ignore the tail |
| `text` | ≤200 chars, plain text, newlines stripped, rendered with `textContent` |
| `durationMs` | clamped to `[2000, 30000]` |
| `animation` | must be a known state from `spritesheet.json`, else fall back to `waving` |
| `url` | HTTPS only, else dropped and the callout is non-clickable |
| `id` | ≤128 chars, `[A-Za-z0-9._-]+`. It is a persistence key |
| Time windows | honour `startsAt`/`expiresAt`; ignore anything expired or not yet live. Compare in UTC |
| Poll | every **5 min** default, **±20% jitter**, plus one fetch on launch. `KEYCODE_PET_MANIFEST_URL` and `KEYCODE_PET_POLL_MINUTES` override |
| Politeness | send `If-None-Match`; treat `304` as "no change" |
| In-flight | one request at a time; never stack polls |
| Failure | **silent.** Debug log only. Never a dialog, never a bubble, never a pet interruption |

**Dedupe by `id`, persisted**, in a `seenBroadcastIds` array capped at 500 entries FIFO. "Exactly once per install, ever" is the requirement and the cap is why it needs stating: an unbounded array in a settings file is a slow leak, and a too-small one re-shows an old announcement.

**Interim hosting, so M6 is not blocked on a decision.** Commit `manifest/manifest.json` to the repo and default `KEYCODE_PET_MANIFEST_URL` to its raw GitHub URL. That makes P4 fully demonstrable today — edit the file, push, watch the pet react — and swapping to S3/R2/an internal host later is one env var. Document both in `docs/BROADCAST.md`, including who needs write access.

### 4.6 Reminders, and the wall-clock rule

Water (45 min) and stretch (60 min), independently toggleable, intervals **not** user-configurable in the POC (keep the menu minimal, per the issue).

**`setInterval` is not a clock.** Suspend a laptop for two hours and it will either fire nothing or fire a burst on wake, depending on platform and phase of the moon. Both outcomes are the bug in P5.

So:

1. Persist `nextDueAt` as an **epoch-millisecond deadline** for each enabled reminder.
2. Tick every 15s and compare against `Date.now()`. That is the only thing the interval is for.
3. If a deadline is past by **more than 2× its interval**, it was slept through: reschedule from now and **do not fire**.
4. Hook `powerMonitor` `suspend` / `resume` / `lock-screen` / `unlock-screen` and re-evaluate deadlines on wake.
5. Toggling a reminder off clears its deadline; on sets it to `now + interval` — never fire immediately on enable.

This is the project's easy-to-get-wrong correctness rule. Unit-test it: it is pure given an injected clock, so simulate a 3-hour sleep and assert exactly zero reminders fire on wake and the next one is scheduled a full interval out.

### 4.7 Settings: one file, atomically written, never fatal

One JSON file in `app.getPath('userData')`:

```ts
{ schemaVersion: 1,
  movementEnabled: true, waterReminderEnabled: true, stretchReminderEnabled: true,
  position: { displayId: number, x: number, y: number } | null,
  reminders: { waterNextDueAt: number | null, stretchNextDueAt: number | null },
  seenBroadcastIds: string[],
  lastKnownRelease: string | null }
```

- **Atomic write:** write `settings.json.tmp`, `fsync`, `rename`. A crash mid-write must not produce a truncated file.
- **Zod-validated read.** On any failure — missing, truncated, wrong types, hand-edited garbage — rename it to `settings.corrupt.<timestamp>.json`, log, and continue from defaults. **A bad settings file must never prevent the pet from appearing.**
- Debounce writes (~500ms) so a drag does not produce 200 file writes.
- `schemaVersion` present from day one so a future migration is possible.

### 4.8 Right-click menu — the only settings surface

Native Electron `Menu`, exactly as the issue specifies:

```
 Keycode Pet
─────────────────────────────
 ✓ Movement
 ✓ Drink water reminder
 ✓ Stretch reminder
─────────────────────────────
   Reset position
   Check for updates…        (M8)
   About
─────────────────────────────
   Quit
```

Every toggle writes through to §4.7 and takes effect immediately — turning Movement off stops the run mid-stride and drops the pet into an in-place state; it does not wait for a tick boundary to notice.

**Wayland swallows right-click on the sprite** as system input (§7). The tray menu carries the identical items, built from **one shared menu-template function** — two menus assembled from one source, never two hand-maintained copies that drift.

---

## 5. The pet asset

### 5.1 Getting it into the repo

Copy `/Users/doyle/Documents/Projects/Keycode2026/pet/` → `pet/` at the repo root and **commit it** (4.3 MB, and the provenance is worth having in history).

Only three of the six files ship inside the app. Excluding the rest via `electron-builder`'s `files` filter keeps ~3 MB of reference art out of every installer:

| File | Repo | Ships |
|---|---|---|
| `spritesheet.png` — 1536×1872 RGBA, 8 cols × 9 rows of 192×208 | ✅ | ✅ (as WebP, §5.6) |
| `spritesheet.json` — animation map, free cells, reaction map | ✅ | ✅ |
| `pet.json` — `{ id: "pixel-coder", displayName: "Pixel Coder", … }` | ✅ | ✅ |
| `source-sheet.png` — 1182×1330, **no alpha**, pre-processing source | ✅ | ❌ |
| `preview.png` — 1024×1024 single pose | ✅ | ❌ |
| `validation.json` — per-cell non-transparent pixel counts | ✅ | ❌ (but see §5.4) |

**The art is a placeholder and that is accepted (locked decision #10).** It is a pixel-art chibi human — spiky brown hair, blue eyes, green hoodie, blue jeans, brown shoes — not the purple Keycode mascot. A Keycode-branded sheet in the same format replaces it later with **zero code change**, which is a property you have to actively preserve (§5.3). Brand palette for whoever authors it: purple `#A16AE8`, near-black `#141111`.

### 5.2 The sheet, as verified

Geometry is an **exact match for openpets' `defaultPetSprite`** — same 192×208 cells, same 8×9 grid, and the per-row frame counts line up with their default durations one-for-one. Their CSS renderer works against it unchanged.

| Row | State | Frames | Distinct | Duration | Note |
|---|---|---|---|---|---|
| 0 | `idle` | 6 | 6 | 5500ms, infinite | includes a blink |
| 1 | `running-right` | 8 | 8 | 1060ms | true run cycle, faces right |
| 2 | `running-left` | 8 | 8 | 1060ms | true run cycle, faces left |
| 3 | `waving` | 4 | 4 | 700ms ×2 | |
| 4 | `jumping` | 5 | 5 | 840ms ×2 | |
| 5 | `failed` | 8 | **6** | 1220ms ×2 | last 3 frames repeat — holds the slumped pose |
| 6 | `waiting` | 6 | 6 | 1010ms | ⚠️ **byte-identical to row 0** |
| 7 | `running` | 6 | 6 | 820ms | in-place busy loop, **not** locomotion |
| 8 | `review` | 6 | 6 | 1030ms | hand-to-chin thinking pose |

Three consequences that will bite if skipped:

1. **`running` is not running.** Row 7 is an in-place busy loop; rows 1 and 2 are locomotion. Naming collision inherited from the source asset. Do not wire row 7 to movement.
2. **Direction is a row, not a transform.** The art faces both ways already — **no CSS mirroring**, no `scaleX(-1)`. Set the state, get the facing.
3. **`failed` declares 8 frames and needs `steps(8)`** even though only 6 are distinct. The repeat *is* the hold on the final pose. "Optimising" it to `steps(6)` changes the timing and loses the beat. Leave it.

### 5.3 Generated geometry — the single-source-of-truth rule

`pet/spritesheet.json` is the **only** place animation geometry exists. A build script consumes it and emits two generated artifacts:

```
pet/spritesheet.json
   └─ scripts/generate-sprite-css.mjs
        ├─► src/renderer/pet.generated.css   @keyframes + [data-state] rules per state
        └─► src/pet-animations.generated.ts  export type AnimationState = 'idle' | … 
                                             export const ANIMATIONS = { … } as const
```

For each state: vertical offset `row × frameHeight`, horizontal travel `frames × frameWidth`, `steps(frames)`, duration and iteration count straight from the JSON.

```css
/* generated — do not edit */
.pet { width: 192px; height: 208px;
       background-image: url("pet/spritesheet.webp"); background-repeat: no-repeat;
       image-rendering: pixelated; }                     /* REQUIRED — see below */
@keyframes kp-running-right { from { background-position: 0 -208px; }
                              to   { background-position: -1536px -208px; } }
.pet[data-state="running-right"] { animation: kp-running-right 1060ms steps(8) infinite; }
```

`image-rendering: pixelated` is **required**, not stylistic. Default smoothing turns pixel art to mush, and it is worst on exactly the HiDPI displays everyone develops on.

Rules that make this pay off:

- Generated files carry a `/* GENERATED — edit pet/spritesheet.json */` header and are **committed** (so a fresh clone runs without a generate step) *and* regenerated in `prebuild`, with CI failing if the committed output differs from freshly generated output. Stale generated CSS is the one failure mode of this approach; close it.
- `AnimationState` being generated means a typo in a state name is a **type error**, and the broadcast validator's "is this a known animation" check is derived from the same union rather than a second hand-written list.
- **Swapping the art** = replace `spritesheet.png`, edit `pet.json`, adjust `spritesheet.json` if the grid changed, rerun the generator. Zero hand-edited code. Prove it in `docs/ASSETS.md` and, ideally, by running the generator against a 12-row variant.

### 5.4 The alpha mask — generated, and load-bearing

P2 and the `footInset` in §4.3 both need to know which pixels are actually the pet.

`scripts/generate-alpha-mask.mjs` reads `spritesheet.png` and emits `assets/pet/alpha-mask.json`:

- A **union mask across every frame of every state** — one 192×208 coverage map, at **4px granularity** (48×52 cells, tiny to ship, trivial to test against).
- **Union, not per-frame**, deliberately: a per-frame mask makes the grabbable area pulse as the sprite animates, so the pet becomes intermittently un-grabbable in a way that feels broken and reads as a bug. Slight over-grab is invisible; flicker is not. Per-state refinement is a possible upgrade — record it in `DECISIONS.md`, do not build it.
- Also emit `footInset` (cell bottom → lowest opaque pixel) and the mask's bounding box.
- A test asserts every cell `validation.json` reports as `used` has coverage in the mask.

> **CORRECTED during the build.** The "~20% fill figure (≈8,000 of 39,936 px)" is a **per-frame** property; the *union* mask such a test would actually run against is much denser. Measured on this art: per-frame mean **8,349 px (20.9%)**, union **14,111 px (35.3%)**, and the 4px cell grid **942/2,496 (37.7%)** set. Assert the two separately or the test is simply wrong.

The renderer hit-tests `mousemove` against this mask (plus the visible bubble rect when one is showing) and reports `pointerOverPet`. Main calls `setIgnoreMouseEvents` accordingly.

### 5.5 The three missing states

The behaviour spec needs `drink`, `stretch` and `sleep`; the sheet has none of them.

**`drink` → reclaim row 6.** Row 6 is byte-identical to row 0 — a copy, not an animation. When you claim it: **delete the `waiting` entry from `spritesheet.json` in the same commit.** Leaving both means the generator emits two states pointing at one row, and `waiting` silently plays a drinking animation. Until the art exists, point `drink` at row 6 (visually idle) so the trigger path, arbiter and callout are all shippable and testable now.

**`sleep` → ships with no new art.** An entry in `spritesheet.json` pointing at row 0 with a very long duration, plus the `overlay: 'sleep-z'` field in `PetFrame` driving a pure-CSS "Z" bubble. This costs one JSON entry and a few lines of CSS, and it is the cheapest possible demonstration that §5.3's generator earns its keep.

**`stretch` → needs the sheet extended** to 12 rows (1536×2496). Blocked on art. Until then map the `stretch-reminder` trigger to `jumping` so the reminder path is complete and demonstrable, and flag it in `DECISIONS.md` and in the M4 gate. When the art lands: add 6 frames at row 9, edit the JSON, rerun the generator. No code change — and that is the point.

Spare fully-transparent cells also exist in rows 0, 3, 4, 6, 7 and 8 for extra frames without resizing.

The `reactionMap` in `spritesheet.json` is already authored — `broadcast-notification → waving`, `water-reminder → drink`, `movement-disabled → sleep`, and so on. **Load it; do not re-declare it in TypeScript.** New triggers are a mapping entry, never renderer work.

### 5.6 WebP

Convert the sheet to **WebP with alpha preserved** at build time (1.18 MB PNG → typically a few hundred KB). One-off `sharp`-based script or a committed converted artifact; either way `sharp` does not become a runtime dependency. Verify alpha survived by re-running the alpha-mask generator against the WebP and asserting an identical mask — a silent alpha flatten would give the pet an opaque box, which is P1's headline failure.

---

## 6. Milestones

Each milestone ends with a commit, a `v0.N.0` tag, and **evidence in `docs/demo/`** — a screenshot for anything visual, a test name for anything logical. Two gates are hard.

**M0 — The verification loop, before the pet.**
This inverts the obvious order on purpose. Every later milestone's evidence is a screenshot; build the thing that takes screenshots first, and each milestone proves itself for free instead of by hand.

- [ ] pnpm workspace, TS strict, Vite + `tsc` builds, Vitest running, `dev` and `build` green
- [ ] `scripts/smoke.mjs`: launch app → wait for window → `/usr/sbin/screencapture` → write `docs/demo/<name>.png` → quit. Non-zero exit if the app dies or no window appears
- [ ] A **dark backdrop window** the harness can put behind the pet, so transparency bugs are visible. A white desktop hides the exact bug we care about most
- [ ] `docs/VERIFICATION.md`: how to run it, and the one-time macOS **Screen Recording** permission grant the terminal needs
*Gate:* `pnpm smoke` produces a PNG of a dark backdrop, unattended.

**M1 — Skeleton.**
- [ ] Tray-first boot: tray icon, `app.dock.hide()` on macOS, `skipTaskbar`, no dock/taskbar entry
- [ ] `requestSingleInstanceLock` — second launch focuses the first
- [ ] Security defaults all on (§3); `setWindowOpenHandler` deny; `will-navigate` prevent; strict CSP
- [ ] `settings-store.ts` with atomic write, Zod read, corrupt-file recovery (§4.7) — and its unit tests
- [ ] Clean quit from the tray: no orphaned window, no orphaned process
- [ ] `THIRD-PARTY-NOTICES.md` if any openpets code has been adapted by now

**M2 — The floating window. HARD GATE.**
- [ ] Frameless, `transparent`, `#00000000`, `hasShadow: false`, correct always-on-top level per platform
- [ ] Visible over a focused app, over a fullscreen app, and across Space/workspace switches
- [ ] `setIgnoreMouseEvents(true, { forward: true })` by default; hit-testing armed only over the pet
- [ ] **Cursor-probe watchdog** in main using `screen.getCursorScreenPoint()`, re-arming forwarding when it dies (§7)
- [ ] `setIgnoreMouseEvents(false)` before every `loadFile`/reload
- [ ] Drag works; Wayland path via native draggable regions
- [ ] Multi-monitor: work-area clamping on `display-*` events; position persisted per display
*Gate:* a committed screenshot of the pet's window **over a dark app**, showing no box, no shadow, no halo. Then, by hand: click beside the sprite and hit the app underneath; click the sprite and hit the pet; switch Spaces and confirm it is still grabbable. **Do not proceed until all of this is true** — every later milestone is invisible or ungrabbable if this is wrong, and retrofitting passthrough after the motion engine exists means re-verifying everything.

**M3 — Rendering and motion. HARD GATE.**
- [ ] `scripts/generate-sprite-css.mjs` → `pet.generated.css` + `pet-animations.generated.ts`; `prebuild` wired; CI checks committed output is fresh (§5.3)
- [ ] WebP conversion with alpha verified by identical regenerated mask (§5.6)
- [ ] `scripts/generate-alpha-mask.mjs` → mask + `footInset`, with its coverage test (§5.4)
- [ ] All 8 real states play at correct frame counts and durations; `image-rendering: pixelated` confirmed crisp on HiDPI by screenshot
- [ ] `PetFrame` seam per §4.2; renderer under ~150 lines with no timers, no fetch, no behavioural branching
- [ ] Pure `advance()` motion engine + run planner, injected clock and seed (§4.3)
- [ ] Horizontal run along the work-area floor, edge flips via `running-left`/`running-right`, randomised destinations and dwells, playful moves (jump, skid-stop, turn-around)
- [ ] Window motion on its own ~60ms integer-step tick, decoupled from sprite frames
- [ ] Alpha-mask hit-testing live; `footInset`-derived floor placement
*Gate:* (a) the ten-minute headless simulation test passes and is deterministic; (b) a screenshot shows the pet crisp over a dark window; (c) the renderer contains no behaviour. If `advance()` needs Electron or a real clock, it is wrong — fix it here, not later.

**M4 — Menu and settings.**
- [ ] Native right-click menu, exactly the items in §4.8; tray menu from the **same** template function
- [ ] Movement toggle — off stops the run immediately and switches to in-place states; drag still works
- [ ] Water and Stretch toggles
- [ ] Reset position; About
- [ ] Every toggle persists across restart (verify by relaunch, not by reading code)

**M5 — Reminders and callouts.**
- [ ] Wall-clock deadline reminders per §4.6 — persisted `nextDueAt`, 15s tick, 2× miss rule, `powerMonitor` hooks
- [ ] Unit test: simulate a 3-hour sleep → **zero** reminders fire on wake, next one a full interval out
- [ ] Pure callout arbiter — transient priority queue + pinned slot, coalescing, depth 16 (§4.4)
- [ ] Pet-anchored bubble with tone accents; bundled emoji font
- [ ] Corner-toast window for `urgent` or pet-hidden
- [ ] Reminders play their animation (`drink` = row 6; `stretch` mapped to `jumping` until art lands — flag it)
*Gate:* screenshot of a bubble with emoji rendering correctly, and the sleep test green.

**M6 — Broadcast. ⭐**
The headline capability, and the reason this is its own milestone rather than half of the issue's M5.
- [ ] `broadcast-poller.ts`: HTTPS-only, 6s timeout, 64 KB cap, `.strict()` Zod, every clamp in §4.5
- [ ] 5-min poll with ±20% jitter, launch fetch, `If-None-Match`, single in-flight
- [ ] Dedupe by `id` against persisted `seenBroadcastIds` (cap 500 FIFO)
- [ ] `startsAt`/`expiresAt` honoured in UTC
- [ ] Fails silently: 500, timeout, truncated body, malformed JSON, no network → nothing user-visible, pet uninterrupted
- [ ] XSS test: `<img src=x onerror=alert(1)>` in `text` renders as literal characters
- [ ] `manifest/manifest.json` committed; default URL points at it; `KEYCODE_PET_MANIFEST_URL` overrides
- [ ] `docs/BROADCAST.md`: the schema, every clamp, how to push a message, who needs write access
*Gate:* edit the hosted manifest, and within one poll interval a running client shows the callout **once**, with the pet animating. Restart the client: it does **not** show again.

**M7 — Package for three OSes.**
- [ ] macOS `dmg` + `zip`, **ad-hoc signed (`identity: "-"`)** — without it, Apple Silicon shows the misleading "damaged and can't be opened" dialog and the POC looks broken before it launches
- [ ] Windows `nsis`, `perMachine: false`
- [ ] Linux `AppImage` + `deb` + `rpm` + `tar.gz`
- [ ] `files` filter excludes `source-sheet.png`, `preview.png`, `validation.json`, `reference/` — **and `pet/spritesheet.png`**, which this list originally omitted: the renderer bundle already contains the sheet, so shipping the original too pays for it twice. Also **not** the emoji font from `assets/`, for the same reason.
- [ ] `asar` — **turned OFF during the build.** Electron 42 silently fails to load an ESM entry point from inside an asar archive: the process starts and never runs its main script, with no error anywhere. See `electron-builder.config.cjs`
- [ ] Artifact sizes recorded in `docs/demo/`
*Gate:* installed from the artifact — not `pnpm dev` — on macOS, and the pet appears and runs. **Windows and Linux cannot be verified from the Mac (§8); a CI matrix producing artifacts plus a manual spot-check on each is what closes this milestone.** Do not mark M7 done on macOS evidence alone; say plainly what was and was not verified.

**M8 — OTA updates. Last, and optional.**
- [ ] Consume the `release` block already returned by the M6 poll — no second endpoint
- [ ] "Update available" callout; `Check for updates…` menu item wired
- [ ] **Recommendation: `shell.openExternal` to the release page.** `electron-updater` on an unsigned internal app buys complications it does not repay here. Record the choice in `DECISIONS.md`

---

## 7. Platform gotchas — port the fixes, do not rediscover them

Every one of these is a documented, already-solved failure mode in openpets. Each cost someone a debugging session; read `docs/wayland.md` and `mouse-forwarding.ts` before you spend it again.

- **Mouse-event forwarding is not portable.** `setIgnoreMouseEvents(true, { forward: true })` delivers hover on **macOS and Windows but not Linux.** Linux pet windows must be kept interactive instead. This is a platform predicate, not a bug to fix.
- **Forwarding dies silently.** macOS: Space switches, display sleep, fullscreen transitions. Windows: rapid reloads, fullscreen sweeps. Symptom: the pet is stuck click-through and cannot be grabbed at all. Fix: a main-process **cursor-probe watchdog** using `screen.getCursorScreenPoint()`, which keeps working when forwarding is dead, and re-arms it.
- **`setAlwaysOnTop(true)` can no-op** when the window already believes it is on top. Fix: toggle `false`, then set `true`.
- **Reset passthrough before navigation.** Call `setIgnoreMouseEvents(false)` before `loadFile` on reload, or the pet comes back click-through.
- **Wayland (KDE Plasma) cannot be dragged the normal way.** The renderer `screenX/screenY` → `setBounds()` loop is unreliable under compositor-managed positioning. Fix: Chromium **native draggable regions**, so KWin performs `xdg_toplevel.move`. Accepted trade-offs: no drag-time sprite animation, and **right-click on the sprite is swallowed as system input** → the tray menu is the settings surface there (§4.8).
- **Bundle a colour emoji font.** A fresh Linux install may have none, and the broadcast text is the one place emoji are guaranteed.
- **Moving a window every frame is expensive** on some compositors. Throttle to the ~60ms integer-step tick in §4.3 and never issue a no-op `setBounds`.
- **DPI and mixed scaling.** Windows multi-monitor with different scale factors will move the pet unexpectedly on transitions. Recompute from `screen` on `display-metrics-changed` rather than trusting cached bounds.

---

## 8. Verification loop

The primary dev machine is a **Mac**, and this feature is *visual*. So looking at pixels is the test.

- **`/usr/sbin/screencapture`** — macOS native, verified present. Full screen or a window, then open the PNG and look at it. Requires a one-time **Screen Recording** permission grant for the terminal or agent host; do it before M0.
- **Always screenshot the pet over a dark, non-white app window.** An opaque black or white box behind the sprite — P1's headline bug — is invisible against a white desktop. M0's backdrop window exists for this.
- **`orca` CLI** (`~/.local/bin/orca`, verified installed) — worktree and terminal orchestration during dev.
- **`computer-use` skill** — reads accessibility trees and drives real desktop windows. Better than eyeballing for asserting the pet window's on-screen bounds and always-on-top ordering.
- **Automate it:** `pnpm smoke` → launch, wait, screenshot, assert sprite pixels appear near expected coordinates, quit. Non-zero exit on failure.

**Honest constraint, and do not paper over it in the final report:** Windows and Linux behaviour **cannot** be verified from the Mac, and the nastiest bugs in §7 are Windows- and Wayland-specific. Budget VMs, or a CI matrix producing artifacts plus manual spot-checks, before calling M7 done. If a platform was not tested, the report says which one and why — a green checklist that quietly means "macOS only" is worse than an honest gap.

---

## 9. Acceptance criteria

Verify each against a **running, installed** app, not against the source.

**The illusion**
- [ ] Launching shows a pixel character floating over other apps with a fully transparent background — no chrome, no box, no shadow. Proven by a screenshot over a dark window
- [ ] Stays visible when another app is focused or fullscreened, and across Space/workspace switches
- [ ] Pixel art is crisp, not smoothed, including on HiDPI
- [ ] Movement on: runs left↔right along the floor using the `running-left`/`running-right` rows, with occasional playful moves
- [ ] Movement off: stays put, still animates in place
- [ ] Dragging works in both modes, on all three OSes, and the position restores after restart
- [ ] No visible jitter or stutter while running

**Interaction**
- [ ] Clicks on transparent area reach the app underneath; clicks on the sprite reach the pet
- [ ] Hit-testing uses the generated alpha mask, not window bounds
- [ ] The pet remains grabbable after Space switch, display sleep/wake, window reload and a fullscreen sweep
- [ ] Right-click opens the menu (tray on Wayland); all three toggles work and persist
- [ ] `Reset position` returns the pet to a sane spot on the current display

**Broadcast and reminders**
- [ ] A message added to the central manifest appears as a callout on a running client within one poll interval, **exactly once per install**, animating the pet
- [ ] Expired and not-yet-live entries never show
- [ ] HTML/script in `text` renders as literal characters
- [ ] Offline, 500, timeout, truncated body and malformed JSON each surface **nothing** and interrupt nothing
- [ ] Water and stretch reminders fire, animate, show a callout, and stop when toggled off
- [ ] A 3-hour machine sleep produces zero reminders on wake and a freshly scheduled next one

**Robustness**
- [ ] Second launch focuses the first instance
- [ ] Corrupt settings file → backed up, defaults used, pet still appears
- [ ] Monitor unplugged while the pet is on it → clamped into a visible work area
- [ ] Quits cleanly from the tray with no orphaned windows or processes

**Code**
- [ ] `tsc --noEmit` clean under `strict`; no `any` on a module boundary
- [ ] Every anti-proof grep in §2 returns 0
- [ ] `advance()`, the run planner, the callout arbiter and the reminder scheduler are pure, with injected clock and seed, and unit-tested
- [ ] The ten-minute headless motion simulation passes deterministically
- [ ] Committed generated CSS/TS matches freshly generated output (CI-enforced)
- [ ] Zero runtime dependencies beyond `zod`
- [ ] `THIRD-PARTY-NOTICES.md` present with openpets' MIT text and a derived-file list

**Packaging**
- [ ] Installable artifacts for macOS, Windows and Linux from one codebase and one command
- [ ] macOS artifact opens on Apple Silicon without the "damaged" dialog
- [ ] Reference art excluded from installers

**Documentation**
- [ ] `README.md`: clone → pet on screen in under ten minutes, per platform
- [ ] `ARCHITECTURE.md`: the `PetFrame` seam, the two-clock tick contract, why one window holds pet+bubble, and what a second app instance would break
- [ ] `docs/BROADCAST.md`: manifest schema, every clamp, how to push a message, who has write access
- [ ] `docs/ASSETS.md`: how to swap the spritesheet with zero code change, including the row-6 reclaim and the 12-row extension
- [ ] `docs/VERIFICATION.md`: the screenshot loop, permissions, and what is untested per platform
- [ ] `DECISIONS.md`: every deviation from this brief and from the issue, one line each
- [ ] `docs/demo/`: screenshots per milestone

---

## 10. Out of scope

Do not build these. If one seems essential, argue it in `DECISIONS.md` first.

A plugin system or SDK. A pet catalog, marketplace, or downloadable pets. Multiple pets, pet selection, or customization. A settings window or control centre. Free 2D roaming, gravity, or physics — horizontal only (locked decision #6). Window occlusion / foreground-app awareness. Agent or CLI integrations. LAN mode, multiplayer, sockets, push. A backend of any kind. Code signing, notarization, store attestation. Accounts, login, telemetry, analytics. User-configurable reminder intervals. Sound or voice. i18n. Auto-launch at login. Clicking or petting interactions beyond drag. `electron-updater` auto-download (M8 recommends `openExternal`). Authoring Keycode-branded sprite art — the format is fixed and the swap is a file swap.

---

## 11. Decisions locked, and questions to decide as you go

The issue's ten locked decisions stand. Restated, because a build that quietly violates one of them is the most likely way this goes wrong:

1. Fresh repo; openpets is reference only. 2. Single pet, no customization. 3. Right-click menu is the only settings surface. 4. Internal-only — no signing/notarization/attestation. 5. Broadcast by polling a static JSON manifest, not push. 6. Horizontal running, not 2D roaming. 7. Dragging works regardless of the movement setting. 8. OTA is last and reuses the M6 poll. 9. CSS sprite-sheet stepping — this supersedes the earlier rigged-SVG plan. 10. `pixel-coder` is the placeholder; a Keycode sheet swaps in with no code change.

The issue's open questions, with a default for each so **none of them blocks you.** Take the default, note it in `DECISIONS.md`, and raise it rather than waiting:

| Question | Default — proceed with this |
|---|---|
| Keycode-branded sheet | Ship on `pixel-coder`. §5.3 and §5.4 make the swap a file swap; prove that, then hand it off |
| `drink` / `stretch` art | `drink` → row 6 (visually idle for now). `stretch` → mapped to `jumping`. `sleep` → re-timed idle + CSS Z, no art. All three trigger paths ship complete |
| Manifest hosting URL & write access | `manifest/manifest.json` in-repo, raw GitHub URL as the default; `KEYCODE_PET_MANIFEST_URL` overrides. **This unblocks P4 today** |
| Poll interval | 5 min, ±20% jitter, `KEYCODE_PET_POLL_MINUTES` override |
| Repo location | This repo (`keycode-pet`). Note the unrelated existing `KeyValueSoftwareSystems/keycode` (2022 countdown timer) |
| Reminder intervals | Water 45 min, stretch 60 min. Constants in one config module, not sprinkled |
| Distribution | GitHub Releases on the private repo. Nothing in the app depends on this choice except M8's `notesUrl` |

---

## 12. Working agreement

**Screenshot before you claim.** The whole product is an appearance. "The code looks right" is not evidence, and on a transparent always-on-top window it is barely a hint. Screenshot it, over something dark, and look at the PNG.

**Read openpets' source, not just its docs, on anything platform-specific.** `mouse-forwarding.ts` and `wayland-backend.ts` encode real compositor behaviour that no amount of reasoning from the Electron docs will reproduce. This brief was written from their documentation; their code is the authority.

**Keep behaviour out of the renderer, always.** It will try to creep in — a `setTimeout` here to smooth something, a small `if` there about when to bubble. Every one of those is behaviour that can no longer be unit-tested and now lives in two processes. Push it back to main.

**Keep the pure core pure.** `advance()`, the run planner, the arbiter and the reminder scheduler take a clock and a seed as arguments. The moment one of them reaches for `Date.now()` or `Math.random()`, the deterministic ten-minute simulation stops being possible and the liveliness logic becomes untestable — which is exactly the code you most need tests for, because its bugs are subtle and only visible after minutes of watching.

**Generate, never duplicate.** Frame counts, durations, row indices and state names exist once, in `pet/spritesheet.json`. If you find yourself typing `steps(` or a pixel offset by hand, the generator is missing a case — extend it instead.

**Tune by watching, not by reasoning.** The gap between "the pet moves" and "the pet feels alive" is entirely in the numbers — dwell durations, run speed, how often it jumps, whether it pauses before turning. You cannot derive those. Run it, watch it for two minutes, adjust one number, watch again.

**Commit before anything risky** — an Electron bump, a window-flag change, a refactor of the `PetFrame` seam — so there is a known-good point to return to.

**Record every deviation in `DECISIONS.md`, one line.** This brief was written against a fetched issue and a read-not-run reference repo. It is wrong somewhere. The log of where is part of the deliverable.

---

## 13. Version control

The repository starts empty — zero commits. Commit discipline is part of the deliverable, for a reason specific to how this gets built: **a long build session's context will be compacted, and commits are the only durable record that survives it.** After a summarisation, `git log -p` is the one place you can see what you actually built rather than what a summary claims.

**Write `.gitignore` first:**

```
node_modules/    dist/    out/    release/    coverage/
reference/       *.log    .DS_Store
.env  .env.local  .env.*.local
```

`reference/` is ignored so openpets can be cloned there for reading without entering our history. Generated sprite CSS/TS and the alpha mask are **committed** (§5.3) — they are build inputs for a fresh clone, not build outputs to ignore.

**Cadence.** Commit at every green checkpoint — `tsc --noEmit` clean and existing tests passing. Typically three to eight commits per milestone. Never commit red; if work must be checkpointed incomplete, skip the failing test and put `wip:` in the summary, then fix it next commit.

**Tags.** Milestone N is `v0.N.0` (`v0.0.0` for M0 through `v0.8.0` for M8); `v1.0.0` when all six proofs hold. Patch bumps fix an already-tagged milestone.

```bash
git tag -a v0.3.0 -m "M3: sprite rendering, PetFrame seam, pure motion engine — P3 passes"
git tag --sort=v:refname          # correct order — plain sort mis-sorts v0.10.0
git push --follow-tags            # after each milestone tag, if a remote exists
```

**Message format.** Follow the `git-commit-push` skill — Conventional Commits, a `Changes:` list, a test-coverage line, an attribution trailer naming the assistant and model actually used. Scopes for this project: `window`, `sprite`, `motion`, `menu`, `settings`, `reminders`, `callouts`, `broadcast`, `updates`, `package`, `assets`, `harness`, `docs`, `infra`.

Commits that make a proof pass say so — `feat(broadcast): poll manifest, dedupe by id (P4)` — so the six proofs are traceable through history and not only through test names.

**Branching.** Work directly on `main` and tag milestones. Single engineer, no review gate; branch-per-milestone buys nothing here.

---

Ship something a colleague installs, forgets about, and then grins at three hours later when it runs across their screen.
