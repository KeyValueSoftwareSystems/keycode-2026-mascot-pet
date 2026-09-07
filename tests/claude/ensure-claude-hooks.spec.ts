import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARGOS_CLAUDE_STATE_MARKER,
  ensureClaudeHooksInstalled,
  mergeArgosClaudeHooks,
} from '../../apps/desktop/src/claude/ensure-claude-hooks.js'

describe('mergeArgosClaudeHooks', () => {
  it('creates hooks on an empty settings object', () => {
    const merged = mergeArgosClaudeHooks({})
    expect(merged).not.toBeNull()
    const hooks = merged!.hooks as Record<string, unknown[]>
    expect(Object.keys(hooks)).toEqual([
      'Notification',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ])
    const notification = hooks.Notification[0] as { hooks: Array<{ command: string }> }
    expect(notification.hooks[0].command).toContain('echo waiting')
    expect(notification.hooks[0].command).toContain(ARGOS_CLAUDE_STATE_MARKER)
  })

  it('is a no-op when Argos hooks are already present', () => {
    const first = mergeArgosClaudeHooks({})!
    expect(mergeArgosClaudeHooks(first)).toBeNull()
  })

  it('keeps unrelated hooks and top-level keys', () => {
    const existing = {
      model: 'sonnet',
      hooks: {
        Notification: [
          {
            hooks: [{ type: 'command', command: 'echo other', timeout: 5 }],
          },
        ],
      },
    }
    const merged = mergeArgosClaudeHooks(existing)!
    expect(merged.model).toBe('sonnet')
    const notification = (merged.hooks as Record<string, unknown[]>).Notification
    expect(notification).toHaveLength(2)
    expect(
      (notification[0] as { hooks: Array<{ command: string }> }).hooks[0].command,
    ).toBe('echo other')
    expect(
      (notification[1] as { hooks: Array<{ command: string }> }).hooks[0].command,
    ).toContain(ARGOS_CLAUDE_STATE_MARKER)
  })

  it('starts fresh when settings is not an object', () => {
    const merged = mergeArgosClaudeHooks(null)
    expect(merged).not.toBeNull()
    expect(merged!.hooks).toBeTruthy()
  })
})

describe('ensureClaudeHooksInstalled', () => {
  let dir: string
  let settingsFile: string
  const prevSmoke = process.env.KEYCODE_PET_SMOKE
  const prevState = process.env.ARGOS_CLAUDE_STATE_FILE

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'argos-hooks-'))
    settingsFile = join(dir, 'settings.json')
    delete process.env.KEYCODE_PET_SMOKE
    delete process.env.ARGOS_CLAUDE_STATE_FILE
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevSmoke === undefined) delete process.env.KEYCODE_PET_SMOKE
    else process.env.KEYCODE_PET_SMOKE = prevSmoke
    if (prevState === undefined) delete process.env.ARGOS_CLAUDE_STATE_FILE
    else process.env.ARGOS_CLAUDE_STATE_FILE = prevState
  })

  it('writes settings.json when missing', () => {
    expect(ensureClaudeHooksInstalled({ settingsFile })).toBe('installed')
    const body = JSON.parse(readFileSync(settingsFile, 'utf8'))
    expect(body.hooks.Stop).toBeTruthy()
  })

  it('is unchanged on a second call', () => {
    expect(ensureClaudeHooksInstalled({ settingsFile })).toBe('installed')
    expect(ensureClaudeHooksInstalled({ settingsFile })).toBe('unchanged')
  })

  it('leaves invalid JSON alone', () => {
    writeFileSync(settingsFile, '{not json')
    expect(ensureClaudeHooksInstalled({ settingsFile })).toBe('failed')
    expect(readFileSync(settingsFile, 'utf8')).toBe('{not json')
  })

  it('skips during smoke runs', () => {
    process.env.KEYCODE_PET_SMOKE = '1'
    expect(ensureClaudeHooksInstalled({ settingsFile })).toBe('skipped')
    expect(existsSync(settingsFile)).toBe(false)
  })

  it('skips when the state file path is overridden', () => {
    process.env.ARGOS_CLAUDE_STATE_FILE = join(dir, 'elsewhere')
    expect(ensureClaudeHooksInstalled({ settingsFile })).toBe('skipped')
    expect(existsSync(settingsFile)).toBe(false)
  })
})
