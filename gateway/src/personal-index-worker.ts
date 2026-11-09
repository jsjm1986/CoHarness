/** Store one validated publication atomically in the private directory database. */
import {sqliteOperation,type NodeSqlite} from './node-sqlite-driver.ts'
import { createHash } from 'node:crypto'
import type { PersonalIndexOwner, PersonalIndexRequest, PersonalIndexPage, PersonalIndexReceipt } from './personal-index.ts'

/** @param db - filesystem-attested SQLite handle. @returns handlers retaining its reviewed prepared statements. */
export function openPersonalIndex(db:NodeSqlite){
db.exec('PRAGMA journal_mode=WAL')
db.exec('PRAGMA synchronous=FULL')
const version = (db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version
if (version !== 0 && version !== 1) throw new Error('Unsupported personal directory schema')
if (version === 0) sqliteOperation(db,true,() => {
  db.exec(`CREATE TABLE publications (owner TEXT PRIMARY KEY,generation INTEGER NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,has_conversations INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE workspaces (owner TEXT NOT NULL,id TEXT NOT NULL,search_text TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(owner,id)) WITHOUT ROWID;
    CREATE TABLE conversations (owner TEXT NOT NULL,id TEXT NOT NULL,updated REAL NOT NULL,search_text TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(owner,id)) WITHOUT ROWID;
    CREATE INDEX recent_conversations ON conversations(owner,updated DESC,id);
    CREATE TABLE members(owner TEXT NOT NULL,workspace TEXT NOT NULL,session TEXT NOT NULL,PRIMARY KEY(owner,workspace,session)) WITHOUT ROWID`)
  db.exec('PRAGMA user_version=1')
})()

const ownerId = (owner: PersonalIndexOwner) => JSON.stringify([owner.organizationId,owner.nodeId,owner.runtimeId,owner.userId])
const insertWorkspace = db.prepare('INSERT INTO workspaces VALUES(?,?,?,?)')
const insertConversation = db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)')
const addMember = db.prepare('INSERT OR IGNORE INTO members VALUES(?,?,?)')
const current = db.prepare('SELECT generation,revision,digest,has_conversations FROM publications WHERE owner=?')
const publish = sqliteOperation(db,true,(request: Extract<PersonalIndexRequest,{op:'publish'}>) => {
  const owner = ownerId(request.owner), { generation, snapshot } = request.input
  const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  const admitted = db.prepare(`INSERT INTO publications VALUES(?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET generation=excluded.generation,
    revision=excluded.revision,digest=excluded.digest,has_conversations=excluded.has_conversations
    WHERE (publications.generation,publications.revision)<(excluded.generation,excluded.revision)`).run(owner,generation,snapshot.revision,digest,Number(snapshot.conversations !== undefined))
  if (admitted.changes === 0) {
    const stored = current.get(owner) as PersonalIndexReceipt
    if (stored.generation === generation && stored.revision === snapshot.revision && stored.digest !== digest) throw new Error('Conflicting directory revision')
    return stored
  }
  for (const table of ['workspaces','conversations','members']) db.prepare('DELETE FROM '+table+' WHERE owner=?').run(owner)
  for (const workspace of snapshot.items) {
    insertWorkspace.run(owner,workspace.workspaceId,[workspace.workspaceId,workspace.title,workspace.path].join(' ').toLowerCase(),JSON.stringify({ ...workspace, sessionIds: [] }))
    for (const session of workspace.sessionIds) addMember.run(owner,workspace.workspaceId,session)
  }
  for (const row of snapshot.conversations ?? []) {
    insertConversation.run(owner,row.sessionId,row.updatedAt,[row.sessionId,row.title,row.cwd].join(' ').toLowerCase(),JSON.stringify(row))
  }
  return { generation, revision:snapshot.revision,digest }
})

const page = sqliteOperation(db,false,(request: Extract<PersonalIndexRequest,{op:'page'}>): PersonalIndexPage | null => {
  const owner = ownerId(request.owner), { kind, query, afterTime, afterId, limit, workspaceId } = request.input
  const source = current.get(owner) as { generation: number; revision: number; has_conversations: number } | undefined
  if (!source) return null
  const rows = kind === 'workspaces'
    ? db.prepare('SELECT value FROM workspaces WHERE owner=? AND id>? AND instr(search_text,?)>0 AND (? IS NULL OR id=?) ORDER BY id LIMIT ?')
      .all(owner,afterId,query.toLowerCase(),workspaceId,workspaceId,limit)
    : db.prepare(`SELECT c.value FROM conversations c WHERE c.owner=? AND instr(c.search_text,?)>0
        AND (? IS NULL OR c.updated<? OR (c.updated=? AND c.id>?))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM members m WHERE m.owner=c.owner AND m.workspace=? AND m.session=c.id))
        ORDER BY c.updated DESC,c.id LIMIT ?`).all(owner,query.toLowerCase(),afterTime,afterTime,afterTime,afterId,workspaceId,workspaceId,limit)
  return { generation: source.generation, revision: source.revision, indexed: kind === 'workspaces' || source.has_conversations === 1,
    rows: rows.map(row => JSON.parse((row as { value: string }).value)) }
})

  return (input:Exclude<PersonalIndexRequest,{op:'close'}>)=>input.op==='publish'?publish(input):input.op==='page'?page(input):
    !!db.prepare(`SELECT 1 FROM conversations c JOIN publications p ON p.owner=c.owner WHERE c.owner=? AND c.id=? AND p.has_conversations=1`).get(ownerId(input.owner),input.sessionId)
}
