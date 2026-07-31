/**
 * The app shell — everything that exists once the app is ready.
 *
 * Kept separate from `main.ts` so that `main.ts` holds only ordering-sensitive boot steps,
 * and so this module can be imported lazily after `whenReady`.
 *
 * Grows across milestones: M0 the backdrop, M1 settings and tray, M2 the pet window,
 * M3 the controller, M4–M8 the rest.
 */

import { app, dialog, net, screen, type BrowserWindow } from 'electron'
import { createDisplayManager, type DisplayManager } from './display-manager.js'
import { createBackdropWindow, shouldShowBackdrop } from './backdrop-window.js'
import { installHarnessControl } from './harness-control.js'
import { SettingsStore } from './settings-store.js'
import { createTray, type TrayController } from './tray.js'
import { createPetWindow, type PetWindow } from './pet-window.js'
import { createPetController, type PetController } from './pet-controller.js'
import { createMenuController, type MenuController } from './menu.js'
import { createActions } from './actions.js'
import type { MenuViewModel, UpdateState } from './menu-template.js'
import { createReminderService, type ReminderService } from './reminder-service.js'
import { createCalloutHost, type CalloutHost } from './callout-host.js'
import { createToastManager, type ToastManager } from './toast.js'
import { REMINDER_TRIGGERS } from '../reminders/reminder-scheduler.js'
import {
  createPoller,
  resolveManifestUrl,
  resolvePollMinutes,
  type Poller,
} from '../broadcast/broadcast-poller.js'
import { appendSeenId } from './settings-schema.js'
import { createUpdateService, type UpdateService } from '../updates/update-service.js'
import { openExternalChecked } from './open-external.js'
import { PRODUCT_NAME } from '../config/constants.js'
import { floorForWorkArea } from './floor-placement.js'
import { isAnimationState, resolveTrigger } from '../pet-animations.generated.js'
import { userDataDir, petAssetPath } from './paths.js'
import { env } from '../config/env.js'
import { log as fileLog, logFilePath } from './logger.js'
import { emit } from './harness-handshake.js'
import { readFileSync } from 'node:fs'

export interface AppShell {
  displays: DisplayManager
  settings: SettingsStore
  tray: TrayController
  pet: PetWindow
  controller: PetController
  menu: MenuController
  callouts: CalloutHost
  reminders: ReminderService
  toasts: ToastManager
  poller: Poller
  updates: UpdateService
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
  // A packaged macOS app has no usable stdio, so diagnostics go to a file. See logger.ts.
  const log = fileLog

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
        menu.popupOverPet()
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
        // Main holds the URL and re-validates it here. The renderer only ever asked to open "the
        // current callout's link" and never saw a string.
        openExternalChecked(callouts?.currentUrl(), { log })
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

  // ---- Callouts and reminders.
  const toasts = createToastManager({ log })

  const callouts: CalloutHost = createCalloutHost({
    onShowingChanged(showing) {
      controller?.setCallout(
        showing
          ? {
              text: showing.text,
              tone: showing.tone,
              pinned: Boolean(showing.pin),
              clickable: Boolean(callouts.currentUrl()),
            }
          : null,
      )
    },
    onAnimation(animation) {
      controller?.enqueue({ kind: 'reaction', state: animation })
      controller?.tickNow()
    },
    onToast(request) {
      toasts.show({ text: request.text, tone: request.tone, durationMs: request.durationMs })
    },
    isPetVisible: () => !pet.win.isDestroyed() && pet.win.isVisible(),
    log,
  })

  const reminders = createReminderService({
    settings,
    log,
    onFire(kind, message) {
      callouts.show({
        sourceId: 'reminder',
        text: message,
        tone: 'info',
        priority: 'normal',
        animation: resolveTrigger(REMINDER_TRIGGERS[kind]),
      })
    },
  })
  reminders.start()

  // ---- Broadcast.
  //
  // The default URL is the local dev server, because no host has been chosen yet. Switching to a real
  // one is a single env var; see docs/BROADCAST.md.
  let updates: UpdateService | null = null

  const manifestUrl = resolveManifestUrl(process.env, 'http://127.0.0.1:8787/manifest.json')

  // TWO independent conditions. `app.isPackaged` is not env-overridable, so a shipped build cannot be
  // talked into accepting loopback HTTP even by someone who sets the flag.
  const allowLoopbackHttp = !app.isPackaged && env.allowInsecureManifestRequested

  const poller = createPoller(manifestUrl, {
    fetch: net.fetch.bind(net),
    allowLoopbackHttp,
    userAgent: `KeycodePet/${app.getVersion()}`,
    log,
    getSeenIds: () => settings.get().seenBroadcastIds,
    async markSeen(id) {
      // patchNow, not patch: "shown exactly once, ever" is a durability claim, and the debounce would
      // leave a window where a crash re-shows the message.
      await settings.patchNow({
        seenBroadcastIds: appendSeenId(settings.get().seenBroadcastIds, id),
      })
    },
    onNotifications(notifications) {
      for (const entry of notifications) {
        callouts.show({
          sourceId: 'broadcast',
          text: entry.text,
          tone: entry.tone,
          priority: entry.priority,
          durationMs: entry.durationMs,
          animation: entry.animation,
          ...(entry.url ? { url: entry.url } : {}),
        })
      }
    },
    onRelease(release) {
      updates?.onReleaseFromPoll(release)
    },
  })

