/** Export only an approved personal directory and its tab drafts from live SQLite WAL snapshots. */
import { decodeDraftHistory } from './draft-history.ts'
import { prepareDraftSchema } from './node-draft-schema.ts'
import { openPersonalIndex } from './personal-index-worker.ts'
import { backup, DatabaseSync } from 'node:sqlite'
import { lstat, mkdir, mkdtemp, realpath, rm, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

interface Input {
  action: 'capture' | 'validate' | 'restore'
  directory: string
  stateRoot?: string
  organizationId: string
  sourceNodeId: string
  scopeId: string
  userId: number
  maxBytes: number
  maxRows: number
  reserveBytes: number
}
const input = workerData as Input
const owner = JSON.stringify([input.organizationId, input.sourceNodeId, input.scopeId, input.userId])
const draftPrefix = JSON.stringify([input.organizationId, input.sourceNodeId, input.userId, input.scopeId]).slice(0, -1)
const directoryTables = ['publications', 'workspaces', 'conversations', 'members'] as const
const upperDraft = draftPrefix + '-'
const lowerDraft = draftPrefix + ','
const file = join(input.directory, 'personal.sqlite')

async function openSource(path: string, required: boolean, versions: readonly number[]): Promise<DatabaseSync | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error('peer-backup/unsafe-source')
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const source = new DatabaseSync(path, { readOnly: true })
  try {
    source.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN')
    if (!versions.includes(Number(source.prepare('PRAGMA user_version').get()?.user_version))) throw new Error('peer-backup/unsupported-source')
    return source
  } catch (error) {
    source.close()
    throw error
  }
}

function parseRow(collection: string, row: Record<string, unknown>): void {
  if (collection === 'drafts') {
    if (typeof row.identity !== 'string' || typeof row.text !== 'string' || !Number.isSafeInteger(row.revision)) {
      throw new Error('peer-backup/invalid-export')
    }
    if ('history' in row && (typeof row.history !== 'string' ||
      decodeDraftHistory(row.history).some(item => item.revision >= Number(row.revision)))) throw new Error('peer-backup/invalid-export')
    const ids: unknown = JSON.parse(row.identity)
    if (
      !Array.isArray(ids) ||
      ids.length !== 7 ||
      ids[0] !== input.organizationId ||
      ids[1] !== input.sourceNodeId ||
      ids[2] !== input.userId ||
      ids[3] !== input.scopeId ||
      !ids.slice(4).every((value) => typeof value === 'string')
    ) {
      throw new Error('peer-backup/cross-scope-row')
    }
  } else if (!(directoryTables as readonly string[]).includes(collection) || row.owner !== owner) {
    throw new Error('peer-backup/cross-scope-row')
  }
}

