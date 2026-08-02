#!/usr/bin/env bash
#
# Bring up an X server the pet can be looked at through, then either capture it or hand it to VNC.
#
#   boot capture <name> [smoke flags…]   run the harness, screenshot the ROOT WINDOW, exit
#   boot vnc [smoke flags…]              run the harness and idle, so you can VNC in and use it
#   boot shell                           a prompt, with X already up
#
# The root-window capture is the entire point. `webContents.capturePage()` — every assertion the
# harness makes — renders the web contents and never sees the X11 window shape, which is why a bubble
# that was being clipped away on Linux passed CI. `import -window root` sees what was composited.
set -euo pipefail

SCREEN="${LAB_SCREEN:-1440x900x24+32}"
OUT_DIR="${LAB_OUT:-/out}"
SETTLE="${LAB_SETTLE:-3}"

log() { printf '\033[36m[lab]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[lab] %s\033[0m\n' "$*" >&2; exit 1; }

start_x() {
  log "Xvfb ${DISPLAY} at ${SCREEN}"
  # `+32` in the screen spec is load-bearing: it is what gives Chromium a 32-bit ARGB visual to
  # choose. At plain depth 24 the window is opaque however well the compositor behaves.
  Xvfb "${DISPLAY}" -screen 0 "${SCREEN}" -nolisten tcp -noreset &
  for _ in $(seq 1 50); do
    xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
    sleep 0.2
  done
  xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 || die "Xvfb never came up on ${DISPLAY}"

  # A coloured root window, not black: the pet's window is transparent, so against black you cannot
  # tell "correctly transparent" from "not drawn at all" — which are the two outcomes under test.
  xsetroot -solid "${LAB_BACKDROP:-#1d3b53}"

  log 'openbox'
  openbox &
  sleep 0.5

  # xrender rather than glx: Xvfb has no GL. Without a compositor, ARGB windows paint black.
  log 'picom (xrender)'
  picom --backend xrender --no-fading-openclose &
  sleep 0.8
}

start_vnc() {
  log 'x11vnc on :5900'
  x11vnc -display "${DISPLAY}" -forever -shared -nopw -rfbport 5900 -quiet -bg >/dev/null 2>&1
}

# The harness, backgrounded and left running. `--no-composite` because composite capture is
# macOS-only (screencapture); `--keep-open` because we want the app alive to photograph.
start_app() {
  local name="$1"; shift
  log "smoke --name ${name} $*"
  node scripts/smoke.mjs --name "${name}" --no-composite --keep-open "$@" &
  APP_PID=$!
}

