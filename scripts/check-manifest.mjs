#!/usr/bin/env node
/**
 * Validate `site/manifest.json` with the client's own parser, before it reaches anyone.
 *
 *   pnpm manifest:check [path]
 *
 * ---------------------------------------------------------------------------------------
 * Why this exists, stated accurately
 * ---------------------------------------------------------------------------------------
 *
 * There was already a pre-deploy check: both `ci.yml` and `pages.yml` run `notify --list`, which calls
 * the real client parser and **fails** when it returns null. So the worst case — a manifest the client
 * rejects outright, losing every announcement in it — was already blocked before reaching Pages. Any
 * claim that hand edits were unguarded is wrong, and this script does not exist to fix that.
 *
 * What it does is close a narrower gap and then take over the job:
 *
 *   - `--list` **warns** about dropped notifications and exits 0. A published announcement that will
 *     never show is a publisher error, and it should fail.
 *   - Dropped *defaults* did not exist as a concept until the client stopped rejecting the file over a
 *     bad value. That change is what makes this script necessary rather than merely tidier: the client
 *     now degrades gracefully, which is right for the client, and moves the burden of noticing here.
 *
 * So there is one validator, used by CI and by the Pages deploy, that fails on all three classes:
 * a rejected manifest, a dropped notification, a dropped default. `notify --list` stays as the
 * human-facing report of what clients will actually do with the file.
 *
 * The division of labour: the client's job is to survive a publisher's mistake. This one's job is to
 * make sure the publisher finds out.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DEFAULT_MANIFEST = join(ROOT, 'site', 'manifest.json')

function fail(message) {
  console.error(`✗ manifest:check — ${message}`)
  process.exit(1)
}

const target = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_MANIFEST
if (!existsSync(target)) fail(`${target} does not exist.`)

const schemaPath = join(ROOT, 'apps', 'desktop', 'dist', 'broadcast', 'manifest-schema.js')
if (!existsSync(schemaPath)) {
  fail('run `pnpm build` first — this validates with the compiled client schema, not a copy of it.')
}
const { parseManifest, selectDue } = await import(`file://${schemaPath}`)

const body = readFileSync(target, 'utf8')
const parsed = parseManifest(body)

if (parsed === null) {
  fail(
    `${target} is REJECTED by the client parser — every install would ignore the whole file,\n` +
      '  including every announcement in it, silently.\n' +
      '  Check `version`, that `notifications` is an array, and that no unknown *top-level* key crept\n' +
      '  in — the envelope is strict even though `defaults` is not.',
  )
}

const problems = []

if (parsed.dropped.length > 0) {
  problems.push(
    `${parsed.dropped.length} notification(s) would never be shown:\n` +
      parsed.dropped.map((d) => `      index ${d.index}: ${d.reason}`).join('\n'),
  )
}

if (parsed.droppedDefaults.length > 0) {
  problems.push(
    `${parsed.droppedDefaults.length} default(s) would never apply: ${parsed.droppedDefaults.join(', ')}\n` +
      '      The value is present but unusable, so the built-in applies instead. Clients tolerate this\n' +
      '      rather than rejecting the file; it is caught here so it is not caught by nobody.',
  )
}

// What a client would actually act on right now, as opposed to what is merely in the file.
//
// Positional args, and the empty set means "a fresh install has seen nothing" — the question that
// matters here is what the manifest *offers*, not what one machine has already been shown. Passing an
// options object instead silently compares every timestamp against NaN and reports 0 live forever,
// which is how the first version of this line lied.
const due = selectDue(parsed.notifications, Date.now(), new Set())

console.log(`▶ ${target.replace(`${ROOT}/`, '')}`)
console.log(`  notifications   ${parsed.notifications.length} usable, ${due.length} live right now`)
console.log(`  release         ${parsed.release ? parsed.release.latestVersion : '(none)'}`)
if (parsed.defaults === null) {
  console.log('  defaults        (none — every client uses its built-ins)')
} else {
  const shown = Object.entries(parsed.defaults)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
  console.log(`  defaults        ${shown.length > 0 ? shown.join(' ') : '(all null)'}`)
}

if (problems.length > 0) {
  console.error('')
  for (const problem of problems) console.error(`  ⚠ ${problem}`)
  fail(`${problems.length} problem(s) — fix before deploying, because the deploy reaches everyone.`)
}

console.log('✓ every announcement and default in this manifest will reach clients as written')
