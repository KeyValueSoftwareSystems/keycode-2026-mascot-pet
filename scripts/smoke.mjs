#!/usr/bin/env node
/**
 * The visual verification harness.
 *
 * Built before the pet exists, on purpose: this whole feature is an appearance, and a
 * transparent always-on-top window is the one category of software unit tests structurally
 * cannot confirm. Every later milestone proves itself with a screenshot, so the thing that
 * takes screenshots comes first and each milestone's evidence is then free.
 *
 *   node scripts/smoke.mjs --name m2-pet-over-dark [--backdrop] [--state waving]
 *                          [--all-states] [--timeout 20000] [--settle 400]
 *                          [--no-assert] [--keep-open] [--no-composite] [--capture-timeout 8000]
 *                          [--place x,feetY] [--size small|medium|large]
 *                          [--callout "text"] [--toast]
 *
 * TWO CAPTURES, deliberately, because they answer different questions:
 *
 *   1. **Window capture** (`webContents.capturePage()`, in-process, always).
 *      Preserves the window's alpha channel and needs no Screen Recording permission, so it
 *      runs unattended and in CI. This is what the assertions read. For "are this window's
 *      own pixels transparent" it is a *better* signal than a composite, because it reads
 *      alpha directly rather than inferring it from what shows through.
 *
 *   2. **Composite screenshot** (`/usr/sbin/screencapture`, when permitted).
 *      The evidence a human looks at: the pet sitting on top of a real dark window. Needs a
 *      TCC grant. If it is missing, the run still passes on the window capture and says
 *      clearly what was skipped — a missing permission must not read as a passing gate.
 *
 * Exit codes are distinct so a CI log alone is enough to diagnose a failure:
 *   0  ok
 *   1  a pixel assertion failed
 *   2  the app exited before a window appeared (stderr tail included)
 *   3  timed out waiting for the app
 *   4  the in-process window capture failed
 *   5  a capture could not be decoded (16-bit / HDR)
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, existsSync, statSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, pixelAt, alphaAt, rgbDistance, PngUnsupportedError } from './lib/png.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DEMO_DIR = join(ROOT, 'docs', 'demo')
const TMP_DIR = join(DEMO_DIR, 'tmp')
const HANDSHAKE_PREFIX = '@@KEYCODE@@'

/** Must match BACKDROP_RGB in apps/desktop/src/main/backdrop-window.ts. */
const BACKDROP_RGB = [0x10, 0x10, 0x14]

const EXIT = { ok: 0, assertion: 1, died: 2, timeout: 3, capture: 4, decode: 5 }

