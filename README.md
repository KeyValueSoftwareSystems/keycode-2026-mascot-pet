# Keycode Pet

A small pixel character that lives on your desktop. It runs along the bottom of the screen, over
whatever you are working on, in a window with no edges. You can grab it. It reminds you to drink
water. And the whole team can make every installed pet say something by editing one JSON file.

Cross-platform Electron app for macOS, Windows and Linux. Internal tool — no signing, no store, no
accounts, no telemetry.

> **The character is a placeholder.** `pixel-coder` is a pixel-art chibi human, not the Keycode
> mascot. Swapping it is a file swap plus a JSON edit with no code changes — see
> [docs/ASSETS.md](docs/ASSETS.md).

---

## Running it

Requires Node ≥ 20 and pnpm. About five minutes from clone to a pet on screen.

```bash
pnpm install          # also fetches the Electron binary (~290MB)
pnpm build
pnpm dev
```

The pet appears at the bottom of your primary display and starts moving. A tray icon gives you the
settings menu; right-clicking the pet gives you the same menu.

**Broadcast notifications wait to be clicked.** A message from the manifest has no timeout unless the
publisher sets one — it sits above the pet with a small × until you click it, so an announcement cannot
be missed by looking away. Clicking one that has a link opens the link and dismisses it together.

**Reminders, with intervals.** Right-click → Drink water reminder / Stretch reminder → Off, or every
5 / 15 / 30 / 45 / 60 / 90 minutes. Changing an interval clears the pending deadline, so the next
reminder is one *new* interval away rather than inheriting the old one. **The 5-minute option is how you
test that reminders work** without waiting 45 minutes.

The team can set default intervals for anyone who never picked one, via the manifest — see
[docs/BROADCAST.md](docs/BROADCAST.md). Defaults never override a local choice, and there is no way for
a manifest to switch a reminder back on. The manifest also sets **how often clients re-fetch it**
(`pollMinutes`), so the broadcast cadence is changed by publishing rather than by shipping a build.

**Three sizes.** Right-click → Size → Small / Medium / Large. `Large` is the size it has always
rendered at, so upgrading changes nothing; `Small` is half that. Only the sprite scales — bubble text
stays readable at every size.

**Drag it anywhere.** It is not stuck to the bottom of the screen — drop it mid-screen and it stays
there, patrolling left and right at that height, and it comes back there after a restart. Drop it near
the floor and it re-locks to the floor. "Reset position" always brings it home.

To watch it over a dark backdrop, which is how you see transparency problems:

```bash
KEYCODE_PET_BACKDROP=1 pnpm dev
```

### Broadcast messages

Every install polls one static JSON file over HTTPS, served from GitHub Pages out of `site/`:

```
https://doylefermi-kv.github.io/keycode-2026-mascot-pet/manifest.json
```

To say something to everyone:

```bash
pnpm notify "Keycode on Fire 🔥" --tone warning --animation jumping --expires 24h
pnpm notify:list                                  # what is live, scheduled, expired
pnpm notify "…" --dry-run                         # validate and print, change nothing
```

**Publishing is a commit.** `notify` writes `site/manifest.json`, validates it with the client's own
parser, commits and pushes; CI deploys Pages. That is deliberate — remote text that lands above
everything on a colleague's screen goes through the same review path as code.

It also generates the id (they are permanent dedupe keys, and reusing one silently shows nothing to
anyone who saw it before) and requires an expiry, defaulting to 24h — every message phrased relative to
"now" is wrong for whoever installs next week.

**The manifest is world-readable.** Nothing goes in it that would not be fine on a public page.

To test against a local server instead, with fault injection:

```bash
pnpm manifest:serve      # serves site/manifest.json on 127.0.0.1:8787

# in another terminal
KEYCODE_PET_MANIFEST_URL=http://127.0.0.1:8787/manifest.json \
KEYCODE_PET_ALLOW_INSECURE_MANIFEST=1 \
KEYCODE_PET_POLL_MINUTES=1 \
pnpm dev
```

See [docs/BROADCAST.md](docs/BROADCAST.md) for the schema, every clamp, and the fault-injection modes.

---

## Commands

| | |
|---|---|
| `pnpm dev` | Run from source |
| `pnpm build` | Compile main (tsc) and the renderer (Vite) |
| `pnpm test` | 397 tests, no Electron required |
| `pnpm typecheck` | `tsc --noEmit` over both tsconfigs |
| `pnpm generate` | Regenerate everything derived from `pet/spritesheet.json` |
| `pnpm generate:check` | Fail if the committed generated files are stale |
| `pnpm smoke --name x --backdrop [--place x,feetY] [--size small]` | Launch, screenshot, assert pixels — see [docs/VERIFICATION.md](docs/VERIFICATION.md) |
| `pnpm smoke:states` | One screenshot per animation state |
| `pnpm package` | macOS `.dmg` + `.zip`. **macOS only by design** — see below |
| `pnpm icons` | Regenerate app icons from the art (macOS only, output committed) |
| `pnpm manifest:serve` | Local broadcast manifest server with fault injection |
| `pnpm notify "…"` | Publish a broadcast: validate, commit, push |
| `pnpm notify:list` | What is live, scheduled and expired |

`pnpm package` is deliberately restricted to `--mac`. Building `deb`/`rpm` on an Apple Silicon host
produces broken packages, so Windows and Linux artifacts come from the CI matrix
(`.github/workflows/release.yml`) only. `package:win-ci-only` and `package:linux-ci-only` exist but are
named to make that obvious.

---

## Environment variables

