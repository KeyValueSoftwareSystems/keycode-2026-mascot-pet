import { describe, it, expect } from 'vitest'
import { createSilentUpdater, githubFromRepoUrl } from '../../apps/desktop/src/updates/silent-updater.js'
import { REPO_URL } from '../../apps/desktop/src/config/constants.js'

describe('githubFromRepoUrl', () => {
  it('parses the repo this app is published from', () => {
    expect(githubFromRepoUrl(REPO_URL)).toEqual({
      owner: 'KeyValueSoftwareSystems',
      repo: 'keycode-2026-mascot-pet',
    })
  })

  it('accepts a trailing .git', () => {
    expect(githubFromRepoUrl('https://github.com/acme/pet.git')).toEqual({
      owner: 'acme',
      repo: 'pet',
    })
  })

  it('is null for a URL that is not a GitHub repo', () => {
    expect(githubFromRepoUrl('https://example.com/acme/pet')).toBeNull()
  })
})

describe('silent updater', () => {
  it('is a no-op when unpackaged — there is no bundle to replace', () => {
    const updater = createSilentUpdater({
      packaged: false,
      onReady: () => {
        throw new Error('unpackaged builds must not report a ready update')
      },
    })
    expect(updater.check()).toBe(false)
    expect(updater.isReady()).toBe(false)
    expect(updater.quitAndInstall()).toBe(false)
  })
})
