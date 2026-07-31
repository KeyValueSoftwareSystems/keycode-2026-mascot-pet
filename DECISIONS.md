# Decisions

Every deviation from `docs/PROMPT.md`, from the GitHub issue, or from openpets — one line each, with
the reason. The brief asks for this log because a brief written against fetched docs and a
read-not-run reference repo is wrong somewhere, and the record of where is part of the deliverable.

Grouped by whether the brief was **wrong**, **silent**, or simply **improved on**.

---

## The brief was wrong

| # | Decision | Why |
|---|---|---|
| 1 | **`steps(n, jump-none)` with `to` one frame short**, not `steps(n)` with `to: -n×frameWidth` | Measured: with the naive form, a finite animation's after-phase value is column *n* — which `freeCells` confirms is transparent for `waving` and `jumping`. Patching the generated CSS to that form produced a capture with **0 opaque pixels**: the pet vanishes. The shipped form holds the final frame at 47.1% fill. |
| 2 | **Floor formula corrected** to `windowY = floorY - (spriteOrigin.y + frameHeight - footInset)` | §4.3's version added the bubble height, double-counting: the bubble sits *above* the sprite, so adding it lifted the pet by the full 112px bubble area. |
| 3 | **Window height ends at the sprite's lowest opaque row**, not the cell bottom | Sized to the full 208px cell, the bottom 16 rows are transparent, so feet-on-floor needs the window to hang below the work area — which macOS clamps, silently lifting the pet by exactly `footInset`. Caught by assertion A4. |
| 4 | **Reminder miss comparison is `>=`, not `>`** | The brief says "past by more than 2× its interval". A three-hour sleep leaves the 60-minute reminder overdue by *exactly* 2×, so `>` fires it — precisely the wake-up backlog the rule exists to prevent. |
| 5 | **Per-frame and union mask fill are different numbers** | §5.4's "~20% fill still holds" is per-frame (measured 20.9%); the union the mask covers is 35.3%, and the 4px cell grid 37.7%. A test asserting the wrong one is simply wrong. |
| 6 | **Anti-proof greps fixed** | Unanchored `lease` matches "please", `lan-` matches "plan-", and the CSS grep matched the *generated* stylesheet beside the hand-written one. Now word-anchored, `--exclude`d, and enforced as tests rather than commands to remember. |
| 7 | **M7's exclusion list omitted `pet/spritesheet.png`** and the emoji font | The renderer bundle already contains both; shipping the originals paid for them twice. The font duplicate alone was 9.75MB of a 13MB archive. |
| 8 | **openpets' overflow eviction is a bug** — evict the `(rank, seq)` minimum, not `queue.shift()` | Their queue is sorted rank-descending, so `shift()` drops the *highest*-priority pending entry: the opposite of the brief's "drops oldest `low` first" and of any caller's expectation. |
| 9 | **openpets' coalescing key is arbitrary** — compare against the newest entry by `seq`, not the queue tail | In a rank-sorted queue the tail is whatever sorts last. "Back-to-back" means most recently enqueued. |
| 10 | **Linux is XWayland, not native Wayland** | openpets forces `--ozone-platform=x11` unconditionally, because native Wayland forbids a client positioning its own toplevel — which breaks motion, drag and z-order together. The brief treated native draggable regions as the primary Linux path; they are an opt-in fallback behind `KEYCODE_PET_OZONE=native`. |
| 11 | **Windows needs `disable-features=CalculateNativeWinOcclusion`** | Absent from the brief entirely. Without it Chromium's occlusion tracker stops painting every window on a display while a fullscreen app is active — a transparent pet goes blank with its z-order intact. Directly fatal to P1. |
| 12 | **Always-on-top needs a 1s re-assert on Windows**, not just the cache-bust toggle | The shell's demotion sweep re-strips `HWND_TOPMOST` every ~2–4s during fullscreen, so a slower cadence loses the race. |
| 13 | **Emoji font is 4.8MB, not ~1.6MB** | The COLRv1 build is still about half the CBDT build openpets ships, but the plan's estimate was 3× optimistic. The CSP also needs `font-src`, which the brief does not mention. |

