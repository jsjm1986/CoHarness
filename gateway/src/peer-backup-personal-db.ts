/** Personal Runtime PostgreSQL records retain their original account and allocation in an isolated recovery point. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool,PoolClient } from 'pg'
import { z } from 'zod'
import { transaction } from './postgres/database.ts'
import type { NodeContentStore } from './node-content-store.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import type { PeerBackupBinding } from './peer-backup-restic.ts'

const tables = ['plugin_states', 'conversation_sessions', 'conversation_events', 'conversation_append_batches',
  'conversation_participants', 'conversation_interaction_responses', 'conversation_migrations', 'conversation_migrated_events'] as const
type Table = typeof tables[number]
function sessionColumn(table: Table): 'conversation_id' | 'session_id' {
  return table === 'conversation_participants' || table === 'conversation_interaction_responses' ? 'conversation_id' : 'session_id'
}
type Budget = { maxBytes: number; maxRows: number }
const invalid = () => new PeerBackupError(409, 'peer-backup/invalid-export')
const over = () => new PeerBackupError(507, 'peer-backup/export-budget')

/** Bounded, private receipt for one repeatable-read snapshot. Empty Runtime tables are distinguished from absent coverage. */
export const personalDatabaseReceipt = z.object({
  owner: z.uuid(), organizationId: z.uuid(), nodeId: z.uuid(), runtimeId: z.uuid(),
  watermark: z.string().regex(/^[0-9]+$/u), capturedAt: z.iso.datetime(),
  bytes: z.number().int().nonnegative(), rows: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict()

const rowBudget=8<<20
async function captureRows(db:PoolClient,path:string,statements:{table:string;sql:string;args:string[]}[],budget:Budget,signal:AbortSignal){
  const file=await open(path,'wx',0o600),hash=createHash('sha256');let rows=0,bytes=0
  try{
    for(const statement of statements){
      await db.query(`DECLARE personal_rows NO SCROLL CURSOR FOR SELECT CASE WHEN octet_length(row_to_json(t)::text)<=$${statement.args.length+1}
        THEN row_to_json(t)::text END body ${statement.sql}`,[...statement.args,Math.min(rowBudget,budget.maxBytes)])
      for(;;){
        signal.throwIfAborted()
        const page=await db.query<{body:string|null}>('FETCH FORWARD 4 FROM personal_rows')
        if(!page.rowCount)break
        for(const {body} of page.rows){
          if(body===null)throw over()
          const line='{"table":'+JSON.stringify(statement.table)+',"row":'+body+'}\n'
          bytes+=Buffer.byteLength(line)
          if(++rows>budget.maxRows||bytes>budget.maxBytes)throw over()
          await file.writeFile(line);hash.update(line)
        }
      }
      await db.query('CLOSE personal_rows')
    }
    await file.sync()
    return {rows,bytes,sha256:hash.digest('hex')}
  }finally{await file.close()}
}

async function verifyRows(path:string,receipt:{rows:number;bytes:number;sha256:string},budget:Budget,signal:AbortSignal,
  check:(table:string,row:Record<string,unknown>)=>void){
  const stat=await lstat(path)
  if(!stat.isFile()||stat.nlink!==1||await realpath(path)!==path||stat.size!==receipt.bytes||receipt.bytes>budget.maxBytes||receipt.rows>budget.maxRows)throw invalid()
  const file=createReadStream(path,{signal}),hash=createHash('sha256')
  let rows=0,parts:Buffer[]=[],size=0
  try{
    for await(const chunk of file){
      signal.throwIfAborted()
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);hash.update(bytes)
      let start=0
      while(start<bytes.length){
        const newline=bytes.indexOf(10,start),part=bytes.subarray(start,newline<0?bytes.length:newline)
        parts.push(part);size+=part.length
        if(size>rowBudget+128)throw invalid()
        if(newline<0)break
        if(++rows>receipt.rows)throw invalid()
        const item=JSON.parse(Buffer.concat(parts,size).toString('utf8')) as {table:string;row:Record<string,unknown>}
        check(item.table,item.row);parts=[];size=0;start=newline+1
      }
    }
    if(size||rows!==receipt.rows||hash.digest('hex')!==receipt.sha256)throw invalid()
  }finally{file.destroy()}
}

/** Export the Runtime's configured plugin state and any Session generations held by the PostgreSQL persistence provider. */
export async function capturePersonalDatabase(pool: Pool, binding: PeerBackupBinding, publicId: number, directory: string,
  budget: Budget, signal: AbortSignal): Promise<z.infer<typeof personalDatabaseReceipt>> {
  return transaction(pool, async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const coordinates = [binding.organizationId, binding.sourceNodeId, binding.scopeId, publicId]
    const owner = (await db.query<{ id: string; watermark: string; capturedAt: Date }>(`SELECT u.id,
      pg_snapshot_xmax(pg_current_snapshot())::text watermark, transaction_timestamp() "capturedAt"
      FROM harness.runtime_environments r JOIN harness.users u ON u.organization_id=r.organization_id AND u.id=r.owner_id
      JOIN harness.personal_directory_placement p ON (p.organization_id,p.runtime_id,p.owner_id,p.node_id)=(r.organization_id,r.id,u.id,r.node_id)
      WHERE r.organization_id=$1 AND r.node_id=$2 AND r.id=$3 AND u.public_id=$4 AND r.owner_kind='user' AND r.retired_at IS NULL`, coordinates)).rows[0]
    if (!owner) throw new PeerBackupError(409, 'peer-backup/space-placement-changed')
    const statements=tables.map(table=>{
      const predicate = table === 'plugin_states' ? 't.user_id=$3 AND t.project_id IS NULL'
        : table === 'conversation_sessions' ? 't.creator_user_id=$3 AND t.project_id IS NULL'
        : `EXISTS(SELECT FROM harness.conversation_sessions s WHERE (s.organization_id,s.runtime_id,s.id)=(t.organization_id,t.runtime_id,t.${sessionColumn(table)})
            AND s.creator_user_id=$3 AND s.project_id IS NULL)`
      return {table,sql:`FROM harness.${table} t WHERE t.organization_id=$1 AND t.runtime_id=$2 AND ${predicate}`,
        args:[binding.organizationId,binding.scopeId,owner.id]}
    })
    const records=await captureRows(db,join(directory,'personal-runtime.jsonl'),statements,budget,signal)
    return personalDatabaseReceipt.parse({ owner:owner.id, organizationId:binding.organizationId, nodeId:binding.sourceNodeId,
      runtimeId:binding.scopeId, watermark:owner.watermark, capturedAt:owner.capturedAt.toISOString(), ...records })
  }, signal)
}

