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
  windowXForPetCentre,
  windowYForFloor,
  petCentreForWindowX,
  type Placement,
} from './floor-placement.js'
import { ALPHA_MASK, shapeRectsForWindow, spriteScreenRect } from '../sprite/alpha-mask.js'
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
  onOpenCalloutUrl(): void
}

export interface PetWindow {
  readonly win: BrowserWindow
  readonly placement: Placement
  /** Move so the pet's body centre sits at `petCentreX` on `floor`. */
  moveTo(petCentreX: number, floor: Floor): void
  /** Current pet-body-centre x, derived from real window bounds. */
  petCentreX(): number
  /** Send a frame to the renderer. Validated here so a bad frame never reaches the view. */
  sendFrame(frame: PetFrame): void
  /** Screen rect of the pet's visible pixels — what the harness asserts against. */
  spriteRect(): Rectangle
  reassertAlwaysOnTop(): void
  setDragging(active: boolean): void
  emitWindowReady(display: DisplaySnapshot): void
  dispose(): void
}

export async function createPetWindow(options: {
  initialFloor: Floor
  initialPetCentreX: number
  events: PetWindowEvents
  log?: (message: string, meta?: unknown) => void
}): Promise<PetWindow> {
  const log = options.log ?? (() => {})
  const placement = computePlacement()

  const x = windowXForPetCentre(options.initialPetCentreX, placement)
  const y = windowYForFloor(options.initialFloor.y, placement)

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
    alwaysOnTop: true,
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

  const shapeRects = shapeRectsForWindow(ALPHA_MASK, placement.spriteOrigin)
  const forwarding = createForwardingController(win, { shapeRects, log })
  let keeper: AlwaysOnTopKeeper | null = null

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

  const onOpenCalloutUrl = (event: Electron.IpcMainEvent): void => {
    if (!isFromThisWindow(event)) return
    options.events.onOpenCalloutUrl()
  }

  ipcMain.on(IPC.pointerOverPet, onPointerOverPet)
  ipcMain.on(IPC.rendererReady, onReady)
  ipcMain.on(IPC.contextMenu, onContextMenu)
  ipcMain.on(IPC.dragStart, onDragStart)
  ipcMain.on(IPC.dragEnd, onDragEnd)
  ipcMain.on(IPC.openCalloutUrl, onOpenCalloutUrl)

  win.webContents.on('did-finish-load', () => {
    forwarding.afterNavigate()
  })

  await win.loadFile(rendererFile('pet.html'))

  // `showInactive` rather than `show`: the pet must never take focus from what the user is doing.
  win.showInactive()
  keeper = startAlwaysOnTopKeeper(win)
  forwarding.onShown()

  const petWindow: PetWindow = {
    win,
    placement,

    moveTo(petCentreX: number, floor: Floor): void {
      if (win.isDestroyed()) return
      const nextX = windowXForPetCentre(petCentreX, placement)
      const nextY = windowYForFloor(floor.y, placement)
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
      win.webContents.send(IPC.frame, parsed.data)
    },

    spriteRect(): Rectangle {
      const bounds = win.isDestroyed() ? { x, y } : win.getBounds()
      return spriteScreenRect(ALPHA_MASK, bounds, placement.spriteOrigin) as Rectangle
    },

    reassertAlwaysOnTop(): void {
      keeper?.reassert()
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
      ipcMain.removeListener(IPC.openCalloutUrl, onOpenCalloutUrl)
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
