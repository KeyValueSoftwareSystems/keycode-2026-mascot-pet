/**
 * Entry point. The ordering in this file is load-bearing — see the comments.
 *
 * Boot sequence:
 *   1. Chromium command-line switches, synchronously, before anything can await.
 *   2. Single-instance lock, before `whenReady`.
 *   3. On ready: dock/activation policy, then hand off to `app-shell.ts`.
 */

import { existsSync, cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { emit } from './harness-handshake.js'
import { log } from './logger.js'
import { LEGACY_PRODUCT_NAME, PRODUCT_NAME } from '../config/constants.js'

/** Set once the shell is up. Until then a second launch has nothing to focus. */
let shellOnSecondInstance: (() => void) | null = null

// ---------------------------------------------------------------------------------------
// 1. Command-line switches.
//
// These MUST run before the app is ready and before any top-level `await` in this module.
// Main is ESM, so a top-level await here would yield to the microtask queue and let `ready`
// fire first, at which point these switches are silently ignored.
// ---------------------------------------------------------------------------------------

/**
 * `appendSwitch` *overwrites* an existing value rather than appending to it, so setting
 * `disable-features` naively would clobber anything Electron or another call already put
 * there. Read, merge, write.
 */
function appendToSwitchList(name: string, value: string): void {
  const existing = app.commandLine.getSwitchValue(name)
  const parts = existing ? existing.split(',').filter(Boolean) : []
  if (!parts.includes(value)) parts.push(value)
  app.commandLine.appendSwitch(name, parts.join(','))
}

function applyCommandLineSwitches(): void {
  if (process.platform === 'linux' && process.env.KEYCODE_PET_OZONE !== 'native') {
    // Native Wayland forbids a client positioning or restacking its own toplevel, which
    // silently breaks motion, drag and always-on-top all at once. XWayland is the Linux
    // target; `KEYCODE_PET_OZONE=native` opts back in and accepts a pet that cannot move.
    app.commandLine.appendSwitch('ozone-platform', 'x11')
  }

  if (process.platform === 'win32') {
    // Chromium's native occlusion tracker treats every window on a display as occluded
    // while a fullscreen app is active there and stops painting it. A transparent
    // always-on-top pet then goes blank even though its z-order is intact — the window is
    // still "on top" of a game, it has just stopped being drawn.
    appendToSwitchList('disable-features', 'CalculateNativeWinOcclusion')
  }

  // An escape hatch for the one thing still unverified anywhere: `webContents.capturePage()` does not
  // return on a Windows CI runner, on an app that is otherwise demonstrably alive and emitting frames.
  // GPU compositing on a session with no real display is the leading suspect, so the release workflow
  // can try turning it off for that leg without a code change — and if it turns out to be the cause,
  // that is a finding about the runner rather than about the app, which is why this is opt-in and not
  // a default.
  if (process.env.KEYCODE_PET_DISABLE_GPU_COMPOSITING === '1') {
    app.commandLine.appendSwitch('disable-gpu-compositing')
  }
}

// ---------------------------------------------------------------------------------------
// 3. Ready. (Defined before use; invoked at the bottom.)
// ---------------------------------------------------------------------------------------

async function boot(): Promise<void> {
  // The pet is a background companion, never a foreground app. `dock.hide()` alone leaves
  // it a "regular" app for activation purposes, which lets it steal focus and interferes
  // with cross-Space visibility; `accessory` is what actually makes it passive.
  if (process.platform === 'darwin') {
    app.dock?.hide()
    app.setActivationPolicy('accessory')
  }
  if (process.platform === 'win32') {
    app.setAppUserModelId('systems.keyvalue.keycodepet')
  }

  await app.whenReady()
  log('app ready', { packaged: app.isPackaged, version: app.getVersion() })

  emit({
    ev: 'app-ready',
    pid: process.pid,
    version: app.getVersion(),
    platform: process.platform,
  })

  // Imported after `whenReady` so nothing touches `screen` or `BrowserWindow` too early.
  const { startApp } = await import('./app-shell.js')
  const shell = await startApp()
  shellOnSecondInstance = shell.onSecondInstance
}

// ---------------------------------------------------------------------------------------
// 2. Single-instance lock.
//
// `app.exit(0)` rather than `app.quit()` for the losing instance: `quit()` runs the
// `before-quit` chain, which flushes the settings file — a file the *first* instance owns.
// A second launch must not write to it.
// ---------------------------------------------------------------------------------------

applyCommandLineSwitches()

// MUST precede `requestSingleInstanceLock()`. The lock is a file inside `userData`, so taking
// it resolves and caches that path — and `userData` is derived from `app.getName()`. Setting
// the name afterwards is silently too late: the app keeps running, but its settings land in
// a directory named after the package (`@keycode/desktop`) instead of the product, and a
// later rename orphans the user's saved position and toggles.
app.setName(PRODUCT_NAME)

{
  const destDir = app.getPath('userData')
  const destFile = join(destDir, 'settings.json')
  const srcFile = join(app.getPath('appData'), LEGACY_PRODUCT_NAME, 'settings.json')
  if (existsSync(srcFile) && !existsSync(destFile)) {
    mkdirSync(destDir, { recursive: true })
    cpSync(srcFile, destFile)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    emit({ ev: 'second-instance' })
    shellOnSecondInstance?.()
  })

  app.on('window-all-closed', () => {
    // Deliberately empty: this is a tray app. Closing the pet window must not quit it —
    // quit happens only through the menu, which calls `app.quit()` explicitly.
  })

  void boot().catch((error: unknown) => {
    emit({ ev: 'error', where: 'boot', message: String(error) })
    // To a file, not the console: a packaged app has no usable stdio, and a boot failure with no
    // trace is the single worst thing to hand a colleague.
    log('BOOT FAILED', { error: String((error as Error)?.stack ?? error) })
    app.exit(1)
  })
}

process.on('uncaughtException', (error) => {
  emit({ ev: 'error', where: 'uncaughtException', message: String(error?.stack ?? error) })
  log('UNCAUGHT EXCEPTION', { error: String(error?.stack ?? error) })
})

process.on('unhandledRejection', (reason) => {
  emit({ ev: 'error', where: 'unhandledRejection', message: String(reason) })
  log('UNHANDLED REJECTION', { reason: String(reason) })
})
