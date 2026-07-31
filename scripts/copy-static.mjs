#!/usr/bin/env node
/**
 * Copy non-compiled runtime files into the build output.
 *
 * Two things need this and neither is handled by tsc or Vite:
 *
 * 1. **The preload.** It is `.cjs` on purpose — a sandboxed preload cannot be an ES module — so
 *    tsc (which is compiling ESM TypeScript) does not emit it, and Vite does not own it either.
 *
 * 2. **The spritesheet.** The generated CSS refers to it by literal filename, so it must not be
 *    fingerprinted by the bundler; and it cannot be copied at runtime because in a packaged app
 *    `dist/` lives inside a read-only asar archive.
 *
 * Runs after `vite build`, which empties `dist/renderer`.
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const APP = join(ROOT, 'apps', 'desktop')
const DIST = join(APP, 'dist')

/** [from, to] pairs, relative to the repo root and to `dist` respectively. */
const COPIES = [
  ['apps/desktop/src/preload/pet-preload.cjs', 'preload/pet-preload.cjs'],
  ['apps/desktop/src/preload/toast-preload.cjs', 'preload/toast-preload.cjs'],
  ['pet/spritesheet.png', 'renderer/spritesheet.png'],
]

async function main() {
  for (const [from, to] of COPIES) {
    const source = join(ROOT, from)
    const target = join(DIST, to)
    if (!existsSync(source)) {
      console.error(`copy-static: missing source ${from}`)
      process.exit(1)
    }
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }
  console.log(`✓ copy-static: ${COPIES.length} file(s)`)
}

main().catch((error) => {
  console.error('copy-static failed', error)
  process.exit(1)
})