# Which window the X server routes the pointer to, at a set of window-relative points.
#
# This is the assertion that the shape region has not been widened into a click-eater. Adding the
# bubble band to it is the fix for the bubble never being painted, and the risk that comes with it is
# that the pet's transparent margin stops passing clicks through to the app underneath. `xdotool
# getmouselocation` reports the window under the pointer *as the X server resolves it*, which is
# exactly the routing that the shape decides — so this reads the real answer rather than inferring one.
probe_passthrough() {
  local id="$1" pet root fails=0
  pet=$(printf '%d' "$id")
  root=$(printf '%d' "$(xwininfo -root | awk '/Window id:/{print $4}')")

  local sw sh
  eval "$(xdpyinfo | awk '/dimensions:/{split($2,d,"x"); print "sw="d[1]"; sh="d[2]}')"

  # The window position is re-read for *every* point, not once up front. The pet patrols, so a
  # position sampled at the start of the probe is wrong a few hundred milliseconds later and the
  # points land somewhere else entirely — which showed up as an intermittent failure on a point that
  # was in fact fine.
  #
  # Points outside the screen are skipped rather than checked. The pet window is deliberately allowed
  # to hang off the screen edge — it is 360px wide for a 107px character, so clamping it would strand
  # the pet ~126px short of the edge — and `xdotool mousemove` clamps a request to the screen. The
  # combination silently relocates an off-screen point *onto the body*, which reads as a
  # passthrough failure at exactly the moment the pet happens to be at the far left.
  at() {
    local wx wy ax ay
    eval "$(xwininfo -id "$id" | awk '/Absolute upper-left X/{print "wx="$4} /Absolute upper-left Y/{print "wy="$4}')"
    ax=$((wx + $1)); ay=$((wy + $2))
    if [ "$ax" -lt 0 ] || [ "$ay" -lt 0 ] || [ "$ax" -ge "$sw" ] || [ "$ay" -ge "$sh" ]; then
      echo offscreen
      return
    fi
    xdotool mousemove "$ax" "$ay" >/dev/null 2>&1
    sleep 0.25
    xdotool getmouselocation --shell 2>/dev/null | awk -F= '/WINDOW/{print $2}'
  }

  check() { # label dx dy expected(pet|through)
    local got verdict
    got=$(at "$2" "$3")
    if [ "$got" = offscreen ]; then
      printf '  %-22s %-8s skipped (off-screen: the window may hang past the edge)\n' "$1" "$4"
      return
    fi
    if [ "$4" = pet ]; then
      if [ "$got" = "$pet" ]; then verdict='ok'; else verdict='FAIL'; fails=$((fails + 1)); fi
    else
      if [ "$got" != "$pet" ]; then verdict='ok'; else verdict='FAIL'; fails=$((fails + 1)); fi
    fi
    printf '  %-22s %-8s %s (window %s)\n' "$1" "$4" "$verdict" "$got"
  }

  # Window-relative, for the 360×304 window: the body occupies x 126–233, its feet reach the window's
  # bottom edge, and the bubble band spans the full width down to the hair. Everything else must fall
  # through. Note there is no point *below* the feet to test — the window ends at them by design.
  log "pointer routing (pet=$pet root=$root)"
  check 'pet body'         180 212 pet
  check 'bubble'           180  40 pet
  check 'margin far left'   20 260 through
  check 'margin far right' 340 260 through
  check 'margin beside hip' 40 180 through

  [ "$fails" -eq 0 ] || die "$fails pointer-routing check(s) failed"
}

wait_for_window() {
  for _ in $(seq 1 100); do
    if xwininfo -root -tree 2>/dev/null | grep -q 'Keycode Pet'; then
      log 'pet window mapped'
      return 0
    fi
    sleep 0.2
  done
  die 'no window named "Keycode Pet" ever appeared. Run `boot shell` and check for missing libraries.'
}

case "${1:-capture}" in
  capture)
    shift
    name="${1:-lab}"; shift || true
    mkdir -p "${OUT_DIR}"
    start_x
    start_app "${name}" "$@"
    wait_for_window
    sleep "${SETTLE}"

    root="${OUT_DIR}/${name}.root.png"
    import -window root -display "${DISPLAY}" "${root}"
    log "root window → ${root}"

    # The pet's own window, cropped by the X server to its shape. Side by side with the harness's
    # capturePage output for the same run, this is what makes the clipping visible as a difference
    # rather than as an opinion.
    id=$(xwininfo -root -tree | awk '/Keycode Pet/ {print $1; exit}')
    if [ -n "${id:-}" ]; then
      window="${OUT_DIR}/${name}.window-x11.png"
      import -window "${id}" -display "${DISPLAY}" "${window}" 2>/dev/null \
        && log "pet window (X11, shaped) → ${window}" \
        || log 'per-window capture failed; the root capture is the one that matters'
      [ "${LAB_PROBE:-1}" = 1 ] && probe_passthrough "${id}"
    fi

    pkill -f 'electron' >/dev/null 2>&1 || true
    wait "${APP_PID}" 2>/dev/null || true
    ;;

  vnc)
    shift
    start_x
    start_vnc
    start_app "${1:-lab-vnc}" "${@:2}"
    wait_for_window
    log ''
    log 'Connect from macOS:  open vnc://localhost:5900'
    log 'Capture at any time: docker exec <container> import -window root -display :99 /out/now.png'
    log ''
    # Idle forever. `wait` on the harness would return the moment it prints its summary — it exits
    # while the app keeps running, which is exactly what --keep-open means.
    tail -f /dev/null
    ;;

  shell)
    start_x
    start_vnc
    exec bash
    ;;

  *)
    exec "$@"
    ;;
esac