/** Reject a modified file, an unowned generation or a child outside its exported personal Session on the recovery computer. */
export async function verifyPersonalDatabase(binding: PeerBackupBinding, receipt: z.infer<typeof personalDatabaseReceipt>,
  directory: string, budget: Budget, signal: AbortSignal): Promise<void> {
  if (receipt.organizationId !== binding.organizationId || receipt.nodeId !== binding.sourceNodeId || receipt.runtimeId !== binding.scopeId) throw invalid()
  const sessions=new Set<string>()
  await verifyRows(join(directory,'personal-runtime.jsonl'),receipt,budget,signal,(table,row)=>{
      if (!(tables as readonly string[]).includes(table) || row.organization_id !== binding.organizationId || row.runtime_id !== binding.scopeId) throw invalid()
      if (table === 'plugin_states') {
        if (row.user_id !== receipt.owner || row.project_id !== null || !Array.isArray(row.entries) || !Array.isArray(row.bundles)) throw invalid()
      } else if (table === 'conversation_sessions') {
        if (row.creator_user_id !== receipt.owner || row.project_id !== null || typeof row.id !== 'string' || sessions.has(row.id)) throw invalid()
        sessions.add(row.id)
      } else {
        const session = row[sessionColumn(table as Table)]
        if (typeof session !== 'string' || !sessions.has(session)) throw invalid()
      }
  })
}

const docTables=['document_roots','document_entries','document_events','document_receipts'] as const
/** Account documents have one root on each computer, shared by that account’s personal Runtime allocations. */
export const personalDocumentReceipt=personalDatabaseReceipt.extend({rootId:z.uuid(),volumeId:z.uuid(),epoch:z.string().regex(/^[1-9]\d*$/u),
  revision:z.string().regex(/^\d+$/u),sequence:z.string().regex(/^\d+$/u),ordinal:z.number().int().nonnegative()}).strict()

