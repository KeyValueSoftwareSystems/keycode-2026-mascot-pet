import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The keeper against a fake window.
 *
 * `powerMonitor` is the only Electron surface this module touches beyond the window, so it is the only
 * thing mocked. The window is a fake rather than a mock of `BrowserWindow` because what is being
 * tested is a sequence of calls — "was the flag actually taken away, and did anything put it back" —
 * and a recorded call log states that directly.
 */

const listeners = new Map<string, Array<() => void>>()
const powerMonitor = {
  on: vi.fn((event: string, fn: () => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), fn])
  }),
  removeListener: vi.fn((event: string, fn: () => void) => {
    listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn))
  }),
}

vi.mock('electron', () => ({ powerMonitor }))

const { startAlwaysOnTopKeeper, alwaysOnTopLevel } = await import(
  '../../apps/desktop/src/main/always-on-top.js'
)

interface Call {
  name: string
  args: unknown[]
}

function fakeWindow() {
  const calls: Call[] = []
  const winListeners = new Map<string, Array<() => void>>()
  let onTop = false
  return {
    calls,
    /** Just the `setAlwaysOnTop` booleans, which is the sequence that matters. */
    topCalls: (): boolean[] =>
      calls.filter((c) => c.name === 'setAlwaysOnTop').map((c) => c.args[0] as boolean),
    /**
     * Where the window actually ended up.
     *
     * Distinct from the call sequence on purpose. On Windows `assertAlwaysOnTop` deliberately writes
     * `false` before `true` — see the drop-then-reassert test — so "every call was true" is a claim
     * about one platform while "it is on top now" is a claim about all of them.
     */
    isOnTop: (): boolean => onTop,
    fire(event: string): void {
      for (const fn of winListeners.get(event) ?? []) fn()
    },
    win: {
      isDestroyed: () => false,
      isVisible: () => true,
      isAlwaysOnTop: () => onTop,
      setAlwaysOnTop(value: boolean, level?: string): void {
        onTop = value
        calls.push({ name: 'setAlwaysOnTop', args: [value, level] })
      },
      setVisibleOnAllWorkspaces(value: boolean, opts?: unknown): void {
        calls.push({ name: 'setVisibleOnAllWorkspaces', args: [value, opts] })
      },
      on(event: string, fn: () => void): void {
        winListeners.set(event, [...(winListeners.get(event) ?? []), fn])
      },
      removeListener(event: string, fn: () => void): void {
        winListeners.set(
          event,
          (winListeners.get(event) ?? []).filter((f) => f !== fn),
        )
      },
    },
  }
}

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value })
}