| Variable | Effect |
|---|---|
| `KEYCODE_PET_BACKDROP=1` | Show the opaque dark backdrop window. Dev only |
| `KEYCODE_PET_SMOKE=1` | Emit the JSONL harness handshake on stdout, accept commands on stdin |
| `KEYCODE_PET_FORCE_STATE=<state>` | Pin one animation state instead of running the motion engine |
| `KEYCODE_PET_MANIFEST_URL=<url>` | Override the broadcast manifest URL |
| `KEYCODE_PET_POLL_MINUTES=<n>` | Override the poll interval, clamped to 1–1440 |
| `KEYCODE_PET_ALLOW_INSECURE_MANIFEST=1` | Permit `http://` to loopback **only**, and only in an unpackaged build |
| `KEYCODE_PET_OZONE=native` | Opt back into native Wayland on Linux, accepting a pet that cannot move |

---

## How it is put together

Two seams carry the whole design. [ARCHITECTURE.md](ARCHITECTURE.md) has the detail; the short
version:

**Main owns truth; the renderer is a dumb view.** One validated object flows main → renderer, one
boolean flows back. The renderer sets attributes, sets `textContent`, hit-tests against a generated
alpha mask, and decides nothing. A test greps it for timers, `fetch` and `innerHTML`, because that
rule only survives if something checks.

**The motion engine is pure.** `advance(state, input) => state`, with the clock and the randomness
injected. Ten minutes of pet life simulates headlessly in about 90ms, deterministically — which
matters because the liveliness logic is the code whose bugs are subtlest and only visible after
minutes of watching.

Everything about the sprite — row offsets, frame counts, durations, state names, the alpha mask, the
tray icon — is generated from `pet/spritesheet.json`. Nobody types `-208px` by hand.

```
apps/desktop/src/
  main/        the impure half: windows, tray, menus, timers, IO
  motion/      pure: advance(), the run planner, seeded RNG
  callouts/    pure: the arbiter, text sanitising
  reminders/   pure: wall-clock deadline rules
  broadcast/   the manifest: URL guard, capped fetch, schema, poller
  updates/     version compare, update service
  renderer/    two dumb views (pet, toast) and their CSS
  preload/     two narrow contextBridge bridges
pet/           the art and its animation map — the single source of truth
scripts/       generators, the smoke harness, the dev manifest server
```

Runtime dependencies: **`zod`**. That is the whole list.

---

## Commits, tags and versions

The build used one convention and then drifted out of it, so it is written down here.

**Commits** are [Conventional Commits](https://www.conventionalcommits.org/) with a scope naming the
directory the change lives in — `feat(motion):`, `fix(broadcast):`, `build(package):`, `docs:` — and a
lowercase subject in the imperative. Scopes in use: `harness`, `infra`, `settings`, `sprite`, `window`,
`motion`, `menu`, `reminders`, `callouts`, `broadcast`, `updates`, `package`.

**Tags** are annotated, never lightweight, so `git tag -n1` reads as a changelog. `v0.0.0`–`v0.8.0`
mark the nine build milestones; `v1.0.0` marks all of them green. From `v1.1.0` they are releases.

**The version in `package.json` matches the tag at that commit** — both files, they are kept in step.
This is not cosmetic: `app.getVersion()` reads it, and the update check compares the manifest's
`latestVersion` against it. A stale `0.0.0` is what made every install think a phantom `0.6.0` was
available.

> Known artefact: `v0.8.0` is an *ancestor* of `v0.7.0`. M8 (the update check) was built before M7
> (packaging), because packaging last means packaging everything. The tags name milestones, not a
> release sequence, and rewriting them to look ordered would misreport when the work actually landed.

---

## Documentation

| | |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | How users install it, including the unsigned-app warnings |
| [docs/PROMPT.md](docs/PROMPT.md) | The implementation brief this was built from, with its errors corrected in place |
| [DECISIONS.md](DECISIONS.md) | Every deviation from the brief, the issue, or openpets — with reasons |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The seams, the two clocks, and what would break at scale |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | The screenshot loop, and **what is not verified** |
| [docs/BROADCAST.md](docs/BROADCAST.md) | Manifest schema, every limit, how to publish |
| [docs/ASSETS.md](docs/ASSETS.md) | Swapping the art with no code changes |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | openpets (MIT), Noto Color Emoji (OFL 1.1 / Apache-2.0) |

---

## Status

All nine milestones are built, tagged `v0.0.0`–`v0.8.0`, with `v1.0.0` marking them all green and
releases from `v1.1.0`. 397 tests pass; typecheck is clean.

**[Download v1.7.0](https://github.com/doylefermi-kv/keycode-2026-mascot-pet/releases/latest)** —
macOS, Windows and Linux, built by CI. See [docs/INSTALL.md](docs/INSTALL.md) first: the app is
unsigned, so both macOS and Windows warn on the first launch.

**Verified on macOS**, including installing from a quarantined `.dmg` — the real download path — and
watching the pet render over another application with a transparent window.

**Broadcast is verified against the real host**, over the internet, with no flags: a published
message appeared once and a restart against the same file showed nothing.

**Linux rendering is now verified** in CI — the pet paints and the window is genuinely transparent
(100% of the alpha ring) under xvfb. **Windows boots, animates and polls the manifest**, but its pixels
are still unverified: `capturePage()` times out on the runner, so the visual assertions never ran.
Details and the full untested list are in [docs/VERIFICATION.md](docs/VERIFICATION.md).

**The app is not code-signed**, so macOS and Windows both warn on first open. On macOS, right-click →
**Open** rather than double-clicking. See [docs/INSTALL.md](docs/INSTALL.md) — this is the single
biggest support cost of the current setup, and buying an Apple Developer certificate is what removes it.

**No telemetry.** One network request (the manifest), no analytics, no identifiers, no accounts. The
"Report a problem…" menu item copies a report and reveals the log for you to attach; nothing is ever
uploaded by the app itself.
