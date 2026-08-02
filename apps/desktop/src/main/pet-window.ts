/**
 * The pet window: frameless, transparent, always on top, click-through except on the character.
 *
 * This is the window the whole product is. If it has a visible edge, a shadow, or a background,
 * the illusion is gone — so every option here that looks redundant is load-bearing.
 */

import { BrowserWindow, screen } from 'electron'
import type { Rectangle } from 'electron'
import { join } from 'node:path'
import { SECURE_WEB_PREFERENCES, applyWindowSecurity } from './window-security.js'
import { startAlwaysOnTopKeeper, type AlwaysOnTopKeeper } from './always-on-top.js'
import { createForwardingController, type ForwardingController } from './mouse-forwarding.js'
import {
  computePlacement,
  placementForScale,
  windowXForPetCentre,
  windowYForFloor,
  petCentreForWindowX,
  type Placement,
} from './floor-placement.js'
import {
  ALPHA_MASK,
  bubbleBandRect,
  shapeRectsForFrame,
  spriteScreenRect,
  type BubbleSide,
} from '../sprite/alpha-mask.js'
import { IPC, petFrameSchema, type PetFrame } from '../pet-frame.js'
import { rendererFile, paths } from './paths.js'
import { emit } from './harness-handshake.js'
import type { DisplaySnapshot, Floor } from './display-manager.js'

export interface PetWindowEvents {
  onReady(): void
  onPointerOverPet(over: boolean): void
  onContextMenu(): void
  onDragStart(): void
  onDragEnd(): void
  onBubbleClicked(): void
}

export interface PetWindow {
  readonly win: BrowserWindow
  readonly placement: Placement
  /** Move so the pet's body centre sits at `petCentreX` and its feet at `feetY`. */
  moveTo(petCentreX: number, feetY: number): void
  /** Current pet-body-centre x, derived from real window bounds. */
  petCentreX(): number
  /** Send a frame to the renderer. Validated here so a bad frame never reaches the view. */
  sendFrame(frame: PetFrame): void
  /** Screen rect of the pet's visible pixels — what the harness asserts against. */
  spriteRect(): Rectangle
  /**
   * The screen y bounding where the speech bubble may paint, and which side of it that is.
   *
   * For `above` it is the current pose's topmost opaque pixel: the bubble hangs over the head with a
   * tail pointing down at it, so it can never paint at or below that line. For `below` it is the
   * pose's lowest opaque pixel and the bubble is under the feet, so it can never paint at or above it.
   *
   * Exists for the harness: the transparency assertion samples a ring around the sprite, and once
   * the bubble became a speech bubble it legitimately paints inside that ring. Without a bound the
   * assertion either fails on a run that is behaving correctly, or gets loosened into meaning
   * nothing. Derived from the same generated per-state mask entries the renderer uses, so there is no
   * second copy of the geometry to drift.
   *
   * `visible` is whether a bubble is actually on screen. The harness must not infer that from its
   * own `--callout` flag: a broadcast or a reminder puts a bubble up with no flag involved, and the
   * assertion would then measure the bubble and report a transparency failure.
   */
  bubbleBand(): { y: number; side: BubbleSide; visible: boolean }
  /**
   * Change the pet's size.
   *
   * Resizes the window and re-derives the placement, then keeps the pet where it was: the body's
   * centre-x and its feet stay put, because a size change that also teleports the pet reads as a bug.
   * Returns the new placement so the caller can push a frame carrying the new scale.
   *
   * `setShape` is re-applied because the input region is in window coordinates and the window just
   * changed size — on Linux a stale shape leaves the pet grabbable in the wrong place.
   */
  setScale(scale: number, petCentreX: number, feetY: number): Placement
  /**
   * Move the bubble's reserved band to the other end of the window, keeping the pet where it is.
   *
   * Visually silent when nothing is on screen but the pet: the window keeps its size and the sprite
   * keeps its screen pixels, so only the invisible window rect moves. Returns the placement in force
   * so the caller can push a frame carrying the new sprite origin.
   */
  setBubbleSide(side: BubbleSide, petCentreX: number, feetY: number): Placement
  reassertAlwaysOnTop(): void
  /**
   * Turn the on-top behaviour on or off. Off is a real "behind other windows", not a weaker level.
   *
   * A callout still raises the pet for as long as it is on screen — see `sendFrame`.
   */
  setAlwaysOnTopEnabled(enabled: boolean): void
  setDragging(active: boolean): void
  emitWindowReady(display: DisplaySnapshot): void
  dispose(): void
}

