/**
 * Update checking, on top of the broadcast poll's `release` block.
 *
 * ---------------------------------------------------------------------------------------
 * Why there is no electron-updater.
 * ---------------------------------------------------------------------------------------
 *
 * The brief recommends opening a release page instead of auto-updating, and the recommendation is
 * stronger than it states. Three reasons, in order of weight:
 *
 *   1. **electron-updater cannot update this app on macOS at all.** Squirrel.Mac requires a valid,
 *      consistent code signature across the old and new versions. This app is ad-hoc signed
 *      (`identity: '-'`) because there is no Developer ID, so the signature check fails and the
 *      update silently does not apply. The one platform that can be verified here is the one where
 *      auto-update is structurally impossible.
 *   2. It would need a published `latest-mac.yml` / `latest.yml` feed — a *second endpoint*, when the
 *      locked decision is that OTA reuses the M6 poll.
 *   3. Windows NSIS and Linux AppImage would each need their own handling, for an install base of a
 *      handful of colleagues who can click a link.
 *
 * So: no electron-updater, and the runtime dependency list stays at exactly `zod`. Signed macOS
 * builds now use Electron's built-in autoUpdater instead: download in the background, restart on
 * click. Windows and Linux still open the download page.
 *
 * ---------------------------------------------------------------------------------------
 * One deliberate exception to "failure is silent".
 * ---------------------------------------------------------------------------------------
 *
 * A background poll that fails says nothing. But a user who clicked "Check for updates…" and is
 * *waiting* must be told something — silence there reads as a broken menu item. So `checkNow` always
 * reports an outcome, via a toast rather than a dialog: a modal breaks the illusion, and with the
 * dock hidden it can open behind everything.
 */

import { isNewer } from './version-compare.js'
import type { SafeRelease } from '../broadcast/manifest-schema.js'
import type { PollOutcome } from '../broadcast/broadcast-poller.js'
import type { UpdateState } from '../main/menu-template.js'
import type { CalloutRequest } from '../callouts/callout-arbiter.js'
import type { Tone } from '../pet-frame.js'

export interface UpdateView {
  state: UpdateState
  latestVersion: string | null
  currentVersion: string
}

export interface UpdateServiceDeps {
  currentVersion: string
  /** Persisted, so a version announces once rather than once per poll. */
  getLastKnownRelease: () => string | null
  setLastKnownRelease: (version: string) => void
  submitCallout: (request: CalloutRequest & { url?: string | null }) => void
  showToast: (toast: { text: string; tone: Tone }) => void
  /** Runs a poll. Supplied by the broadcast poller. */
  pollNow: () => Promise<PollOutcome>
  onStateChange: (view: UpdateView) => void
  openReleaseNotes: (url: string | null) => boolean
  log?: (message: string, meta?: unknown) => void
  /**
   * Packaged macOS, not running from a DMG. When true, an available update downloads itself and
   * "Restart to update" swaps the .app; the notes URL is not attached to the callout.
   */
  canApplyInPlace?: boolean
  beginDownload?: () => void
  installAndRelaunch?: (beforeQuitForUpdate: () => Promise<void>) => boolean
  /** Whether auto-downloading / in-place updating should be used on macOS. */
  isAutoUpdateEnabled?: () => boolean
}

export interface UpdateService {
  /** Wire to the poller's `onRelease`. */
  onReleaseFromPoll(release: SafeRelease | null): void
  /** The menu item. Always reports an outcome. */
  checkNow(): Promise<void>
  /** Open the notes for the currently known release. */
  openNotes(): boolean
  /** Menu click while an update is known: install on Mac, otherwise open notes. */
  actOnKnownUpdate(beforeQuitForUpdate: () => Promise<void>): void
  onDownloaded(): void
  view(): UpdateView
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const log = deps.log ?? (() => {})