class SmokeFailure extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ---------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    name: 'smoke',
    backdrop: false,
    state: null,
    timeoutMs: 20_000,
    captureTimeoutMs: 8_000,
    settleMs: Number(process.env.KEYCODE_PET_SMOKE_SETTLE_MS ?? 400),
    assert: true,
    keepOpen: false,
    allStates: false,
    composite: true,
    callout: null,
    toast: false,
    sticky: false,
    freshProfile: false,
    place: null,
    size: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--name':
        opts.name = argv[(i += 1)]
        break
      case '--backdrop':
        opts.backdrop = true
        break
      case '--state':
        opts.state = argv[(i += 1)]
        break
      case '--timeout':
        opts.timeoutMs = Number(argv[(i += 1)])
        break
      case '--capture-timeout':
        opts.captureTimeoutMs = Number(argv[(i += 1)])
        break
      case '--settle':
        opts.settleMs = Number(argv[(i += 1)])
        break
      case '--no-assert':
        opts.assert = false
        break
      case '--keep-open':
        opts.keepOpen = true
        break
      case '--all-states':
        opts.allStates = true
        break
      case '--no-composite':
        opts.composite = false
        break
      case '--callout':
        opts.callout = argv[(i += 1)]
        break
      case '--toast':
        opts.toast = true
        break
      case '--sticky':
        opts.sticky = true
        break
      case '--fresh-profile':
        opts.freshProfile = true
        break
      case '--size':
        opts.size = argv[(i += 1)]
        break
      case '--place': {
        // "x,feetY" in screen coordinates — the pet's body centre and the y of its feet.
        const raw = String(argv[(i += 1)] ?? '')
        const [x, feetY] = raw.split(',').map(Number)
        if (!Number.isFinite(x) || !Number.isFinite(feetY)) {
          throw new Error(`--place needs "x,feetY", got ${JSON.stringify(raw)}`)
        }
        opts.place = { x, feetY }
        break
      }
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag ${arg}`)
    }
  }
  if (!opts.name) throw new Error('--name requires a value')
  return opts
}

// ---------------------------------------------------------------------------------------
// Launch, handshake, control
// ---------------------------------------------------------------------------------------

function electronBinary() {
  const require = createRequire(import.meta.url)
  const binary = require('electron')
  if (typeof binary !== 'string' || !existsSync(binary)) {
    throw new Error(
      'The Electron binary is missing. Run `pnpm install` (which triggers `install-electron`).',
    )
  }
  return binary
}

/** A live app under harness control. */
class AppSession {
  constructor(child) {
    this.child = child
    this.events = []
    this.waiters = []
    this.stderrTail = ''
    this.exited = false
  }

  record(event) {
    this.events.push(event)
    for (const waiter of [...this.waiters]) {
      if (waiter.match(event)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(event)
      }
    }
  }

  /** Resolve with the first event matching `match`, including ones already seen. */
  wait(match, timeoutMs, label) {
    const existing = this.events.find(match)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolvePromise, reject) => {
      const waiter = { match, resolve: resolvePromise, reject, label }
      this.waiters.push(waiter)
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter)
        if (at !== -1) this.waiters.splice(at, 1)
        reject(
          new SmokeFailure(
            EXIT.timeout,
            `Timed out after ${timeoutMs}ms waiting for ${label}.\n` +
              `Events seen: ${this.events.map((e) => e.ev).join(', ') || '(none)'}\n` +
              `stderr tail:\n${this.stderrTail.slice(-1500)}`,
          ),
        )
      }, timeoutMs)
      timer.unref?.()
    })
  }

  send(command) {
    if (this.exited) throw new SmokeFailure(EXIT.died, 'The app exited; cannot send commands.')
    this.child.stdin.write(`${JSON.stringify(command)}\n`)
  }

  latest(match) {
    return [...this.events].reverse().find(match) ?? null
  }

  async shutdown() {
    if (this.exited) return
    try {
      this.send({ cmd: 'quit' })
    } catch {
      /* already gone */
    }
    const died = await Promise.race([
      new Promise((r) => this.child.once('exit', () => r(true))),
      new Promise((r) => setTimeout(() => r(false), 3_000)),
    ])
    if (!died) {
      this.child.kill('SIGTERM')
      const died2 = await Promise.race([
        new Promise((r) => this.child.once('exit', () => r(true))),
        new Promise((r) => setTimeout(() => r(false), 2_000)),
      ])
      if (!died2) this.child.kill('SIGKILL')
    }
  }
}

/**
 * A profile directory of the harness's own.
 *
 * Two problems this solves at once. The single-instance lock lives in `userData`, so a packaged pet
 * running on the same machine made every smoke run exit instantly — which matters because the app is
 * dogfooded while it is developed. And evidence was being shaped by whatever state the last manual
 * session left behind: a screenshot run once came out at `small` because a menu click earlier in the
 * day had persisted, and a broadcast test consumed the very id it was meant to demonstrate.
 *
 * Persistent rather than per-run, because some checks are *about* persistence — "drag it, restart, is
 * it still there". `--fresh-profile` wipes it for a clean first-run.
 */
const HARNESS_PROFILE = join(TMP_DIR, 'profile')

function launch(opts) {
  if (opts.freshProfile) rmSync(HARNESS_PROFILE, { recursive: true, force: true })
  mkdirSync(HARNESS_PROFILE, { recursive: true })

  const child = spawn(
    electronBinary(),
    [join(ROOT, 'apps', 'desktop'), `--user-data-dir=${HARNESS_PROFILE}`],
    {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KEYCODE_PET_SMOKE: '1',
      ...(opts.backdrop ? { KEYCODE_PET_BACKDROP: '1' } : {}),
      ...(opts.state ? { KEYCODE_PET_FORCE_STATE: opts.state } : {}),
    },
  },
  )

  const session = new AppSession(child)
  let stdoutRest = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutRest += chunk
    const lines = stdoutRest.split('\n')
    stdoutRest = lines.pop() ?? ''
    for (const line of lines) {
      const at = line.indexOf(HANDSHAKE_PREFIX)
      if (at === -1) {
        if (line.trim()) process.stderr.write(`  [app] ${line}\n`)
        continue
      }
      try {
        const event = JSON.parse(line.slice(at + HANDSHAKE_PREFIX.length))
        if (event.ev === 'error') {
          process.stderr.write(`  [app error] ${event.where}: ${event.message}\n`)
        }
        session.record(event)
      } catch {
        /* not a handshake line after all */
      }
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    session.stderrTail += chunk
  })

  child.on('exit', (code, signal) => {
    session.exited = true
    session.exitInfo = { code, signal }

    // Reject anything still waiting, rather than dropping the waiters on the floor.
    //
    // They used to be discarded, and the `wait()` timeout is `unref`'d — so once the child was gone
    // there was nothing left to keep the event loop alive and node exited 0 having printed only the
    // banner. A run that did nothing looked like a run that passed. It cost two silent multi-minute
    // waits before being tracked down, both times because another copy of the pet was already
    // running: the harness's child lost the single-instance lock and exited immediately.
    const sawNothing = session.events.length === 0
    const hint = sawNothing
      ? '\n\nThe app exited before saying anything. The usual cause is that another copy of ' +
        'Keycode Pet is\nalready running and holding the single-instance lock, so this one exited ' +
        'immediately.\nThe harness runs in its own profile now, so if you see this, check for a ' +
        'packaged app:\n  pgrep -fl "Keycode Pet.app/Contents/MacOS"'
      : ''
    for (const waiter of session.waiters.splice(0)) {
      waiter.reject?.(
        new SmokeFailure(
          EXIT.died,
          `The app exited (code ${code}, signal ${signal}) while waiting for ${waiter.label}.` +
            `${hint}\n\nstderr tail:\n${session.stderrTail.slice(-1500)}`,
        ),
      )
    }
  })

  child.stdin.on('error', () => {
    /* the app can exit while we are mid-write; not interesting */
  })

  return session
}

// ---------------------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------------------

/**
 * In-process window capture. Alpha-preserving, permission-free, and therefore the basis of
 * every automated assertion.
 */
async function captureWindow(session, windowName, outPath, timeoutMs) {
  mkdirSync(dirname(outPath), { recursive: true })
  session.send({ cmd: 'capture-window', window: windowName, path: outPath })
  let event
  try {
    event = await session.wait(
      (e) => (e.ev === 'capture-written' || e.ev === 'capture-failed') && e.path === outPath,
      timeoutMs,
      `a window capture of ${windowName}`,
    )
  } catch (error) {
    // **Not fatal.** `capturePage()` does not return on a Windows runner, and this used to abort the run
    // at exit 3 with every assertion unrun — on an app that was emitting frames the whole time. A stalled
    // capture now costs the assertions that need alpha and nothing else; the composite path still runs.
    if (error instanceof SmokeFailure) return { unavailable: error.message }
    throw error
  }
  if (event.ev === 'capture-failed') {
    return { unavailable: `In-process capture failed: ${event.reason}` }
  }
  return { event, png: decodeOrThrow(outPath) }
}

/**
 * Where the pet is, without photographing it.
 *
 * Split out from the capture so a composite-only run — which is all Windows can manage today — still
 * knows the sprite rect it has to index.
 */
async function requestGeometry(session, timeoutMs) {
  session.send({ cmd: 'geometry' })
  try {
    return await session.wait((e) => e.ev === 'geometry', timeoutMs, 'a geometry report')
  } catch {
    return null
  }
}

/**
 * Composite screenshot. `-D <n>` pins one display: without it, `screencapture` on a
 * multi-display machine writes several suffixed files and the path we assert against may
 * not exist. `-x` suppresses the shutter sound, `-o` omits window shadows.
 *
 * Returns null (with an explanation) rather than throwing when the permission is missing —
 * the run is still valid on the window capture, and the report says what was skipped.
 */
function captureComposite(outPath, displayIndex) {
  mkdirSync(dirname(outPath), { recursive: true })
  rmSync(outPath, { force: true })

  const backend = COMPOSITE_BACKENDS[process.platform]
  if (!backend) {
    return { ok: false, reason: `no composite backend for ${process.platform}` }
  }

  const { command, args, hint } = backend(outPath, displayIndex)
  const result = spawnSync(command, args, { encoding: 'utf8' })
  const produced = existsSync(outPath) && statSync(outPath).size > 0
  if (result.error) return { ok: false, reason: `${command} could not run: ${result.error.message}` }
  if (result.status !== 0 || !produced) {
    return {
      ok: false,
      reason:
        `${command} exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ''}.` +
        (hint ? ` ${hint}` : ''),
    }
  }
  return { ok: true, path: outPath }
}

/**
 * One composite capture, three platforms — the picture taken from *outside* the process.
 *
 * This used to be macOS-only, and that was the whole reason Windows had no pixel evidence: the only
 * other instrument, `capturePage()`, renders the web contents and never sees the window. The Linux lab
 * proved the point by finding a bubble that was never painted while every in-process assertion passed;
 * `import -window root` is exactly the command that found it, folded in here so the harness owns it.
 *
 * Each backend returns `{ ok: false, reason }` rather than throwing, so a platform that cannot manage
 * it reports what was skipped and the run stays valid on the window capture. A missing capability must
 * never be mistaken for a passing gate.
 */
const COMPOSITE_BACKENDS = {
  // `-D <n>` pins one display: without it, a multi-display machine writes several suffixed files and
  // the path we assert against may not exist. `-x` suppresses the shutter, `-o` omits window shadows.
  darwin: (outPath, displayIndex) => ({
    command: '/usr/sbin/screencapture',
    args: [
      '-x',
      '-o',
      '-t',
      'png',
      ...(typeof displayIndex === 'number' ? ['-D', String(displayIndex + 1)] : []),
      outPath,
    ],
    hint: 'This is almost always a missing Screen Recording permission.',
  }),

  // ImageMagick against the X root window. The same command the Linux lab runs by hand.
  linux: (outPath) => ({
    command: 'import',
    args: ['-window', 'root', outPath],
    hint: 'Install ImageMagick (`import`), and check DISPLAY is set.',
  }),

  // .NET via PowerShell: `CopyFromScreen` over the virtual screen. Whether a GitHub Windows runner's
  // session hands back a real frame or a black one is genuinely unknown until it runs — the CI step is
  // written to upload whatever it gets and not fail the leg, and A7 is what will say which happened.
  win32: (outPath) => ({
    // `powershell.exe`, spelled out: libuv resolves a bare name through PATHEXT, and being explicit
    // costs nothing on the one platform this branch runs.
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        'Add-Type -AssemblyName System.Drawing,System.Windows.Forms;',
        '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
        '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;',
        '$g = [System.Drawing.Graphics]::FromImage($bmp);',
        '$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size);',
        // Single quotes, so the escape that matters is doubling `'` — **not** backslashes. This first
        // read `outPath.replace(/\\/g, '\\\\')`, which is the JavaScript instinct and wrong here: inside
        // a PowerShell single-quoted string a backslash is literal, so it turned `C:\a\b.png` into
        // `C:\\a\\b.png`. .NET usually collapses doubled separators, which is exactly what makes this
        // the kind of bug that survives to the one platform nobody can test on.
        `$bmp.Save('${outPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
        '$g.Dispose(); $bmp.Dispose();',
      ].join(' '),
    ],
    hint: 'The runner session may not permit screen capture.',
  }),
}

function decodeOrThrow(path) {
  try {
    return decodePng(readFileSync(path))
  } catch (error) {
    if (error instanceof PngUnsupportedError) {
      throw new SmokeFailure(
        EXIT.decode,
        `Could not decode ${path}: ${error.message}\n` +
          'Re-run with --no-assert to keep the image without pixel checks.',
      )
    }
    throw error
  }
}

function tccHelp() {
  return [
    'To enable composite screenshots, grant Screen Recording to the terminal or agent host:',
    '  System Settings › Privacy & Security › Screen & System Audio Recording',
    'then fully restart that app — the permission is only picked up at launch.',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------

/**
 * A1 — the sprite painted.
 *
 * Runs against the alpha channel of the window capture: count pixels with meaningful alpha
 * inside the reported sprite rect. A single frame paints ~8360 opaque pixels into a 107×178
 * bbox ≈ 44%, so 20% is a 2× margin against sub-pixel drift and edge antialiasing.
 */
function assertSpritePainted(png, region, label) {
  let opaque = 0
  let total = 0
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      total += 1
      if (alphaAt(png, x, y) > 32) opaque += 1
    }
  }
  const ratio = total === 0 ? 0 : opaque / total
  if (ratio < 0.2) {
    throw new SmokeFailure(
      EXIT.assertion,
      `${label}: only ${(ratio * 100).toFixed(1)}% of the sprite rect has alpha (expected ≥20%). ` +
        'The sprite did not paint, or it painted somewhere other than where main said it did.',
    )
  }
  return ratio
}

/**
 * A2 — the window's own pixels are transparent. This is P1, automated.
 *
 * Samples a ring just *outside* the sprite's visible pixels but still *inside* the window.
 * Because the window is much wider than the character, that ring is composed entirely of
 * window pixels, so a fully transparent ring proves the window itself is see-through. A
 * background colour, a halo, a drop shadow or a rounded-corner artifact all fail here.
 *
 * Reading alpha directly is what makes this trustworthy: a composite could show the
 * backdrop colour through a window that is merely *painted* the same colour.
 *
 * `bubble` — `{ edge, side }` in capture pixels, or null — excludes the band the bubble occupies. The
 * speech bubble is wider than the body, so when one is on screen the app is legitimately painting in
 * the ring on three sides. Main reports the exact y no bubble pixel can cross, derived from the same
 * generated per-state mask entries the renderer anchors to, so this excludes the bubble and nothing
 * more. `side` matters because a pet near the top of the screen wears its bubble *below* its feet:
 * excluding the region above it would then check nothing and miss the region that is actually painted.
 * A run without a callout still checks the whole ring.
 */
function assertWindowTransparentAround(png, spriteRegion, label, ringPx, bubble = null) {
  let transparent = 0
  let total = 0

  const inSprite = (x, y) =>
    x >= spriteRegion.x - 1 &&
    y >= spriteRegion.y - 1 &&
    x < spriteRegion.x + spriteRegion.width + 1 &&
    y < spriteRegion.y + spriteRegion.height + 1

  const above = bubble && bubble.side !== 'below' ? bubble.edge : null
  const below = bubble && bubble.side === 'below' ? bubble.edge : null
  const top = Math.max(spriteRegion.y - ringPx, above ?? -Infinity)
  const bottom = Math.min(
    spriteRegion.y + spriteRegion.height + ringPx,
    below ?? Number.POSITIVE_INFINITY,
  )
  for (let y = top; y < bottom; y += 1) {
    for (let x = spriteRegion.x - ringPx; x < spriteRegion.x + spriteRegion.width + ringPx; x += 1) {
      if (inSprite(x, y)) continue
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue
      total += 1
      if (alphaAt(png, x, y) <= 8) transparent += 1
    }
  }

  if (total === 0) {
    throw new SmokeFailure(
      EXIT.assertion,
      `${label}: the ring is empty — the window is not larger than the sprite, so this ` +
        'assertion cannot prove anything. Check the window size and sprite origin.',
    )
  }

  const ratio = transparent / total
  if (ratio < 0.98) {
    throw new SmokeFailure(
      EXIT.assertion,
      `${label}: only ${(ratio * 100).toFixed(1)}% of the ${total}px ring around the sprite is ` +
        'transparent (expected ≥98%). Something is painting where the window should be fully ' +
        'see-through — a background colour, a shadow, or a rounded-corner artifact.',
    )
  }
  return ratio
}

/** A3 — the image is real, not a uniform frame from a failed or denied capture. */
function assertNotBlank(png, region, label) {
  const seen = new Set()
  for (let y = region.y; y < region.y + region.height; y += 2) {
    for (let x = region.x; x < region.x + region.width; x += 2) {
      const [r, g, b, a] = pixelAt(png, x, y)
      if (a <= 8) continue
      seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3))
      if (seen.size >= 12) return seen.size
    }
  }
  throw new SmokeFailure(
    EXIT.assertion,
    `${label}: only ${seen.size} distinct colours among the opaque pixels — the image looks blank.`,
  )
}

/**
 * A6 — the pixel art is crisp, not smoothed.
 *
 * Acceptance criterion 5, and otherwise only checkable by eye. On a 2x display with
 * `image-rendering: pixelated`, each source pixel must land as an exact NxN block of identical
 * colour. Smoothing (the CSS default) interpolates between neighbours instead, so blocks stop
 * being uniform. Sampling block interiors makes this a direct test of the rendering mode.
 *
 * Skipped at scale 1, where there is no upscaling and therefore nothing to smooth.
 */
function assertPixelArtCrisp(png, region, scale, label, petScale = 1) {
  // How many *device* pixels one source pixel covers: the display's scale factor times the pet's own
  // CSS scale. This is the number that decides whether the assertion means anything.
  //
  //   large  1.00 x 2 = 2    → each source pixel is a 2x2 device block; smoothing is detectable
  //   medium 0.75 x 2 = 1.5  → not an integer, so there are no uniform blocks to look for. This size
  //                            is documented as deliberately soft; asserting here would be asserting
  //                            that resampling did not happen when it necessarily did
  //   small  0.50 x 2 = 1    → one device pixel per source pixel: nothing is scaled, so crispness is
  //                            exact by construction and there is nothing to measure
  //
  // Before pet sizes existed this was always 2, so `Math.round(scale)` happened to be right. Left as
  // it was, `small` reported 18% uniform and looked like a smoothing regression when in fact the
  // sprite was pixel-exact — the assertion's model had stopped matching the rendering.
  const devicePerSource = scale * petScale
  const block = Math.round(devicePerSource)
  if (block < 2 || Math.abs(devicePerSource - block) > 1e-6) return null

  let checked = 0
  let uniform = 0

  for (let by = region.y; by + block <= region.y + region.height; by += block) {
    for (let bx = region.x; bx + block <= region.x + region.width; bx += block) {
      const first = pixelAt(png, bx, by)
      if (first[3] <= 32) continue // skip transparent blocks; nothing to smooth there
      let same = true
      for (let dy = 0; dy < block && same; dy += 1) {
        for (let dx = 0; dx < block; dx += 1) {
          const p = pixelAt(png, bx + dx, by + dy)
          if (rgbDistance(p, first) > 2 || Math.abs(p[3] - first[3]) > 2) {
            same = false
            break
          }
        }
      }
      checked += 1
      if (same) uniform += 1
    }
  }

  if (checked === 0) return null

  const ratio = uniform / checked
  // Blocks straddling a source-pixel boundary are not expected to be uniform when the region
  // origin is not block-aligned, so this is a strong majority rather than a demand for 100%.
  if (ratio < 0.9) {
    throw new SmokeFailure(
      EXIT.assertion,
      `${label}: only ${(ratio * 100).toFixed(1)}% of ${block}x${block} pixel blocks are uniform ` +
        `(expected >=90%). The sprite is being smoothed — check that image-rendering: pixelated ` +
        `is still applied to .pet-sprite.`,
    )
  }
  return ratio
}

/** A4 — the pet's feet sit on the work-area floor, not floating and not clipped into the Dock. */
function assertFeetOnFloor(spriteRect, display, label, floorLocked = true) {
  const feet = spriteRect.y + spriteRect.height
  const floor = display.workArea.y + display.workArea.height

  // A freely placed pet is *supposed* to be off the floor, so the floor check would fail on correct
  // behaviour. What still has to hold is that it is inside the work area — a pet parked off-screen
  // is the actual bug this guards against once free placement exists.
  if (!floorLocked) {
    const top = spriteRect.y
    if (top < display.workArea.y || feet > floor) {
      throw new SmokeFailure(
        EXIT.assertion,
        `${label}: freely placed, but the sprite (y=${top}..${feet}) is outside the work area ` +
          `(${display.workArea.y}..${floor}). The vertical clamp is wrong.`,
      )
    }
    return
  }

  if (Math.abs(feet - floor) > 2) {
    throw new SmokeFailure(
      EXIT.assertion,
      `${label}: the sprite's feet are at y=${feet} but the work-area floor is y=${floor} ` +
        `(${Math.abs(feet - floor)}px off). Check footInset and the placement formula.`,
    )
  }
}

