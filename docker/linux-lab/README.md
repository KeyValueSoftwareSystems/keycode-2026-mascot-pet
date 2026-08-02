# The Linux lab

Run the pet on a real X server, from a Mac, and take a picture of what the X server actually drew.

```bash
pnpm lab:linux                                       # capture, with a sticky callout
pnpm lab:linux capture sleep-z --state sleep          # any smoke flags after the name
pnpm lab:linux capture top --place 700,192 --callout "at the top" --sticky
pnpm lab:linux vnc                                   # then: open vnc://localhost:5900
pnpm lab:linux shell                                 # a prompt inside, X already up
```

Captures land in `docs/demo/linux-lab/`.

## Why this exists

`webContents.capturePage()` — every pixel assertion the harness makes — renders the **web contents**.
It never touches the window: not its shape, not its z-order, not what the compositor did with its
alpha.

On Linux, click-through is achieved with `win.setShape(rects)`, and Electron documents that as
determining where the system permits **drawing**, not merely clicking: *"Outside of the given region,
no pixels will be drawn."* The region was the character's opaque cells, so the speech bubble — which
sits in a band above the sprite — was never painted at all. Only the sliver overlapping the hair
appeared.

It shipped for four versions with every check green, because no instrument in the project could see it.
`import -window root` can.

## What each output is for

| | |
|---|---|
| `*.root.png` | The whole X root window. **The one to look at** — the only file that shows shape clipping, real compositing and z-order |
| `*.window-x11.png` | The pet's window as the X server holds it, i.e. after shaping |
| `*.capturePage.png` | The harness's own capture of the same instant, for the side-by-side |

It also runs a **pointer-routing probe**: `xdotool getmouselocation` reports the window under the
pointer *as the X server resolves it*, which is exactly what the shape region decides. The pet's body
and its bubble must route to the pet; the transparent margin must fall through. That makes Linux
click-through a checked assertion instead of a claim ported on trust.

## Things in here that are load-bearing

- **`picom`.** Xvfb has no compositor, and an ARGB window without one paints its transparent regions
  black. That looks exactly like a rendering bug. Cinnamon and GNOME both composite, so picom emulates
  the user's machine rather than working around it.
- **`-screen 0 1440x900x24+32`.** The `+32` gives Chromium a 32-bit ARGB visual to choose. At plain
  depth 24 the window is opaque no matter what the compositor does.
- **A root-owned setuid `chrome-sandbox`, and `--security-opt seccomp=unconfined`.** Chromium's
  namespace sandbox needs clone flags Docker's default seccomp profile blocks, and the SUID helper must
  be root-owned or Electron aborts with a message that reads like a missing library. The alternative is
  `--no-sandbox`, which would mean observing a different Chromium than the one users run — in an image
  whose only purpose is observing how Chromium composites a window.
- **A non-root user.** Chromium refuses to start as root without disabling its sandbox, and the
  `node` base image already ships an unprivileged user.
- **Network off by default.** The live manifest injects the current release announcement into any run
  long enough to poll, silently replacing whatever callout the run was about. `LAB_NET=1` opts back in
  when the broadcast path is the thing under test.
- **Dependencies baked into the image, not mounted.** The Mac's `node_modules` holds a *darwin*
  Electron. Mounting it shadows the Linux binary the image installed, and the failure is an
  exec-format error that looks nothing like its cause.

## Environment

| | |
|---|---|
| `LAB_NET=1` | Allow network (needed only to test the broadcast path) |
| `LAB_SCREEN` | Xvfb screen spec, default `1440x900x24+32` |
| `LAB_PROBE=0` | Skip the pointer-routing probe |
| `LAB_SETTLE` | Seconds to wait after the window maps, default 3 |

## Known limits

- **X11 only.** The app forces XWayland in production anyway (native Wayland forbids an application
  positioning its own window), so the XWayland path is what users get — but a genuine Wayland
  compositor is not exercised here, and neither is the tray fallback for Wayland's swallowed
  right-click.
- **No tray icon interaction.** The appindicator library is installed, but driving a tray menu through
  VNC is manual.
- Runs natively on Apple Silicon because colima is aarch64. On an Intel Mac it is x86-64, also native.
