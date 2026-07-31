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
import { createPetController, type PetController } from './pet-controller.js'
import { floorForWorkArea } from './floor-placement.js'
import { isAnimationState } from '../pet-animations.generated.js'
import { userDataDir, petAssetPath } from './paths.js'
import { emit } from './harness-handshake.js'
import { readFileSync } from 'node:fs'

export interface AppShell {
  displays: DisplayManager
  settings: SettingsStore
  tray: TrayController
  pet: PetWindow
  controller: PetController
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

  let controller: PetController | null = null

  const pet = await createPetWindow({
    initialFloor: startFloor,
    initialPetCentreX: startX,
    log,
    events: {
      onReady(): void {
        emit({ ev: 'sprite-ready', window: 'pet' })
        pet.emitWindowReady(startDisplay)
        controller?.tickNow()
      },
      onPointerOverPet(): void {
        // The passthrough switch is pet-window's job and already applied. Nothing behavioural
        // hangs off hover today; M5 may use it to hold a bubble open under the cursor.
      },
      onContextMenu(): void {
        // M4 pops the shared menu here.
        log('context menu requested (wired in M4)')
      },
      onDragStart(): void {
        pet.setDragging(true)
        controller?.enqueue({ kind: 'drag-start' })
        controller?.tickNow()
      },
      onDragEnd(): void {
        pet.setDragging(false)
        const dropped = controller?.petCentreX() ?? startX
        controller?.enqueue({ kind: 'drag-end', petCentreX: dropped })
        controller?.tickNow()
        const displayNow = displays.nearest({ x: dropped, y: startFloor.y - 1 })
        settings.patch({ position: { displayKey: displayNow.key, x: dropped } })
      },
      onOpenCalloutUrl(): void {
        // M5/M6 own callouts; M8 validates and opens the URL.
      },
    },
  })

  controller = createPetController({
    pet,
    displays,
    getMovementEnabled: () => settings.get().movementEnabled,
    onPositionChanged(displayKey, petCentreX) {
      settings.patch({ position: { displayKey, x: petCentreX } })
    },
    startPetCentreX: startX,
    startFloor,
    // Seeded from the clock so two launches do not produce an identical pet, while the engine
    // itself stays deterministic given a seed.
    seed: Date.now() & 0x7fffffff,
    log,
  })

  const forcedFromEnv = process.env.KEYCODE_PET_FORCE_STATE
  if (forcedFromEnv && isAnimationState(forcedFromEnv)) {
    controller.setForcedState(forcedFromEnv)
  }

  controller.start()

  // The controller re-derives the floor every tick, so a display change needs no position fix-up
  // here — only a z-order re-assert, since window managers reorder on reconfiguration.
  const stopDisplayWatch = displays.onChanged(() => {
    pet.reassertAlwaysOnTop()
    controller?.tickNow()
    log('display configuration changed; re-asserted z-order')
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
      controller?.setForcedState(state)
    },
  })

  let disposed = false

  const shell: AppShell = {
    displays,
    settings,
    tray,
    pet,
    controller,
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
      controller?.stop()
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
