/**
 * macOS in-place update, using Electron's built-in autoUpdater (Squirrel.Mac).
 *
 * No extra dependency: Windows and Linux keep opening the download page. quitAndInstall relaunches
 * after the swap — but only if before-quit does not preventDefault and app.exit the process.
 */

import { autoUpdater } from 'electron'
import { assertAllowedUrl } from '../broadcast/url-guard.js'
import { canApplyMacUpdate, macUpdateFeedUrl } from './mac-update-feed.js'

export { canApplyMacUpdate, macUpdateFeedUrl }

export interface MacAutoUpdater {
  readonly canApply: boolean
  check(): void
  /** true if quitAndInstall was invoked. false means still downloading (or not applicable). */
  install(beforeQuitForUpdate: () => Promise<void>): boolean
}

export interface MacAutoUpdaterDeps {
  packaged: boolean
  platform: NodeJS.Platform
  arch: string
  execPath: string
  log: (message: string, meta?: unknown) => void
  onDownloaded: () => void
}

export function createMacAutoUpdater(deps: MacAutoUpdaterDeps): MacAutoUpdater {
  const canApply = canApplyMacUpdate(deps)
  if (!canApply) {
    return {
      canApply: false,
      check() {},
      install() {
        return false
      },
    }
  }

  const feed = macUpdateFeedUrl({ arch: deps.arch })
  let downloaded = false
  let checking = false
  let installing = false

  try {
    const url = assertAllowedUrl(feed)
    autoUpdater.setFeedURL({ url: url.toString() })
  } catch (error) {
    deps.log('update feed rejected', { error: String(error), feed })
    return {
      canApply: false,
      check() {},
      install() {
        return false
      },
    }
  }

  autoUpdater.on('update-downloaded', () => {
    downloaded = true
    checking = false
    deps.log('update downloaded')
    deps.onDownloaded()
  })
  autoUpdater.on('update-not-available', () => {
    checking = false
  })
  autoUpdater.on('error', (error) => {
    checking = false
    deps.log('auto-update error', { error: String(error) })
  })

  return {
    canApply: true,
    check() {
      if (checking || downloaded || installing) return
      checking = true
      try {
        autoUpdater.checkForUpdates()
      } catch (error) {
        checking = false
        deps.log('checkForUpdates failed', { error: String(error) })
      }
    },
    install(beforeQuitForUpdate) {
      if (!downloaded || installing) {
        this.check()
        return false
      }
      installing = true
      void beforeQuitForUpdate()
        .catch((error: unknown) => {
          deps.log('flush before update failed', { error: String(error) })
        })
        .finally(() => {
          autoUpdater.quitAndInstall()
        })
      return true
    },
  }
}
