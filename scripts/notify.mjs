#!/usr/bin/env node
/**
 * Broadcast a message to every installed pet.
 *
 *   pnpm notify "Keycode on Fire 🔥" --tone warning --animation jumping --expires 24h
 *   pnpm notify "KeyCode starts 1 Sept" --expires 30d --url https://…/kickoff
 *   pnpm notify "Deploy freeze at 5pm" --urgent --duration 10s
 *   pnpm notify --list
 *   pnpm notify "…" --dry-run
 *
 * Publishing is a **commit**. The manifest is served from GitHub Pages out of `site/`, so a message
 * reaches people by being merged — which is the point: remote text that appears above everything on a
 * colleague's screen goes through the same review as code.
 *
 * ---------------------------------------------------------------------------------------
 * Why this is a script and not a text editor.
 * ---------------------------------------------------------------------------------------
 *
 * Three things went wrong repeatedly while publishing these by hand, and each is now impossible:
 *
 *  1. **A malformed envelope silences every announcement for every install.** Per-entry parsing means
 *     one bad notification only costs itself, but an unknown *top-level* key means clients reject the
 *     whole file. So the client's own parser runs here and refuses to write if it would fail.
 *  2. **Ids are permanent dedupe keys.** Reusing one shows nothing to anyone who saw it before —
 *     silently. Ids are generated, never typed.
 *  3. **Relative wording goes stale.** "Starting in 15 mins" and "in 30 days" were both published with
 *     week-long windows and would have been wrong for anyone installing later. `--expires` is
 *     mandatory-with-a-default for exactly that reason.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const MANIFEST = join(ROOT, 'site', 'manifest.json')

const PAGES_URL = 'https://keyvaluesoftwaresystems.github.io/keycode-2026-mascot-pet/manifest.json'

/** Entries stay in the file this long after expiring, then get pruned, so it reads as a log. */
const KEEP_EXPIRED_DAYS = 7

const TONES = ['info', 'success', 'warning', 'error']
const PRIORITIES = ['low', 'normal', 'high', 'urgent']

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------

function parseDuration(raw, label) {
  // Seconds are included because `--duration` needs them: the schema clamps a bubble's display time to
  // 2000–30000ms, so the smallest unit the old parser accepted (1m = 60000) already exceeded the
  // maximum. The flag could not express a single legal value.
  const match = /^(\d+)(s|m|h|d)$/.exec(String(raw ?? '').trim())
  if (!match) fail(`${label} must look like 10s, 30m, 24h or 7d — got ${JSON.stringify(raw)}`)
  const n = Number(match[1])
  const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]
  return n * ms
}

/** The window the client will actually honour for a bubble's display time. */
const DURATION_MIN_MS = 2_000
const DURATION_MAX_MS = 30_000

function parseArgs(argv) {
  const opts = {
    text: null,
    tone: 'info',
    priority: 'high',
    animation: 'waving',
    // 24h by default: long enough for everyone to be at a computer, short enough that a message
    // phrased relative to "now" cannot mislead someone who installs next week.
    expiresMs: 86_400_000,
    startsInMs: -60_000,
    url: null,
    durationMs: null,
    list: false,
    dryRun: false,
    push: true,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--tone': opts.tone = argv[(i += 1)]; break
      case '--priority': opts.priority = argv[(i += 1)]; break
      case '--urgent': opts.priority = 'urgent'; break
      case '--animation': opts.animation = argv[(i += 1)]; break
      case '--expires': opts.expiresMs = parseDuration(argv[(i += 1)], '--expires'); break
      case '--starts-in': opts.startsInMs = parseDuration(argv[(i += 1)], '--starts-in'); break
      case '--url': opts.url = argv[(i += 1)]; break
      // Omitting --duration is what makes a notification wait to be clicked. See DECISIONS #72.
      case '--duration': {
        const ms = parseDuration(argv[(i += 1)], '--duration')
        // Refuse rather than let the client silently clamp: someone asking for 5 minutes should be told
        // it is impossible, not given 30 seconds and left wondering.
        if (ms < DURATION_MIN_MS || ms > DURATION_MAX_MS) {
          fail(
            `--duration must be between 2s and 30s (the client clamps it) — got ${ms}ms.\n` +
              '  Omit it entirely and the notification waits to be clicked instead.',
          )
        }
        opts.durationMs = ms
        break
      }
      case '--list': opts.list = true; break
      case '--dry-run': opts.dryRun = true; break
      case '--no-push': opts.push = false; break
      default:
        if (arg.startsWith('--')) fail(`Unknown flag ${arg}`)
        else if (opts.text === null) opts.text = arg
        else fail(`Unexpected extra argument ${JSON.stringify(arg)} — quote the message.`)
    }
  }

  if (!opts.list && !opts.text) {
    fail('Nothing to say. Pass the message as the first argument, or use --list.')
  }
  if (!TONES.includes(opts.tone)) fail(`--tone must be one of ${TONES.join(', ')}`)
  if (!PRIORITIES.includes(opts.priority)) fail(`--priority must be one of ${PRIORITIES.join(', ')}`)
  return opts
}

