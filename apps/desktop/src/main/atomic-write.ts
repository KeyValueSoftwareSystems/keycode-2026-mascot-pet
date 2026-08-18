/**
 * Write a file so that a crash can never leave a half-written one behind.
 *
 * Extracted from the settings store when the analytics queue needed the same guarantee. The sequence
 * is load-bearing in every part:
 *
 *   - **Temp file first**, named with the pid and a counter so two writers cannot collide.
 *   - **`fsync` before rename.** Rename is atomic with respect to the directory entry, but without a
 *     flush the *contents* may not have reached the device — so a power loss can leave a correctly
 *     named, entirely empty file. That failure mode looks exactly like data loss and is invisible in
 *     testing, because it needs real power loss to reproduce.
 *   - **Rename with retries.** Windows antivirus and indexers transiently lock a destination file,
 *     surfacing as EPERM/EBUSY/EACCES. Three quick retries turn a spurious failure into a non-event;
 *     a persistent one still surfaces to the caller.
 *
 * Throws on failure. Callers decide whether that is worth reporting — it generally is not.
 */

import { open, rename, unlink } from 'node:fs/promises'

let tempSeq = 0

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temp = `${path}.${process.pid}.${(tempSeq += 1)}.tmp`

  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export async function renameWithRetry(from: string, to: string, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!retryable || attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}
