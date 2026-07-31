/**
 * Every environment flag the app reads, in one place, read once.
 *
 * Scattered `process.env` reads are how a dev-only escape hatch ends up live in a packaged
 * build. Each flag below states its blast radius, and the ones that can weaken security
 * are additionally gated on `app.isPackaged` at their call site — see `broadcast/url-guard.ts`.
 */

export const ENV_KEYS = {
  /** Emit the JSONL handshake on stdout. Harness only. */
  smoke: 'KEYCODE_PET_SMOKE',
  /** Open the opaque dark backdrop window behind the pet. Dev/harness only. */
  backdrop: 'KEYCODE_PET_BACKDROP',
  /** Pin the pet to one animation state instead of running the motion engine. Harness only. */
  forceState: 'KEYCODE_PET_FORCE_STATE',
  /** Override the broadcast manifest URL. */
  manifestUrl: 'KEYCODE_PET_MANIFEST_URL',
  /** Override the poll interval in minutes. Clamped to [1, 1440]. */
  pollMinutes: 'KEYCODE_PET_POLL_MINUTES',
  /**
   * Permit http:// to loopback hosts for the local dev manifest server.
   * Ineffective in a packaged build — `app.isPackaged` is not env-overridable.
   */
  allowInsecureManifest: 'KEYCODE_PET_ALLOW_INSECURE_MANIFEST',
  /** Opt back in to native Wayland. Breaks positioning, drag and z-order; see docs/VERIFICATION.md. */
  ozone: 'KEYCODE_PET_OZONE',
} as const

function flag(key: string): boolean {
  return process.env[key] === '1'
}

export const env = {
  get smoke(): boolean {
    return flag(ENV_KEYS.smoke)
  },
  get backdrop(): boolean {
    return flag(ENV_KEYS.backdrop)
  },
  get forceState(): string | null {
    return process.env[ENV_KEYS.forceState] ?? null
  },
  get allowInsecureManifestRequested(): boolean {
    return flag(ENV_KEYS.allowInsecureManifest)
  },
  get wantsNativeWayland(): boolean {
    return process.env[ENV_KEYS.ozone] === 'native'
  },
}
