import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createClaudeStateSource,
  CLAUDE_STATE_STALE_MS,
} from '../../apps/desktop/src/claude/claude-state-source.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'argos-claude-'))
  file = join(dir, 'claude-state')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** `refresh()` rather than the poll, so no test depends on a timer firing. */
function sourceFor(onChange?: (s: string) => void) {
  return createClaudeStateSource({ file, onChange })
}

describe('claude state source', () => {
  it('reports none when the file does not exist', () => {
    expect(sourceFor().refresh()).toBe('none')
  })

  it('reports none when the whole directory is missing', () => {
    const source = createClaudeStateSource({ file: join(dir, 'nope', 'claude-state') })
    expect(source.refresh()).toBe('none')
  })

  it.each(['waiting', 'running', 'idle'])('reads %s', (word) => {
    writeFileSync(file, `${word}\n`)
    expect(sourceFor().refresh()).toBe(word)
  })

  it('ignores surrounding whitespace and case', () => {
    writeFileSync(file, '  WAITING  \n')
    expect(sourceFor().refresh()).toBe('waiting')
  })

  it('treats an unknown word as none', () => {
    writeFileSync(file, 'thinking')
    expect(sourceFor().refresh()).toBe('none')
  })

  it('treats an empty file as none', () => {
    writeFileSync(file, '')
    expect(sourceFor().refresh()).toBe('none')
  })

  it('treats a stale file as none, however good its contents', () => {
    // A session killed with Ctrl+C never fires SessionEnd, so the file outlives the session.
    writeFileSync(file, 'waiting')
    const old = new Date(Date.now() - CLAUDE_STATE_STALE_MS - 60_000)
    utimesSync(file, old, old)
    expect(sourceFor().refresh()).toBe('none')
  })

  it('picks up a change on the next refresh', () => {
    writeFileSync(file, 'running')
    const source = sourceFor()
    expect(source.refresh()).toBe('running')
    writeFileSync(file, 'waiting')
    expect(source.refresh()).toBe('waiting')
  })

  it('reports a deletion as none', () => {
    writeFileSync(file, 'running')
    const source = sourceFor()
    expect(source.refresh()).toBe('running')
    rmSync(file)
    expect(source.refresh()).toBe('none')
  })

  it('fires onChange once per distinct state, not once per read', () => {
    const seen: string[] = []
    const source = sourceFor((s) => seen.push(s))
    writeFileSync(file, 'running')
    source.refresh()
    source.refresh()
    writeFileSync(file, 'running\n')
    source.refresh()
    writeFileSync(file, 'waiting')
    source.refresh()
    expect(seen).toEqual(['running', 'waiting'])
  })

  it('exposes the last read through current() without touching the disk', () => {
    writeFileSync(file, 'idle')
    const source = sourceFor()
    source.refresh()
    rmSync(file)
    expect(source.current()).toBe('idle')
  })

  it('creates the directory on start so the watch has something to watch', () => {
    // Without this the watch silently does nothing until the first hook happens to create the
    // directory, which looks exactly like the feature not working.
    const nested = join(dir, 'made-by-start', 'claude-state')
    const source = createClaudeStateSource({ file: nested })
    source.start()
    source.stop()
    expect(existsSync(join(dir, 'made-by-start'))).toBe(true)
  })

  it('start() then stop() leaves no live handles', () => {
    const source = sourceFor()
    source.start()
    expect(() => source.stop()).not.toThrow()
    expect(() => source.stop()).not.toThrow()
  })
})
