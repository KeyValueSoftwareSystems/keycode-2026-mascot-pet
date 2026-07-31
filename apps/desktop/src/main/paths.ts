/**
 * Filesystem paths, resolved once.
 *
 * ESM main means there is no `__dirname`, and the built layout differs from the source
 * layout, so every path is derived from `import.meta.url` here rather than guessed at each
 * call site.
 *
 * Built layout (what this file reasons about):
 *   apps/desktop/dist/main/paths.js      ← this file at runtime
 *   apps/desktop/dist/renderer/*.html    ← vite output
 *   apps/desktop/assets/**               ← copied verbatim, outside the bundle
 *   pet/**                               ← the art, at the repo/app root
 */

import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { app } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))

/** `apps/desktop/dist` in a build, or the tsc output dir in dev. */
const distDir = resolve(here, '..')

/** `apps/desktop` — the package root. */
const packageDir = resolve(distDir, '..')

/**
 * In a packaged app everything lives under `app.asar`; `app.getAppPath()` points at it.
 * In dev it points at the package dir, so both cases resolve the same way.
 */
function appRoot(): string {
  return app.isPackaged ? app.getAppPath() : packageDir
}

export function rendererFile(name: string): string {
  return join(distDir, 'renderer', name)
}

export function assetPath(...parts: string[]): string {
  return join(appRoot(), 'assets', ...parts)
}

/**
 * The pet art directory. Lives at the repo root in dev and is copied to the app root at
 * package time, so the same relative lookup works in both.
 */
export function petAssetPath(...parts: string[]): string {
  return app.isPackaged
    ? join(app.getAppPath(), 'pet', ...parts)
    : resolve(packageDir, '..', '..', 'pet', ...parts)
}

export function userDataDir(): string {
  return app.getPath('userData')
}

export const paths = { distDir, packageDir, rendererFile, assetPath, petAssetPath, userDataDir }
