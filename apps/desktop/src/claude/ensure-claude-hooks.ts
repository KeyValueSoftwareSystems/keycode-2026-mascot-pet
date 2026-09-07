/**
 * Install Argos's Claude Code hooks into `~/.claude/settings.json` on launch.
 *
 * Silent and idempotent: users are not asked to paste JSON, and a second launch is a no-op.
 * Existing hooks are kept — we only append our matcher groups when the Argos command is absent.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Marker every Argos hook command carries, used for idempotency. */
export const ARGOS_CLAUDE_STATE_MARKER = '~/.argos/claude-state'

const ARGOS_HOOKS: ReadonlyArray<{ event: string; command: string }> = [
  {
    event: 'Notification',
    command: `mkdir -p ~/.argos && echo waiting > ${ARGOS_CLAUDE_STATE_MARKER}`,
  },
  {
    event: 'UserPromptSubmit',
    command: `mkdir -p ~/.argos && echo running > ${ARGOS_CLAUDE_STATE_MARKER}`,
  },
  {
    event: 'PreToolUse',
    command: `mkdir -p ~/.argos && echo running > ${ARGOS_CLAUDE_STATE_MARKER}`,
  },
  {
    event: 'PostToolUse',
    command: `mkdir -p ~/.argos && echo running > ${ARGOS_CLAUDE_STATE_MARKER}`,
  },
  {
    event: 'Stop',
    command: `mkdir -p ~/.argos && echo idle > ${ARGOS_CLAUDE_STATE_MARKER}`,
  },
  {
    event: 'SessionEnd',
    command: `rm -f ${ARGOS_CLAUDE_STATE_MARKER}`,
  },
]

export function defaultClaudeSettingsFile(): string {
  return process.env.ARGOS_CLAUDE_SETTINGS_FILE ?? join(homedir(), '.claude', 'settings.json')
}

export interface EnsureClaudeHooksOptions {
  settingsFile?: string
  log?: (message: string, meta?: unknown) => void
}

export type EnsureClaudeHooksResult = 'installed' | 'unchanged' | 'skipped' | 'failed'

function commandMentionsArgos(value: unknown): boolean {
  return typeof value === 'string' && value.includes(ARGOS_CLAUDE_STATE_MARKER)
}

function eventHasArgosHook(entries: unknown): boolean {
  if (!Array.isArray(entries)) return false
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const hooks = (entry as { hooks?: unknown }).hooks
    if (!Array.isArray(hooks)) continue
    for (const hook of hooks) {
      if (!hook || typeof hook !== 'object') continue
      if (commandMentionsArgos((hook as { command?: unknown }).command)) return true
    }
  }
  return false
}

/**
 * Pure merge: returns a new settings object, or `null` if nothing changed.
 * `settings` may be any JSON value; non-objects start a fresh root with only our hooks.
 */
export function mergeArgosClaudeHooks(settings: unknown): Record<string, unknown> | null {
  const root: Record<string, unknown> =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? { ...(settings as Record<string, unknown>) }
      : {}

  const hooksRaw = root.hooks
  const hooks: Record<string, unknown> =
    hooksRaw && typeof hooksRaw === 'object' && !Array.isArray(hooksRaw)
      ? { ...(hooksRaw as Record<string, unknown>) }
      : {}

  let changed = false
  for (const { event, command } of ARGOS_HOOKS) {
    if (eventHasArgosHook(hooks[event])) continue
    const existing = hooks[event]
    const list = Array.isArray(existing) ? [...existing] : []
    list.push({ hooks: [{ type: 'command', command, timeout: 5 }] })
    hooks[event] = list
    changed = true
  }

  if (!changed) return null
  return { ...root, hooks }
}

export function ensureClaudeHooksInstalled(
  options: EnsureClaudeHooksOptions = {},
): EnsureClaudeHooksResult {
  const log = options.log ?? ((): void => {})

  // Smoke / harness runs point the state file elsewhere — never touch the user's Claude settings.
  if (process.env.KEYCODE_PET_SMOKE === '1' || process.env.ARGOS_CLAUDE_STATE_FILE) {
    return 'skipped'
  }

  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile()

  let parsed: unknown = {}
  try {
    parsed = JSON.parse(readFileSync(settingsFile, 'utf8'))
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') {
      // Invalid JSON would wipe every Claude setting if we overwrote it. Leave it alone.
      log('claude-hooks: settings.json unreadable; leaving alone', error)
      return 'failed'
    }
  }

  let merged: Record<string, unknown> | null
  try {
    merged = mergeArgosClaudeHooks(parsed)
  } catch (error) {
    log('claude-hooks: merge failed', error)
    return 'failed'
  }
  if (!merged) return 'unchanged'

  try {
    mkdirSync(dirname(settingsFile), { recursive: true })
    writeFileSync(settingsFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  } catch (error) {
    log('claude-hooks: could not write settings.json', error)
    return 'failed'
  }

  log('claude-hooks: installed Argos hooks into Claude Code settings')
  return 'installed'
}
