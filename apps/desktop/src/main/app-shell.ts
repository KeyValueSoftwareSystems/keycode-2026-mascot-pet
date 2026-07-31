/**
 * The app shell — everything that exists once the app is ready.
 *
 * Kept separate from `main.ts` so that `main.ts` holds only ordering-sensitive boot steps,
 * and so this module can be imported lazily after `whenReady`.
 *
 * Grows across milestones: M0 the backdrop, M1 settings and tray, M2 the pet window,
 * M3 the controller, M4–M8 the rest.
 */

import { app, dialog, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { createDisplayManager, type DisplayManager } from './display-manager.js'
import { createBackdropWindow, shouldShowBackdrop } from './backdrop-window.js'
import { installHarnessControl } from './harness-control.js'
import { SettingsStore } from './settings-store.js'
import { createTray, type TrayController } from './tray.js'
import { createPetWindow, type PetWindow } from './pet-window.js'
import { floorForWorkArea } from './floor-placement.js'
import { isAnimationState } from '../pet-animations.generated.js'
import type { PetFrame } from '../pet-frame.js'
import { userDataDir, petAssetPath } from './paths.js'
import { emit } from './harness-handshake.js'
import { readFileSync } from 'node:fs'

export interface AppShell {
  displays: DisplayManager
  settings: SettingsStore
  tray: TrayController
  pet: PetWindow
  backdrop: BrowserWindow | null
  onSecondInstance(): void
  dispose(): Promise<void>
}

interface PetMetadata {
  id: string
  displayName: string
}

function readPetMetadata(): PetMetadata {
  try {
    const raw = JSON.parse(readFileSync(petAssetPath('pet.json'), 'utf8')) as Partial<PetMetadata>
    return { id: raw.id ?? 'unknown', displayName: raw.displayName ?? 'Pet' }
  } catch {
    // The pet's display name is cosmetic; never let it stop the app booting.
    return { id: 'unknown', displayName: 'Pet' }
  }
}

export async function startApp(): Promise<AppShell> {
  const log = (message: string, meta?: unknown): void => {
    console.log(`[keycode-pet] ${message}`, meta ?? '')
  }

  const displays = createDisplayManager()
  const settings = await SettingsStore.open({ dir: userDataDir(), log })
  const petMeta = readPetMetadata()

  if (settings.recovery) {
    // Surfaced in About rather than as a dialog: a modal at launch would be a jarring first
    // impression for a problem the app has already recovered from.
    log('settings were recovered from a corrupt file', settings.recovery)
  }

  let backdrop: BrowserWindow | null = null
  if (shouldShowBackdrop()) {
    backdrop = await createBackdropWindow(displays.primary())
  }

  // ---- The pet window.
  //
  // Restore the saved position if its display still exists, else start centre-ish on the primary
  // display. `byKey` returning null is the normal case after a monitor change, not an error.
  const saved = settings.get().position
  const startDisplay = (saved && displays.byKey(saved.displayKey)) || displays.primary()
  const startFloor = floorForWorkArea(startDisplay.workArea, startDisplay.key)
  const startX = saved
    ? Math.min(startFloor.maxX, Math.max(startFloor.minX, saved.x))
    : startFloor.minX + (startFloor.maxX - startFloor.minX) * 0.35

  /** Harness-only state pinning, so `smoke:states` can drive every animation in one launch. */
  let forcedState: string | null = process.env.KEYCODE_PET_FORCE_STATE ?? null
  let animationNonce: 0 | 1 = 0

  const pet = await createPetWindow({
    initialFloor: startFloor,
    initialPetCentreX: startX,
    log,
    events: {
      onReady(): void {
        emit({ ev: 'sprite-ready', window: 'pet' })
        pet.emitWindowReady(startDisplay)
        sendCurrentFrame()
      },
      onPointerOverPet(): void {
        // M3 uses this to pause movement under the cursor; M2 only needs the passthrough
        // switch, which pet-window has already applied.
      },
      onContextMenu(): void {
        // M4 pops the shared menu here.
        log('context menu requested (wired in M4)')
      },
      onDragStart(): void {
        pet.setDragging(true)
      },
      onDragEnd(): void {
        pet.setDragging(false)
        const displayNow = displays.nearest({
          x: pet.petCentreX(),
          y: startFloor.y - 1,
        })
        settings.patch({
          position: { displayKey: displayNow.key, x: pet.petCentreX() },
        })
      },
      onOpenCalloutUrl(): void {
        // M5/M6 own callouts; M8 validates and opens the URL.
      },
    },
  })

  /**
   * The single place a frame is built, until M3's motion engine takes over.
   *
   * M2's pet is static: it renders, it is transparent, it is grabbable. Making it *alive* is M3.
   */
  const sendCurrentFrame = (): void => {
    const animation = forcedState && isAnimationState(forcedState) ? forcedState : 'idle'
    const frame: PetFrame = {
      animation,
      animationNonce,
      facing: 'right',
      sprite: pet.placement.spriteOrigin,
      bubble: null,
      overlay: animation === 'sleep' ? 'sleep-z' : 'none',
    }
    pet.sendFrame(frame)
    emit({ ev: 'frame', animation, nonce: animationNonce, facing: frame.facing })
  }

  // Re-clamp on display changes: a monitor unplugged while the pet is on it must not orphan it
  // off-screen. Recomputed from `screen` rather than from cached bounds.
  const stopDisplayWatch = displays.onChanged(() => {
    const centre = pet.petCentreX()
    const display = displays.nearest({ x: centre, y: startFloor.y - 1 })
    const floor = floorForWorkArea(display.workArea, display.key)
    const clamped = Math.min(floor.maxX, Math.max(floor.minX, centre))
    pet.moveTo(clamped, floor)
    pet.reassertAlwaysOnTop()
    log('re-clamped after a display change', { displayKey: display.key, x: Math.round(clamped) })
  })

  /**
   * M1's placeholder menu. M4 replaces this with the shared template that also feeds the
   * sprite's right-click menu — the injection point exists so that swap needs no changes here.
   */
  const buildTemplate = (): MenuItemConstructorOptions[] => [
    { label: 'Keycode Pet', enabled: false },
    { type: 'separator' },
    {
      label: 'About',
      click: () => {
        void showAbout(petMeta, settings.recovery?.reason ?? null)
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]

  const tray = createTray({ buildTemplate, tooltip: `Keycode Pet — ${petMeta.displayName}` })

  const stopHarnessControl = installHarnessControl({
    pet: () => pet.win,
    backdrop: () => backdrop,
    setForcedState(state: string): void {
      if (!isAnimationState(state)) {
        log('harness asked for an unknown animation state', { state })
        return
      }
      forcedState = state
      // Flip the nonce so re-selecting the *same* state still restarts its animation. This is
      // the mechanism under test when smoke:states drives every state in one launch.
      animationNonce = animationNonce === 0 ? 1 : 0
      sendCurrentFrame()
    },
  })

  let disposed = false

  const shell: AppShell = {
    displays,
    settings,
    tray,
    pet,
    backdrop,

    onSecondInstance(): void {
      // Nothing to focus: the pet has no focusable surface and there is no settings window
      // by design. The first instance carries on; the second has already exited.
      log('a second instance was launched and exited')
    },

    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      stopHarnessControl()
      stopDisplayWatch()
      // Flush before tearing anything down — an unflushed position or reminder deadline is
      // exactly the state that must survive a quit.
      await settings.flush()
      pet.dispose()
      tray.dispose()
      displays.dispose()
      if (backdrop && !backdrop.isDestroyed()) backdrop.destroy()
    },
  }

  // `before-quit` can be followed immediately by process teardown, so the flush is started
  // here and awaited by holding the quit until it settles.
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    shell
      .dispose()
      .catch((error: unknown) => {
        emit({ ev: 'error', where: 'dispose', message: String(error) })
      })
      .finally(() => {
        app.exit(0)
      })
  })

  return shell
}

async function showAbout(pet: PetMetadata, recoveryReason: string | null): Promise<void> {
  const detail = [
    `Version ${app.getVersion()}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    `Pet: ${pet.displayName} (${pet.id})`,
    '',
    'Includes code adapted from openpets (MIT).',
    ...(recoveryReason
      ? ['', `Note: settings were reset after a read error (${recoveryReason}).`]
      : []),
  ].join('\n')

  await dialog.showMessageBox({
    type: 'info',
    message: 'Keycode Pet',
    detail,
    buttons: ['OK'],
    noLink: true,
  })
}