  updates = createUpdateService({
    currentVersion: app.getVersion(),
    log,
    getLastKnownRelease: () => settings.get().lastKnownRelease,
    setLastKnownRelease: (version) => settings.patch({ lastKnownRelease: version }),
    submitCallout: (request) => callouts.show(request),
    showToast: (toast) => toasts.show(toast),
    pollNow: () => poller.pollNow('user'),
    onStateChange: (nextView) => {
      updateState = { state: nextView.state, latestVersion: nextView.latestVersion }
      menu.refresh()
    },
    openReleaseNotes: (url) => openExternalChecked(url, { log }),
  })

  log('broadcast polling', {
    url: manifestUrl,
    everyMinutes: resolvePollMinutes(process.env),
    allowLoopbackHttp,
  })
  poller.start()

  // The controller re-derives the floor every tick, so a display change needs no position fix-up
  // here — only a z-order re-assert, since window managers reorder on reconfiguration.
  const stopDisplayWatch = displays.onChanged(() => {
    pet.reassertAlwaysOnTop()
    controller?.tickNow()
    log('display configuration changed; re-asserted z-order')
  })

  // ---- Menus. ONE template feeds both the sprite's right-click menu and the tray menu, because
  // on Wayland the compositor swallows right-click on the sprite and the tray is the only way in.
  let updateState: { state: UpdateState; latestVersion: string | null } = {
    state: 'idle',
    latestVersion: null,
  }

  const menuView = (): MenuViewModel => {
    const current = settings.get()
    return {
      movementEnabled: current.movementEnabled,
      waterReminderEnabled: current.waterReminderEnabled,
      stretchReminderEnabled: current.stretchReminderEnabled,
      update: updateState,
    }
  }

  const actions = createActions({
    settings,
    controller,
    displays,
    getCursorPoint: () => screen.getCursorScreenPoint(),
    showAbout: () => void showAbout(petMeta, settings.recovery?.reason ?? null),
    checkForUpdates: () => {
      // If an update is already known, the item opens its notes; otherwise it runs a real check.
      if (updateState.state === 'available') {
        updates?.openNotes()
        return
      }
      void updates?.checkNow()
    },
    quit: () => app.quit(),
    log,
  })

  // The menu and the tray reference each other: the tray asks the menu for a template, and a state
  // change asks the tray to rebuild. `createTray` calls `buildTemplate()` synchronously, so the menu
  // must exist first — hence the explicit late binding rather than two consts that appear to work.
  let trayRef: TrayController | null = null

  const menu: MenuController = createMenuController({
    view: menuView,
    actions,
    petWindow: () => pet.win,
    // The tray menu is retained by the OS, so a state change has to push a rebuild into it.
    onTemplateChanged: () => trayRef?.refresh(),
  })

  const tray = createTray({
    buildTemplate: () => menu.template(),
    tooltip: `${PRODUCT_NAME} — ${petMeta.displayName}`,
  })
  trayRef = tray

  // Any settings change re-renders the menus, so a checkbox can never disagree with the store.
  const stopSettingsWatch = settings.onChange((_next, _prev, changed) => {
    menu.refresh()
    // Enabling a reminder must schedule it now rather than at the next 15s tick, and disabling must
    // clear its deadline immediately.
    if (changed.includes('waterReminderEnabled') || changed.includes('stretchReminderEnabled')) {
      reminders.evaluateNow()
    }
  })

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
    showCallout(request): void {
      const tone = (['info', 'success', 'warning', 'error'] as const).find((t) => t === request.tone)
      const priority = (['low', 'normal', 'high', 'urgent'] as const).find(
        (p) => p === request.priority,
      )
      callouts.show({
        sourceId: 'system',
        text: request.text,
        tone: tone ?? 'info',
        priority: priority ?? 'normal',
        ...(request.toast ? { durationMs: 8_000 } : {}),
      })
      if (request.toast) {
        toasts.show({ text: request.text, tone: tone ?? 'info', durationMs: 8_000 })
      }
    },
  })

  let disposed = false

  const shell: AppShell = {
    displays,
    settings,
    tray,
    pet,
    controller,
    menu,
    callouts,
    reminders,
    toasts,
    poller,
    updates,
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
      stopSettingsWatch()
      menu.dispose()
      reminders.stop()
      poller.stop()
      callouts.dispose()
      toasts.destroyAll()
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
    ...(logFilePath() ? ['', `Log: ${logFilePath()}`] : []),
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