let platform: string
beforeEach(() => {
  platform = process.platform
  listeners.clear()
  vi.useFakeTimers()
  // Pinned, so a test that is not *about* a platform does not silently inherit the host's. Windows
  // takes a different route through `assertAlwaysOnTop`, and a suite that runs green on a Mac and red
  // on a Windows runner is worse than one that fails everywhere: it fails at release time, in CI, on a
  // change that had nothing to do with it. Which is exactly what happened.
  setPlatform('darwin')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('always-on-top keeper', () => {
  it('asserts on top immediately when enabled', () => {
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never)
    expect(fake.topCalls()).toEqual([true])
    keeper.dispose()
  })

  it('starts released when the setting is off, without ever flashing in front', () => {
    // Not "assert then release": a pet that appears on top for a frame and then drops behind is a
    // visible glitch at launch, on the one setting whose whole point is not being in the way.
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never, { enabled: false })
    expect(fake.topCalls()).toEqual([false])
    keeper.dispose()
  })

  it('releases and re-asserts as the setting is toggled', () => {
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never)
    keeper.setEnabled(false)
    keeper.setEnabled(true)
    expect(fake.topCalls()).toEqual([true, false, true])
    keeper.dispose()
  })

  it('ignores a toggle to the value already in force', () => {
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never)
    keeper.setEnabled(true)
    expect(fake.topCalls()).toEqual([true])
    keeper.dispose()
  })

  it('does not let show/blur/resume put a released window back on top', () => {
    // The whole module exists to defeat things that quietly strip the flag. Turned off, those same
    // hooks would quietly put it back — undoing the user's choice a few seconds after they made it.
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never, { enabled: false })
    fake.fire('show')
    fake.fire('blur')
    fake.fire('restore')
    for (const fn of listeners.get('resume') ?? []) fn()
    keeper.reassert()
    expect(fake.topCalls()).toEqual([false])
    keeper.dispose()
  })

  it('raises for a callout even while the setting is off, and drops back after', () => {
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never, { enabled: false })
    keeper.raiseForCallout(true)
    expect(fake.topCalls()).toEqual([false, true])
    keeper.raiseForCallout(false)
    expect(fake.topCalls()).toEqual([false, true, false])
    keeper.dispose()
  })

  it('does not drop the pet mid-bubble when the setting is turned off during a callout', () => {
    // Turning the setting off while a message is on screen must not make that message disappear
    // behind a window. The callout hold outlives the setting change and releases on its own.
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never)
    keeper.raiseForCallout(true)
    keeper.setEnabled(false)
    expect(fake.topCalls().at(-1)).toBe(true)
    keeper.raiseForCallout(false)
    expect(fake.topCalls().at(-1)).toBe(false)
    keeper.dispose()
  })

  it('keeps a raised window on top when the callout ends but the setting is on', () => {
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never)
    keeper.raiseForCallout(true)
    keeper.raiseForCallout(false)
    // The end state, not the call sequence. This assertion originally read "every call was `true`" and
    // passed on macOS while failing on a real Windows runner, because `assertAlwaysOnTop` writes a
    // deliberate `false` there — the workaround tested directly below. The bug was in the assertion,
    // and it was hiding behind the host platform.
    expect(fake.isOnTop()).toBe(true)
    expect(fake.topCalls().at(-1)).toBe(true)
    keeper.dispose()
  })

  it('drops the flag before re-asserting it on Windows, but only when it is already set', () => {
    // Load-bearing and previously untested. The Windows shell strips `WS_EX_TOPMOST` behind Electron's
    // back while a fullscreen app is foreground, and Electron's cached flag still reads "on" — so a
    // plain `setAlwaysOnTop(true)` short-circuits and never reaches the OS. Writing `false` first
    // forces a real `SetWindowPos`. Without this the pet spends seconds at a time buried, and the
    // symptom is indistinguishable from the feature simply not working.
    setPlatform('win32')
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never, { intervalMs: 10 })
    // First assert: nothing was set, so there is nothing to drop.
    expect(fake.topCalls()).toEqual([true])

    keeper.reassert()
    // Second: already on top, so the cached value is cleared first.
    expect(fake.topCalls()).toEqual([true, false, true])
    expect(fake.isOnTop()).toBe(true)
    keeper.dispose()
  })

  it('does not do the Windows drop dance anywhere else', () => {
    setPlatform('darwin')
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never)
    keeper.reassert()
    keeper.reassert()
    expect(fake.topCalls()).toEqual([true, true, true])
    keeper.dispose()
  })

  it('uses a higher band on Linux, where panels and docks sit above "floating"', () => {
    setPlatform('linux')
    expect(alwaysOnTopLevel()).toBe('screen-saver')
    setPlatform('darwin')
    expect(alwaysOnTopLevel()).toBe('floating')
  })

  it('runs no re-assert sweep off Windows', () => {
    setPlatform('darwin')
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never, { intervalMs: 10 })
    vi.advanceTimersByTime(100)
    expect(fake.topCalls()).toEqual([true])
    keeper.dispose()
  })

  it('sweeps on Windows while on top, and stops sweeping once released', () => {
    // The sweep answers a real Windows behaviour: the shell re-strips the topmost flag every few
    // seconds. While the pet is deliberately behind things it is pure battery cost whose only
    // possible effect is to undo the setting.
    setPlatform('win32')
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never, { intervalMs: 10 })
    vi.advanceTimersByTime(35)
    const swept = fake.topCalls().length
    expect(swept).toBeGreaterThan(1)

    keeper.setEnabled(false)
    const afterRelease = fake.topCalls().length
    vi.advanceTimersByTime(100)
    expect(fake.topCalls().length).toBe(afterRelease)
    keeper.dispose()
  })

  it('restarts the Windows sweep when a callout raises a released window', () => {
    setPlatform('win32')
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never, { enabled: false, intervalMs: 10 })
    vi.advanceTimersByTime(50)
    expect(fake.topCalls()).toEqual([false])

    keeper.raiseForCallout(true)
    vi.advanceTimersByTime(35)
    expect(fake.topCalls().length).toBeGreaterThan(2)
    keeper.dispose()
  })

  it('leaves the window on all workspaces when released', () => {
    // Revoking this alongside the on-top flag would make a pet the user merely sent to the back
    // *vanish* on a Space switch, which reads as a crash rather than as a setting.
    setPlatform('darwin')
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never)
    const before = fake.calls.filter((c) => c.name === 'setVisibleOnAllWorkspaces').length
    keeper.setEnabled(false)
    const after = fake.calls.filter((c) => c.name === 'setVisibleOnAllWorkspaces')
    expect(before).toBe(1)
    expect(after).toHaveLength(1)
    expect(after[0]!.args[0]).toBe(true)
    keeper.dispose()
  })

  it('stops the sweep and unhooks powerMonitor on dispose', () => {
    setPlatform('win32')
    const fake = fakeWindow()
    const keeper = startAlwaysOnTopKeeper(fake.win as never, { intervalMs: 10 })
    keeper.dispose()
    const settled = fake.topCalls().length
    vi.advanceTimersByTime(100)
    expect(fake.topCalls().length).toBe(settled)
    expect(listeners.get('resume') ?? []).toHaveLength(0)
  })
})
