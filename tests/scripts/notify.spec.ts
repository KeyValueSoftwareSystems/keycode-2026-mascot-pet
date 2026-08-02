import { describe, it, expect } from 'vitest'
// @ts-expect-error — untyped .mjs script under test
import { makeId, pruneExpired } from '../../scripts/notify.mjs'

const AT = Date.parse('2026-08-02T03:19:00Z')

describe('notify: id generation', () => {
  it('produces a readable, schema-legal id', () => {
    // The schema allows only [A-Za-z0-9._-], and the id lives in every client's settings file forever,
    // so it has to be both legal and recognisable months later.
    const id = makeId('Keycode on Fire 🔥', AT)
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(id).toBe('keycode-on-fire-20260802T0319')
  })

  it('strips emoji and punctuation rather than emitting an illegal id', () => {
    expect(makeId('Deploy freeze @ 5pm!! 🚀', AT)).toBe('deploy-freeze-5pm-20260802T0319')
  })

  it('never ends in a separator, however the text ends', () => {
    for (const text of ['trailing punctuation!!!', 'emoji at the end 🔥', 'dashes---']) {
      expect(makeId(text, AT)).not.toMatch(/--\d|-{2,}/)
      expect(makeId(text, AT).split('-').at(-1)).toMatch(/^\d{8}T\d{4}$/)
    }
  })

  it('differs for the same text a minute later, so an id is never accidentally reused', () => {
    // Reusing an id silently shows nothing to anyone who saw the first one — the worst kind of failure,
    // because the publisher sees a successful push.
    const a = makeId('Standup in 5', AT)
    const b = makeId('Standup in 5', AT + 60_000)
    expect(a).not.toBe(b)
  })

  it('falls back rather than producing a bare timestamp for unslugifiable text', () => {
    expect(makeId('🔥🔥🔥', AT)).toBe('message-20260802T0319')
  })

  it('caps the slug so the id cannot grow unbounded', () => {
    const id = makeId('x'.repeat(300), AT)
    expect(id.length).toBeLessThan(60)
  })
})

describe('notify: pruning', () => {
  const entry = (id: string, expiresAt: string) => ({ id, expiresAt })

  it('keeps live and recently expired entries, drops long-expired ones', () => {
    const now = Date.parse('2026-08-02T00:00:00Z')
    const kept = pruneExpired(
      [
        entry('live', '2026-08-09T00:00:00Z'),
        entry('yesterday', '2026-08-01T00:00:00Z'),
        entry('ancient', '2020-01-01T00:00:00Z'),
      ],
      now,
    )
    // Recently expired entries stay for a week so the file reads as a log of what was announced.
    expect(kept.map((e) => e.id)).toEqual(['live', 'yesterday'])
  })

  it('keeps an entry with an unparseable expiry rather than silently deleting it', () => {
    // Deleting something we failed to understand is how a real announcement disappears without trace;
    // leaving it in means the validator reports it instead.
    const kept = pruneExpired([entry('weird', 'not-a-date')], Date.parse('2026-08-02T00:00:00Z'))
    expect(kept.map((e) => e.id)).toEqual(['weird'])
  })
})