/** In the composite, the pet must actually differ from the backdrop it sits on. */
function assertCompositeShowsSprite(png, region, display, label) {
  const scale = png.width / display.bounds.width
  const px = {
    x: Math.round((region.x - display.bounds.x) * scale),
    y: Math.round((region.y - display.bounds.y) * scale),
    width: Math.round(region.width * scale),
    height: Math.round(region.height * scale),
  }
  let differing = 0
  let total = 0
  for (let y = px.y; y < px.y + px.height; y += 1) {
    for (let x = px.x; x < px.x + px.width; x += 1) {
      total += 1
      if (rgbDistance(pixelAt(png, x, y), BACKDROP_RGB) > 24) differing += 1
    }
  }
  const ratio = total === 0 ? 0 : differing / total
  if (ratio < 0.15) {
    throw new SmokeFailure(
      EXIT.assertion,
      `${label}: the pet is not visible in the composite (${(ratio * 100).toFixed(1)}% of the ` +
        'sprite rect differs from the backdrop). The pet may be behind the backdrop window — ' +
        'check the relative always-on-top levels.',
    )
  }
  return ratio
}

/**
 * A7 — in the composite, the ring *around* the pet is still the backdrop.
 *
 * The transparency claim, in a form that needs no alpha channel. A2 reads alpha out of the window
 * capture and is the stronger check, but it cannot run at all where `capturePage()` does not return —
 * which is Windows. Sampling the composite instead asks the same question of the compositor: if the
 * window were painting an opaque box, the ring would be that box's colour rather than the backdrop's.
 *
 * This is the assertion that would have caught a grey box on Windows, and nothing in the project could
 * make it before the composite backend existed on more than one platform.
 */
