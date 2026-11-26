/** Recovery notices retain only suspended environment names inside the sealed target files. */
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PeerBackupError } from './peer-backup-repository.ts'

const marker = '.recovery-environment.json'
const record = z.object({ version: z.literal(1), keys: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/u)).max(128) }).strict()

/** Read names from an unpublished or restored Runtime; older copies without a marker return no notices.
 * @param home - node-owned Runtime home. @param maxBytes - configured restore byte budget.
 * @returns unique sorted setting names, never their values.
 */
export async function readRecoveryEnvironment(home: string, maxBytes: number): Promise<string[]> {
  const file = join(home, marker)
  const info = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return []
  if (!info.isFile() || info.isSymbolicLink() || info.size > Math.min(maxBytes, 32768))
    throw new PeerBackupError(409, 'peer-backup/environment-evidence-incomplete')
  const text = await readFile(file, 'utf8')
  let value: unknown
  try { value = JSON.parse(text) } catch (error) {
    if (error instanceof SyntaxError) throw new PeerBackupError(409, 'peer-backup/environment-evidence-incomplete')
    throw error
  }
  const parsed = record.safeParse(value)
  if (!parsed.success || new Set(parsed.data.keys).size !== parsed.data.keys.length)
    throw new PeerBackupError(409, 'peer-backup/environment-evidence-incomplete')
  return parsed.data.keys.slice().sort()
}

/** Preserve earlier notices when another disaster removes additional connection settings; ordinary migration never invokes this writer.
 * @param home - private, unpublished Runtime copy. @param keys - names removed from this copy.
 * @param maxBytes - configured restore byte budget.
 * @returns the sealed union of setting names requiring administrator review.
 */
export async function sealRecoveryEnvironment(home: string, keys: string[], maxBytes: number): Promise<string[]> {
  const names = [...new Set([...await readRecoveryEnvironment(home, maxBytes), ...keys])].sort()
  if (!names.length) return names
  const parsed = record.safeParse({ version: 1, keys: names })
  if (!parsed.success) throw new PeerBackupError(409, 'peer-backup/environment-evidence-incomplete')
  await writeFile(join(home, marker), JSON.stringify(parsed.data) + '\n', { mode: 0o600, flush: true })
  return names
}
