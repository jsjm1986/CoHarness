/** Owner-private SQL credentials for the node's content volume. */
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { privateFileState } from './node-private-file.ts'

/** Read a bounded connection URL through its private, regular-file handle.
 * @param path - operating-system protected credential file.
 * @returns its PostgreSQL URL; never include it in diagnostics.
 */
export async function readNodeContentDatabaseUrl(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    const info = await handle.stat()
    if (await privateFileState(path, info, 8192) !== 'private') throw new Error('The node content database credential file must be private.')
    const value = (await handle.readFile('utf8')).trim()
    if (!/^postgres(?:ql)?:\/\//u.test(value)) throw new Error('The node content database credential file must contain one PostgreSQL URL.')
    return value
  } finally { await handle.close() }
}