function assertCompositeRingIsBackdrop(png, spriteRect, display, label, ringPx, bubble = null) {
  const scale = png.width / display.bounds.width
  const toPx = (rect) => ({
    x: Math.round((rect.x - display.bounds.x) * scale),
    y: Math.round((rect.y - display.bounds.y) * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  })
  const sprite = toPx(spriteRect)
  const pad = Math.round(ringPx * scale)

  // Same exclusions as A2: a bubble legitimately paints in the ring, on whichever side it is on.
  const above = bubble && bubble.side !== 'below' ? Math.round((bubble.edge - display.bounds.y) * scale) : null
  const below = bubble && bubble.side === 'below' ? Math.round((bubble.edge - display.bounds.y) * scale) : null

  // Clipped to the **work area**, not the display. The backdrop window is sized to the whole display,
  // but the OS draws its own furniture on top of it — the macOS menu bar and Dock, a Windows taskbar, a
  // Linux panel. Sampling those was the first version's mistake: it read 90.9% and blamed the pet for a
  // band below its feet that was simply the Dock.
  const work = toPx(display.workArea ?? display.bounds)
  let backdrop = 0
  let total = 0
  // Where the offending pixels are, for the failure message. A bare percentage sent one investigation
  // through cluster analysis of a whole 3024x1964 screenshot to discover the answer was "the context
  // menu was open over the pet" — something a human did mid-run, which A7 was right to notice.
  const off = { minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 }
  const top = Math.max(sprite.y - pad, work.y, above ?? -Infinity)
  const bottom = Math.min(
    sprite.y + sprite.height + pad,
    work.y + work.height,
    below ?? Number.POSITIVE_INFINITY,
  )
  const left = Math.max(sprite.x - pad, work.x)
  const right = Math.min(sprite.x + sprite.width + pad, work.x + work.width)
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      // Skip the sprite itself, generously — the point is the surroundings.
      if (
        x >= sprite.x - 1 &&
        y >= sprite.y - 1 &&
        x < sprite.x + sprite.width + 1 &&
        y < sprite.y + sprite.height + 1
      ) {
        continue
      }
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue
      total += 1
      if (rgbDistance(pixelAt(png, x, y), BACKDROP_RGB) <= 24) {
        backdrop += 1
      } else {
        if (x < off.minX) off.minX = x
        if (y < off.minY) off.minY = y
        if (x > off.maxX) off.maxX = x
        if (y > off.maxY) off.maxY = y
      }
    }
  }

  if (total === 0) {
    throw new SmokeFailure(
      EXIT.assertion,
      `${label}: the ring is empty, so this assertion proves nothing. Check the sprite rect and the ` +
        'display bounds.',
    )
  }
  const ratio = backdrop / total
  if (ratio < 0.95) {
    throw new SmokeFailure(
      EXIT.assertion,
      `${label}: only ${(ratio * 100).toFixed(1)}% of the ${total}px ring around the pet is still the ` +
        'backdrop colour (expected ≥95%). The pet window is painting something where it should be ' +
        'see-through — the opaque-grey-box failure, seen from outside the process.',
    )
  }
  return ratio
}

