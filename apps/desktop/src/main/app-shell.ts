/**
 * The app shell — everything that exists once the app is ready.
 *
 * Kept separate from `main.ts` so that `main.ts` holds only ordering-sensitive boot steps,
 * and so this module can be imported lazily after `whenReady`.
 *
 * Grows across milestones: M0 the backdrop, M1 settings and tray, M2 the pet window,
 * M3 the controller, M4–M8 the rest.
 */

// `shell` is aliased: this module already has a local `shell` (the AppShell it returns).
import {
  app,
  clipboard,
  dialog,
  net,
  screen,
  shell as electronShell,
  type BrowserWindow,
} from 'electron'
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
import {
  ISSUES_URL,
  PRODUCT_NAME,
  STRETCH_INTERVAL_MS,
  WATER_INTERVAL_MS,
  isPetSize,
  petScaleFor,
} from '../config/constants.js'
import { bubbleSideFor, floorForWorkArea, placementForScale } from './floor-placement.js'
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
  const startScale = petScaleFor(settings.get().petSize)
  // The envelope depends on the pet's size, so the placement for the saved size is derived first.
  const startFloor = floorForWorkArea(
    startDisplay.workArea,
    startDisplay.key,
    undefined,
    placementForScale(startScale),
  )
  const startX = saved
    ? Math.min(startFloor.maxX, Math.max(startFloor.minX, saved.x))
    : startFloor.minX + (startFloor.maxX - startFloor.minX) * 0.35
  // A restored free placement is clamped into the envelope of the display it is landing on, which may
  // not be the display it was saved from. null stays null: floor-locked is re-derived, never restored.
  const startFeetY =
    saved?.feetY == null
      ? null
      : Math.min(startFloor.maxFeetY, Math.max(startFloor.minFeetY, saved.feetY))

  let controller: PetController | null = null

  const pet = await createPetWindow({
    initialFloor: startFloor,
    initialPetCentreX: startX,
    initialFeetY: startFeetY,
    initialScale: startScale,
    initialBubbleSide: bubbleSideFor(
      startFeetY ?? startFloor.y,
      startDisplay.workArea,
      startScale,
    ),
    alwaysOnTop: settings.get().alwaysOnTop,
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
        // The controller owns the snap-to-floor rule, so it builds the trigger.
        controller?.endDrag()
        controller?.tickNow()
        const settled = controller?.position()
        const dropped = settled?.x ?? startX
        const displayNow = displays.nearest({ x: dropped, y: settled?.feetY ?? startFloor.y - 1 })
        settings.patch({
          position: {
            displayKey: displayNow.key,
            x: dropped,
            // null means floor-locked: re-derived on launch rather than restored.
            feetY: settled && !settled.floorLocked ? settled.feetY : null,
          },
        })
      },
      onBubbleClicked(): void {
        // Main holds the URL and re-validates it here. The renderer only ever reported "the bubble was
        // clicked" and never saw a string — deciding what a click *means* is behaviour, so it lives
        // here rather than in the view.
        const url = callouts?.currentUrl()
        if (url) openExternalChecked(url, { log })
        // Dismiss either way. A sticky notification has no other way to go, and for a timed one this
        // just means a click gets rid of it early.
        callouts?.dismissShowing()
      },
    },
  })

  controller = createPetController({
    pet,
    displays,
    getMovementEnabled: () => settings.get().movementEnabled,
    onPositionChanged(displayKey, petCentreX, feetY) {
      settings.patch({ position: { displayKey, x: petCentreX, feetY } })
    },
    startPetCentreX: startX,
    startFeetY,
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
              // Sticky entries have no expiry, so a click is the only way they go.
              dismissible: Boolean(showing.sticky),
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
  // A static file on GitHub Pages: no application to run, no auth to administer, and a shipped build
  // needs nothing but HTTPS and an ETag, both of which come for free.
  //
  // Publishing is a *commit* (`pnpm notify`), which is the point — remote text that lands above
  // everything on a colleague's screen goes through the same review as code.
  //
  // Pages advertises `max-age=600`, but it purges its CDN on deploy (measured: `x-cache: MISS`,
  // `age: 0`, new content served immediately), so that only governs how long an *unchanged* file is
  // served from the edge. A short poll interval therefore does deliver quickly.
  //
  // The manifest is world-readable, so nothing goes in it that would not be fine on a public page.
  // See docs/BROADCAST.md. Override with KEYCODE_PET_MANIFEST_URL.
  let updates: UpdateService | null = null

  /**
   * Team defaults from the last poll, in memory only.
   *
   * Deliberately not persisted: nothing the manifest says gets written to disk, so a bad or hostile
   * default cannot outlive the process that received it, and there is no stale remote policy to reason
   * about after a restart. The cost is that the built-in intervals apply for the second or so between
   * launch and the first poll — irrelevant for a 45-minute reminder.
   */
  let manifestDefaults: {
    waterMinutes: number | null
    stretchMinutes: number | null
    pollMinutes: number | null
  } | null = null

  const effectiveDefaults = (): { waterMinutes: number; stretchMinutes: number } => ({
    waterMinutes: manifestDefaults?.waterMinutes ?? WATER_INTERVAL_MS / 60_000,
    stretchMinutes: manifestDefaults?.stretchMinutes ?? STRETCH_INTERVAL_MS / 60_000,
  })

  const manifestUrl = resolveManifestUrl(
    process.env,
    'https://doylefermi-kv.github.io/keycode-2026-mascot-pet/manifest.json',
  )

  // TWO independent conditions. `app.isPackaged` is not env-overridable, so a shipped build cannot be
  // talked into accepting loopback HTTP even by someone who sets the flag.
  const allowLoopbackHttp = !app.isPackaged && env.allowInsecureManifestRequested

  const poller = createPoller(manifestUrl, {
    fetch: net.fetch.bind(net),
    allowLoopbackHttp,
    userAgent: `KeycodePet/${app.getVersion()}`,
    log,
    getPollMinutes: () => manifestDefaults?.pollMinutes ?? null,
    getSeenIds: () => settings.get().seenBroadcastIds,
    async markSeen(id) {
      // patchNow, not patch: "shown exactly once, ever" is a durability claim, and the debounce would
      // leave a window where a crash re-shows the message.
      await settings.patchNow({
        seenBroadcastIds: appendSeenId(settings.get().seenBroadcastIds, id),
      })
    },
    onDefaults(defaults) {
      // Defaults only, never overrides: applied through `??` at read time against a local value of
      // null, which is the settings file's way of saying "never chosen here". A user who picked an
      // interval keeps it, and one who turned a reminder off stays off.
      const pollChanged = defaults?.pollMinutes !== manifestDefaults?.pollMinutes
      const changed =
        pollChanged ||
        defaults?.waterMinutes !== manifestDefaults?.waterMinutes ||
        defaults?.stretchMinutes !== manifestDefaults?.stretchMinutes
      manifestDefaults = defaults
      if (changed) {
        log('team defaults from manifest', { defaults })
        // A changed default can move a deadline for anyone who never chose an interval.
        reminders.evaluateNow()
        menu?.refresh()
      }
      if (pollChanged) {
        // Recompute the pending wait, or a shortened interval would not apply until the old, longer
        // one had already elapsed.
        poller.rescheduleNow()
      }
    },
    onNotifications(notifications) {
      for (const entry of notifications) {
        callouts.show({
          sourceId: 'broadcast',
          text: entry.text,
          tone: entry.tone,
          priority: entry.priority,
          // No duration in the manifest means the notification waits to be clicked. An announcement
          // worth sending to everybody is worth acknowledging, and a bubble that disappears after six
          // seconds is one you can miss by looking away. Set `durationMs` to opt back into a timeout.
          ...(entry.durationMs === null
            ? { sticky: true }
            : { durationMs: entry.durationMs }),
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
    // Named to say what it is: the interval *before* any manifest has been read. The manifest can
    // shorten it, and does — but only from the first poll that actually sees the value, which is why
    // reporting it as `everyMinutes` here read as a contradiction of the published `pollMinutes`.
    startingEveryMinutes: resolvePollMinutes(process.env),
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
      alwaysOnTop: current.alwaysOnTop,
      petSize: current.petSize,
      water: {
        enabled: current.waterReminderEnabled,
        minutes: current.reminders.waterMinutes ?? effectiveDefaults().waterMinutes,
        isDefault: current.reminders.waterMinutes === null,
      },
      stretch: {
        enabled: current.stretchReminderEnabled,
        minutes: current.reminders.stretchMinutes ?? effectiveDefaults().stretchMinutes,
        isDefault: current.reminders.stretchMinutes === null,
      },
      update: updateState,
    }
  }

  /**
   * The whole of crash reporting: nothing is uploaded, ever.
   *
   * The app already keeps a log; the gap was that a user had to know where it lives and what to say.
   * This copies a filled-in report to the clipboard, reveals the log file so it can be attached, and
   * opens a fresh issue — three things nobody does reliably by hand. A toast confirms it, because a
   * clipboard write is otherwise completely invisible.
   */
  function reportProblem(): void {
    const path = logFilePath()
    const body = [
      '**What happened?**',
      '',
      '',
      '---',
      `Version: ${app.getVersion()}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Log: ${path ?? '(unavailable)'}`,
      '',
      'Please attach the log file above if you can — the app never uploads anything by itself.',
    ].join('\n')

    try {
      clipboard.writeText(body)
      if (path) electronShell.showItemInFolder(path)
    } catch (error) {
      // Never let the reporting path be the thing that breaks.
      log('report a problem: could not prepare the report', { error: String(error) })
    }

    openExternalChecked(ISSUES_URL, { log })
    toasts.show({
      text: 'Report details copied. Paste them into the issue, and attach the log.',
      tone: 'info',
      durationMs: 8_000,
    })
    log('report a problem opened')
  }

  const actions = createActions({
    settings,
    controller,
    displays,
    getCursorPoint: () => screen.getCursorScreenPoint(),
    evaluateReminders: () => reminders.evaluateNow(),
    setAlwaysOnTop: (enabled) => pet.setAlwaysOnTopEnabled(enabled),
    showAbout: () => void showAbout(petMeta, settings.recovery?.reason ?? null),
    reportProblem,
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
    spriteRect: () => pet.spriteRect(),
    bubbleBand: () => pet.bubbleBand(),
    floorLocked: () => controller?.position().floorLocked ?? true,
    petScale: () => pet.placement.scale,
    place(position): void {
      controller?.place(position)
    },
    setSize(size): void {
      if (!isPetSize(size)) {
        log('harness asked for an unknown pet size', { size })
        return
      }
      // Through the real action, so the harness exercises the same path the menu does — including
      // the settings write, which is what makes the size survive a relaunch.
      actions.setPetSize(size)
    },
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
        ...(request.sticky ? { sticky: true } : {}),
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
