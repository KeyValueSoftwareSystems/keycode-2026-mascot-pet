/**
 * Claude Code's state, read off a file that Claude Code's hooks write.
 *
 * The transport is a file holding one word, because a hook that is `echo running > file` cannot
 * fail in an interesting way: no JSON to parse, no port to bind, no dependency on either side.
 *
 * No Electron import. This module is the one place that knows how the state arrives, so it is
 * also the only file that changes when multi-session support lands — at which point it reads a
 * directory of per-session files and aggregates them instead.
 */

import { mkdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CLAUDE_STATES, type ClaudeState } from '../pet-frame.js'

/**
 * How old a state file may be before it is disbelieved.
 *
 * A session killed with Ctrl+C may never fire its `SessionEnd` hook, leaving a file that would
 * otherwise pin the cap on for the rest of the day. The mtime is the guard, which is why the
 * file holds only a word: the timestamp already exists in the filesystem, and putting a second
 * one in the payload would be a second source of truth for the same fact.
 */
export const CLAUDE_STATE_STALE_MS = 15 * 60_000

/** How often to re-read regardless of the watch. See `start()`. */
const DEFAULT_POLL_MS = 5_000

export function defaultClaudeStateFile(): string {
  return process.env.ARGOS_CLAUDE_STATE_FILE ?? join(homedir(), '.argos', 'claude-state')
}

export interface ClaudeStateSourceOptions {
  /** Defaults to `defaultClaudeStateFile()`. */
  file?: string
  /** Injected so tests can drive staleness without waiting a quarter of an hour. */
  now?: () => number
  pollMs?: number
  onChange?: (state: ClaudeState) => void
  log?: (message: string, meta?: unknown) => void
}

export interface ClaudeStateSource {
  start(): void
  stop(): void
  /** The last state read. Cheap: no disk access. */
  current(): ClaudeState
  /** Re-read now and report a change if there is one. Returns the new state. */
  refresh(): ClaudeState
}

const KNOWN = new Set<string>(CLAUDE_STATES)

function readState(file: string, nowMs: number): ClaudeState {
  let raw: string
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
    raw = readFileSync(file, 'utf8')
  } catch {
    // Missing, unreadable, a directory, a permission error — all the same answer.
    return 'none'
  }
  if (nowMs - mtimeMs > CLAUDE_STATE_STALE_MS) return 'none'
  const word = raw.trim().toLowerCase()
  return KNOWN.has(word) ? (word as ClaudeState) : 'none'
}

export function createClaudeStateSource(
  options: ClaudeStateSourceOptions = {},
): ClaudeStateSource {
  const file = options.file ?? defaultClaudeStateFile()
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const onChange = options.onChange ?? ((): void => {})
  const log = options.log ?? ((): void => {})

  let state: ClaudeState = 'none'
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null

  const refresh = (): ClaudeState => {
    const next = readState(file, now())
    if (next !== state) {
      state = next
      onChange(state)
    }
    return state
  }

  return {
    current: () => state,
    refresh,

    start(): void {
      // Make the directory ourselves so the watch has a target from the first launch, rather
      // than silently doing nothing until the first hook happens to create it.
      try {
        mkdirSync(dirname(file), { recursive: true })
      } catch (error) {
        log('claude-state: could not create the state directory', error)
      }

      refresh()

      // Watch the *directory*, not the file: a writer that replaces the file swaps the inode,
      // and a file-level watch is then pointed at something nothing will ever touch again.
      try {
        watcher = watch(dirname(file), { persistent: false }, () => {
          refresh()
        })
      } catch (error) {
        log('claude-state: directory watch unavailable, polling only', error)
      }

      // Backstop. fs.watch misses events on some platforms and filesystems, and a missed event
      // here means a cap stuck on the wrong colour — the one failure the whole feature is
      // supposed to prevent.
      timer = setInterval(refresh, pollMs)
      timer.unref?.()
    },

    stop(): void {
      watcher?.close()
      watcher = null
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
