import { DEFAULT_MAC_UPDATE_FEED_URL } from '../config/constants.js'

/**
 * Whether this process can have its .app replaced in place (Squirrel.Mac).
 *
 * Packaged macOS only, and not from a mounted disk image — Squirrel cannot write back onto a DMG.
 */
export function canApplyMacUpdate(opts: {
  packaged: boolean
  platform: NodeJS.Platform
  execPath: string
}): boolean {
  if (!opts.packaged || opts.platform !== 'darwin') return false
  return !opts.execPath.includes('/Volumes/')
}

export function macUpdateFeedUrl(opts: {
  arch: string
}): string {
  return opts.arch === 'x64' ? DEFAULT_MAC_UPDATE_FEED_URL.x64 : DEFAULT_MAC_UPDATE_FEED_URL.arm64
}
