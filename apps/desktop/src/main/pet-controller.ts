/**
 * The controller: the only impure owner of motion.
 *
 * It holds the app's single `setInterval`, feeds the pure engine a clock and the current screen
 * geometry, and turns the resulting state into a window position and a `PetFrame`.
 *
 * ---------------------------------------------------------------------------------------
 * Two clocks, deliberately unsynchronised.
 * ---------------------------------------------------------------------------------------
 *
 *   Window motion — this 60ms tick, integer-pixel steps, in main.
 *   Sprite frames  — each state's own duration, stepped by CSS, in the renderer.
 *
 * Moving a window on every animation frame stutters some compositors; stepping the sprite from main
 * would mean an IPC message per frame. Each clock lives where it is cheap. The only coupling is
 * that a *state change* is pushed over IPC, which happens a few times a second at most.
 */

import { screen } from 'electron'
import { advance, initialState } from '../motion/motion-engine.js'
import { DEFAULT_MOTION_CONFIG, type MotionConfig } from '../motion/motion-config.js'
import type { MotionState, MotionTrigger } from '../motion/types.js'
import { resolveTrigger, type Trigger } from '../pet-animations.generated.js'
import type { PetFrame, Tone } from '../pet-frame.js'
import { floorForWorkArea } from './floor-placement.js'
import type { DisplayManager, Floor } from './display-manager.js'
import type { PetWindow } from './pet-window.js'
import { emit, isHarnessEnabled } from './harness-handshake.js'

export interface ActiveCallout {
  text: string
  tone: Tone
  pinned: boolean
  clickable: boolean
}

export interface PetControllerOptions {
  pet: PetWindow
  displays: DisplayManager
  getMovementEnabled: () => boolean
  onPositionChanged: (displayKey: string, petCentreX: number) => void
  startPetCentreX: number
  startFloor: Floor
  seed: number
  config?: MotionConfig
  /** Injected so tests can drive the controller without a real clock. */
  now?: () => number
  log?: (message: string, meta?: unknown) => void
}

export interface PetController {
  start(): void
  stop(): void
  /** Queue a trigger for the next tick. */
  enqueue(trigger: MotionTrigger): void
  /** Queue a reaction by trigger name, resolved through the spritesheet's reaction map. */
  react(trigger: Trigger): void
  /**
   * Run the tick body now, out of phase, without resetting the interval.
   *
   * This is what makes a menu toggle take effect mid-stride rather than at the next tick boundary.
   */
  tickNow(): void
  setCallout(callout: ActiveCallout | null): void
  /** Pin an animation, for the smoke harness. */
  setForcedState(animation: string | null): void
  petCentreX(): number
  currentFloor(): Floor
}

export function createPetController(options: PetControllerOptions): PetController {
  const config = options.config ?? DEFAULT_MOTION_CONFIG
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const { pet, displays } = options

  let state: MotionState = initialState({
    seed: options.seed,
    x: options.startPetCentreX,
    now: now(),
    movementEnabled: options.getMovementEnabled(),
    config,
  })

  let floor = options.startFloor
  let pending: MotionTrigger[] = []
  let timer: NodeJS.Timeout | null = null
  let ticking = false
  let callout: ActiveCallout | null = null
  let forcedState: string | null = null
  let dragOrigin: { cursorX: number; petCentreX: number } | null = null
  let lastSentFrame: string | null = null
  let lastPositionReported = options.startPetCentreX

  const buildFrame = (): PetFrame => {
    const animation = forcedState ?? state.animation
    return {
      animation: animation as PetFrame['animation'],
      animationNonce: state.animationNonce,
      facing: state.facing,
      sprite: pet.placement.spriteOrigin,
      bubble: callout
        ? {
            text: callout.text,
            tone: callout.tone,
            pinned: callout.pinned,
            clickable: callout.clickable,
          }
        : null,
      overlay: animation === config.sleepAnimation ? 'sleep-z' : 'none',
    }
  }

  /** Only push a frame when something the renderer cares about actually changed. */
  const sendFrameIfChanged = (): void => {
    const frame = buildFrame()
    const signature = JSON.stringify(frame)
    if (signature === lastSentFrame) return
    lastSentFrame = signature
    pet.sendFrame(frame)
    if (isHarnessEnabled()) {
      emit({
        ev: 'frame',
        animation: frame.animation,
        nonce: frame.animationNonce,
        facing: frame.facing,
      })
    }
  }

  const tick = (): void => {
    // Re-entrancy guard: `tickNow()` can fire while the interval's tick is mid-flight.
    if (ticking) return
    ticking = true
    try {
      const timestamp = now()

      // Recompute the floor every tick from the display nearest the pet. Cheap (the display list is
      // cached) and it is what makes a monitor unplug or a Dock resize self-correcting rather than
      // needing its own recovery path.
      const display = displays.nearest({ x: state.x, y: floor.y - 1 })
      floor = floorForWorkArea(display.workArea, display.key)

      // A drag is driven from the real cursor, not from renderer coordinates. Renderer
      // screenX/screenY dies the moment mouse forwarding does, and forwarding dying mid-drag is a
      // documented failure mode on both macOS and Windows.
      if (dragOrigin) {
        const cursor = screen.getCursorScreenPoint()
        const dragged = dragOrigin.petCentreX + (cursor.x - dragOrigin.cursorX)
        state = { ...state, x: Math.min(floor.maxX, Math.max(floor.minX, dragged)) }
      }

      const drained = pending
      pending = []

      state = advance(
        state,
        {
          now: timestamp,
          floor,
          settings: { movementEnabled: options.getMovementEnabled() },
          pending: drained,
        },
        config,
      )

      pet.moveTo(state.x, floor)
      sendFrameIfChanged()

      // Persist position sparingly: the settings store debounces, but there is no reason to mark it
      // dirty on every one of ~17 ticks a second when the pet has barely moved.
      if (Math.abs(state.x - lastPositionReported) >= 8) {
        lastPositionReported = state.x
        options.onPositionChanged(floor.displayKey, state.x)
      }
    } catch (error) {
      // A throw here would kill the interval and freeze the pet forever. Log and keep ticking.
      log('motion tick failed', { error: String(error) })
      emit({ ev: 'error', where: 'pet-controller:tick', message: String(error) })
    } finally {
      ticking = false
    }
  }

  return {
    start(): void {
      if (timer) return
      timer = setInterval(tick, config.tickMs)
      timer.unref?.()
      sendFrameIfChanged()
    },

    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    },

    enqueue(trigger: MotionTrigger): void {
      pending.push(trigger)
      if (trigger.kind === 'drag-start') {
        dragOrigin = {
          cursorX: screen.getCursorScreenPoint().x,
          petCentreX: state.x,
        }
      }
      if (trigger.kind === 'drag-end') dragOrigin = null
    },

    react(trigger: Trigger): void {
      pending.push({ kind: 'reaction', state: resolveTrigger(trigger) })
    },

    tickNow(): void {
      tick()
    },

    setCallout(next: ActiveCallout | null): void {
      callout = next
      sendFrameIfChanged()
    },

    setForcedState(animation: string | null): void {
      forcedState = animation
      // Advance the nonce so re-selecting the same state still restarts its animation — the
      // mechanism `smoke:states` exercises when it walks every state in one launch.
      state = { ...state, animationNonce: state.animationNonce === 0 ? 1 : 0 }
      sendFrameIfChanged()
    },

    petCentreX(): number {
      return state.x
    },

    currentFloor(): Floor {
      return floor
    },
  }
}
