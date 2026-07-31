import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The packaging config, asserted rather than hoped about.
 *
 * This is why the config is CJS rather than YAML: an untested `files` filter is exactly how 3MB of
 * reference art ends up in every installer, or how a renamed asset silently stops shipping — and
 * neither shows up until someone downloads a build.
 */

const REPO = resolve(import.meta.dirname, '..', '..')
const require = createRequire(import.meta.url)
const config = require(resolve(REPO, 'electron-builder.config.cjs')) as {
  appId: string
  productName: string
  asar: boolean
  publish: unknown
  artifactName: string
  files: Array<string | { from: string; to: string; filter: string[] }>
  mac: Record<string, unknown>
  win: Record<string, unknown>
  nsis: Record<string, unknown>
  linux: Record<string, unknown>
  directories: Record<string, string>
}

/** Flatten the allow-list into plain glob strings plus explicit from/to entries. */
const globs = config.files.filter((entry): entry is string => typeof entry === 'string')
const mappings = config.files.filter(
  (entry): entry is { from: string; to: string; filter: string[] } => typeof entry !== 'string',
)

describe('files filter', () => {
  it('is an allow-list: every positive glob is rooted in a specific directory', () => {
    // Naming what ships means a future file in pet/ is excluded by default rather than by accident.
    // Wildcards are fine — an unrooted one is not, because `**/*` at the top level would sweep in the
    // whole repository including docs/, scripts/, tests/ and the reference art.
    const positive = globs.filter((glob) => !glob.startsWith('!'))
    expect(positive.length).toBeGreaterThan(0)
    for (const glob of positive) {
      expect(glob.startsWith('**'), `${glob} is not rooted`).toBe(false)
      expect(
        glob.startsWith('apps/desktop/') || glob === 'package.json',
        `${glob} is outside apps/desktop and is not the root manifest`,
      ).toBe(true)
    }
  })

  it('ships only the three pet files that are actually needed', () => {
    const petMapping = mappings.find((entry) => entry.from === 'pet')
    expect(petMapping).toBeDefined()
    expect(petMapping!.filter.sort()).toEqual(['pet.json', 'spritesheet.json'])
  })

  it('excludes the reference art', () => {
    // ~3MB of source sheet, preview render and validation output that no runtime path reads.
    const petMapping = mappings.find((entry) => entry.from === 'pet')!
    for (const excluded of ['source-sheet.png', 'preview.png', 'validation.json', 'README.md']) {
      expect(petMapping.filter).not.toContain(excluded)
    }
  })

  it('excludes pet/spritesheet.png, because the renderer bundle already contains it', () => {
    // Easy to miss: the brief's exclusion list does not mention it, and shipping both pays for the
    // sprite twice.
    const petMapping = mappings.find((entry) => entry.from === 'pet')!
    expect(petMapping.filter).not.toContain('spritesheet.png')
  })

  it('ships no source maps or TypeScript', () => {
    expect(globs).toContain('!**/*.map')
    expect(globs).toContain('!**/*.ts')
  })

  it('references neither reference/, docs/, scripts/ nor tests/', () => {
    for (const glob of globs) {
      for (const forbidden of ['reference/', 'docs/', 'scripts/', 'tests/', 'manifest/']) {
        expect(glob, `${glob} must not reference ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('ships the build output and the tray icon, but not the whole assets tree', () => {
    expect(globs).toContain('apps/desktop/dist/**/*')
    // Only the tray icon is read from disk at runtime. Shipping all of `assets/` duplicated the
    // 4.8MB emoji font — Vite already emits a fingerprinted copy into dist/renderer, and the
    // generated CSS references that one. The duplicate was three quarters of a 13MB archive.
    expect(globs).toContain('apps/desktop/assets/tray/**/*')
    expect(globs).not.toContain('apps/desktop/assets/**/*')
  })

  it('does not ship the emoji font twice', () => {
    for (const glob of globs) {
      expect(glob, `${glob} would re-ship assets/fonts`).not.toMatch(/assets\/fonts/)
    }
  })
})

describe('macOS target', () => {
  it('builds dmg and zip for both architectures', () => {
    const targets = config.mac.target as Array<{ target: string; arch: string[] }>
    expect(targets.map((t) => t.target).sort()).toEqual(['dmg', 'zip'])
    for (const target of targets) {
      expect(target.arch.sort()).toEqual(['arm64', 'x64'])
    }
  })

  it('is ad-hoc signed', () => {
    // Without any signature, Gatekeeper on Apple Silicon reports "damaged and can't be opened",
    // which reads as a broken build rather than an unsigned one.
    expect(config.mac.identity).toBe('-')
    expect(config.mac.hardenedRuntime).toBe(false)
    expect(config.mac.gatekeeperAssess).toBe(false)
  })

  it('declares LSUIElement so no dock icon flashes at launch', () => {
    // The plist counterpart to app.dock.hide(); without it there is a visible seam at startup.
    expect((config.mac.extendInfo as Record<string, unknown>).LSUIElement).toBe(true)
  })

  it('points at a committed icns', () => {
    expect(config.mac.icon).toBe('build/icon.icns')
    expect(existsSync(resolve(REPO, 'build/icon.icns'))).toBe(true)
  })
})

describe('Windows target', () => {
  it('builds an NSIS installer', () => {
    const targets = config.win.target as Array<{ target: string; arch: string[] }>
    expect(targets.map((t) => t.target)).toEqual(['nsis'])
  })

  it('installs per-user, so no elevation prompt', () => {
    expect(config.nsis.perMachine).toBe(false)
    expect(config.nsis.oneClick).toBe(false)
  })

  it('does not verify an update signature it cannot have', () => {
    expect(config.win.verifyUpdateCodeSignature).toBe(false)
  })

  it('points at a committed ico', () => {
    expect(existsSync(resolve(REPO, 'build/icon.ico'))).toBe(true)
  })
})

describe('Linux target', () => {
  it('builds exactly the four expected targets', () => {
    expect(config.linux.target).toEqual(['AppImage', 'deb', 'rpm', 'tar.gz'])
  })

  it('points at a committed icon directory', () => {
    expect(config.linux.icon).toBe('build/icons')
    for (const size of [16, 32, 48, 64, 128, 256, 512]) {
      expect(existsSync(resolve(REPO, `build/icons/${size}x${size}.png`)), `${size}px`).toBe(true)
    }
  })
})

describe('general', () => {
  it('has asar disabled, because Electron 42 cannot load an ESM entry point from inside one', () => {
    // Empirical, not stylistic. With asar: true the packaged app starts, stays alive, and never runs
    // its main script — no windows, no log, no error. Verified by building both ways.
    expect(config.asar).toBe(false)
    expect(config).not.toHaveProperty('asarUnpack')
  })

  it('never auto-publishes', () => {
    // Publishing is a deliberate act, not a side effect of a build.
    expect(config.publish).toBeNull()
  })

  it('names artifacts with product, version, os and arch', () => {
    for (const token of ['${productName}', '${version}', '${os}', '${arch}', '${ext}']) {
      expect(config.artifactName).toContain(token)
    }
  })

  it('has a stable app id', () => {
    expect(config.appId).toBe('systems.keyvalue.keycodepet')
  })
})

describe('required assets exist on disk', () => {
  it('every asset the build or the runtime depends on is present', () => {
    // Catches a rename of the font, the tray icon or the mask. Not all of these are *shipped* — the
    // font is consumed by Vite and re-emitted into dist, and the mask JSON exists for tests — but all
    // of them break something if they move.
    const required = [
      'apps/desktop/assets/fonts/NotoColorEmoji-COLRv1.ttf',
      'apps/desktop/assets/tray/trayIconTemplate.png',
      'apps/desktop/assets/tray/trayIconTemplate@2x.png',
      'apps/desktop/assets/pet/alpha-mask.json',
      'pet/spritesheet.json',
      'pet/pet.json',
      'build/icon.icns',
      'build/icon.ico',
      'build/icon.png',
    ]
    for (const path of required) {
      expect(existsSync(resolve(REPO, path)), path).toBe(true)
    }
  })
})
