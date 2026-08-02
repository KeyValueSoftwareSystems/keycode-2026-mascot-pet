/**
 * Harness handshake — a one-line-per-event JSONL protocol on stdout.
 *
 * The smoke harness is a plain `child_process.spawn` of the Electron binary, so it needs
 * to learn when a window is up, where the sprite landed, and which display to capture.
 * stdout was chosen over a socket or Electron IPC because it needs no port, no cleanup,
 * and behaves identically in CI.
 *
 * Every emit is gated on `KEYCODE_PET_SMOKE=1`, so a packaged app writes nothing at all.
 */

export const HANDSHAKE_PREFIX = '@@KEYCODE@@'

export interface HandshakeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface HandshakeDisplay {
  /** Ordinal in `screen.getAllDisplays()`. `screencapture -D` is 1-based, so the harness adds 1. */
  index: number
  key: string
  scaleFactor: number
  bounds: HandshakeRect
  workArea: HandshakeRect
}

export type HandshakeEvent =
  | { ev: 'app-ready'; pid: number; version: string; platform: string }
  | {
      ev: 'window-ready'
      window: 'pet' | 'backdrop'
      bounds: HandshakeRect
      display: HandshakeDisplay
      /** Screen-space rect of the sprite's visible pixels. Absent until the mask exists (M3). */
      spriteRect?: HandshakeRect
    }
  | { ev: 'sprite-ready'; window: 'pet' }
  | { ev: 'frame'; animation: string; nonce: 0 | 1; facing: 'left' | 'right' }
  | { ev: 'second-instance' }
  /**
   * An in-process `capturePage()` PNG was written. This is the capture the automated
   * assertions read: it preserves the window's alpha channel and needs no Screen Recording
   * permission, so it works in CI and on a fresh machine.
   */
  | {
      ev: 'capture-written'
      path: string
      window: 'pet' | 'backdrop'
      width: number
      height: number
      bounds: HandshakeRect
      /**
       * The sprite rect at the instant of capture, so the assertions index the pixels that are
       * actually in this image rather than where the pet was at startup. Pet window only.
       */
      spriteRect?: HandshakeRect
      /**
       * The screen y no speech-bubble pixel can cross: the head top when the bubble is above the
       * pet, the feet when it is below. Pet window only.
       */
      bubbleEdgeY?: number
      /** Which side of the pet the bubble is anchored on. Pet window only. */
      bubbleSide?: 'above' | 'below'
      /** Whether a bubble was actually on screen for this capture. Pet window only. */
      bubbleVisible?: boolean
      /**
       * Whether the pet is sitting on the floor. False means it has been freely placed, in which
       * case asserting feet-on-floor would fail on correct behaviour.
       */
      floorLocked?: boolean
      /** Sprite CSS scale, so the crispness assertion knows its own block size. */
      petScale?: number
    }
  | { ev: 'capture-failed'; path: string; reason: string }
  | { ev: 'error'; where: string; message: string }

let enabled: boolean | null = null

/** Cached so a hot path does not re-read `process.env` on every frame. */
export function isHarnessEnabled(): boolean {
  if (enabled === null) enabled = process.env.KEYCODE_PET_SMOKE === '1'
  return enabled
}

export function emit(event: HandshakeEvent): void {
  if (!isHarnessEnabled()) return
  try {
    process.stdout.write(`${HANDSHAKE_PREFIX}${JSON.stringify(event)}\n`)
  } catch {
    // stdout can be closed if the harness died first. Never let telemetry take the app down.
  }
}

/** Parse one stdout line. Returns null for ordinary log output. */
export function parseHandshakeLine(line: string): HandshakeEvent | null {
  const at = line.indexOf(HANDSHAKE_PREFIX)
  if (at === -1) return null
  try {
    return JSON.parse(line.slice(at + HANDSHAKE_PREFIX.length)) as HandshakeEvent
  } catch {
    return null
  }
}
