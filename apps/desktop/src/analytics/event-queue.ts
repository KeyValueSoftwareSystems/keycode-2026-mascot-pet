/**
 * A small, bounded, disk-backed queue of pending analytics events.
 *
 * ---------------------------------------------------------------------------------------
 * Why a queue exists at all
 * ---------------------------------------------------------------------------------------
 *
 * Without one, "is anyone actually using this?" is answerable only for people who happen to be
 * online at the moment the timer fires. Someone working offline for three days would look
 * indistinguishable from someone who uninstalled — the single most misleading thing this whole
 * feature could report.
 *
 * So every event is recorded locally the moment it happens, stamped with the time it *actually*
 * happened, and sent whenever the network next allows. PostHog accepts historical timestamps, so a
 * backlog lands in the timeline where it belongs rather than bunched at the moment of reconnection.
 *
 * ---------------------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------------------------
 *
 * A queue on disk that only grows is a slow leak on someone else's laptop. Two caps, both applied
 * on every load and every append: at most `queueMax` events, and nothing older than
 * `queueMaxAgeMs`. Oldest go first — a stale heartbeat is worth less than a fresh one, and dropping
 * from the front keeps the newest window intact.
 *
 * Writes reuse the same temp-fsync-rename dance as the settings store, for the same reason: a
 * half-written JSON file at the moment of a crash must not be able to poison the next launch. A
 * corrupt or unreadable queue is discarded silently — losing pending analytics is a non-event, and
 * it is never worth a user-visible failure.
 */

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from '../main/atomic-write.js'
import { ANALYTICS } from '../config/constants.js'

export const QUEUE_FILENAME = 'analytics-queue.json'

/** One captured event, in the shape PostHog's batch endpoint takes. */
export interface QueuedEvent {
  event: string
  /** Epoch ms of when it happened, not when it is sent. The reason the queue is worth having. */
  at: number
  properties: Record<string, unknown>
}

export interface EventQueueOptions {
  dir: string
  now?: () => number
  log?: (message: string, meta?: unknown) => void
}

/**
 * Apply both caps. Pure, so the eviction rules are testable without touching a disk.
 *
 * Age first, then count: trimming expired events can bring the queue back under the count cap on its
 * own, and doing it the other way round would evict live events to make room for dead ones.
 */
export function prune(events: readonly QueuedEvent[], now: number): QueuedEvent[] {
  const fresh = events.filter((event) => now - event.at <= ANALYTICS.queueMaxAgeMs)
  return fresh.length > ANALYTICS.queueMax ? fresh.slice(fresh.length - ANALYTICS.queueMax) : fresh
}

export class EventQueue {
  readonly #path: string
  readonly #now: () => number
  readonly #log: (message: string, meta?: unknown) => void

  #events: QueuedEvent[] = []
  #loaded = false
  /** Serialises writes so two flushes cannot interleave temp files. Mirrors the settings store. */
  #tail: Promise<void> = Promise.resolve()

  constructor(options: EventQueueOptions) {
    this.#path = join(options.dir, QUEUE_FILENAME)
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => {})
  }

  /**
   * Read whatever survived the last session.
   *
   * Anything unreadable, unparseable, or not an array is treated as an empty queue. There is no
   * quarantine path here, unlike settings: nothing in this file is the user's, so nothing is lost
   * worth preserving for inspection.
   */
  async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true

    let raw: string
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') this.#log('analytics: queue unreadable', { code })
      return
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      this.#events = prune(parsed.filter(isQueuedEvent), this.#now())
    } catch {
      this.#log('analytics: queue corrupt, discarding')
    }
  }

  size(): number {
    return this.#events.length
  }

  /** A copy, so a caller draining a batch cannot mutate what is still queued. */
  peek(limit: number): QueuedEvent[] {
    return this.#events.slice(0, limit)
  }

  async append(event: QueuedEvent): Promise<void> {
    this.#events = prune([...this.#events, event], this.#now())
    await this.#persist()
  }

  /**
   * Drop events that were accepted by the server.
   *
   * Matched by identity against the head of the queue rather than by value: events appended while a
   * send was in flight must survive, and two identical heartbeats are genuinely indistinguishable by
   * value.
   */
  async drop(count: number): Promise<void> {
    if (count <= 0) return
    this.#events = this.#events.slice(count)
    await this.#persist()
  }

  async #persist(): Promise<void> {
    const snapshot = [...this.#events]
    const write = this.#tail.then(async () => {
      if (snapshot.length === 0) {
        // An empty file is just a file to read and discard next launch.
        await unlink(this.#path).catch(() => {})
        return
      }
      try {
        await atomicWrite(this.#path, JSON.stringify(snapshot))
      } catch (error) {
        this.#log('analytics: queue write failed', { error: String(error) })
      }
    })
    // Failures are already swallowed above; this keeps one from poisoning the chain regardless.
    this.#tail = write.then(
      () => {},
      () => {},
    )
    await this.#tail
  }
}

function isQueuedEvent(value: unknown): value is QueuedEvent {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['event'] === 'string' &&
    typeof candidate['at'] === 'number' &&
    Number.isFinite(candidate['at']) &&
    candidate['properties'] !== null &&
    typeof candidate['properties'] === 'object'
  )
}
