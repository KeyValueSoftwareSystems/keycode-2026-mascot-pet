import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
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
const { createConfig } = require(resolve(REPO, 'electron-builder.create-config.cjs')) as {
  createConfig: (env?: NodeJS.Dict<string>) => {
    mac: Record<string, unknown>
  }
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

  it('keeps the root and app versions in step, and off the 0.0.0 placeholder', () => {
    // `app.getVersion()` reads this, and the update check compares the manifest's `latestVersion`
    // against it. While it sat at the 0.0.0 placeholder, a manifest declaring 0.6.0 handed every
    // install a clickable "update available" bubble pointing at a domain reserved to never resolve.
    // Nothing crashed and no other test failed — the announcement was simply wrong for everybody.
    const root = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8')) as {
      version?: string
    }
    const app = JSON.parse(readFileSync(resolve(REPO, 'apps/desktop/package.json'), 'utf8')) as {
      version?: string
    }
    expect(root.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(root.version).not.toBe('0.0.0')
    expect(app.version, 'apps/desktop/package.json drifted from the root version').toBe(root.version)
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

  it('defaults to ad-hoc signing without credentials', () => {
    // Without any signature, Gatekeeper on Apple Silicon reports "damaged and can't be opened",
    // which reads as a broken build rather than an unsigned one. Signing is env-gated so Windows
    // and Linux CI (and unsigned local builds) keep this path. Pass an empty env so a developer's
    // shell CSC_LINK cannot flip this assertion.
    const unsigned = createConfig({})
    expect(unsigned.mac.identity).toBe('-')
    expect(unsigned.mac.hardenedRuntime).toBe(false)
    expect(unsigned.mac.gatekeeperAssess).toBe(false)
    expect(unsigned.mac.notarize).toBeUndefined()
  })

  it('enables Developer ID signing when CSC_LINK is set', () => {
    const signed = createConfig({ CSC_LINK: 'file.p12' })
    expect(signed.mac.identity).toBeUndefined()
    expect(signed.mac.hardenedRuntime).toBe(true)
    expect(signed.mac.entitlements).toBe('build/entitlements.mac.plist')
    expect(signed.mac.entitlementsInherit).toBe('build/entitlements.mac.plist')
    expect(signed.mac.notarize).toBe(false)
    expect(existsSync(resolve(REPO, 'build/entitlements.mac.plist'))).toBe(true)
  })

  it('notarizes only when Apple credentials accompany signing', () => {
    expect(
      createConfig({
        CSC_LINK: 'file.p12',
        APPLE_API_KEY: '/tmp/key.p8',
        APPLE_API_KEY_ID: 'KEYID',
        APPLE_API_ISSUER: 'issuer-uuid',
      }).mac.notarize,
    ).toBe(true)
    // Notarize creds alone must not flip signing on — that would break unsigned CI.
    expect(createConfig({ APPLE_API_KEY: '/tmp/key.p8' }).mac.identity).toBe('-')
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

  it('does not export createConfig, which electron-builder 26.15 rejects as an unknown key', () => {
    expect(Object.getOwnPropertyNames(config)).not.toContain('createConfig')
  })

  it('names artifacts with product, version, os and arch', () => {
    for (const token of ['${productName}', '${version}', '${os}', '${arch}', '${ext}']) {
      expect(config.artifactName).toContain(token)
    }
  })

  it('announces the download page, not the GitHub tag listing', () => {
    // The tag page is a pile of .dmg/.exe/.zip/.AppImage files. The Pages site already picks the
    // installer for the device that opened it — same idea as Chrome's download button.
    const downloadPage =
      'https://keyvaluesoftwaresystems.github.io/keycode-2026-mascot-pet/'
    const yml = readFileSync(resolve(REPO, '.github/workflows/release.yml'), 'utf8')
    const manifest = JSON.parse(readFileSync(resolve(REPO, 'site/manifest.json'), 'utf8')) as {
      release?: { notesUrl?: string; latestVersion?: string }
    }
    expect(yml).toContain(downloadPage)
    expect(yml).not.toMatch(/releases\/tag\//)
    expect(manifest.release?.notesUrl).toBe(downloadPage)

    const version = manifest.release?.latestVersion
    expect(version).toBeTruthy()
    for (const arch of ['arm64', 'x64'] as const) {
      const feed = JSON.parse(
        readFileSync(resolve(REPO, `site/updates/darwin-${arch}.json`), 'utf8'),
      ) as { url: string; name: string }
      expect(feed.name).toBe(version)
      expect(feed.url).toBe(
        `https://github.com/KeyValueSoftwareSystems/keycode-2026-mascot-pet/releases/download/v${version}/Argos-${version}-mac-${arch}.zip`,
      )
    }
    expect(yml).toContain('site/updates/darwin-')
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