  let state: UpdateState = 'idle'
  let latestVersion: string | null = null
  let notesUrl: string | null = null
  /** Set while a user-initiated check is running, so the background handler can report its outcome. */
  let userCheckPending = false

  const view = (): UpdateView => ({
    state,
    latestVersion,
    currentVersion: deps.currentVersion,
  })

  const setState = (next: UpdateState): void => {
    state = next
    deps.onStateChange(view())
  }

  return {
    onReleaseFromPoll(release: SafeRelease | null): void {
      if (!release) {
        if (state !== 'available' && state !== 'ready') setState('current')
        return
      }

      notesUrl = release.notesUrl
      const newer = isNewer(release.latestVersion, deps.currentVersion)

      if (!newer) {
        latestVersion = null
        setState('current')
        return
      }

      latestVersion = release.latestVersion

      if (state === 'ready' && deps.getLastKnownRelease() === release.latestVersion) {
        return
      }

      // Announce once per *version*, not once per install — deliberately different from broadcast
      // dedupe, because a further version must be able to announce again.
      const alreadyAnnounced = deps.getLastKnownRelease() === release.latestVersion
      setState('available')
      if (deps.isAutoUpdateEnabled?.() ?? true) deps.beginDownload?.()

      if (alreadyAnnounced) {
        log('update already announced', { version: release.latestVersion })
        return
      }

      deps.setLastKnownRelease(release.latestVersion)

      deps.submitCallout({
        sourceId: 'update',
        text: `Version ${release.latestVersion} is available`,
        tone: 'success',
        // A mandatory release gets a pinned, higher-priority callout — the only durable surface this
        // app has. It does not block, nag modally, or quit: nothing in scope enforces an update.
        priority: release.mandatory ? 'high' : 'normal',
        ...(release.mandatory ? { pin: true, sticky: true } : {}),
        animation: 'jumping',
        // On Mac the bubble must not open the download page; restart is the menu item.
        ...(!deps.canApplyInPlace && release.notesUrl ? { url: release.notesUrl } : {}),
      })

      log('update available', { version: release.latestVersion, mandatory: release.mandatory })
    },

    async checkNow(): Promise<void> {
      if (userCheckPending) return
      userCheckPending = true
      const before = latestVersion
      setState('checking')

      try {
        const outcome = await deps.pollNow()

        if (outcome.kind === 'error') {
          // The deliberate exception: a person is waiting, so say something.
          setState('error')
          deps.showToast({ text: 'Couldn’t check for updates', tone: 'warning' })
          return
        }

        if (latestVersion && isNewer(latestVersion, deps.currentVersion)) {
          if (state !== 'ready') setState('available')
          // Only speak up if this is news; the callout already fired if it was.
          if (latestVersion === before && state !== 'ready') {
            deps.showToast({ text: `Version ${latestVersion} is available`, tone: 'success' })
          }
          return
        }

        setState('current')
        deps.showToast({ text: 'You’re up to date', tone: 'info' })
      } finally {
        userCheckPending = false
      }
    },

    openNotes(): boolean {
      return deps.openReleaseNotes(notesUrl)
    },

    actOnKnownUpdate(beforeQuitForUpdate): void {
      if (state !== 'available' && state !== 'ready') return
      if (deps.canApplyInPlace && deps.installAndRelaunch && (deps.isAutoUpdateEnabled?.() ?? true)) {
        if (deps.installAndRelaunch(beforeQuitForUpdate)) return
        deps.beginDownload?.()
        return
      }
      deps.openReleaseNotes(notesUrl)
    },

    onDownloaded(): void {
      if (!latestVersion) return
      if (!(deps.isAutoUpdateEnabled?.() ?? true)) {
        setState('available')
        return
      }
      setState('ready')
      const version = latestVersion
      deps.submitCallout({
        sourceId: 'update',
        text: `Restart now to install ${version}`,
        tone: 'success',
        priority: 'high',
        sticky: true,
        animation: 'waving',
        clickable: true,
      })
    },

    view,
  }
}
