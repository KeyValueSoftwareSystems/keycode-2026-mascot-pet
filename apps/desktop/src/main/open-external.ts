/**
 * The single choke point for opening a URL outside the app.
 *
 * `shell.openExternal` on an unvalidated string is a genuine local-execution vector: `file://` opens
 * a local path, `smb://` reaches a network share, and any application installed on the machine can
 * have registered a custom scheme that does something on being handed a URL. The manifest is remote
 * input, so every URL that reaches here has to be re-checked.
 *
 * Re-checked, note, even though the schema already validated it. The schema check happens when the
 * manifest is parsed; this one happens at the moment of use, which is the check that still holds if
 * the value was ever cached, persisted, or restored from disk in between.
 */

import { shell } from 'electron'
import { assertAllowedUrl, UnsafeUrlError } from '../broadcast/url-guard.js'
import { emit } from './harness-handshake.js'

export interface OpenExternalOptions {
  log?: (message: string, meta?: unknown) => void
}

/**
 * Open an https URL in the user's browser.
 *
 * @returns whether it was opened. Never throws — a bad link is a non-event, not a crash.
 */
export function openExternalChecked(
  raw: string | null | undefined,
  options: OpenExternalOptions = {},
): boolean {
  const log = options.log ?? (() => {})

  let url: URL
  try {
    // Loopback HTTP is never permitted here, whatever the manifest fetch is allowed to do: a dev
    // convenience for reading a file is not a reason to hand a local address to the OS.
    url = assertAllowedUrl(raw, { allowLoopbackHttp: false })
  } catch (error) {
    const reason = error instanceof UnsafeUrlError ? error.reason : 'invalid'
    log('refused to open an external URL', { reason, raw: String(raw).slice(0, 80) })
    emit({ ev: 'error', where: 'open-external', message: `refused (${reason})` })
    return false
  }

  try {
    void shell.openExternal(url.toString())
    log('opened an external URL', { host: url.host })
    return true
  } catch (error) {
    log('failed to open an external URL', { error: String(error) })
    return false
  }
}
