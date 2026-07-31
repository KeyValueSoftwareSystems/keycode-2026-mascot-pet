/**
 * Shared plumbing for generated artifacts.
 *
 * Generated files are committed (a fresh clone must build without a generate step) which
 * creates exactly one failure mode: committed output drifting from what the generator now
 * produces. `--check` closes it — it regenerates into memory, diffs, and exits non-zero
 * with the first differing line. Wired into `build` and CI.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, relative } from 'node:path'

export const BANNER_LINES = [
  'GENERATED FILE — DO NOT EDIT.',
  'Source of truth: pet/spritesheet.json',
  'Regenerate with: pnpm generate',
]

export function cssBanner() {
  return `/*\n${BANNER_LINES.map((l) => ` * ${l}`).join('\n')}\n */\n`
}

export function tsBanner() {
  return `/*\n${BANNER_LINES.map((l) => ` * ${l}`).join('\n')}\n */\n`
}

/**
 * Write `content` to `path`, or in check mode compare and report.
 *
 * @returns {{ changed: boolean, diff: string | null }}
 */
export function emitOrCheck(path, content, { check = false } = {}) {
  const rel = relative(process.cwd(), path)

  if (!check) {
    mkdirSync(dirname(path), { recursive: true })
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (existing === content) return { changed: false, diff: null }
    writeFileSync(path, content, 'utf8')
    return { changed: true, diff: null }
  }

  if (!existsSync(path)) {
    return { changed: true, diff: `${rel} does not exist but the generator produces it.` }
  }
  const existing = readFileSync(path, 'utf8')
  if (existing === content) return { changed: false, diff: null }
  return { changed: true, diff: firstDifference(rel, existing, content) }
}

function firstDifference(rel, actual, expected) {
  const a = actual.split('\n')
  const b = expected.split('\n')
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i += 1) {
    if (a[i] !== b[i]) {
      return [
        `${rel} is stale at line ${i + 1}:`,
        `  committed: ${JSON.stringify(a[i] ?? '<end of file>')}`,
        `  generated: ${JSON.stringify(b[i] ?? '<end of file>')}`,
        '',
        'Run `pnpm generate` and commit the result.',
      ].join('\n')
    }
  }
  return `${rel} differs in length only. Run \`pnpm generate\`.`
}

/** Report a set of emit results and exit non-zero in check mode if anything was stale. */
export function reportResults(label, results, { check = false } = {}) {
  const stale = results.filter((r) => r.changed)
  if (check) {
    if (stale.length === 0) {
      console.log(`✓ ${label}: committed output is up to date`)
      return
    }
    for (const r of stale) if (r.diff) console.error(`✗ ${r.diff}`)
    console.error(`\n${label}: ${stale.length} generated file(s) are stale.`)
    process.exit(1)
  }
  console.log(
    stale.length === 0
      ? `✓ ${label}: already up to date`
      : `✓ ${label}: wrote ${stale.length} file(s)`,
  )
}
