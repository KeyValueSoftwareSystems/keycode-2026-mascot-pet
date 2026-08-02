#!/usr/bin/env bash
#
# Run the pet on a real X server from a Mac.
#
#   pnpm lab:linux                                   # capture, with the default callout
#   pnpm lab:linux capture sleep --state sleep        # any smoke flags after the name
#   pnpm lab:linux vnc                                # leave it running; open vnc://localhost:5900
#   pnpm lab:linux shell                              # a prompt inside, X already up
#
# Captures land in docs/demo/linux-lab/. The one to look at is `*.root.png`: it is what the X server
# composited, which is the only thing that shows window-shape clipping. `*.window.png` beside it is the
# harness's own `capturePage()` output for the same instant — the two disagreeing is the whole reason
# this exists.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

IMAGE=keycode-pet-lab
OUT_DIR=docs/demo/linux-lab
MODE="${1:-capture}"
shift || true

# Chromium's namespace sandbox needs clone flags that Docker's default seccomp profile blocks. The
# alternative is `--no-sandbox`, which would mean observing a different Chromium than the user runs —
# see the Dockerfile.
RUN_FLAGS=(--security-opt seccomp=unconfined)

# No network by default. The live manifest injects the current release announcement into any run long
# enough to poll, which silently replaces whatever callout the run was about — captures stop being
# reproducible and start depending on what was published this week. `LAB_NET=1` opts back in when the
# broadcast path is what you are testing.
[ "${LAB_NET:-0}" = 1 ] || RUN_FLAGS+=(--network none)

echo "▶ building ${IMAGE} (cached after the first run)"
docker build -t "${IMAGE}" -f docker/linux-lab/Dockerfile . >/dev/null

case "${MODE}" in
  capture)
    name="${1:-lab}"; shift || true
    # No flags given: a sticky bubble, because a bubble is what the shape region gets wrong.
    if [ "$#" -eq 0 ]; then
      set -- --callout "Time for some water 💧" --sticky
    fi
    container="${IMAGE}-run-$$"
    trap 'docker rm -f "${container}" >/dev/null 2>&1 || true' EXIT
    # Captured on failure too, and the exit code carried at the end. A run that failed an assertion is
    # the run whose screenshots you most want to look at; discarding them would be backwards.
    status=0
    docker run --name "${container}" "${RUN_FLAGS[@]}" "${IMAGE}" capture "${name}" "$@" || status=$?

    mkdir -p "${OUT_DIR}"
    docker cp "${container}:/out/." "${OUT_DIR}/" >/dev/null
    # The harness's own capture of the same run, for the side-by-side.
    docker cp "${container}:/app/docs/demo/${name}.window.png" \
      "${OUT_DIR}/${name}.capturePage.png" >/dev/null 2>&1 || true
    echo
    echo "▶ ${OUT_DIR}/"
    ls -1 "${OUT_DIR}" | sed 's/^/    /'
    exit "${status}"
    ;;

  vnc)
    container="${IMAGE}-vnc"
    docker rm -f "${container}" >/dev/null 2>&1 || true
    docker run -d --name "${container}" "${RUN_FLAGS[@]}" -p 5900:5900 \
      "${IMAGE}" vnc "${1:-lab-vnc}" "${@:2}" >/dev/null
    echo "▶ starting…"
    sleep 12
    docker logs "${container}" 2>&1 | grep -v '^Xlib' | tail -20
    echo
    echo "  open vnc://localhost:5900          (macOS Screen Sharing, no password)"
    echo "  docker exec ${container} import -window root -display :99 /out/now.png"
    echo "  docker rm -f ${container}          when you are done"
    ;;

  shell)
    docker run --rm -it "${RUN_FLAGS[@]}" -p 5900:5900 "${IMAGE}" shell
    ;;

  *)
    echo "usage: pnpm lab:linux [capture <name> [smoke flags…] | vnc | shell]" >&2
    exit 2
    ;;
esac
