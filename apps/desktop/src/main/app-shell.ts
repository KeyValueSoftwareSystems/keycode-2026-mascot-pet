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
import { REMINDER_MESSAGES, REMINDER_TRIGGERS } from '../reminders/reminder-scheduler.js'
import { CLOCK_REMINDER_MESSAGES, CLOCK_REMINDER_TRIGGERS } from '../reminders/clock-reminders.js'
import { GREETING_MESSAGES, GREETING_TRIGGERS } from '../reminders/greetings.js'
import {
  createPoller,
  resolveManifestUrl,
  resolvePollMinutes,
  type Poller,
} from '../broadcast/broadcast-poller.js'
import type { SafeDefaults } from '../broadcast/manifest-schema.js'
import { appendSeenId } from './settings-schema.js'
import { createUpdateService, type UpdateService } from '../updates/update-service.js'
import { createMacAutoUpdater } from '../updates/mac-auto-updater.js'
import { createAnalytics, type AnalyticsService } from '../analytics/analytics-service.js'
import { osName } from '../analytics/analytics-client.js'
import { openExternalChecked } from './open-external.js'
import {
  ANALYTICS_ENDPOINT,
  DEFAULT_ALWAYS_ON_TOP,
  DEFAULT_MANIFEST_URL,
  DEFAULT_PET_SIZE,
  DRINK_LOOP_GAP_MS,
  ISSUES_URL,
  PRODUCT_NAME,
  STRETCH_INTERVAL_MS,
  WATER_INTERVAL_MS,
  isPetSize,
  petScaleFor,
  type PetSize,
} from '../config/constants.js'
import { bubbleSideFor, floorForWorkArea, placementForScale } from './floor-placement.js'
import { ANIMATIONS, isAnimationState, resolveTrigger } from '../pet-animations.generated.js'
import { userDataDir, petAssetPath } from './paths.js'
import { env } from '../config/env.js'
import { log as fileLog, logFilePath } from './logger.js'
import { emit } from './harness-handshake.js'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { release } from 'node:os'

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
  analytics: AnalyticsService
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

  /**
   * Team defaults from the last poll, in memory only.
   *
   * Deliberately not persisted: nothing the manifest says gets written to disk, so a bad or hostile
   * default cannot outlive the process that received it, and there is no stale remote policy to reason
   * about after a restart. The cost is that the built-ins apply for the second or so between launch and
   * the first poll — irrelevant for a 45-minute reminder, and the reason `DEFAULT_PET_SIZE` matches what
   * the manifest publishes: if they differed, the pet would visibly resize on every launch.
   *
   * Declared here rather than beside the poller because the pet window's *size and z-order* are now
   * derived from it, and those are decided before the poller exists.
   */
  let manifestDefaults: SafeDefaults | null = null

  // ---- The three-way resolution, in one place.
  //
  //   a local choice  >  a team default  >  the built-in
  //
  // Every one of these reads a nullable settings field, and null means "never chosen here". That is the
  // whole enforcement of "a default may fill a choice nobody made, never override one somebody did" —
  // it is a property of `??`, not of anyone remembering the rule.

  const effectiveDefaults = (): { waterMinutes: number; stretchMinutes: number } => ({
    waterMinutes: manifestDefaults?.waterMinutes ?? WATER_INTERVAL_MS / 60_000,
    stretchMinutes: manifestDefaults?.stretchMinutes ?? STRETCH_INTERVAL_MS / 60_000,
  })

  const effectivePetSize = (): PetSize =>
    settings.get().petSize ?? manifestDefaults?.petSize ?? DEFAULT_PET_SIZE

  const effectiveAlwaysOnTop = (): boolean =>
    settings.get().alwaysOnTop ?? manifestDefaults?.alwaysOnTop ?? DEFAULT_ALWAYS_ON_TOP

  let pointerOverPet = false
  /** Hover quick-menu currently shown. Separate from freeze so waking from sleep can hide the zap. */
  let hoverMenuOpen = false
  /** True while hover-start is holding locomotion (cursor over the pet, no callout). */
  let hoverFrozen = false
  /** True while the right-click settings menu is open. */
  let settingsMenuOpen = false
  /** True only between a real drag-start and its matching drag-end. */
  let petDragging = false
  /**
   * After a speech bubble (ok / snooze / dismiss), require the pointer to leave and re-enter
   * before showing the zap menu again — otherwise the click that closed the bubble immediately
   * opens the hover chip on top of where the buttons were.
   */
  let hoverNeedsReenter = false
  let hoverLeaveTimer: ReturnType<typeof setTimeout> | null = null
  /** Bubble unmount looks like a leave; wait this long off the pet before treating it as real. */
  const HOVER_LEAVE_CONFIRM_MS = 200

  const clearHoverLeaveTimer = (): void => {
    if (!hoverLeaveTimer) return
    clearTimeout(hoverLeaveTimer)
    hoverLeaveTimer = null
  }

  const syncHoverMenu = (): void => {
    const animation = controller?.animation()
    const freeze = pointerOverPet && !callouts?.showing()
    const hideZap =
      petDragging ||
      animation === 'electrocute' ||
      animation === 'panic'
    const showZap = freeze && !hoverNeedsReenter && !settingsMenuOpen && !hideZap
    let changed = false

    if (showZap !== hoverMenuOpen) {
      hoverMenuOpen = showZap
      controller?.setQuickActions(showZap ? ['zap'] : [])
      changed = true
    }
    if (freeze !== hoverFrozen) {
      hoverFrozen = freeze
      controller?.enqueue(freeze ? { kind: 'hover-start' } : { kind: 'hover-end' })
      changed = true
    }
    if (changed) controller?.tickNow()
  }

  const confirmHoverLeft = (): void => {
    clearHoverLeaveTimer()
    hoverLeaveTimer = setTimeout(() => {
      hoverLeaveTimer = null
      hoverNeedsReenter = false
      syncHoverMenu()
    }, HOVER_LEAVE_CONFIRM_MS)
    hoverLeaveTimer.unref?.()
  }

  // ---- The pet window.
  //
  // Restore the saved position if its display still exists, else start centre-ish on the primary
  // display. `byKey` returning null is the normal case after a monitor change, not an error.
  const saved = settings.get().position
  const startDisplay = (saved && displays.byKey(saved.displayKey)) || displays.primary()
  const startScale = petScaleFor(effectivePetSize())
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
    alwaysOnTop: effectiveAlwaysOnTop(),
    log,
    events: {
      onReady(): void {
        emit({ ev: 'sprite-ready', window: 'pet' })
        pet.emitWindowReady(startDisplay)
        controller?.tickNow()
      },
      onPointerOverPet(over): void {
        clearHoverLeaveTimer()
        pointerOverPet = over
        if (!over) confirmHoverLeft()
        syncHoverMenu()
      },
      onContextMenu(): void {
        settingsMenuOpen = true
        syncHoverMenu()
        menu.popupOverPet()
      },
      onDragStart(): void {
        // Counted, not captured. Folded into the next heartbeat as one number — a pet dragged
        // across the screen thirty times in an afternoon is one fact, not thirty events.
        petInteractions += 1
        petDragging = true
        hoverMenuOpen = false
        hoverFrozen = false
        controller?.setQuickActions([])
        pet.setDragging(true)
        controller?.enqueue({ kind: 'drag-start' })
        controller?.tickNow()
      },
      onDragEnd(): void {
        if (!petDragging) return
        petDragging = false
        pet.setDragging(false)
        // The controller owns the snap-to-floor rule, so it builds the trigger.
        controller?.endDrag()
        const held = callouts?.showing()
        if (held?.holdMs != null && held.animation) {
          controller?.enqueue({ kind: 'reaction', state: held.animation, holdMs: held.holdMs })
        }
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
        petInteractions += 1
        const showing = callouts?.showing()
        if (showing?.actions?.length) return
        if (showing?.sourceId === 'update' && updateState.state === 'ready') {
          updates?.actOnKnownUpdate(async () => {
            installingUpdate = true
            await settings.flush()
          })
          return
        }
        const url = callouts?.currentUrl()
        if (url) {
          // Only for broadcasts, and only the id — never the URL, which is the one field in a
          // manifest entry that could carry something specific to a person.
          if (showing?.sourceId === 'broadcast' && showing.broadcastId) {
            void analytics.capture('broadcast_clicked', { broadcast_id: showing.broadcastId })
          }
          openExternalChecked(url, { log })
        }
        // Dismiss either way. A sticky notification has no other way to go, and for a timed one this
        // just means a click gets rid of it early.
        callouts?.dismissShowing()
      },
      onBubbleAction(action): void {
        const showing = callouts?.showing()
        if (!showing?.actions?.includes(action)) return
        if (action === 'snooze' && showing.reminderKind) reminders.snooze(showing.reminderKind)
        callouts?.dismissShowing()
      },
      onQuickAction(action): void {
        if (action !== 'zap') return
        if (hoverMenuOpen) {
          hoverMenuOpen = false
          controller?.setQuickActions([])
        }
        controller?.react('zap')
        controller?.tickNow()
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
    onAnimationChanged() {
      syncHoverMenu()
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

  let holdingCalloutPose = false
  const callouts: CalloutHost = createCalloutHost({
    onShowingChanged(showing) {
      controller?.setCallout(
        showing
          ? {
              text: showing.text,
              tone: showing.tone,
              pinned: Boolean(showing.pin),
              clickable: Boolean(
                callouts.currentUrl() || showing.clickable || (showing.sourceId === 'update' && updateState.state === 'ready'),
              ),
              // Sticky entries have no expiry, so a click is the only way they go.
              dismissible: Boolean(showing.sticky) && !(showing.actions && showing.actions.length > 0),
              actions: showing.actions ? [...showing.actions] : [],
            }
          : null,
      )
      // Zap must not appear on the click that closed a bubble, or on the leave/enter flicker
      // when the bubble rect vanishes under the cursor. Require a confirmed leave first.
      hoverNeedsReenter = true
      if (!showing && !pointerOverPet) confirmHoverLeft()
      syncHoverMenu()
      if (!showing && holdingCalloutPose) {
        holdingCalloutPose = false
        controller?.enqueue({ kind: 'reaction', state: 'idle' })
        controller?.tickNow()
      }
    },
    onAnimation(animation) {
      const showing = callouts.showing()
      // Finite waves otherwise end mid-greeting and locomotion resumes while the bubble is still up.
      const holdMs =
        showing?.holdMs ?? (animation === 'waving' ? Number.MAX_SAFE_INTEGER : undefined)
      if (holdMs !== undefined) holdingCalloutPose = true
      controller?.enqueue({
        kind: 'reaction',
        state: animation,
        ...(holdMs === undefined ? {} : { holdMs }),
      })
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
        reminderKind: kind,
        sticky: true,
        actions: ['ok', 'snooze'],
        ...(kind === 'water'
          ? { holdMs: (ANIMATIONS.drink.totalMs ?? ANIMATIONS.drink.durationMs) + DRINK_LOOP_GAP_MS }
          : kind === 'stretch'
            ? { holdMs: ANIMATIONS.stretch.totalMs ?? ANIMATIONS.stretch.durationMs }
            : {}),
      })
    },
    onClockFire(kind, message) {
      callouts.show({
        sourceId: 'reminder',
        text: message,
        tone: 'info',
        priority: 'normal',
        animation: resolveTrigger(CLOCK_REMINDER_TRIGGERS[kind]),
      })
    },
    onGreeting(period, message) {
      callouts.show({
        sourceId: 'reminder',
        text: message,
        tone: 'info',
        priority: 'low',
        animation: resolveTrigger(GREETING_TRIGGERS[period]),
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

  const manifestUrl = resolveManifestUrl(
    process.env,
    DEFAULT_MANIFEST_URL,
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
      // Captured *before* `manifestDefaults` is replaced: these are what the pet is actually doing
      // right now, and comparing against them afterwards is how we know whether to act.
      const sizeBefore = effectivePetSize()
      const onTopBefore = effectiveAlwaysOnTop()
      const changed =
        pollChanged ||
        defaults?.waterMinutes !== manifestDefaults?.waterMinutes ||
        defaults?.stretchMinutes !== manifestDefaults?.stretchMinutes ||
        defaults?.petSize !== manifestDefaults?.petSize ||
        defaults?.alwaysOnTop !== manifestDefaults?.alwaysOnTop

      manifestDefaults = defaults

      if (changed) {
        log('team defaults from manifest', { defaults })
        // A changed default can move a deadline for anyone who never chose an interval.
        reminders.evaluateNow()
        menu?.refresh()
      }

      // Size and z-order are *applied*, not just read at the next tick — a reminder deadline can wait
      // for the next evaluation, but a pet that is the wrong size stays the wrong size until something
      // resizes it. Both are no-ops when the local value is non-null, because `effective*` returns the
      // same answer before and after.
      const sizeNow = effectivePetSize()
      if (sizeNow !== sizeBefore) {
        controller?.setScale(petScaleFor(sizeNow))
        log('pet size from team default', { size: sizeNow })
      }
      const onTopNow = effectiveAlwaysOnTop()
      if (onTopNow !== onTopBefore) {
        pet.setAlwaysOnTopEnabled(onTopNow)
        log('always-on-top from team default', { enabled: onTopNow })
      }

      if (pollChanged) {
        // Recompute the pending wait, or a shortened interval would not apply until the old, longer
        // one had already elapsed.
        poller.rescheduleNow()
      }
    },
    onNotifications(notifications) {
      for (const entry of notifications) {
        // Broadcast reach: how many installs a given announcement actually reached. Without it,
        // publishing to the manifest is sending mail to an address nobody confirms.
        void analytics.capture('broadcast_shown', { broadcast_id: entry.id })
        callouts.show({
          sourceId: 'broadcast',
          broadcastId: entry.id,
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

  let installingUpdate = false
  const macUpdater = createMacAutoUpdater({
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    log,
    onDownloaded: () => updates?.onDownloaded(),
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
      // Update-adoption lag: the gap between this and the next `app_launched` on a new version is
      // how long a release actually takes to reach people, which is the number that says whether
      // the "check for updates" path works at all.
      if (nextView.state === 'available' && updateState.state !== 'available') {
        void analytics.capture('update_available', { latest_version: nextView.latestVersion })
      }
      updateState = { state: nextView.state, latestVersion: nextView.latestVersion }
      menu.refresh()
    },
    openReleaseNotes: (url) => {
      void analytics.capture('update_notes_opened', { latest_version: updateState.latestVersion })
      return openExternalChecked(url, { log })
    },
    canApplyInPlace: macUpdater.canApply,
    beginDownload: () => macUpdater.check(),
    installAndRelaunch: (beforeQuitForUpdate) => macUpdater.install(beforeQuitForUpdate),
    isAutoUpdateEnabled: () => settings.get().autoUpdateEnabled,
  })

  // ---------------------------------------------------------------------------------------
  // Analytics
  // ---------------------------------------------------------------------------------------
  //
  // On by default and switched off from the right-click menu. What it may know is described in
  // analytics/analytics-service.ts; the short version is a random install id and nothing that
  // identifies a person. The manifest can withdraw it from the whole fleet by publishing
  // `defaults.analyticsMinutes: 0`, which is what makes shipping it on by default defensible.
  const sessionStartedAt = Date.now()
  const sessionId = randomUUID()
  // An allow-list, not a deny-list. A new setting reports nothing until someone adds it here and
  // decides that it should — which is the correct default for a file that also holds a screen
  // position and an install id.
  const REPORTABLE_SETTINGS = [
    'movementEnabled',
    'alwaysOnTop',
    'petSize',
    'waterReminderEnabled',
    'stretchReminderEnabled',
    'coffeeReminderEnabled',
    'lunchReminderEnabled',
    'analyticsEnabled',
  ] as const
  // Folded into the heartbeat rather than sent per click: a pet that gets poked forty times in an
  // afternoon would otherwise cost forty events to say what one number says.
  let petInteractions = 0

  const analytics = createAnalytics({
    endpoint: ANALYTICS_ENDPOINT,
    dir: userDataDir(),
    fetch: net.fetch.bind(net),
    userAgent: `KeycodePet/${app.getVersion()}`,
    log,
    isEnabled: () => settings.get().analyticsEnabled,
    getIntervalMinutes: () => manifestDefaults?.analyticsMinutes ?? null,
    context: {
      // `start()` mints this before anything is captured, so the fallback is never the one used.
      installId: settings.get().installId ?? 'unknown',
      appVersion: app.getVersion(),
      os: osName(process.platform),
      osVersion: release(),
      arch: process.arch,
      electronVersion: process.versions.electron ?? 'unknown',
      locale: app.getLocale(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      displayCount: screen.getAllDisplays().length,
      petId: petMeta.id,
    },
    getHeartbeatProperties: () => {
      const current = settings.get()
      const interactions = petInteractions
      petInteractions = 0
      return {
        session_id: sessionId,
        session_minutes: Math.round((Date.now() - sessionStartedAt) / 60_000),
        movement_enabled: current.movementEnabled,
        always_on_top: effectiveAlwaysOnTop(),
        pet_size: effectivePetSize(),
        water_reminder: current.waterReminderEnabled,
        stretch_reminder: current.stretchReminderEnabled,
        coffee_reminder: current.coffeeReminderEnabled,
        lunch_reminder: current.lunchReminderEnabled,
        pet_interactions: interactions,
      }
    },
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

  // The pet introduces itself, once, on a genuinely new install.
  //
  // Gated on `settings.firstRun` — "no settings file existed" — rather than on the analytics install
  // id. Those differ for anyone upgrading into the analytics release: they mint an id for the first
  // time but have had the pet for months, and being introduced to it would be strange.
  //
  // Sticky, so it waits to be acknowledged rather than passing by while someone is looking
  // elsewhere. Dismissing it is also the first click on the pet, which teaches the interaction
  // without a tutorial.
  if (settings.firstRun) {
    callouts.show({
      sourceId: 'broadcast',
      text: `Hi, I'm ${petMeta.displayName} — on duty! 👋`,
      tone: 'info',
      priority: 'normal',
      sticky: true,
      animation: 'waving',
    })
  }

  // Fire-and-forget: analytics must never delay the pet appearing, and every failure inside is
  // already swallowed and logged.
  void (async () => {
    // Mint the id before anything is captured. `patchNow` rather than `patch` for the same reason
    // `seenBroadcastIds` uses it — a crash in the next few hundred milliseconds would otherwise mint
    // a second id on the next launch and report one machine as two installs.
    let installId = settings.get().installId
    const isNewInstall = installId === null
    if (isNewInstall) {
      installId = randomUUID()
      await settings.patchNow({ installId })
    }
    analytics.setInstallId(installId ?? 'unknown')

    await analytics.start()

    // `firstRun` is "no settings file existed", not "no install id" — the difference matters exactly
    // once, on the release that introduces analytics, when every existing user mints an id for the
    // first time. Without it they would all report as new installs on upgrade day.
    if (settings.firstRun) await analytics.capture('app_installed')

    // No analytics notice in a bubble. The pet's first words are a greeting, and a consent-form
    // sentence in the middle of one reads as an interruption rather than as courtesy.
    //
    // The disclosure is not gone, it has moved to where someone looks for it rather than where they
    // cannot avoid it: the About dialog states the current setting on every open, the menu item
    // shows it as a tick, and README / INSTALL / SECURITY / the site footer all describe it.

    await analytics.capture('app_launched', {
      migrated_install: isNewInstall && !settings.firstRun,
    })
    await analytics.flush()
  })()

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
      alwaysOnTop: { value: effectiveAlwaysOnTop(), isDefault: current.alwaysOnTop === null },
      petSize: { value: effectivePetSize(), isDefault: current.petSize === null },
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
      coffee: current.coffeeReminderEnabled,
      lunch: current.lunchReminderEnabled,
      analyticsEnabled: current.analyticsEnabled,
      autoUpdateEnabled: current.autoUpdateEnabled,
      update: updateState,
    }
  }

  /**
   * The whole of crash reporting: no crash data is ever uploaded.
   *
   * Analytics report *that* the app ran, never *why* it stopped — there is no stack trace, no error
   * text and no log content in any event. A problem still only reaches us if a person sends it.
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
    effectivePetSize,
    effectiveAlwaysOnTop,
    showAbout: () =>
      void showAbout(petMeta, settings.recovery?.reason ?? null, settings.get().analyticsEnabled),
    reportProblem,
    captureEvent: (event, properties) => analytics.capture(event, properties),
    flushAnalytics: () => analytics.flush(),
    checkForUpdates: () => {
      // If an update is already known: Mac installs (or starts the download); other OSes open notes.
      if (updateState.state === 'available' || updateState.state === 'ready') {
        updates?.actOnKnownUpdate(async () => {
          installingUpdate = true
          await settings.flush()
        })
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
    onPopupChanged(open) {
      settingsMenuOpen = open
      if (!open) syncHoverMenu()
    },
  })

  const tray = createTray({
    buildTemplate: () => menu.template(),
    tooltip: `${PRODUCT_NAME} — ${petMeta.displayName}`,
  })
  trayRef = tray

  // Any settings change re-renders the menus, so a checkbox can never disagree with the store.
  const stopSettingsWatch = settings.onChange((next, _prev, changed) => {
    menu.refresh()

    // Feature adoption, captured here rather than in each action so there is one place that knows
    // which settings are reportable and no way for a new toggle to start reporting by accident.
    //
    // `position` and `reminders` are excluded on purpose: position is a screen coordinate, and the
    // reminder deadlines change every few minutes, so both would be noise at best.
    for (const key of REPORTABLE_SETTINGS) {
      if (changed.includes(key)) {
        void analytics.capture('setting_changed', { setting: key, value: next[key] })
      }
    }
    // Enabling a reminder must schedule it now rather than at the next 15s tick, and disabling must
    // clear its deadline immediately.
    if (
      changed.includes('waterReminderEnabled') ||
      changed.includes('stretchReminderEnabled') ||
      changed.includes('coffeeReminderEnabled') ||
      changed.includes('lunchReminderEnabled')
    ) {
      reminders.evaluateNow()
    }
  })

  const stopHarnessControl = installHarnessControl({
    pet: () => pet.win,
    backdrop: () => backdrop,
    spriteRect: () => pet.spriteRect(),
    bubbleBand: () => pet.bubbleBand(),
    setMovement: (enabled) => {
      // The same three steps `toggleMovement` takes — durable setting, immediate trigger, out-of-phase
      // tick — so freezing the pet for a screenshot goes through the real path rather than a back door
      // that could diverge from it.
      settings.patch({ movementEnabled: enabled })
      controller?.enqueue({ kind: 'movement-changed', enabled })
      controller?.tickNow()
    },
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
    analytics,
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

      // Record the session length, then stop the timer and make one bounded attempt to send.
      // Bounded because quit is on a deadline: `before-quit` is holding process exit open, and an
      // unreachable server must not turn "Quit" into a hang. Anything unsent is already on disk and
      // goes out on the next launch — which is the entire reason the queue exists.
      await analytics.capture('app_quit', {
        session_id: sessionId,
        session_minutes: Math.round((Date.now() - sessionStartedAt) / 60_000),
      })
      analytics.stop()
      await Promise.race([
        analytics.flush(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_500)
          ;(timer as unknown as { unref?: () => void }).unref?.()
        }),
      ])

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
    // Squirrel.Mac applies the swap after a normal quit. preventDefault + app.exit(0) would
    // kill the process and the new version would never launch.
    if (installingUpdate) return
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

async function showAbout(
  pet: PetMetadata,
  recoveryReason: string | null,
  analyticsEnabled: boolean,
): Promise<void> {
  const detail = [
    `Version ${app.getVersion()}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    `Pet: ${pet.displayName} (${pet.id})`,
    '',
    // Stated here as well as in the menu, because About is where people look to find out what a
    // program does, and "off" is only reassuring if it is visible somewhere without hunting.
    `Anonymous usage data: ${analyticsEnabled ? 'on' : 'off'} (change in the right-click menu)`,
    '',
    'Includes code adapted from openpets (MIT).',
    ...(logFilePath() ? ['', `Log: ${logFilePath()}`] : []),
    ...(recoveryReason
      ? ['', `Note: settings were reset after a read error (${recoveryReason}).`]
      : []),
  ].join('\n')

  await dialog.showMessageBox({
    type: 'info',
    message: PRODUCT_NAME,
    detail,
    buttons: ['OK'],
    noLink: true,
  })
}