## The brief was silent

| # | Decision | Why |
|---|---|---|
| 14 | **Redirects followed manually, max 3 hops, scheme re-validated at each** | With `redirect: 'follow'` the HTTPS-only rule constrains only the initial URL, so `302 https → http` is taken silently and the rule is void. openpets uses `node:https`, which does not follow redirects at all, so the case is simply absent there. |
| 15 | **Strict envelope, per-entry parsing** for the manifest | The brief says `.strict()` but never says whether one malformed entry kills the batch. With a naive strict array it does — one typo'd field silences every announcement for every install. |
| 16 | **Change detection is a body hash, not `304`** | With `cache: 'no-store'` and a hand-set `If-None-Match` there is no cache entry to revalidate; how a given stack surfaces a bare 304 is not worth depending on. The ETag stays as bandwidth politeness. |
| 17 | **Manifest timestamps require an explicit UTC offset** | `2026-08-01T09:00:00` means different instants in different timezones, and a broadcast window that shifts by the reader's location is not a schedule. |
| 18 | **Bidi overrides and isolates stripped from bubble text** | `textContent` closes script injection but not spoofing: those characters are inert and reorder everything after them, so the *visible* text can differ from the manifest. U+200D and U+FE0F are deliberately kept — stripping them breaks emoji. |
| 19 | **Backwards-clock rule for reminders** | A deadline further out than one interval means the clock jumped back (NTP step, timezone edit). Without this the reminder parks for however far it moved. |
| 20 | **`changed` gates the reminder settings write** | The tick runs 5,760×/day; an unconditional dirty flag turns the 500ms debounce into a disk write every 15 seconds, forever. |
| 21 | **`seenBroadcastIds` written with a forced flush** | "Shown exactly once, ever" is a durability claim; the debounce leaves a window where a crash re-shows the message. |
| 22 | **A file logger** | A packaged macOS app has no usable stdio. The first packaging failure was completely opaque until this existed. About shows the log path so a bug report can include it. |
| 23 | **A crispness assertion (A6)** | "Pixel art renders crisp" is acceptance criterion 5 and otherwise only checkable by eye. At 2× every source pixel must be a uniform block: 100% with `pixelated`, 12.5% without — verified by deliberately breaking it. |

## Improvements and choices