export async function createPetWindow(options: {
  initialFloor: Floor
  initialPetCentreX: number
  /** Restored free-placement height, or null to start on the floor. */
  initialFeetY?: number | null
  initialScale?: number
  /**
   * Which side the bubble starts on. Passed in rather than derived, because deciding it needs the
   * work area and the caller already has the display.
   *
   * It matters at launch and not only later: a pet restored to a free placement near the top of the
   * screen would otherwise be created with the band above it, and the first controller tick would
   * move the window — a visible jump on startup for the one placement that most needs to look
   * deliberate.
   */
  initialBubbleSide?: BubbleSide
  /** Whether the pet starts in front of everything. Default true. */
  alwaysOnTop?: boolean
  events: PetWindowEvents
  log?: (message: string, meta?: unknown) => void
}): Promise<PetWindow> {
  const log = options.log ?? (() => {})
  // Mutable: changing the pet's size or the bubble's side re-derives the whole placement.
  let placement = placementForScale(
    options.initialScale ?? 1,
    ALPHA_MASK,
    options.initialBubbleSide ?? 'above',
  )

  const x = windowXForPetCentre(options.initialPetCentreX, placement)
  const y = windowYForFloor(options.initialFeetY ?? options.initialFloor.y, placement)

  const win = new BrowserWindow({
    x,
    y,
    width: placement.windowSize.width,
    height: placement.windowSize.height,
    frame: false,
    transparent: true,
    // Without this the compositor may composite an opaque backing store: the grey box.
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: options.alwaysOnTop ?? true,
    // Linux compositors otherwise treat the overlay as a normal focusable toplevel and let it
    // steal focus. Nothing in the pet window needs keyboard input.
    focusable: process.platform !== 'linux',
    show: false,
    acceptFirstMouse: true,
    title: 'Keycode Pet',
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: join(paths.distDir, 'preload', 'pet-preload.cjs'),
    },
  })

  applyWindowSecurity(win, 'pet')

  let keeper: AlwaysOnTopKeeper | null = null
  /** Last animation sent, so the bubble band can use the right per-state head top and foot inset. */
  let lastAnimation: string | null = null
  /** Whether the last frame carried a bubble. Drives the shape region and the callout raise. */
  let lastBubbleVisible = false
  /** Whether the last frame carried a CSS overlay — the sleep Z's. Drives the shape region. */
  let lastOverlayVisible = false

  /**
   * The Linux input-and-drawing region for what is currently on screen.
   *
   * Recomputed rather than fixed because `setShape` clips *drawing*: a region covering only the
   * character means the speech bubble and the sleep Z's are never painted at all on Linux. See
   * `shapeRectsForFrame`.
   */
  const currentShapeRects = (): readonly Rectangle[] =>
    shapeRectsForFrame(
      ALPHA_MASK,
      {
        spriteOrigin: placement.spriteOrigin,
        scale: placement.scale,
        windowWidth: placement.windowSize.width,
        windowHeight: placement.windowSize.height,
      },
      {
        animation: lastAnimation ?? 'idle',
        bubbleVisible: lastBubbleVisible,
        overlayVisible: lastOverlayVisible,
        bubbleSide: placement.bubbleSide,
      },
    )

  const forwarding = createForwardingController(win, {
    shapeRects: currentShapeRects(),
    log,
  })

  // ---- IPC from the renderer. Every handler checks provenance: a message from another
  // webContents has no business steering the pet window.
  const isFromThisWindow = (event: Electron.IpcMainEvent): boolean =>
    !win.isDestroyed() && event.sender === win.webContents

  const { ipcMain } = await import('electron')

  const onPointerOverPet = (event: Electron.IpcMainEvent, over: unknown): void => {
    if (!isFromThisWindow(event)) return
    const value = Boolean(over)
    forwarding.setPointerOverPet(value)
    options.events.onPointerOverPet(value)
  }

  const onReady = (event: Electron.IpcMainEvent): void => {
    if (!isFromThisWindow(event)) return
    options.events.onReady()
  }

  const onContextMenu = (event: Electron.IpcMainEvent): void => {
    if (!isFromThisWindow(event)) return
    options.events.onContextMenu()
  }

  const onDragStart = (event: Electron.IpcMainEvent): void => {
    if (!isFromThisWindow(event)) return
    options.events.onDragStart()
  }

  const onDragEnd = (event: Electron.IpcMainEvent): void => {
    if (!isFromThisWindow(event)) return
    options.events.onDragEnd()
  }

  const onBubbleClicked = (event: Electron.IpcMainEvent): void => {
    if (!isFromThisWindow(event)) return
    options.events.onBubbleClicked()
  }

  ipcMain.on(IPC.pointerOverPet, onPointerOverPet)
  ipcMain.on(IPC.rendererReady, onReady)
  ipcMain.on(IPC.contextMenu, onContextMenu)
  ipcMain.on(IPC.dragStart, onDragStart)
  ipcMain.on(IPC.dragEnd, onDragEnd)
  ipcMain.on(IPC.bubbleClicked, onBubbleClicked)

  win.webContents.on('did-finish-load', () => {
    forwarding.afterNavigate()
  })

  await win.loadFile(rendererFile('pet.html'))

  // `showInactive` rather than `show`: the pet must never take focus from what the user is doing.
  win.showInactive()
  keeper = startAlwaysOnTopKeeper(win, { enabled: options.alwaysOnTop ?? true })
  forwarding.onShown()

  const petWindow: PetWindow = {
    win,

    // A GETTER, not `placement,`. Writing the property once copies the reference that existed at
    // construction, so `setScale` reassigning the local `placement` would leave every consumer —
    // the controller's frame, the sprite rect, the floor envelope — reading the original scale
    // forever. That is not theoretical: it shipped for the length of one screenshot run, where the
    // renderer painted a resized pet while main still described the old one, and A1 caught it as
    // "only 10.8% of the sprite rect has alpha".
    get placement(): Placement {
      return placement
    },

    moveTo(petCentreX: number, feetY: number): void {
      if (win.isDestroyed()) return
      const nextX = windowXForPetCentre(petCentreX, placement)
      const nextY = windowYForFloor(feetY, placement)
      const bounds = win.getBounds()
      // Never issue a no-op: some compositors do real work per setPosition even when nothing moves.
      if (bounds.x === nextX && bounds.y === nextY) return
      win.setPosition(nextX, nextY, false)
    },

    petCentreX(): number {
      if (win.isDestroyed()) return options.initialPetCentreX
      return petCentreForWindowX(win.getBounds().x, placement)
    },

    sendFrame(frame: PetFrame): void {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      // Validated on the way out as well as on the way in. The renderer is the last place a bad
      // animation name could produce a silently invisible pet.
      const parsed = petFrameSchema.safeParse(frame)
      if (!parsed.success) {
        emit({
          ev: 'error',
          where: 'pet-window:send-frame',
          message: parsed.error.issues[0]?.message ?? 'invalid frame',
        })
        return
      }
      const previous = { lastAnimation, lastBubbleVisible, lastOverlayVisible }
      lastAnimation = parsed.data.animation
      lastBubbleVisible = parsed.data.bubble !== null
      lastOverlayVisible = parsed.data.overlay !== 'none'
      win.webContents.send(IPC.frame, parsed.data)

      // On Linux the shape region decides what gets *painted*, so it has to follow the frame: the
      // bubble band belongs in it only while a bubble is up, and the pose changes where that band
      // ends. Guarded on an actual change — this runs on every animation assignment, and `setShape`
      // is an X server round trip.
      if (
        previous.lastAnimation !== lastAnimation ||
        previous.lastBubbleVisible !== lastBubbleVisible ||
        previous.lastOverlayVisible !== lastOverlayVisible
      ) {
        forwarding.setShapeRects(currentShapeRects())
      }

      // A pet the user has sent behind their windows still has to be able to say something. Doing it
      // here rather than at each call site is what makes it cover reminders, broadcasts and update
      // announcements alike: this is the one place that knows whether a bubble is on screen, so the
      // raise cannot drift out of sync with what is actually visible.
      if (previous.lastBubbleVisible !== lastBubbleVisible) {
        keeper?.raiseForCallout(lastBubbleVisible)
      }
    },

    spriteRect(): Rectangle {
      const bounds = win.isDestroyed() ? { x, y } : win.getBounds()
      return spriteScreenRect(ALPHA_MASK, bounds, placement.spriteOrigin, placement.scale) as Rectangle
    },

    bubbleBand(): { y: number; side: BubbleSide; visible: boolean } {
      const bounds = win.isDestroyed() ? { x, y } : win.getBounds()
      const band = bubbleBandRect(
        ALPHA_MASK,
        {
          spriteOrigin: placement.spriteOrigin,
          scale: placement.scale,
          windowWidth: placement.windowSize.width,
          windowHeight: placement.windowSize.height,
        },
        lastAnimation ?? 'idle',
        placement.bubbleSide,
      )
      return {
        // The band's inner edge — the head top for `above`, the feet for `below`. Both are the line
        // the bubble cannot cross, which is the only thing the harness needs from it.
        y: bounds.y + (placement.bubbleSide === 'below' ? band.y : band.height),
        side: placement.bubbleSide,
        visible: lastBubbleVisible,
      }
    },

    setScale(scale: number, petCentreX: number, feetY: number): Placement {
      if (win.isDestroyed()) return placement
      if (scale === placement.scale) return placement

      placement = placementForScale(scale, ALPHA_MASK, placement.bubbleSide)
      const nextX = windowXForPetCentre(petCentreX, placement)
      const nextY = windowYForFloor(feetY, placement)

      // setBounds in one call rather than setSize + setPosition: two calls make the window visibly
      // jump through an intermediate rectangle at the old position.
      win.setBounds({
        x: nextX,
        y: nextY,
        width: placement.windowSize.width,
        height: placement.windowSize.height,
      })

      forwarding.setShapeRects(currentShapeRects())
      log('pet size changed', { scale, height: placement.windowSize.height })
      return placement
    },

    setBubbleSide(side: BubbleSide, petCentreX: number, feetY: number): Placement {
      if (win.isDestroyed()) return placement
      // The controller asks on every tick, so the early return is what stops a drag issuing a
      // `setBounds` and a `setShape` seventeen times a second.
      if (side === placement.bubbleSide) return placement

      placement = placementForScale(placement.scale, ALPHA_MASK, side)
      // The window keeps its size; only which end of it is reserved changes, so this moves the window
      // by exactly the band height and leaves the sprite on the same screen pixels.
      win.setPosition(windowXForPetCentre(petCentreX, placement), windowYForFloor(feetY, placement), false)
      forwarding.setShapeRects(currentShapeRects())
      log('bubble side changed', { side, feetY })
      return placement
    },

    reassertAlwaysOnTop(): void {
      keeper?.reassert()
    },

    setAlwaysOnTopEnabled(enabled: boolean): void {
      keeper?.setEnabled(enabled)
    },

    setDragging(active: boolean): void {
      forwarding.setDragging(active)
    },

    emitWindowReady(display: DisplaySnapshot): void {
      if (win.isDestroyed()) return
      emit({
        ev: 'window-ready',
        window: 'pet',
        bounds: win.getContentBounds(),
        display: {
          index: display.index,
          key: display.key,
          scaleFactor: display.scaleFactor,
          bounds: display.bounds,
          workArea: display.workArea,
        },
        spriteRect: petWindow.spriteRect(),
      })
    },

    dispose(): void {
      ipcMain.removeListener(IPC.pointerOverPet, onPointerOverPet)
      ipcMain.removeListener(IPC.rendererReady, onReady)
      ipcMain.removeListener(IPC.contextMenu, onContextMenu)
      ipcMain.removeListener(IPC.dragStart, onDragStart)
      ipcMain.removeListener(IPC.dragEnd, onDragEnd)
      ipcMain.removeListener(IPC.bubbleClicked, onBubbleClicked)
      forwarding.dispose()
      keeper?.dispose()
      if (!win.isDestroyed()) win.destroy()
    },
  }

  return petWindow
}

/** Cursor position, for drag tracking. Keeps working when forwarded mouse events do not. */
export function cursorPoint(): { x: number; y: number } {
  return screen.getCursorScreenPoint()
}
