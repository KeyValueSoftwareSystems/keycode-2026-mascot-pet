/**
 * A small file logger.
 *
 * Added because a packaged macOS app has no usable stdio: launched from Finder there is nowhere for
 * console output to go, and even launched from a terminal the bundle's output does not reach it. The
 * first time the packaged build misbehaved, there was no way to see why — which for an internal tool
 * people will install on their own machines is the difference between a fixable report and "it
 * doesn't work".
 *
 * Writes to `<userData>/logs/main.log`, capped and rotated once, and mirrors to the console in
 * development. Never throws: a logger that can break the app it is diagnosing is worse than none.
 */

import { app } from 'electron'
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Rotate at this size, keeping one previous file. Plenty for diagnosing a launch. */
const MAX_BYTES = 512 * 1024

let logPath: string | null = null
let failed = false

function resolvePath(): string | null {
  if (failed) return null
  if (logPath) return logPath
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'main.log')
    return logPath
  } catch {
    failed = true
    return null
  }
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return
    if (statSync(path).size < MAX_BYTES) return
    renameSync(path, `${path}.1`)
  } catch {
    // A failed rotation just means the file keeps growing. Not worth surfacing.
  }
}

/** Human-readable, one line per entry, with the metadata inlined as JSON when present. */
function format(message: string, meta?: unknown): string {
  const stamp = new Date().toISOString()
  if (meta === undefined) return `${stamp} ${message}\n`
  let rendered: string
  try {
    rendered = typeof meta === 'string' ? meta : JSON.stringify(meta)
  } catch {
    rendered = String(meta)
  }
  return `${stamp} ${message} ${rendered}\n`
}

export function log(message: string, meta?: unknown): void {
  const line = format(message, meta)

  // In development the console is genuinely visible and immediate, so keep using it too.
  if (!app.isPackaged) process.stdout.write(`[keycode-pet] ${line}`)

  const path = resolvePath()
  if (!path) return
  try {
    rotateIfNeeded(path)
    appendFileSync(path, line, 'utf8')
  } catch {
    failed = true
  }
}

/** Where the log lives, for the About dialog and for support requests. */
export function logFilePath(): string | null {
  return resolvePath()
}