| # | Decision | Why |
|---|---|---|
| 24 | **`asar: false`** | Electron 42 silently fails to load an ESM entry point from inside an asar: the process starts and never runs its main script, with no error anywhere. asar was never a security boundary, so the cost is tidiness and the gain is an app that runs. |
| 25 | **Per-state `@keyframes` duplicated per nonce**, rejecting openpets' single-keyframes-plus-custom-properties design | A CSS animation restarts only when `animation-name` changes. With one shared animation, local time grows for the whole session, so a finite state selected later is already finished and paints one static frame. The nonce is what makes re-triggering the *same* state replay, and keeping it in main keeps restart policy where behaviour belongs. |
| 26 | **Animation completion is state, not a `setTimeout`** | openpets uses `setTimeout(durationMs × iterations)`, which drifts, leaks on state change, and cannot be exercised headlessly. `animationEndsAt` is observed by the existing tick. |
| 27 | **Direction pushed from main**, never diffed from window `move` events | openpets diffs `getPosition()` with a 180ms debounce, which fails silently to a permanently idle sprite if a compositor swallows position writes. |
| 28 | **Alpha-mask hit-testing** — original work, not a port | openpets uses a padded DOM rect. The character fills ~21% of its cell and the margin is mostly horizontal, so a bounds test eats clicks across a wide invisible band. The mask is a union across all frames, never per-frame: per-frame would make the grabbable area pulse with the animation. |
| 29 | **`window.setShape()` for Linux click-through** | Electron cannot forward hover on Linux, so a click-through window there is permanently ungrabbable. Best effort: X11-only, re-applied after navigation, degrading to a fully interactive window. |
| 30 | **Sprite generators landed in M2, not M3** | So the transparency gate could screenshot the real sprite rather than a placeholder — and `setShape` and hit-testing need the mask regardless. M3 became purely the seam-driven motion engine. |
| 31 | **`x` is a float in `MotionState`** | Sub-pixel accumulation becomes inherent and rounding happens once at the `setPosition` boundary, replacing openpets' explicit `fracX`/`fracY` bookkeeping with less code. |
| 32 | **Jump probability is per second, not per tick** | Otherwise changing `tickMs` silently changes the pet's personality. |
| 33 | **Drag follows `getCursorScreenPoint()`**, not renderer coordinates | Renderer `screenX/screenY` dies exactly when mouse forwarding dies, and forwarding dying mid-drag is a documented failure mode on macOS and Windows. |
| 34 | **A real `toast.html` with its own preload**, not openpets' `data:text/html` URL | A data: URL has an opaque origin and cannot load the bundled font, and a template-string page puts HTML-string interpolation of untrusted text in the codebase. There is now no interpolation anywhere. |
| 35 | **Toast layout recomputed from the current list** | openpets' slot counter is never compacted, so destroying a middle toast leaves a visible hole. |
| 36 | **The arbiter is pure; the host owns the only timer** | openpets' arbiter owns `setTimeout` handles, which makes it impossible to reason about at an instant or test as a unit. |
| 37 | **`aliases` block in `spritesheet.json`** for undrawn states | The reaction map keeps naming the state it *wants* (`stretch`), so when the art lands the only change is deleting one alias entry. The generator validates that every alias target exists, which is what caught `stretch-reminder` pointing at nothing. |
| 38 | **Electron pinned `^42`** though 43.2.0 is current | Every platform workaround ported from openpets was validated against 42. |
| 39 | **No `electron-updater`** | Squirrel.Mac needs a consistent valid signature across versions; with `identity: '-'` the check fails and the update silently does not apply. The one platform verifiable here is the one where auto-update is structurally impossible. Runtime dependencies stay at exactly `zod`. |
| 40 | **`checkNow` always reports an outcome** — a carve-out from "failure is silent" | Background silence is right; silence after a person clicked a menu item and is waiting reads as a broken menu. Reported by toast, not dialog: a modal breaks the illusion and with the dock hidden can open behind everything. |
| 41 | **`zod` and `main` declared at the workspace root** | electron-builder reads the app entry and runtime dependencies from the root `package.json` in this layout, even though `apps/desktop` is where they belong semantically. |
| 42 | **Icons and the tray glyph are derived from the art** | Keeps locked decision #10 whole: a Keycode-branded pack regenerates its own icons. The tray glyph is a coverage-downsampled alpha silhouette because a full-colour sprite at 16px is mud. |
| 43 | **`position` keyed by display *geometry*, storing only `x`** | Display ids are not stable across reboots, so an id-keyed position silently resolves to "no saved position". `y` is always re-derived, so a persisted one could only ever be stale. |

## Deliberately not done

| Item | Status |
|---|---|
| A real broadcast host | Not chosen. P4 is proven end to end against the local dev server, including every clamp, the dedupe and the XSS case. Switching is one env var; `docs/BROADCAST.md` lists candidates. |
| A git remote | None, per the locked decision. The CI workflow is written and committed but has never run. |
| Windows and Linux verification | Not possible from this machine. See `docs/VERIFICATION.md`. |
| `stretch` animation art | Aliased to `jumping`. The trigger path is complete and testable. |
| `drink` animation art | Row 6 reclaimed; plays the idle frames until drawn. The reminder path is complete. |
| Keycode-branded art | Ships on the `pixel-coder` placeholder. `docs/ASSETS.md` documents the zero-code-change swap. |
| Shipping the emoji font only in Linux artifacts | Would save 4.8MB on macOS and Windows. Left as a simplification rather than an oversight. |
| Per-state mask refinement for hit-testing | The union mask over-grabs slightly; per-state would make the grabbable area flicker. Not worth it. |
