/**
 * The security posture applied to every window we create, without exception.
 *
 * Centralised so "did this window get locked down" is answered by one call rather than by
 * reading each window's construction site. The `webPreferences` half is a constant the
 * callers spread in; the navigation half is a function they call after construction.
 */

import type { BrowserWindow, WebPreferences } from 'electron'
import { emit } from './harness-handshake.js'

/**
 * Non-negotiable renderer settings. `sandbox: true` is what makes the preload unable to
 * `require` anything outside Electron's allowlist — which is why zod validation of the
 * PetFrame happens in main and in the renderer bundle, never in the preload.
 */
export const SECURE_WEB_PREFERENCES = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  // No renderer of ours needs to talk to another window.
  nodeIntegrationInSubFrames: false,
} as const satisfies WebPreferences

/**
 * Deny every form of navigation and window opening.
 *
 * `will-navigate` does not fire for `loadFile`, so this does not interfere with our own
 * page loads — it only catches a page trying to move itself, which for us is always a bug
 * or an attack.
 */
export function applyWindowSecurity(win: BrowserWindow, label: string): void {
  const { webContents } = win

  webContents.setWindowOpenHandler(({ url }) => {
    // Nothing in this app legitimately opens a window. External links go through
    // `openExternalChecked`, which validates the scheme first.
    emit({ ev: 'error', where: `${label}:window-open`, message: `denied ${url.slice(0, 120)}` })
    return { action: 'deny' }
  })

  webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    emit({ ev: 'error', where: `${label}:will-navigate`, message: `blocked ${url.slice(0, 120)}` })
  })

  webContents.on('will-redirect', (event, url) => {
    event.preventDefault()
    emit({ ev: 'error', where: `${label}:will-redirect`, message: `blocked ${url.slice(0, 120)}` })
  })

  // A sandboxed renderer cannot reach these, but attaching a WebView or a devtools
  // extension could. Refuse both rather than reason about whether they are reachable.
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  webContents.setVisualZoomLevelLimits(1, 1).catch(() => {
    /* not fatal; only affects pinch-zoom on a window the user cannot focus anyway */
  })

  webContents.on('render-process-gone', (_event, details) => {
    emit({ ev: 'error', where: `${label}:render-process-gone`, message: details.reason })
  })
}