async function capture() {
  if (!input.stateRoot) throw new Error('peer-backup/consistent-export-unavailable')
  const catalog = await openSource(join(input.stateRoot, 'personal-directory', 'index.sqlite'), true, [1])
  if (!catalog) throw new Error('peer-backup/consistent-export-unavailable')
  const spool = await mkdtemp(join(dirname(input.directory), 'personal-source-'))
  const projection = new DatabaseSync(join(spool, 'scoped.sqlite'))
  let drafts: DatabaseSync | undefined
  try {
    // The recovered file contains only scoped rows. The shared source databases never become backup payloads.
    const disk = await statfs(spool, { bigint: true })
    const free = disk.bsize * disk.bavail - BigInt(input.reserveBytes)
    if (free < 32768n) throw new Error('peer-backup/export-budget')
    const quota = Math.min(input.maxBytes, Number(free / 2n))
    projection.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=${Math.max(2, Math.floor(quota / 4096))};
      CREATE TABLE records (collection TEXT NOT NULL, body TEXT NOT NULL); PRAGMA user_version=1; BEGIN`)
    const insert = projection.prepare('INSERT INTO records VALUES (?, ?)')
    const publication = catalog.prepare('SELECT generation,revision FROM publications WHERE owner=?').get(owner)
    if (
      !publication ||
      !Number.isSafeInteger(publication.generation) ||
      !Number.isSafeInteger(publication.revision) ||
      Number(publication.generation) < 1
    )
      throw new Error('peer-backup/personal-directory-unpublished')
    let rows = 0,
      bytes = 0
    function append(collection: string, row: Record<string, unknown>) {
      parseRow(collection, row)
      const body = JSON.stringify(row)
      bytes += Buffer.byteLength(body)
      if (++rows > input.maxRows || bytes > input.maxBytes) throw new Error('peer-backup/export-budget')
      insert.run(collection, body)
    }
    for (const table of directoryTables) {
      for (const row of catalog.prepare('SELECT * FROM ' + table + ' WHERE owner=?').iterate(owner)) append(table, row)
    }
    drafts = await openSource(join(input.stateRoot, 'node-content-drafts', 'drafts.sqlite'), false, [1, 2, 3])
    if (drafts) {
      const versions = drafts.prepare('PRAGMA user_version').get()?.user_version === 3 ? ',previous_versions AS history' : ''
      for (const row of drafts
        .prepare('SELECT identity,revision,text' + versions + ' FROM drafts WHERE identity>=? AND identity<?')
        .iterate(lowerDraft, upperDraft))
        append('drafts', row)
    }
    projection.exec('COMMIT')
    await backup(projection, file, { rate: 64 })
    return { generation: Number(publication.generation), revision: Number(publication.revision), rows, drafts: !!drafts }
  } finally {
    catalog.close()
    drafts?.close()
    projection.close()
    await rm(spool, { recursive: true, force: true })
  }
}

async function validate() {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(file)) !== file || info.size > input.maxBytes) {
    throw new Error('peer-backup/invalid-export')
  }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF')
    if (
      db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok' ||
      db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='records'").get()?.n !== 1
    ) {
      throw new Error('peer-backup/invalid-export')
    }
    let rows = 0,
      generation = 0,
      revision = 0
    for (const entry of db.prepare('SELECT collection,body FROM records').iterate()) {
      if (++rows > input.maxRows || typeof entry.collection !== 'string' || typeof entry.body !== 'string') {
        throw new Error('peer-backup/invalid-export')
      }
      const row = JSON.parse(entry.body) as Record<string, unknown>
      parseRow(entry.collection, row)
      if (entry.collection === 'publications') {
        if (generation || !Number.isSafeInteger(row.generation) || !Number.isSafeInteger(row.revision))
          throw new Error('peer-backup/invalid-export')
        generation = Number(row.generation)
        revision = Number(row.revision)
      }
    }
    if (!generation) throw new Error('peer-backup/invalid-export')
    return { generation, revision, rows }
  } finally {
    db.close()
  }
}

async function restore() {
  if(!input.stateRoot)throw new Error('peer-backup/invalid-export')
  const proof=await validate()
  const catalogDir=join(input.stateRoot,'personal-directory'), draftDir=join(input.stateRoot,'node-content-drafts')
  await mkdir(catalogDir,{mode:0o700});await mkdir(draftDir,{mode:0o700})
  const catalog=new DatabaseSync(join(catalogDir,'index.sqlite')),drafts=new DatabaseSync(join(draftDir,'drafts.sqlite')),
    records=new DatabaseSync(file,{readOnly:true})
  try {
    openPersonalIndex(catalog);prepareDraftSchema(drafts)
    catalog.exec('BEGIN');drafts.exec('BEGIN')
    const apply={
      publications:catalog.prepare('INSERT INTO publications(owner,generation,revision,digest,has_conversations) VALUES(:owner,:generation,:revision,:digest,:has_conversations)'),
      workspaces:catalog.prepare('INSERT INTO workspaces(owner,id,search_text,value) VALUES(:owner,:id,:search_text,:value)'),
      conversations:catalog.prepare('INSERT INTO conversations(owner,id,updated,search_text,value) VALUES(:owner,:id,:updated,:search_text,:value)'),
      members:catalog.prepare('INSERT INTO members(owner,workspace,session) VALUES(:owner,:workspace,:session)'),
      drafts:drafts.prepare('INSERT INTO drafts(identity,revision,text,previous_versions) VALUES(:identity,:revision,:text,:history)'),
    }
    for(const entry of records.prepare('SELECT collection,body FROM records').iterate()){
      const collection=String(entry.collection) as keyof typeof apply,row=JSON.parse(String(entry.body)) as Record<string,string|number>
      parseRow(collection,row)
      if(collection==='drafts')row.history??='[]'
      apply[collection].run(row)
    }
    catalog.exec('COMMIT');drafts.exec('COMMIT')
    return proof
  }finally{records.close();catalog.close();drafts.close()}
}

try {
  const result = input.action === 'capture' ? await capture() : input.action==='restore' ? await restore() : await validate()
  parentPort?.postMessage({ result })
} catch (error) {
  const message =
    error instanceof Error && /^peer-backup\/[a-z-]+$/u.test(error.message)
      ? error.message
      : 'peer-backup/personal-domain-unavailable'
  parentPort?.postMessage({ error: message })
}
