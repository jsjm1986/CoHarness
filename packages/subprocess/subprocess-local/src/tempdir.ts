/**
 * @module @deepseek-ai/dsh-subprocess-local/tempdir
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Create a private directory under the OS temporary location. `os.tmpdir()`
 * is env-derived and can name an unusable path (a regular file, a removed
 * directory); managed launches and output spill must still work, so the POSIX
 * default is the fallback before the failure surfaces.
 * @param prefix - directory-name prefix identifying the owning feature.
 * @returns the created directory's absolute path.
 */
export function privateTemporaryDirectory(prefix: string): string {
  try {
    return mkdtempSync(join(tmpdir(), prefix))
  } catch (error) {
    if (tmpdir() === '/tmp') throw error
    return mkdtempSync(join('/tmp', prefix))
  }
}