// ---------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------

/**
 * A readable, unique id: a slug of the message plus a UTC minute stamp.
 *
 * Readable because it appears in the manifest and in every client's settings file forever, and unique
 * because reusing an id means the message silently never shows to anyone who saw the first one. The
 * charset matches the schema's `[A-Za-z0-9._-]`.
 */
export function makeId(text, now) {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    // Drop anything the schema would reject, including the emoji that make good message text.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 13) // YYYYMMDDTHHMM
  return `${slug || 'message'}-${stamp}`
}

/** Drop entries that expired more than `KEEP_EXPIRED_DAYS` ago. */
export function pruneExpired(entries, now, keepDays = KEEP_EXPIRED_DAYS) {
  const cutoff = now - keepDays * 86_400_000
  return entries.filter((entry) => {
    const expires = Date.parse(entry.expiresAt ?? '')
    return !Number.isFinite(expires) || expires >= cutoff
  })
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

/**
 * Only run when invoked directly.
 *
 * `makeId` and `pruneExpired` are the parts worth unit-testing, and a module that publishes a
 * notification as a side effect of being imported cannot be tested at all — the test file failed to
 * load before this guard existed.
 */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) await main()

async function main() {
const opts = parseArgs(process.argv.slice(2))
const now = Date.now()

if (!existsSync(MANIFEST)) fail(`${MANIFEST} is missing.`)
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))

if (opts.text) {
  const entry = {
    id: makeId(opts.text, now),
    text: opts.text,
    tone: opts.tone,
    priority: opts.priority,
    animation: opts.animation,
    ...(opts.durationMs === null ? {} : { durationMs: opts.durationMs }),
    startsAt: iso(now + opts.startsInMs),
    expiresAt: iso(now + opts.expiresMs),
    ...(opts.url ? { url: opts.url } : {}),
  }
  manifest.notifications = pruneExpired([entry, ...manifest.notifications], now)
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
}

// ---- Validate with the client's own parser, from the built output.
const schemaPath = join(ROOT, 'apps', 'desktop', 'dist', 'broadcast', 'manifest-schema.js')
if (!existsSync(schemaPath)) fail('Run `pnpm build` first — validation uses the compiled client schema.')
const { parseManifest, selectDue } = await import(`file://${schemaPath}`)

const body = readFileSync(MANIFEST, 'utf8')
const parsed = parseManifest(body)
if (parsed === null) {
  fail(
    'the manifest is REJECTED by the client parser — every install would ignore the whole file.\n' +
      '  Check `version`, that `notifications` is an array, and that no unknown top-level key crept in.',
  )
}

// ---- Report what clients will do with it.
// The empty set is "a fresh install has seen nothing", which is the question that matters here: this
// reports what the manifest *offers*, not what any one machine has already been shown.
const live = selectDue(parsed.notifications, now, new Set())

console.log(`manifest: site/manifest.json  (${body.length} bytes)`)
for (const d of parsed.dropped) console.log(`  ⚠ entry ${d.index} DROPPED — ${d.reason}`)

for (const n of parsed.notifications) {
  const state = live.some((l) => l.id === n.id)
    ? 'LIVE'
    : now < n.startsAtMs
      ? `scheduled ${iso(n.startsAtMs)}`
      : `expired   ${iso(n.expiresAtMs)}`
  const holds = n.durationMs === null ? 'until clicked' : `${n.durationMs}ms`
  console.log(`  ${state.padEnd(24)} ${n.id}`)
  if (state === 'LIVE') console.log(`  ${' '.repeat(24)} "${n.text}" · ${n.priority} · ${holds}`)
}

console.log(
  `\n  A fresh install would receive ${live.length} message(s), at most 3 per poll.` +
    `\n  Existing installs see only ids they have never seen.`,
)
if (parsed.defaults?.pollMinutes) {
  console.log(`  Poll interval: ${parsed.defaults.pollMinutes} min. Pages purges its CDN on deploy,`)
  console.log('  so a publish is visible immediately rather than after the max-age window.')
}
console.log('\n  This file is world-readable. Nothing goes in it that would not be fine on a public page.')

if (opts.list) process.exit(0)
if (opts.dryRun) {
  console.log('\n· --dry-run: file written, nothing committed')
  process.exit(0)
}

// ---- Publish, which here means commit and push.
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) fail(`git ${args.join(' ')} failed:\n${r.stderr?.trim()}`)
  return r.stdout.trim()
}

git('add', 'site/manifest.json')
if (!git('status', '--porcelain', '--', 'site/manifest.json')) {
  console.log('\n· nothing changed; not committing')
  process.exit(0)
}
git('commit', '-m', `notify: ${opts.text}`)
console.log('\n✓ committed')

if (opts.push) {
  git('push')
  console.log(`✓ pushed — Pages will serve it within a minute or two:\n  ${PAGES_URL}`)
} else {
  console.log('· --no-push: commit it yourself when ready')
}
}
