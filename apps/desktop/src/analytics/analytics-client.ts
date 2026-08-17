/**
 * Turning queued events into a PostHog batch request. Pure — no `fs`, no `electron`, no timers.
 *
 * ---------------------------------------------------------------------------------------
 * Why there is no SDK here
 * ---------------------------------------------------------------------------------------
 *
 * `posthog-js` is the browser SDK and `posthog-node` the server one, and neither can be used:
 * a test asserts the runtime dependency list is exactly `zod` (see SECURITY.md), the renderer's CSP
 * is `connect-src 'none'`, and a renderer source file is forbidden from containing a URL at all.
 * The capture API is a JSON POST, so the SDK would buy batching and retries we need in a different
 * shape anyway — ours has to survive being offline across a restart, which an in-memory SDK queue
 * does not.
 *
 * ---------------------------------------------------------------------------------------
 * `$`-prefixed property names
 * ---------------------------------------------------------------------------------------
 *
 * PostHog's built-in charts key off specific names — `$os`, `$app_version`, `$device_type`. Using
 * them means version-adoption and OS-breakdown views work out of the box instead of needing custom
 * insights built by hand. Everything app-specific stays unprefixed.
 */

import { ANALYTICS_PROJECT_KEY } from '../config/constants.js'
import type { QueuedEvent } from './event-queue.js'

/** Stable per-install and per-build facts, attached to every event. */
export interface AnalyticsContext {
  installId: string
  appVersion: string
  os: string
  osVersion: string
  arch: string
  electronVersion: string
  locale: string
  timezone: string
  displayCount: number
  petId: string
}

/**
 * Map `process.platform` onto the names PostHog's own charts use.
 *
 * Worth the three lines: `darwin` and `win32` render as themselves in every breakdown otherwise, and
 * nobody reading a chart wants to translate kernel names.
 */
export function osName(platform: string): string {
  if (platform === 'darwin') return 'Mac OS X'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

export function buildBatch(
  events: readonly QueuedEvent[],
  context: AnalyticsContext,
): string {
  return JSON.stringify({
    api_key: ANALYTICS_PROJECT_KEY,
    batch: events.map((event) => ({
      event: event.event,
      distinct_id: context.installId,
      // ISO, and the event's own time rather than now — this is what makes an offline backlog land
      // in the right place on a retention chart instead of spiking at the moment of reconnection.
      timestamp: new Date(event.at).toISOString(),
      properties: {
        $os: context.os,
        $os_version: context.osVersion,
        $app_version: context.appVersion,
        $device_type: 'Desktop',
        $lib: 'argus-main',
        $lib_version: context.appVersion,
        arch: context.arch,
        electron_version: context.electronVersion,
        locale: context.locale,
        timezone: context.timezone,
        display_count: context.displayCount,
        pet_id: context.petId,
        ...event.properties,
      },
    })),
  })
}
