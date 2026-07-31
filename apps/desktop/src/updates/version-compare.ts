/**
 * Version comparison. Pure.
 *
 * Ported from openpets' `update-version.ts`, including its deliberate simplification: prerelease
 * suffixes are stripped and ignored rather than ordered. So `0.4.0-rc.1` compares *equal* to
 * `0.4.0`, which means a prerelease is never announced as newer than its release. For an internal
 * tool that is the safe direction to be wrong — the alternative is telling everyone a release
 * candidate is an upgrade.
 */

export const SEMVER_CORE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

export function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== 'string') return null
  const match = SEMVER_CORE.exec(raw.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

/**
 * Is `remote` newer than `current`?
 *
 * Unparseable input yields **false**, never true. An unreadable version must not be announced as an
 * upgrade, and it must certainly not crash a background poll.
 */
export function isNewer(remote: unknown, current: unknown): boolean {
  const a = parseVersion(remote)
  const b = parseVersion(current)
  if (!a || !b) return false

  if (a.major !== b.major) return a.major > b.major
  if (a.minor !== b.minor) return a.minor > b.minor
  // Numeric, not lexical: 0.10.0 is newer than 0.9.0, which a string compare gets backwards.
  return a.patch > b.patch
}
