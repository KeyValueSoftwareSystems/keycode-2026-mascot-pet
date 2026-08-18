/**
 * Packaged auto-update: download when the user asks, then quit, replace the app, and relaunch.
 *
 * Unpackaged (`pnpm dev`) is a no-op — there is no bundle to replace. Production builds are
 * Developer ID signed and notarized, which is what makes Squirrel.Mac's signature check pass.
 */

import { REPO_URL } from '../config/constants.js'

export interface SilentUpdater {
  /** Kick a background check/download. No-op when unpackaged or already in flight. */
  check(): boolean
  /** True after the new version has been downloaded and is waiting to apply. */
  isReady(): boolean
  /**
   * Quit, apply the downloaded update, and reopen. Returns false if nothing is ready
   * (unpackaged, or the download has not finished).
   */
  quitAndInstall(): boolean
  /**
   * True between `quitAndInstall` and process exit. `before-quit` must not `preventDefault`
   * in that window — electron-updater applies the swap on `will-quit`, and intercepting
   * quit with `app.exit(0)` skips the installer and the relaunch.
   */
  isInstalling(): boolean
}

export interface SilentUpdaterOptions {
  packaged: boolean
  log?: (message: string, meta?: unknown) => void
  onReady: (version: string) => void
  onError?: (message: string) => void
}

export function githubFromRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  if (!match) return null
  return { owner: match[1]!, repo: match[2]! }
}

export function createSilentUpdater(options: SilentUpdaterOptions): SilentUpdater {
  const log = options.log ?? (() => {})

  if (!options.packaged) {
    return {
      check: () => false,
      isReady: () => false,
      quitAndInstall: () => false,
      isInstalling: () => false,
    }
  }

  const feed = githubFromRepoUrl(REPO_URL)
  if (!feed) {
    log('auto-update skipped: could not parse GitHub repo from REPO_URL')
    return {
      check: () => false,
      isReady: () => false,
      quitAndInstall: () => false,
      isInstalling: () => false,
    }
  }

  let ready = false
  let checking = false
  let installing = false
  let quitAndInstallImpl: (() => void) | null = null

  const loaded = import('electron-updater')
    .then(({ autoUpdater }) => {
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.autoRunAppAfterInstall = true
      autoUpdater.allowPrerelease = false
      autoUpdater.setFeedURL({ provider: 'github', owner: feed.owner, repo: feed.repo })
      autoUpdater.on('update-downloaded', (info) => {
        ready = true
        const version = info.version || 'newer'
        log('update downloaded', { version })
        options.onReady(version)
      })
      autoUpdater.on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error)
        log('auto-update failed', { message })
        options.onError?.(message)
      })
      quitAndInstallImpl = () => {
        installing = true
        // Silent on Windows; unused on macOS. Force relaunch after the swap so the pet
        // comes back by itself rather than staying quit.
        autoUpdater.quitAndInstall(true, true)
      }
      return autoUpdater
    })
    .catch((error) => {
      log('auto-update unavailable', { error: String(error) })
      return null
    })

  return {
    check(): boolean {
      if (checking) return true
      checking = true
      void loaded
        .then((autoUpdater) => {
          if (!autoUpdater) return
          return autoUpdater.checkForUpdates()
        })
        .catch((error) => {
          log('auto-update check failed to start', { error: String(error) })
        })
        .finally(() => {
          checking = false
        })
      return true
    },
    isReady: () => ready,
    isInstalling: () => installing,
    quitAndInstall(): boolean {
      if (!ready || !quitAndInstallImpl) return false
      quitAndInstallImpl()
      return true
    },
  }
}
