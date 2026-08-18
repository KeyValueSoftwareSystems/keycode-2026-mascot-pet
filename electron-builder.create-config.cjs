/**
 * Factory for the electron-builder configuration.
 *
 * Lives in its own file so `electron-builder.config.cjs` can export a plain config object.
 * electron-builder 26.15 validates every own property (including non-enumerable ones), so attaching
 * this helper to the config export fails the schema with "unknown property 'createConfig'".
 *
 * CJS rather than YAML on purpose: a Vitest test can `require` this and assert the `files` filter and
 * the target matrix. An untested filter is exactly how 3MB of reference art ends up in every
 * installer, and how a renamed asset silently stops shipping.
 */

const YEAR = new Date().getFullYear()

/**
 * Developer ID signing + notarization are env-gated so unsigned CI/local builds stay ad-hoc.
 * `CSC_LINK` enables signing; APPLE_API_KEY + KEY_ID + ISSUER enables notarization.
 * Tests call `createConfig` with a fake env.
 */
function createConfig(env = process.env) {
  const signMac = Boolean(env.CSC_LINK)
  const notarize = Boolean(
    signMac && env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER,
  )

  return {
    appId: 'systems.keyvalue.keycodepet',
    productName: 'Argus',
    copyright: `Copyright © ${YEAR} KeyValue Systems`,

    directories: {
      output: 'release',
      buildResources: 'build',
    },

    /**
     * asar is OFF, and this is an empirical finding rather than a preference.
     *
     * The main process is ESM (`"type": "module"`, `import.meta.url`, top-level `import`). With
     * `asar: true`, Electron 42 **silently fails to load an ESM entry point from inside the archive**:
     * the process starts and stays alive, but the main script never executes — no `whenReady`, no
     * windows, no log output, no error. The app appears to launch and then does nothing.
     *
     * That is exactly the failure mode this build is most exposed to, because a packaged macOS bundle
     * has no usable stdio either, so there is nothing to read. It took building the artifact, noticing
     * the pet never appeared, adding a file logger, and then re-packaging with `--config.asar=false`
     * to establish the cause. With asar disabled the same build boots correctly first time.
     *
     * The cost is small and worth naming: app contents ship as loose files rather than one archive.
     * asar was never a security boundary (it unpacks with one command), so what is lost is a marginal
     * startup improvement and some tidiness. What is gained is an app that runs.
     *
     * The alternative — compiling main to CommonJS — would mean giving up `import.meta.url` in
     * paths.ts and the ESM-everywhere property the brief asks for, to work around a bug in a bundling
     * step that buys us nothing here.
     */
    asar: false,
    // Metadata for electron-updater (`latest-mac.yml` and friends). The package scripts pass
    // `--publish never` so a GH_TOKEN in CI cannot turn a build into a GitHub Release by itself.
    publish: {
      provider: 'github',
      owner: 'KeyValueSoftwareSystems',
      repo: 'keycode-2026-mascot-pet',
    },
    artifactName: '${productName}-${version}-${os}-${arch}.${ext}',

    /**
     * An ALLOW-LIST, not a deny-list.
     *
     * The brief frames this as "exclude source-sheet.png, preview.png, validation.json". Naming what
     * *does* ship is strictly safer: a future eighth file in `pet/` is excluded by default instead of
     * shipping by accident.
     *
     * Note `pet/spritesheet.png` is deliberately absent — the renderer bundle already contains the
     * sheet (Vite fingerprints it into dist/renderer), so shipping the original too would pay for the
     * sprite twice. Easy to miss, because the brief's exclusion list does not mention it.
     */
    files: [
      'apps/desktop/dist/**/*',
      /**
       * Only the assets read from disk at runtime.
       *
       * `assets/fonts/` is deliberately NOT shipped: Vite already emits a fingerprinted copy of the
       * emoji font into `dist/renderer/`, and the generated CSS references *that* one. Shipping both
       * put 9.75MB of duplicated font into a 13MB archive — three quarters of the app was one file,
       * twice. Found by listing the built asar rather than by reading the config.
       *
       * `assets/pet/alpha-mask.json` is likewise omitted: the app imports the generated TypeScript
       * module, and the JSON exists for tests and humans.
       */
      'apps/desktop/assets/tray/**/*',
      'apps/desktop/package.json',
      'package.json',
      // Negations come BEFORE the from/to mapping below. Patterns listed after a mapping object are
      // scoped to that mapping rather than to the whole fileset, so `!**/*.map` placed at the end
      // silently excluded nothing and the source maps shipped.
      '!**/*.map',
      '!**/*.ts',
      '!**/{test,tests,__tests__,docs,example,examples}/**',
      { from: 'pet', to: 'pet', filter: ['spritesheet.json', 'pet.json'] },
    ],

    mac: {
      category: 'public.app-category.utility',
      target: [
        { target: 'dmg', arch: ['x64', 'arm64'] },
        { target: 'zip', arch: ['x64', 'arm64'] },
      ],
      icon: 'build/icon.icns',
      /**
       * Default: ad-hoc signing. Without *any* signature, Gatekeeper on Apple Silicon refuses the
       * app with "damaged and can't be opened". `identity: '-'` avoids that specific dialog.
       *
       * With CSC_LINK: omit identity so electron-builder uses the Developer ID, enable hardened
       * runtime (required to notarize), and notarize when Apple API credentials are present.
       */
      ...(signMac
        ? {
            hardenedRuntime: true,
            entitlements: 'build/entitlements.mac.plist',
            entitlementsInherit: 'build/entitlements.mac.plist',
            notarize,
          }
        : {
            identity: '-',
            hardenedRuntime: false,
          }),
      gatekeeperAssess: false,
      extendInfo: {
        /**
         * The plist counterpart to `app.dock.hide()`.
         *
         * Without it macOS briefly shows a dock icon at launch before the runtime call hides it — a
         * visible seam in a product whose whole thesis is that nothing reads as a window.
         */
        LSUIElement: true,
      },
    },

    dmg: {
      // A plain drag-to-Applications window. Nothing to configure that would earn its keep.
      contents: [
        { x: 130, y: 220 },
        { x: 410, y: 220, type: 'link', path: '/Applications' },
      ],
    },

    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: 'build/icon.ico',
      // There is no Authenticode certificate, so update-signature verification would fail closed.
      verifyUpdateCodeSignature: false,
    },

    nsis: {
      // Per-user install: no elevation prompt, which an internal tool has no business requiring.
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      shortcutName: 'Argus',
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
    },

    linux: {
      target: ['AppImage', 'deb', 'rpm', 'tar.gz'],
      category: 'Utility',
      icon: 'build/icons',
      maintainer: 'doyle@keyvalue.systems',
      description: 'A desktop companion that lives on your screen',
    },
  }
}

module.exports = { createConfig }
