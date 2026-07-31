import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // The whole test suite is Electron-free by design: every Electron touch point
    // is behind an injected dependency or a type-only import. If a test ever needs
    // the electron module, that is a design smell to fix, not a config to change.
    globals: false,
    reporters: ['default'],
    testTimeout: 20_000,
  },
})
