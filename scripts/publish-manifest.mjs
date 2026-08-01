#!/usr/bin/env node
/**
 * Publish manifest/manifest.json to the broadcast host.
 *
 *   pnpm manifest:publish            # validate, then upload
 *   pnpm manifest:publish --dry-run  # validate only
 *
 * The host is a static file on plain nginx. There is no application to deploy and no auth to
 * administer: a shipped client needs HTTPS and an ETag, and both come for free.
 *
 * The reason this is a script and not a bare `scp`: **a malformed envelope silences every
 * announcement for every install.** Per-entry parsing means one bad notification only costs itself,
 * but a bad envelope means the client trusts nothing in the file — so the same parser the clients
 * use runs here, before the file is reachable, and refuses to upload if it fails. A typo that would
 * have been silent for everyone becomes a non-zero exit on one machine.
 *
 * It also reports what each client will actually *do* with the file, which is not obvious from
 * reading it: which entries are live now, which are scheduled, which have expired, and which were
 * dropped. `expiresAt` in the past is the normal resting state, not a mistake.
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const MANIFEST = join(ROOT, 'manifest', 'manifest.json')

const SSH_HOST = 'Ubuntu-OCI-Personal_doylefermi'
const REMOTE_DIR = 'demos/keycode'
const PUBLIC_URL = 'https://demos.doylefermi.freeddns.org/keycode/manifest.json'

const dryRun = process.argv.includes('--dry-run')
const allowDefaults = process.argv.includes('--allow-defaults')

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

// ---- Validate with the client's own parser, from the built output.
const schemaPath = join(ROOT, 'apps', 'desktop', 'dist', 'broadcast', 'manifest-schema.js')
let parseManifest
let selectDue
try {
  const mod = await import(`file://${schemaPath}`)
  ;({ parseManifest, selectDue } = mod)
} catch {
  fail(`cannot import ${schemaPath}\n  Run \`pnpm build\` first — validation uses the compiled schema.`)
}

const body = readFileSync(MANIFEST, 'utf8')
const parsed = parseManifest(body)

if (parsed === null) {
  fail(
    'the manifest is REJECTED by the client parser.\n' +
      '  Every client would ignore this file entirely — not just the bad entry.\n' +
      '  Check `version`, that `notifications` is an array, and that no unknown top-level keys exist.',
  )
}

// ---- Report what clients will do with it.
const now = Date.now()
const live = selectDue(parsed.notifications, now)
const liveIds = new Set(live.map((n) => n.id))

console.log(`manifest: ${MANIFEST}`)
console.log(`  ${body.length} bytes, ${parsed.notifications.length} valid notification(s)`)

if (parsed.dropped.length > 0) {
  console.log(`  ⚠ ${parsed.dropped.length} entry/entries DROPPED — they will never be shown:`)
  for (const d of parsed.dropped) console.log(`      · entry ${d.index}: ${d.reason}`)
}

for (const n of parsed.notifications) {
  // Already -Infinity / +Infinity when the field was absent, so no defaulting is needed here.
  const starts = n.startsAtMs
  const expires = n.expiresAtMs
  const state = liveIds.has(n.id)
    ? 'LIVE NOW'
    : now < starts
      ? `scheduled (${new Date(starts).toISOString()})`
      : now >= expires
        ? `expired (${new Date(expires).toISOString()})`
        : 'not selected'
  console.log(`  · ${n.id} — ${state}`)
  console.log(`      "${n.text}"`)
}

if (parsed.release) {
  console.log(`  release: ${parsed.release.latestVersion}${parsed.release.mandatory ? ' (mandatory)' : ''}`)

  // Guard against the mistake this file already shipped once: the example block declared 0.6.0
  // while package.json said 0.0.0, so making the host real handed every install a clickable
  // "update available" bubble pointing at example.invalid — a domain reserved to never resolve.
  //
  // An update announcement is the one manifest entry that is *not* deduped per install: it dedupes
  // per version, so a wrong one re-announces to everybody on every fresh install rather than once.
  const { isNewer } = await import(
    `file://${join(ROOT, 'apps', 'desktop', 'dist', 'updates', 'version-compare.js')}`
  )
  const appVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

  if (isNewer(parsed.release.latestVersion, appVersion)) {
    console.log(
      `      ⚠ this ANNOUNCES AN UPDATE to every install (${appVersion} → ${parsed.release.latestVersion}).`,
    )
    if (/\.invalid\b|example\.com|localhost/.test(parsed.release.notesUrl)) {
      fail(
        `the release block announces ${parsed.release.latestVersion} but notesUrl is a placeholder:\n` +
          `    ${parsed.release.notesUrl}\n` +
          '  Every install would show a clickable update bubble that goes nowhere.\n' +
          '  Point notesUrl at a real page, or remove the `release` block — it is optional.',
      )
    }
  } else {
    console.log(`      · not newer than this build (${appVersion}) — no update will be announced`)
  }
}

// ---- The one change that breaks older clients.
if (parsed.defaults) {
  console.log(
    `  defaults: ${JSON.stringify(parsed.defaults)} — applied only where a user never chose`,
  )
  if (!allowDefaults) {
    fail(
      'this manifest contains a `defaults` block, which BREAKS EVERY CLIENT OLDER THAN v1.4.0.\n' +
        '  The envelope is strict, so an older build rejects the whole file on an unknown top-level\n' +
        '  key — it does not ignore `defaults`, it ignores the entire manifest. Those installs would\n' +
        '  silently stop receiving announcements altogether, with one debug log line each.\n' +
        '\n' +
        '  Publish this only once everyone is on v1.4.0 or later, then pass --allow-defaults.',
    )
  }
  console.log('      ⚠ --allow-defaults given: clients older than v1.4.0 will ignore this whole file.')
}

if (live.length === 0) {
  console.log('\n  Nothing is live: installs will show no bubble. That is the resting state.')
} else {
  console.log(
    `\n  ${live.length} message(s) will appear on every install, once each, on the next poll` +
      ' (within ~5 minutes).',
  )
}

console.log(
  '\n  Reminder: this host has no auth. The manifest is world-readable at the URL below.\n' +
    '  Nothing goes in it that would not be fine on a public page.',
)

if (dryRun) {
  console.log('\n· --dry-run: not uploaded')
  process.exit(0)
}

// ---- Upload.
const scp = spawnSync('scp', ['-q', MANIFEST, `${SSH_HOST}:${REMOTE_DIR}/`], { stdio: 'inherit' })
if (scp.status !== 0) fail(`scp exited ${scp.status}`)

// ---- Verify what is actually being served, not what we think we sent.
const curl = spawnSync('curl', ['-fsS', PUBLIC_URL], { encoding: 'utf8' })
if (curl.status !== 0) fail(`published, but ${PUBLIC_URL} did not serve: ${curl.stderr?.trim()}`)
if (curl.stdout !== body) {
  fail(`published, but the served body differs from the local file (caching? wrong path?)`)
}

console.log(`\n✓ published — ${PUBLIC_URL}`)
