/**
 * Update checking.
 *
 * Packaged builds announce a newer version, then download only after a click, then quit, swap the
 * app, and relaunch. Unpackaged (`pnpm dev`) still opens the download page: there is no bundle
 * to replace.
 *
 * A background poll that fails says nothing. A user who clicked "Check for updates…" and is
 * *waiting* must be told something — silence there reads as a broken menu item. So `checkNow`
 * always reports an outcome, via a toast rather than a dialog: a modal breaks the illusion, and
 * with the dock hidden it can open behind everything.
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
  /** Packaged auto-update. Absent in tests and in `pnpm dev`. */
  startDownload?: () => boolean
  isReady?: () => boolean
  applyUpdate?: () => boolean
}

export interface UpdateService {
  /** Wire to the poller's `onRelease`. */
  onReleaseFromPoll(release: SafeRelease | null): void
  /** The installer finished downloading. Packaged builds quit and relaunch. */
  onDownloaded(version: string): void
  /** Quit, apply, relaunch if a download is waiting. */
  applyIfReady(): boolean
  /**
   * Bubble click. Applies a finished download, or starts one. Returns true when the click
   * was handled here so the download page does not also open.
   */
  beginInstall(): boolean
  /** The menu item. Always reports an outcome. */
  checkNow(): Promise<void>
  /** Open the notes for the currently known release. */
  openNotes(): boolean
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

  const applyIfReady = (): boolean => {
    if (!deps.isReady?.()) return false
    return deps.applyUpdate?.() === true
  }

  const beginInstall = (): boolean => {
    if (applyIfReady()) return true
    if (!deps.startDownload?.()) return false
    log('update download started', { version: latestVersion })
    deps.showToast({ text: `Downloading version ${latestVersion}…`, tone: 'success' })
    return true
  }

  const announceReady = (version: string): void => {
    latestVersion = version
    setState('downloaded')
    deps.submitCallout({
      sourceId: 'update',
      text: `Version ${version} is ready. Click to restart.`,
      tone: 'success',
      priority: 'high',
      sticky: true,
      animation: 'jumping',
    })
    log('update ready to install', { version })
  }

  return {
    onReleaseFromPoll(release: SafeRelease | null): void {
      if (!release) {
        if (state !== 'available' && state !== 'downloaded') setState('current')
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

      // Announce once per *version*, not once per install — deliberately different from broadcast
      // dedupe, because a further version must be able to announce again.
      const alreadyAnnounced = deps.getLastKnownRelease() === release.latestVersion
      setState(deps.isReady?.() ? 'downloaded' : 'available')

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
        // app has when we cannot replace the running bundle (dev, or a failed auto-update).
        priority: release.mandatory ? 'high' : 'normal',
        ...(release.mandatory ? { pin: true, sticky: true } : {}),
        animation: 'jumping',
        ...(release.notesUrl ? { url: release.notesUrl } : {}),
      })

      log('update available', { version: release.latestVersion, mandatory: release.mandatory })
    },

    onDownloaded(version: string): void {
      latestVersion = version
      setState('downloaded')
      if (deps.applyUpdate) {
        log('update ready, restarting', { version })
        deps.applyUpdate()
        return
      }
      announceReady(version)
    },

    applyIfReady,
    beginInstall,

    async checkNow(): Promise<void> {
      if (applyIfReady()) return
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

        if (deps.isReady?.()) {
          setState('downloaded')
          deps.showToast({ text: `Version ${latestVersion} is ready. Restarting…`, tone: 'success' })
          deps.applyUpdate?.()
          return
        }

        if (latestVersion && isNewer(latestVersion, deps.currentVersion)) {
          setState('available')
          if (latestVersion === before) {
            // A second "Check for updates…" is the user asking to install, not to be told again.
            if (beginInstall()) return
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

    view,
  }
}
