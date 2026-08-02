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
import {
  floorForWorkArea,
  clampToFloor,
  clampFeetY,
  isOnFloor,
  bubbleSideFor,
} from './floor-placement.js'
import type { DisplayManager, Floor } from './display-manager.js'
import type { PetWindow } from './pet-window.js'
import { emit, isHarnessEnabled } from './harness-handshake.js'

export interface ActiveCallout {
  text: string
  tone: Tone
  pinned: boolean
  clickable: boolean
  /** Waits for a click rather than timing out, so the view shows a dismiss affordance. */
  dismissible: boolean
}

export interface PetControllerOptions {
  pet: PetWindow
  displays: DisplayManager
  getMovementEnabled: () => boolean
  /** `feetY` is null when the pet is floor-locked, meaning "re-derive it on launch". */
  onPositionChanged: (displayKey: string, petCentreX: number, feetY: number | null) => void
  startPetCentreX: number
  /** Restored free-placement height, or null for floor-locked. */
  startFeetY?: number | null
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
  /**
   * End a drag, deciding here whether the drop re-locks the pet to the floor.
   *
   * The rule lives with the state and the envelope rather than at the call site, so "how close to
   * the bottom counts as on the floor" has exactly one answer.
   */
  endDrag(): void
  /** Where the pet is, and whether it is floor-locked. */
  position(): { x: number; feetY: number; floorLocked: boolean }
  /**
   * Place the pet at an absolute position, as a drop would — same clamping, same snap-to-floor rule.
   *
   * Exists for the harness, which has no cursor to drag with, and is the seam that makes free
   * placement assertable from a screenshot instead of only by hand.
   */
  place(position: { x: number; feetY: number }): void
  setCallout(callout: ActiveCallout | null): void
  /**
   * Change the pet's size, keeping it where it is.
   *
   * The floor is re-derived immediately rather than at the next tick, because a smaller pet has a
   * *lower* `minFeetY` and a narrower body: without re-clamping first, a freely placed pet could sit
   * outside the envelope for a frame, and `Reset position` would compute against stale bounds.
   */
  setScale(scale: number): void
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
    feetY: options.startFeetY ?? null,
    floor: options.startFloor,
    config,
  })

  let floor = options.startFloor
  let pending: MotionTrigger[] = []
  let timer: NodeJS.Timeout | null = null
  let ticking = false
  let callout: ActiveCallout | null = null
  let forcedState: string | null = null
  let dragOrigin: { cursorX: number; cursorY: number; petCentreX: number; feetY: number } | null = null
  let lastSentFrame: string | null = null
  let lastPositionReported = {
    x: options.startPetCentreX,
    feetY: options.startFeetY ?? options.startFloor.y,
    floorLocked: (options.startFeetY ?? null) === null,
  }

  const buildFrame = (): PetFrame => {
    const animation = forcedState ?? state.animation
    return {
      animation: animation as PetFrame['animation'],
      animationNonce: state.animationNonce,
      facing: state.facing,
      sprite: pet.placement.spriteOrigin,
      scale: pet.placement.scale,
      bubbleSide: pet.placement.bubbleSide,
      bubble: callout
        ? {
            text: callout.text,
            tone: callout.tone,
            pinned: callout.pinned,
            clickable: callout.clickable,
            dismissible: callout.dismissible,
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
      // The placement is passed in because it decides both how close to the edge the pet may go
      // (body half-width) and how high it may be lifted (window height) — and both change with size.
      floor = floorForWorkArea(display.workArea, display.key, undefined, pet.placement)

      // A drag is driven from the real cursor, not from renderer coordinates. Renderer
      // screenX/screenY dies the moment mouse forwarding does, and forwarding dying mid-drag is a
      // documented failure mode on both macOS and Windows.
      if (dragOrigin) {
        const cursor = screen.getCursorScreenPoint()
        const draggedX = dragOrigin.petCentreX + (cursor.x - dragOrigin.cursorX)
        const draggedY = dragOrigin.feetY + (cursor.y - dragOrigin.cursorY)
        state = {
          ...state,
          x: clampToFloor(draggedX, floor),
          feetY: clampFeetY(draggedY, floor),
          // Unlocked for the whole drag so the pet actually follows the cursor upwards; whether it
          // re-locks is decided at drop time from where it landed.
          floorLocked: false,
        }
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

      // Before moving, not after: the bubble side changes `spriteOrigin`, and therefore what window y
      // puts the feet where the motion engine says they are. Moving first would place the window with
      // the old offset and leave the pet a band-height out of position for one frame.
      //
      // Asked every tick and a no-op almost every time — `setBubbleSide` returns early when the side
      // is unchanged, which keeps a drag from issuing a `setBounds` seventeen times a second.
      pet.setBubbleSide(
        bubbleSideFor(state.feetY, display.workArea, pet.placement.scale),
        state.x,
        state.feetY,
      )
      pet.moveTo(state.x, state.feetY)
      sendFrameIfChanged()

      // Persist position sparingly: the settings store debounces, but there is no reason to mark it
      // dirty on every one of ~17 ticks a second when the pet has barely moved. `feetY` is included
      // in the comparison because a purely vertical drag moves the pet without changing x at all.
      const movedFar =
        Math.abs(state.x - lastPositionReported.x) >= 8 ||
        Math.abs(state.feetY - lastPositionReported.feetY) >= 8 ||
        state.floorLocked !== lastPositionReported.floorLocked
      if (movedFar) {
        lastPositionReported = { x: state.x, feetY: state.feetY, floorLocked: state.floorLocked }
        // A floor-locked pet persists no y: it is re-derived on launch, so storing it could only ever
        // be a stale value fighting the correct one.
        options.onPositionChanged(
          floor.displayKey,
          state.x,
          state.floorLocked ? null : state.feetY,
        )
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
        const cursor = screen.getCursorScreenPoint()
        dragOrigin = {
          cursorX: cursor.x,
          cursorY: cursor.y,
          petCentreX: state.x,
          feetY: state.feetY,
        }
      }
      if (trigger.kind === 'drag-end') dragOrigin = null
    },

    endDrag(): void {
      // Read the live cursor rather than `state`: the drop may land between ticks, and using the
      // last tick's position drops the pet up to one tick's worth of travel away from the cursor.
      const cursor = dragOrigin ? screen.getCursorScreenPoint() : null
      const feetY =
        dragOrigin && cursor
          ? clampFeetY(dragOrigin.feetY + (cursor.y - dragOrigin.cursorY), floor)
          : state.feetY
      const petCentreX =
        dragOrigin && cursor
          ? clampToFloor(dragOrigin.petCentreX + (cursor.x - dragOrigin.cursorX), floor)
          : state.x

      this.enqueue({
        kind: 'drag-end',
        petCentreX,
        feetY,
        floorLocked: isOnFloor(feetY, floor),
      })
    },

    position(): { x: number; feetY: number; floorLocked: boolean } {
      return { x: state.x, feetY: state.feetY, floorLocked: state.floorLocked }
    },

    place(position: { x: number; feetY: number }): void {
      const feetY = clampFeetY(position.feetY, floor)
      pending.push({
        kind: 'drag-end',
        petCentreX: clampToFloor(position.x, floor),
        feetY,
        floorLocked: isOnFloor(feetY, floor),
      })
      tick()
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

    setScale(scale: number): void {
      pet.setScale(scale, state.x, state.feetY)

      // Re-derive the envelope for the new window size, then re-settle the pet inside it.
      const display = displays.nearest({ x: state.x, y: state.feetY - 1 })
      floor = floorForWorkArea(display.workArea, display.key, undefined, pet.placement)
      state = {
        ...state,
        x: clampToFloor(state.x, floor),
        feetY: state.floorLocked ? floor.maxFeetY : clampFeetY(state.feetY, floor),
      }

      // A smaller pet needs less room above it, so a size change can free up the space for the bubble
      // to go back over the head — or take it away.
      pet.setBubbleSide(
        bubbleSideFor(state.feetY, display.workArea, pet.placement.scale),
        state.x,
        state.feetY,
      )
      pet.moveTo(state.x, state.feetY)
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
