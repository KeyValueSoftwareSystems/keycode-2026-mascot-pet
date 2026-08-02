# The Linux lab: a real X server, so window-level bugs are visible from a Mac.
#
# This exists because of one specific failure. `setShape()` — the mechanism that makes the pet
# click-through on Linux — also clips *drawing*, so the speech bubble was never painted there. Every
# automated check passed, because the only pixel evidence the harness produces is
# `webContents.capturePage()`, which renders the web contents directly and never touches the X11
# window shape. No amount of capturePage output can see that class of bug.
#
# What makes this image useful is therefore not Linux per se. It is that `import -window root`
# captures what the X server actually composited — shape clipping, transparency, z-order and all.
#
# Node and the dependencies live in the image, so the harness (`scripts/smoke.mjs`) runs in here with
# its `--callout` / `--place` / `--state` flags. Driving the packaged app by hand through VNC would
# otherwise mean waiting 45 minutes for a water reminder to produce a bubble.
#
# Built natively: colima on Apple Silicon is aarch64, so this is not emulated and Electron's
# postinstall fetches the linux-arm64 binary. That is also why the Mac's node_modules cannot simply
# be mounted in — it holds a darwin Electron.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# Three groups, kept separate because they fail differently:
#   1. The X stack. `picom` is not optional — Xvfb has no compositor, and an ARGB window with no
#      compositor paints its transparent regions black. That looks exactly like a rendering bug and
#      would send you chasing the wrong thing. Cinnamon and GNOME both composite, so running picom
#      here is emulating the user's machine rather than working around it.
#   2. Electron's shared libraries. Missing one produces a silent exit, or a bare "cannot open shared
#      object file" naming a library without saying which feature wanted it.
#   3. `imagemagick` for the root-window capture, `x11-utils` for xdpyinfo/xwininfo (how you check the
#      display is actually up and what shape the window ended up), `xdotool` for scripted clicks.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc picom openbox x11-xserver-utils \
      x11-utils x11-apps xdotool imagemagick \
      libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
      libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libasound2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libpango-1.0-0 libcairo2 libayatana-appindicator3-1 \
      dbus-x11 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Globally rather than through corepack: corepack caches under the *invoking* user's home, and this
# image switches users below — a root-side corepack activation is invisible to the user that then
# has to run pnpm.
RUN npm install --global pnpm@11.6.0

# Chromium refuses to start as root unless its sandbox is disabled, and disabling the sandbox to run
# a test of window compositing would be testing a different program. The `node` image already ships
# an unprivileged user; `/out` belongs to it so captures can be written without a permission dance.
RUN mkdir -p /app /out /tmp/.X11-unix \
    && chown -R node:node /app /out \
    && chmod 1777 /tmp/.X11-unix
WORKDIR /app
USER node

# Dependencies first, so editing source does not re-install them.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/desktop/package.json apps/desktop/
RUN pnpm install --frozen-lockfile

# Chromium's SUID sandbox helper must be root-owned and setuid, and pnpm cannot make it so — it is
# unpacked as whichever user ran the install. Without this Electron aborts on startup with
# "The SUID sandbox helper binary was found, but is not configured correctly", which reads like a
# missing dependency and is not.
#
# The alternative is `--no-sandbox`, and it is the wrong trade here: this image exists to observe how
# Chromium composites a shaped, transparent window, so it should be the same Chromium the user runs.
USER root
RUN set -eu; \
    sandbox=$(find /app/node_modules/.pnpm -path '*/electron/dist/chrome-sandbox' -print -quit); \
    test -n "$sandbox" || { echo 'chrome-sandbox not found' >&2; exit 1; }; \
    chown root:root "$sandbox" && chmod 4755 "$sandbox"
USER node

COPY --chown=node:node . .
RUN pnpm build

# `+32` in the screen spec is load-bearing: it is what gives Chromium a 32-bit ARGB visual to choose.
# At plain depth 24 the window comes out opaque no matter what the compositor does.
ENV DISPLAY=:99 \
    LAB_SCREEN=1440x900x24+32 \
    LAB_BACKDROP="#1d3b53" \
    LAB_OUT=/out

EXPOSE 5900
ENTRYPOINT ["/app/docker/linux-lab/boot.sh"]
CMD ["capture", "lab"]
