/** Exact, version-ordered migration bytes from the installed Gateway release. */
import { createHash } from 'node:crypto'
import { readFile,readdir } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import type { Queryable } from './postgres/database.ts'

/** @param directory - migration directory (defaults to the installed release). @returns ordered SQL and its digest. */
export async function nodeContentMigrations(directory=resolve(import.meta.dirname,'../deploy/node-content/migrations')) {
  const names = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/u.test(name)).sort()
  if (names.length === 0 || names.some((name, i) => Number(name.slice(0,3)) !== i+1)) throw new Error('Invalid node content migration sequence.')
  return Promise.all(names.map(async name => {
    const sql = await readFile(join(directory,name),'utf8')
    return { version: Number(name.slice(0,3)), name, sql, checksum: createHash('sha256').update(sql).digest('hex') }
  }))
}

/** @param database - already attested content database. @param files - checked release file list.
 * @returns count of verified installed migrations, in order.
 */
export async function checkedNodeContentVersions(database:Queryable, files:Awaited<ReturnType<typeof nodeContentMigrations>>): Promise<number>{
  const recorded=(await database.query<{version:number;name:string;checksum:string}>('SELECT version,name,checksum FROM node_content.schema_migrations ORDER BY version')).rows
  if (recorded.some((row,i)=>row.version!==i+1 || row.name!==files[i]?.name || row.checksum!==files[i]?.checksum)) throw new Error('The node content migration checksums differ from the installed release.')
  return recorded.length
}