/** Capture the published account-wide references and transfer receipts from the exact owning volume. */
export async function capturePersonalDocuments(pool:Pool,store:Pick<NodeContentStore,'readVolume'>,binding:PeerBackupBinding,
  publicId:number,directory:string,budget:Budget,signal:AbortSignal):Promise<z.infer<typeof personalDocumentReceipt>|undefined>{
  const authority=async()=>(await pool.query<{owner:string;rootId:string;volumeId:string;epoch:string}>(`SELECT u.id owner,p.root_id "rootId",p.volume_id "volumeId",p.writer_epoch::text epoch
    FROM harness.document_scope_placement p JOIN harness.users u ON (u.organization_id,u.id)=(p.organization_id,p.scope_id)
    JOIN harness.runtime_environments r ON (r.organization_id,r.node_id,r.owner_id)=(p.organization_id,p.node_id,u.id)
    WHERE p.organization_id=$1 AND p.node_id=$2 AND r.id=$3 AND u.public_id=$4 AND r.owner_kind='user' AND r.retired_at IS NULL
    AND p.scope_kind='personal' AND p.project_runtime_id IS NULL`,[binding.organizationId,binding.sourceNodeId,binding.scopeId,publicId])).rows[0]
  const location=await authority()
  if(!location)return
  const result=await store.readVolume(async db=>{
    const root=(await db.query<{revision:string;sequence:string;ordinal:number;watermark:string;time:Date}>(`SELECT revision::text,sequence::text,ordinal,
      pg_snapshot_xmax(pg_current_snapshot())::text watermark,transaction_timestamp() time FROM node_content.document_roots
      WHERE organization_id=$1 AND node_id=$2 AND scope_kind='personal' AND scope_id=$3 AND root_id=$4 AND volume_id=$5 AND writer_epoch=$6 AND runtime_id IS NULL`,
      [binding.organizationId,binding.sourceNodeId,location.owner,location.rootId,location.volumeId,location.epoch])).rows[0]
    if(!root)throw new PeerBackupError(409,'peer-backup/space-placement-changed')
    const records=await captureRows(db,join(directory,'personal-documents.jsonl'),docTables.map(table=>({table,
      sql:`FROM node_content.${table} t WHERE t.organization_id=$1 AND t.root_id=$2 AND t.runtime_id IS NULL`,args:[binding.organizationId,location.rootId]})),budget,signal)
    return personalDocumentReceipt.parse({...location,revision:root.revision,sequence:root.sequence,ordinal:root.ordinal,watermark:root.watermark,capturedAt:root.time.toISOString(),
      organizationId:binding.organizationId,nodeId:binding.sourceNodeId,runtimeId:binding.scopeId,...records})
  },signal)
  if(JSON.stringify(await authority())!==JSON.stringify(location))throw new PeerBackupError(409,'peer-backup/space-placement-changed')
  return result
}

/** Revalidate the root, account, original node, cursor and every referenced file identity in an offline recovery snapshot. */
export async function verifyPersonalDocuments(binding:PeerBackupBinding,receipt:z.infer<typeof personalDocumentReceipt>,directory:string,budget:Budget,signal:AbortSignal){
  if(receipt.organizationId!==binding.organizationId||receipt.nodeId!==binding.sourceNodeId||receipt.runtimeId!==binding.scopeId)throw invalid()
  let roots=0
  const entries=new Set<string>()
  await verifyRows(join(directory,'personal-documents.jsonl'),receipt,budget,signal,(table,row)=>{
    if(!(docTables as readonly string[]).includes(table)||row.root_id!==receipt.rootId||row.organization_id!==binding.organizationId||row.runtime_id!==null)throw invalid()
    if(table==='document_roots'){
      if(++roots!==1||row.node_id!==binding.sourceNodeId||row.scope_kind!=='personal'||row.scope_id!==receipt.owner||row.volume_id!==receipt.volumeId||
        String(row.writer_epoch)!==receipt.epoch||String(row.revision)!==receipt.revision||String(row.sequence)!==receipt.sequence||row.ordinal!==receipt.ordinal)throw invalid()
    }else if(table==='document_entries'){
      if(typeof row.catalog_id!=='string'||entries.has(row.catalog_id))throw invalid()
      entries.add(row.catalog_id)
    }else if(row.catalog_id!==null&&(typeof row.catalog_id!=='string'||!entries.has(row.catalog_id)))throw invalid()
  })
  if(roots!==1)throw invalid()
}