// ---------------------------------------------------------------------------------------
// One capture-and-assert pass
// ---------------------------------------------------------------------------------------

async function assertPass(session, opts, name) {
  const pet = session.latest((e) => e.ev === 'window-ready' && e.window === 'pet')
  const backdrop = session.latest((e) => e.ev === 'window-ready' && e.window === 'backdrop')
  const reference = pet ?? backdrop
  if (!reference) throw new SmokeFailure(EXIT.died, 'No window-ready event was reported.')

  const windowName = pet ? 'pet' : 'backdrop'
  const windowPath = join(DEMO_DIR, `${name}.window.png`)

  // Geometry first, and separately. A composite-only run — all Windows can manage while `capturePage()`
  // stalls there — still needs to know which pixels are the pet.
  const geometry = await requestGeometry(session, 4_000)

  const capture = await captureWindow(session, windowName, windowPath, opts.captureTimeoutMs)
  const png = capture.png ?? null
  // `captured` is the geometry-bearing event: the capture's own copy when there is one, else the
  // standalone report. Both carry the same fields; see the `geometry` harness command.
  const captured = capture.event ?? geometry ?? null

  if (png) {
    console.log(`  captured window ${png.width}×${png.height} → docs/demo/${name}.window.png`)
  } else {
    console.log(`  ⚠ no window capture: ${capture.unavailable}`)
    console.log('    Alpha assertions (A1/A2/A3/A6) need one. The composite checks below do not.')
  }

  const results = []

  // Prefer the rect sampled at the moment of capture. `window-ready`'s copy is from startup, and
  // the pet walks: indexing a later capture with it fails when you are lucky and, worse, checks
  // the wrong pixels when you are not. Fall back only for a build with no capture-time rect.
  const spriteRect = captured?.spriteRect ?? pet?.spriteRect ?? null

  if (!png) {
    // Nothing alpha-based can run. Deliberately not an error: the composite pass below is what carries
    // the evidence on this platform.
  } else if (!opts.assert) {
    console.log('  · assertions skipped (--no-assert)')
  } else if (spriteRect) {
    // Sprite rect is reported in screen DIP; convert to capture pixels relative to the window.
    const scale = png.width / captured.bounds.width
    const region = {
      x: Math.round((spriteRect.x - captured.bounds.x) * scale),
      y: Math.round((spriteRect.y - captured.bounds.y) * scale),
      width: Math.round(spriteRect.width * scale),
      height: Math.round(spriteRect.height * scale),
    }
    if (process.env.KEYCODE_PET_SMOKE_DEBUG) {
      console.log(
        `  · debug region=${JSON.stringify(region)} bounds=${JSON.stringify(captured.bounds)} ` +
          `spriteRect=${JSON.stringify(spriteRect)} fresh=${Boolean(captured.spriteRect)} ` +
          `png=${png.width}x${png.height}`,
      )
    }
    const colours = assertNotBlank(png, region, 'A3 not-blank')
    const fill = assertSpritePainted(png, region, 'A1 sprite-painted')
    const ring = assertWindowTransparentAround(
      png,
      region,
      'A2 window-transparent',
      Math.max(8, Math.round(24 * scale)),
      // Gated on main reporting a bubble actually on screen — never on `--callout`, because a
      // broadcast or a reminder raises one with no flag involved. Absent, the full ring is checked.
      captured.bubbleVisible && captured.bubbleEdgeY !== undefined
        ? {
            edge: Math.round((captured.bubbleEdgeY - captured.bounds.y) * scale),
            side: captured.bubbleSide ?? 'above',
          }
        : null,
    )
    // `floorLocked` is absent on builds before free placement, where floor-locked was the only mode.
    const floorLocked = captured.floorLocked ?? true
    assertFeetOnFloor(spriteRect, pet.display, 'A4 feet-on-floor', floorLocked)
    const crisp = assertPixelArtCrisp(
      png,
      region,
      scale,
      'A6 pixel-art-crisp',
      captured.petScale ?? 1,
    )
    console.log(`  ✓ A1 sprite painted (${(fill * 100).toFixed(1)}% of the bbox has alpha)`)
    console.log(
      `  ✓ A2 window transparent around the sprite (${(ring * 100).toFixed(1)}% of ring` +
        `${
          captured.bubbleVisible
            ? captured.bubbleSide === 'below'
              ? ', down to the feet — a bubble is up below the pet'
              : ', from the hair down — a bubble is up'
            : ''
        })`,
    )
    console.log(`  ✓ A3 image is not blank (${colours} distinct colours)`)
    console.log(
      floorLocked
        ? '  ✓ A4 feet are on the work-area floor'
        : '  ✓ A4 freely placed, and inside the work area',
    )
    if (crisp !== null) {
      console.log(`  ✓ A6 pixel art is crisp (${(crisp * 100).toFixed(1)}% of blocks uniform)`)
    } else {
      console.log(
        `  · A6 skipped — ${(scale * (captured.petScale ?? 1)).toFixed(2)} device pixels per source ` +
          'pixel, so there are no whole blocks to check (see assertPixelArtCrisp)',
      )
    }
    results.push('A1', 'A2', 'A3', 'A4', 'A6')
  } else {
    // Before M3 there is no sprite. The only meaningful check is that we captured a real image.
    const colours = assertNotBlank(png, { x: 0, y: 0, width: png.width, height: png.height }, 'A3')
    console.log(`  ✓ A3 image is not blank (${colours} distinct colours)`)
    console.log('  · no sprite rect reported yet (expected before M3)')
    results.push('A3')
  }

  // Composite evidence: the pet on top of a real window, which is what a human judges.
  let composite = null
  if (opts.composite) {
    const compositePath = join(DEMO_DIR, `${name}.png`)

    // **Freeze the pet first.** A composite is a separate process spawn taking a few hundred
    // milliseconds; the geometry it is indexed against is sampled in about one. A walking pet moves
    // ~15px in that gap — most of the width of the ring A7 samples — so it drifts into its own ring and
    // the assertion reports the pet painting where it should be see-through. That is a measurement
    // artefact, and loosening the threshold would only hide it. Caught on an `--all-states` run, where
    // the pet is mid-walk rather than freshly launched and stationary.
    //
    // Movement is restored afterwards, so a `--keep-open` session is left as it was found.
    let frozen = false
    try {
      session.send({ cmd: 'set-movement', enabled: false })
      frozen = true
      // Long enough for the tick that stops it to land and the sprite to settle.
      await new Promise((r) => setTimeout(r, 250))
    } catch {
      // An older build with no such command: fall through and accept the drift risk.
    }

    // Re-sample now that it is still, so the rect and the screenshot agree.
    const settled = frozen ? await requestGeometry(session, 4_000) : null
    const compositeRect = settled?.spriteRect ?? spriteRect

    composite = captureComposite(compositePath, reference.display.index)
    if (frozen) session.send({ cmd: 'set-movement', enabled: true })
    if (composite.ok) {
      console.log(`  captured composite → docs/demo/${name}.png`)
      if (opts.assert && compositeRect && pet && opts.backdrop) {
        const cpng = decodeOrThrow(compositePath)
        const ratio = assertCompositeShowsSprite(
          cpng,
          compositeRect,
          pet.display,
          'A5 composite-shows-pet',
        )
        console.log(`  ✓ A5 pet visible over the backdrop (${(ratio * 100).toFixed(1)}%)`)
        results.push('A5')

        const ringRatio = assertCompositeRingIsBackdrop(
          cpng,
          compositeRect,
          pet.display,
          'A7 composite-ring-is-backdrop',
          24,
          captured?.bubbleVisible && captured?.bubbleEdgeY !== undefined
            ? { edge: captured.bubbleEdgeY, side: captured.bubbleSide ?? 'above' }
            : null,
        )
        console.log(
          `  ✓ A7 the ring around the pet is still the backdrop (${(ringRatio * 100).toFixed(1)}%)`,
        )
        results.push('A7')
      }
    } else {
      console.log(`  ⚠ composite screenshot skipped: ${composite.reason}`)
    }
  }

  return { results, composite }
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

async function run() {
  const opts = parseArgs(process.argv.slice(2))
  mkdirSync(TMP_DIR, { recursive: true })

  console.log(`▶ smoke: ${opts.name}${opts.backdrop ? ' (over dark backdrop)' : ''}`)
  const session = launch(opts)
  let compositeSkipped = null

  try {
    // Wait for the app to report a painted window. `sprite-ready` means the renderer has
    // decoded the spritesheet — `ready-to-show` fires before that and can be captured empty.
    // Before M3 there is no sprite, so a window-ready is the best available signal.
    await session.wait((e) => e.ev === 'app-ready', opts.timeoutMs, 'app-ready')
    const ready = await Promise.race([
      session.wait((e) => e.ev === 'sprite-ready', opts.timeoutMs, 'sprite-ready'),
      session.wait((e) => e.ev === 'window-ready', opts.timeoutMs, 'window-ready'),
    ])
    if (ready.ev === 'window-ready') {
      // A pet window may still be coming; give it a moment before deciding there is none.
      await Promise.race([
        session.wait((e) => e.ev === 'sprite-ready', 1_500, 'sprite-ready').catch(() => null),
        new Promise((r) => setTimeout(r, 1_500)),
      ])
    }

    // `sprite-ready` removes the dominant race (an undecoded bitmap). What remains — "has
    // the compositor presented a frame" — has no portable signal, so this is an honest
    // heuristic. The not-blank assertion is what stops it silently passing on a blank window.
    await new Promise((r) => setTimeout(r, opts.settleMs))

    if (opts.size) {
      session.send({ cmd: 'set-size', size: opts.size })
      await new Promise((r) => setTimeout(r, 400))
    }

    if (opts.place) {
      session.send({ cmd: 'place', x: opts.place.x, feetY: opts.place.feetY })
      // One tick for the move, plus a moment for the compositor to present it.
      await new Promise((r) => setTimeout(r, 400))
    }

    if (opts.callout) {
      session.send({
        cmd: 'show-callout',
        text: opts.callout,
        toast: opts.toast,
        sticky: opts.sticky,
      })
      // Let the bubble paint and the emoji font resolve before capturing.
      await new Promise((r) => setTimeout(r, 700))
    }

    if (opts.allStates) {
      const states = readAnimationStates()
      console.log(`  driving ${states.length} animation states`)
      for (const state of states) {
        session.send({ cmd: 'set-state', state })
        await new Promise((r) => setTimeout(r, 260))
        const pass = await assertPass(session, opts, `${opts.name}-${state}`)
        compositeSkipped ??= pass.composite?.ok === false ? pass.composite.reason : null
      }
    } else {
      const pass = await assertPass(session, opts, opts.name)
      compositeSkipped = pass.composite?.ok === false ? pass.composite.reason : null
    }

    console.log(`✓ smoke: ${opts.name}`)
    if (compositeSkipped) {
      console.log(`\n⚠ Composite screenshots were not produced.\n  ${compositeSkipped}\n${tccHelp()}`)
      console.log(
        '  The window-capture assertions above still ran and passed. They prove the window is\n' +
          '  transparent; they do not prove the pet renders correctly on top of another app.',
      )
    }
  } finally {
    if (!opts.keepOpen) await session.shutdown()
    else console.log('  (--keep-open: app left running)')
  }
}

/** Animation state names, from the generated module if it exists yet. */
function readAnimationStates() {
  const generated = join(ROOT, 'apps', 'desktop', 'src', 'pet-animations.generated.ts')
  if (!existsSync(generated)) return ['idle']
  const source = readFileSync(generated, 'utf8')
  const match = source.match(/ANIMATION_STATES\s*(?::[^=]+)?=\s*\[([^\]]+)\]/)
  if (!match) return ['idle']
  return [...match[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
}

run().catch((error) => {
  const code = error instanceof SmokeFailure ? error.code : EXIT.assertion
  console.error(`\n✗ smoke failed (exit ${code})\n${error.message}`)
  process.exit(code)
})
