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

To watch it over a dark backdrop, which is how you see transparency problems:

```bash
KEYCODE_PET_BACKDROP=1 pnpm dev
```

### Broadcast messages

Every install polls one static JSON file over HTTPS:

```
https://demos.doylefermi.freeddns.org/keycode/manifest.json
```

To say something to everyone, edit `manifest/manifest.json` and publish it:

```bash
pnpm manifest:check      # validate with the client's own parser, report what will be shown
pnpm manifest:publish    # validate, upload, then verify what the host actually serves
```

`manifest:publish` refuses to upload a file the client would reject, because a malformed envelope
silences every announcement for every install. It also prints which entries are live, scheduled or
expired, since that is not obvious from reading the JSON.

**The host has no auth — the manifest is world-readable.** Nothing goes in it that would not be fine
on a public page.

To test against a local server instead, with fault injection:

```bash
pnpm manifest:serve      # serves manifest/manifest.json on 127.0.0.1:8787

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
| `pnpm test` | 335 tests, no Electron required |
| `pnpm typecheck` | `tsc --noEmit` over both tsconfigs |
| `pnpm generate` | Regenerate everything derived from `pet/spritesheet.json` |
| `pnpm generate:check` | Fail if the committed generated files are stale |
| `pnpm smoke --name x --backdrop` | Launch, screenshot, assert pixels — see [docs/VERIFICATION.md](docs/VERIFICATION.md) |
| `pnpm smoke:states` | One screenshot per animation state |
| `pnpm package` | macOS `.dmg` + `.zip`. **macOS only by design** — see below |
| `pnpm icons` | Regenerate app icons from the art (macOS only, output committed) |
| `pnpm manifest:serve` | Local broadcast manifest server with fault injection |
| `pnpm manifest:check` | Validate `manifest/manifest.json` and report what clients will show |
| `pnpm manifest:publish` | Validate, upload to the host, verify what is served |

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

## Documentation

| | |
|---|---|
| [docs/PROMPT.md](docs/PROMPT.md) | The implementation brief this was built from, with its errors corrected in place |
| [DECISIONS.md](DECISIONS.md) | Every deviation from the brief, the issue, or openpets — with reasons |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The seams, the two clocks, and what would break at scale |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | The screenshot loop, and **what is not verified** |
| [docs/BROADCAST.md](docs/BROADCAST.md) | Manifest schema, every limit, how to publish |
| [docs/ASSETS.md](docs/ASSETS.md) | Swapping the art with no code changes |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | openpets (MIT), Noto Color Emoji (OFL 1.1 / Apache-2.0) |

---

## Status

All nine milestones are built, tagged `v0.0.0`–`v0.8.0`. 339 tests pass; typecheck is clean.

**Verified on macOS**, including installing from a quarantined `.dmg` — the real download path — and
watching the pet render over another application with a transparent window.

**Broadcast is verified against the real host**, over the internet, with no flags: a published
message appeared once and a restart against the same file showed nothing.

**Not verified:** all Windows behaviour and all Linux behaviour. One reproducible macOS oddity is
also open:
launching from `/Applications` on the development machine does not start the main script, while the
identical bundle works from `~/Applications` including quarantined. Details and the full untested list
are in [docs/VERIFICATION.md](docs/VERIFICATION.md).
