/**
 * Harness control channel — newline-delimited JSON commands on **stdin**.
 *
 * The handshake (stdout) reports what the app is doing; this reports back what we want it
 * to do. stdin was chosen for the same reasons as stdout: no port, no cleanup, identical
 * in CI, and it dies with the process.
 *
 * Why this exists at all: two of the harness's jobs cannot be done from outside the process.
 *
 *  1. **`capturePage()` needs no Screen Recording permission.** `screencapture` does, and a
 *     TCC grant is not something CI or a fresh machine has. `capturePage` renders the
 *     window in-process *with its alpha channel*, which is a strictly better signal for
 *     "are this window's own pixels transparent" than sampling a composite ever was.
 *     The composite screenshot is still taken when permitted — it is the evidence a human
 *     looks at — but the automated assertions no longer depend on it.
 *
 *  2. **Driving the pet through every animation state** without relaunching the app ten
 *     times, which would take ten times as long and prove less.
 *
 * Every command is gated on `KEYCODE_PET_SMOKE=1`.
 */

import { writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { emit, isHarnessEnabled } from './harness-handshake.js'

export type HarnessCommand =
  | { cmd: 'capture-window'; path: string; window: 'pet' | 'backdrop' }
  | { cmd: 'set-state'; state: string }
  /** Show a callout, so the bubble and the emoji font can be screenshotted. */
  | { cmd: 'show-callout'; text: string; tone?: string; priority?: string; toast?: boolean; sticky?: boolean }
  /**
   * Place the pet, as a drag would.
   *
   * Not a synthetic mouse drag: the harness has no cursor control, and `screen.getCursorScreenPoint`
   * is what a real drag follows. This drives the same `place` path the drop handler ends at, so what
   * it proves is the placement and clamping logic — not the pointer plumbing, which stays manual.
   */
  | { cmd: 'place'; x: number; feetY: number }
  /** Change the pet's size, so each one can be screenshotted without relaunching. */
  | { cmd: 'set-size'; size: string }
  /**
   * Report where the pet is *right now*, without capturing anything.
   *
   * Everything `capture-written` carries except the image. It exists because those two facts were
   * welded together, and on a Windows runner `capturePage()` does not return: the harness timed out
   * waiting for it and every assertion went unrun, on an app that was demonstrably alive and emitting
   * frames. Asking where the pet is should not depend on being able to photograph it — and a composite
   * screenshot taken from outside the process needs the geometry, not the window's own pixels.
   */
  | { cmd: 'geometry' }
  /**
   * Stop or start the pet walking.
   *
   * Needed because a **composite** screenshot is a separate process spawn that takes a few hundred
   * milliseconds, while the geometry it is indexed against is sampled in about a millisecond. A walking
   * pet moves ~15px in that gap, which is most of the width of the ring A7 samples — so the pet drifts
   * into its own ring and the assertion reports the pet painting where it should be see-through. That
   * is a measurement artefact, and no threshold fixes it honestly.
   *
   * The in-process window capture does not need this: it and its geometry come from the same instant.
   */
  | { cmd: 'set-movement'; enabled: boolean }
  | { cmd: 'quit' }

export interface HarnessTargets {
  pet: () => BrowserWindow | null
  backdrop: () => BrowserWindow | null
  /** Pin the pet to one animation state. Provided from M3 onward. */
  setForcedState?: (state: string) => void
  /** Show a callout. Provided from M5 onward. */
  showCallout?: (request: { text: string; tone?: string; priority?: string; toast?: boolean; sticky?: boolean }) => void
  /**
   * The sprite's screen rect *right now*.
   *
   * Reported alongside every capture rather than only once at `window-ready`, because the pet
   * moves. A rect sampled at startup and used to index a capture taken seconds later points at
   * whatever the pet has since walked away from — which fails the pixel assertions when you are
   * lucky and passes them against the wrong pixels when you are not.
   */
  spriteRect?: () => { x: number; y: number; width: number; height: number }
  /** The line the speech bubble cannot cross, and which side of the pet it is on. See
   * PetWindow.bubbleBand. */
  bubbleBand?: () => { y: number; side: 'above' | 'below'; visible: boolean }
  /** Whether the pet is floor-locked, so the harness knows if feet-on-floor is assertable. */
  floorLocked?: () => boolean
  /** Place the pet at an absolute position, as a drop would. */
  place?: (position: { x: number; feetY: number }) => void
  /** Change the pet's size. */
  setSize?: (size: string) => void
  /** Stop or start the pet walking, so a composite capture can be correlated with a geometry sample. */
  setMovement?: (enabled: boolean) => void
  /** The sprite's current CSS scale, which decides whether the crispness assertion is meaningful. */
  petScale?: () => number
}

export function installHarnessControl(targets: HarnessTargets): () => void {
  if (!isHarnessEnabled()) return () => {}

  let buffer = ''

  const handle = async (command: HarnessCommand): Promise<void> => {
    switch (command.cmd) {
      case 'capture-window': {
        const win = command.window === 'pet' ? targets.pet() : targets.backdrop()
        if (!win || win.isDestroyed()) {
          emit({
            ev: 'error',
            where: 'harness:capture-window',
            message: `no ${command.window} window`,
          })
          emit({ ev: 'capture-failed', path: command.path, reason: 'no-window' })
          return
        }
        try {
          // No rect argument: capture the whole window, including the transparent margin.
          // That margin is precisely what the transparency assertion needs to inspect.
          const image = await win.webContents.capturePage()
          mkdirSync(dirname(command.path), { recursive: true })
          await writeFile(command.path, image.toPNG())
          const size = image.getSize()
          const isPet = command.window === 'pet'
          const rect = isPet ? targets.spriteRect?.() : undefined
          const bubble = isPet ? targets.bubbleBand?.() : undefined
          const floorLocked = isPet ? targets.floorLocked?.() : undefined
          const petScale = isPet ? targets.petScale?.() : undefined
          emit({
            ev: 'capture-written',
            path: command.path,
            window: command.window,
            width: size.width,
            height: size.height,
            bounds: win.getContentBounds(),
            ...(rect ? { spriteRect: rect } : {}),
            ...(bubble === undefined
              ? {}
              : { bubbleEdgeY: bubble.y, bubbleSide: bubble.side, bubbleVisible: bubble.visible }),
            ...(floorLocked === undefined ? {} : { floorLocked }),
            ...(petScale === undefined ? {} : { petScale }),
          })
        } catch (error) {
          emit({
            ev: 'capture-failed',
            path: command.path,
            reason: String((error as Error)?.message ?? error),
          })
        }
        return
      }

      case 'set-state': {
        if (!targets.setForcedState) {
          emit({ ev: 'error', where: 'harness:set-state', message: 'no state sink registered' })
          return
        }
        targets.setForcedState(command.state)
        return
      }

      case 'show-callout': {
        if (!targets.showCallout) {
          emit({ ev: 'error', where: 'harness:show-callout', message: 'no callout sink registered' })
          return
        }
        targets.showCallout({
          text: command.text,
          ...(command.tone === undefined ? {} : { tone: command.tone }),
          ...(command.priority === undefined ? {} : { priority: command.priority }),
          ...(command.toast === undefined ? {} : { toast: command.toast }),
          ...(command.sticky === undefined ? {} : { sticky: command.sticky }),
        })
        return
      }

      case 'place': {
        if (!targets.place) {
          emit({ ev: 'error', where: 'harness:place', message: 'no place sink registered' })
          return
        }
        targets.place({ x: command.x, feetY: command.feetY })
        return
      }

      case 'set-size': {
        if (!targets.setSize) {
          emit({ ev: 'error', where: 'harness:set-size', message: 'no size sink registered' })
          return
        }
        targets.setSize(command.size)
        return
      }

      case 'set-movement': {
        if (!targets.setMovement) {
          emit({ ev: 'error', where: 'harness:set-movement', message: 'no movement sink registered' })
          return
        }
        targets.setMovement(command.enabled)
        return
      }

      case 'geometry': {
        const win = targets.pet()
        if (!win || win.isDestroyed()) {
          emit({ ev: 'error', where: 'harness:geometry', message: 'no pet window' })
          return
        }
        const bubble = targets.bubbleBand?.()
        emit({
          ev: 'geometry',
          bounds: win.getContentBounds(),
          ...(targets.spriteRect ? { spriteRect: targets.spriteRect() } : {}),
          ...(targets.floorLocked ? { floorLocked: targets.floorLocked() } : {}),
          ...(targets.petScale ? { petScale: targets.petScale() } : {}),
          ...(bubble === undefined
            ? {}
            : { bubbleEdgeY: bubble.y, bubbleSide: bubble.side, bubbleVisible: bubble.visible }),
        })
        return
      }

      case 'quit': {
        app.quit()
        return
      }
    }
  }

  const onData = (chunk: Buffer | string): void => {
    buffer += String(chunk)
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let command: HarnessCommand
      try {
        command = JSON.parse(trimmed) as HarnessCommand
      } catch {
        emit({ ev: 'error', where: 'harness:stdin', message: `unparseable: ${trimmed.slice(0, 80)}` })
        continue
      }
      void handle(command)
    }
  }

  process.stdin.on('data', onData)
  process.stdin.resume()

  return () => {
    process.stdin.off('data', onData)
    process.stdin.pause()
  }
}
