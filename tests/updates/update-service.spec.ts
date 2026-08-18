import { describe, it, expect, vi } from 'vitest'
import { isNewer, parseVersion, SEMVER_CORE } from '../../apps/desktop/src/updates/version-compare.js'
import { createUpdateService } from '../../apps/desktop/src/updates/update-service.js'
import type { SafeRelease } from '../../apps/desktop/src/broadcast/manifest-schema.js'
import type { PollOutcome } from '../../apps/desktop/src/broadcast/broadcast-poller.js'

describe('version comparison', () => {
  it('compares major, minor and patch numerically', () => {
    expect(isNewer('0.4.0', '0.3.0')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('0.3.1', '0.3.0')).toBe(true)
  })

  it('is numeric, not lexical', () => {
    // The case a string compare gets backwards, and the reason to parse rather than compare strings.
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.9.0', '0.10.0')).toBe(false)
    expect(isNewer('1.0.0', '0.20.0')).toBe(true)
  })

  it('tolerates a leading v', () => {
    expect(isNewer('v0.4.0', '0.3.0')).toBe(true)
    expect(isNewer('0.4.0', 'v0.3.0')).toBe(true)
  })

  it('treats a prerelease as equal to its release, never newer', () => {
    // Deliberate: the alternative is telling everyone a release candidate is an upgrade.
    expect(isNewer('0.4.0-rc.1', '0.4.0')).toBe(false)
    expect(isNewer('0.4.0', '0.4.0-rc.1')).toBe(false)
    expect(isNewer('0.4.0+build7', '0.4.0')).toBe(false)
  })

  it('is false for equal versions', () => {
    expect(isNewer('1.2.3', '1.2.3')).toBe(false)
  })

  it('is false for an older remote', () => {
    expect(isNewer('0.1.0', '0.2.0')).toBe(false)
  })

  it('is false — never true — for unparseable input', () => {
    // An unreadable version must not be announced as an upgrade, and must not crash a poll.
    for (const bad of ['latest', '', '1.2', '1.2.3.4', '🔥', 'v', null, undefined, 42, {}]) {
      expect(isNewer(bad as unknown, '0.1.0'), String(bad)).toBe(false)
      expect(isNewer('9.9.9', bad as unknown), String(bad)).toBe(false)
    }
  })

  it('parses into components', () => {
    expect(parseVersion('v10.20.30')).toEqual({ major: 10, minor: 20, patch: 30 })
    expect(parseVersion('nope')).toBeNull()
  })

  it('uses a regex that requires all three components', () => {
    expect(SEMVER_CORE.test('1.2.3')).toBe(true)
    expect(SEMVER_CORE.test('1.2')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------
// Update service
// ---------------------------------------------------------------------------------------

function release(overrides: Partial<SafeRelease> = {}): SafeRelease {
  return {
    latestVersion: '0.9.0',
    notesUrl: 'https://example.com/releases',
    mandatory: false,
    ...overrides,
  }
}

function harness(
  options: {
    currentVersion?: string
    lastKnownRelease?: string | null
    pollOutcome?: PollOutcome
    startDownload?: () => boolean
    isReady?: () => boolean
    applyUpdate?: () => boolean
  } = {},
) {
  let lastKnown = options.lastKnownRelease ?? null
  const callouts: Array<Record<string, unknown>> = []
  const toasts: Array<{ text: string; tone: string }> = []
  const states: string[] = []
  const opened: Array<string | null> = []

  const service = createUpdateService({
    currentVersion: options.currentVersion ?? '0.5.0',
    getLastKnownRelease: () => lastKnown,
    setLastKnownRelease: (version) => {
      lastKnown = version
    },
    submitCallout: (request) => callouts.push(request as Record<string, unknown>),
    showToast: (toast) => toasts.push(toast),
    pollNow: async () => options.pollOutcome ?? { kind: 'ok', surfaced: 0, unchanged: false },
    onStateChange: (view) => states.push(view.state),
    openReleaseNotes: (url) => {
      opened.push(url)
      return url !== null
    },
    ...(options.startDownload ? { startDownload: options.startDownload } : {}),
    ...(options.isReady ? { isReady: options.isReady } : {}),
    ...(options.applyUpdate ? { applyUpdate: options.applyUpdate } : {}),
  })

  return {
    service,
    callouts,
    toasts,
    states,
    opened,
    get lastKnown() {
      return lastKnown
    },
  }
}

describe('update service', () => {
  it('announces a newer version once and not again on the next poll', () => {
    const h = harness()
    h.service.onReleaseFromPoll(release())
    h.service.onReleaseFromPoll(release())

    expect(h.callouts).toHaveLength(1)
    expect(h.callouts[0]).toMatchObject({
      sourceId: 'update',
      text: 'Version 0.9.0 is available',
      tone: 'success',
    })
    expect(h.lastKnown).toBe('0.9.0')
    expect(h.service.view().state).toBe('available')
  })

  it('announces again when the manifest advances to a further version', () => {
    // Deliberately different from broadcast dedupe, which is once per install: a *new* version must
    // be able to speak up.
    const h = harness()
    h.service.onReleaseFromPoll(release({ latestVersion: '0.9.0' }))
    h.service.onReleaseFromPoll(release({ latestVersion: '1.0.0' }))
    expect(h.callouts.map((c) => c.text)).toEqual([
      'Version 0.9.0 is available',
      'Version 1.0.0 is available',
    ])
  })

  it('never announces the current version or an older one', () => {
    const h = harness({ currentVersion: '1.0.0' })
    h.service.onReleaseFromPoll(release({ latestVersion: '1.0.0' }))
    h.service.onReleaseFromPoll(release({ latestVersion: '0.5.0' }))
    expect(h.callouts).toEqual([])
    expect(h.service.view().state).toBe('current')
  })

  it('never announces an unparseable version', () => {
    const h = harness()
    h.service.onReleaseFromPoll(release({ latestVersion: 'latest' }))
    expect(h.callouts).toEqual([])
  })

  it('pins a high-priority sticky callout for a mandatory release', () => {
    // The only durable surface this app has. It still does not block, nag modally, or quit.
    const h = harness()
    h.service.onReleaseFromPoll(release({ mandatory: true }))
    expect(h.callouts[0]).toMatchObject({ priority: 'high', pin: true, sticky: true })
  })

  it('carries the notes URL on the callout so the bubble can be clickable', () => {
    const h = harness()
    h.service.onReleaseFromPoll(release())
    expect(h.callouts[0]).toMatchObject({ url: 'https://example.com/releases' })
  })

  it('omits the URL when the manifest had an unusable one', () => {
    const h = harness()
    h.service.onReleaseFromPoll(release({ notesUrl: null }))
    expect(h.callouts[0]).not.toHaveProperty('url')
  })

  it('reports being up to date when a user-initiated check finds nothing', () => {
    // The deliberate exception to "failure is silent": a person clicked and is waiting.
    const h = harness({ currentVersion: '1.0.0' })
    return h.service.checkNow().then(() => {
      expect(h.toasts).toEqual([{ text: 'You’re up to date', tone: 'info' }])
      expect(h.states).toContain('checking')
      expect(h.service.view().state).toBe('current')
    })
  })

  it('reports a failure when a user-initiated check errors', async () => {
    const h = harness({ pollOutcome: { kind: 'error', reason: 'timeout' } })
    await h.service.checkNow()
    expect(h.toasts).toEqual([{ text: 'Couldn’t check for updates', tone: 'warning' }])
    expect(h.service.view().state).toBe('error')
  })

  it('produces no toast for a background poll failure', async () => {
    // Background silence is the rule; the exception is only the menu item.
    const h = harness()
    h.service.onReleaseFromPoll(null)
    expect(h.toasts).toEqual([])
  })

  it('ignores a second user check while one is running', async () => {
    const pollNow = vi.fn(
      async (): Promise<PollOutcome> => ({ kind: 'ok', surfaced: 0, unchanged: false }),
    )
    const service = createUpdateService({
      currentVersion: '1.0.0',
      getLastKnownRelease: () => null,
      setLastKnownRelease: () => {},
      submitCallout: () => {},
      showToast: () => {},
      pollNow,
      onStateChange: () => {},
      openReleaseNotes: () => true,
    })
    await Promise.all([service.checkNow(), service.checkNow()])
    expect(pollNow).toHaveBeenCalledTimes(1)
  })

  it('drives the menu through checking then a resolved state', async () => {
    const h = harness({ currentVersion: '1.0.0' })
    await h.service.checkNow()
    expect(h.states[0]).toBe('checking')
    expect(h.states.at(-1)).toBe('current')
  })

  it('opens the notes URL it was given', () => {
    const h = harness()
    h.service.onReleaseFromPoll(release())
    expect(h.service.openNotes()).toBe(true)
    expect(h.opened).toEqual(['https://example.com/releases'])
  })

  it('reports failure when there is no notes URL to open', () => {
    const h = harness()
    expect(h.service.openNotes()).toBe(false)
  })

  it('downloads in the background instead of announcing, when an installer can be applied', () => {
    const started: string[] = []
    const h = harness({
      startDownload: () => {
        started.push('yes')
        return true
      },
    })
    h.service.onReleaseFromPoll(release())
    expect(started).toEqual(['yes'])
    expect(h.callouts).toEqual([])
    expect(h.service.view().state).toBe('available')
  })

  it('announces a restart once the installer has downloaded, when it cannot apply it itself', () => {
    const h = harness({ startDownload: () => true })
    h.service.onReleaseFromPoll(release())
    h.service.onDownloaded('0.9.0')
    expect(h.callouts).toHaveLength(1)
    expect(h.callouts[0]).toMatchObject({
      sourceId: 'update',
      text: 'Version 0.9.0 is ready. Click to restart.',
      sticky: true,
    })
    expect(h.callouts[0]).not.toHaveProperty('url')
    expect(h.service.view().state).toBe('downloaded')
  })

  it('restarts immediately once the installer has downloaded', () => {
    const applied: string[] = []
    const h = harness({
      startDownload: () => true,
      applyUpdate: () => {
        applied.push('yes')
        return true
      },
    })
    h.service.onReleaseFromPoll(release())
    h.service.onDownloaded('0.9.0')
    expect(applied).toEqual(['yes'])
    expect(h.callouts).toEqual([])
    expect(h.service.view().state).toBe('downloaded')
  })

  it('applies a ready update from the menu without polling again', async () => {
    const applied: string[] = []
    const pollNow = vi.fn(
      async (): Promise<PollOutcome> => ({ kind: 'ok', surfaced: 0, unchanged: false }),
    )
    const service = createUpdateService({
      currentVersion: '0.5.0',
      getLastKnownRelease: () => '0.9.0',
      setLastKnownRelease: () => {},
      submitCallout: () => {},
      showToast: () => {},
      pollNow,
      onStateChange: () => {},
      openReleaseNotes: () => true,
      isReady: () => true,
      applyUpdate: () => {
        applied.push('yes')
        return true
      },
    })
    await service.checkNow()
    expect(applied).toEqual(['yes'])
    expect(pollNow).not.toHaveBeenCalled()
  })
})
