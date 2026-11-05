/** Route an editor's private draft to the same project volume as the conversation. */
import { createHash } from 'node:crypto'
import { recordNodeContentDomainReceipt, requireNodeContentRelations, type NodeContentCheckInput } from './node-content-publication.ts'
import { transaction } from './postgres/database.ts'
import type { LocalNodeDrafts } from './node-drafts.ts'
import { NodeContentUnavailable, type NodeContentStore } from './node-content-store.ts'
import { decodeDraftHistory, defaultDraftHistoryLimits, pinnedDraftValue, retainDraftHistory } from './draft-history.ts'
import { resolveDraftEdit, type NodeDraftStorage } from './node-drafts.ts'
import { CollaborationDeniedError } from './collaboration.ts'
import { checkDraftSession,confirmDraftAuthority,draftAuthority } from './node-content-draft-authority.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'

/**
 * Keep personal and not-yet-migrated drafts on the serving computer and enforce the recorded primary for placed projects.
 * @param context - authenticated governance and node identity.
 * @param legacy - node-private store for personal and unmigrated scopes.
 * @param local - attested content volume, absent when not provisioned.
 * @param limits - maximum predecessor count and UTF-8 history size for one private draft.
 * @returns revision-checked access for the authenticated Gateway route.
 */
export function projectNodeDrafts(context: PostgresRuntimeContext, legacy: NodeDraftStorage & Partial<Pick<LocalNodeDrafts,'projectPage'>>, local?: Pick<NodeContentStore, 'read' | 'write' | 'confirmCollaborationRead'>, limits=defaultDraftHistoryLimits): NodeDraftStorage & {verifyNodeContent(input:NodeContentCheckInput):Promise<void>} {
  return { apply() { throw new CollaborationDeniedError('forbidden') }, async applyAuthenticated(key,operation,sessionDigest) {
    if (key.nodeId!==context.nodeId || key.organizationId!==context.organizationId) throw new NodeContentUnavailable()
    const save=operation.kind==='save',initial=await draftAuthority(context.pool,key,sessionDigest,save),binding=initial.binding
    const confirm=async(control:import('pg').PoolClient,lock:boolean)=>{
      const final=await draftAuthority(control,key,sessionDigest,save,lock)
      confirmDraftAuthority(initial,final)
      return final
    }
    if (!binding) {
      await checkDraftSession(context.pool,'harness',key,initial)
      const readResult=save ? undefined : await legacy.apply(key,operation)
      return transaction(context.pool,async control=>{
        await checkDraftSession(control,'harness',key,initial,true)
        await confirm(control,true)
        return readResult ?? legacy.apply(key,operation)
      })
    }
    if (!local || binding.nodeId!==context.nodeId) throw new NodeContentUnavailable()
    const identity=[binding.organizationId,binding.projectId,binding.runtimeId,key.userId,key.draftId,key.sessionId]
    const read=async(db:import('pg').PoolClient,withHistory:boolean)=>{
      const row=(await db.query<{revision:string;body:Buffer;previous_versions?:Buffer}>(`SELECT revision::text,body${withHistory ? ',previous_versions' : ''} FROM node_content.composer_drafts
        WHERE (organization_id,project_id,runtime_id,account_id,draft_id,session_id)=($1,$2,$3,$4,$5,$6)`,identity)).rows[0]
      return { value: row?{revision:Number(row.revision),text:row.body.toString('utf8')}:{revision:0,text:''}, history: row?.previous_versions?.toString('utf8') ?? '[]' }
    }
    const snapshot=await local.read(binding,async db=>{
        await checkDraftSession(db,'node_content',key,initial)
        const v=(await db.query<{revision:string}>(`SELECT revision::text FROM node_content.conversation_acl_versions
          WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3`,identity.slice(0,3))).rows[0]
        if(!v)throw new NodeContentUnavailable()
        const stored=await read(db,operation.kind==='read' && operation.revision!==undefined)
        return {revision:v.revision,value:pinnedDraftValue(stored.value,operation.kind==='read'?operation.revision:undefined,stored.history)}
    })
    if (!save) {
      return transaction(context.pool,control=>local.confirmCollaborationRead(binding,snapshot.revision,async()=>{
        await confirm(control,false)
        return snapshot.value
      }))
    }
    return transaction(context.pool,control=>local.write(binding,async db=>{
      await db.query('LOCK TABLE node_content.composer_drafts IN ROW EXCLUSIVE MODE NOWAIT')
      const {value:previous,history}=await read(db,true),actor=await confirm(control,true)
      await checkDraftSession(db,'node_content',key,actor,true)
      const result=resolveDraftEdit(previous,operation)
      if(result.status===200 && result.value!==previous) {
        await db.query(`INSERT INTO node_content.composer_drafts(organization_id,project_id,runtime_id,account_id,draft_id,session_id,revision,body,previous_versions)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(organization_id,project_id,runtime_id,account_id,draft_id,session_id)
          DO UPDATE SET revision=EXCLUDED.revision,body=EXCLUDED.body,previous_versions=EXCLUDED.previous_versions`,
          [...identity,result.value.revision,Buffer.from(result.value.text),Buffer.from(retainDraftHistory(previous,history,limits))])
      }
      await confirm(control,false)
      return result
    }))
  }, async verifyNodeContent({control,local:db,binding:b,migration}) {
    if (!local || context.organizationId!==b.organizationId || context.nodeId!==b.nodeId) throw new NodeContentUnavailable()
    await requireNodeContentRelations(db,['composer_drafts'])
    if (!migration) return
    if (!legacy.projectPage) throw new NodeContentUnavailable('The project draft source is unavailable.')
    const project=(await control.query<{public_id:string}>('SELECT public_id::text FROM harness.projects WHERE organization_id=$1 AND id=$2',
      [b.organizationId,b.projectId])).rows[0]
    if (!project) throw new NodeContentUnavailable()
    const digest=createHash('sha256')
    let after='',records=0
    for (;;) {
      const rows=await legacy.projectPage(b,after)
      if (!rows.length) break
      for (const row of rows) {
        const key:unknown=JSON.parse(row.identity)
        if (!Array.isArray(key) || key.length!==7 || key[0]!==b.organizationId || key[1]!==b.nodeId || !Number.isSafeInteger(key[2])
          || key[2]<=0 || key[3]!==b.runtimeId || key[4]!=='project:'+project.public_id || typeof key[5]!=='string' || typeof key[6]!=='string'
          || !Number.isSafeInteger(row.revision) || row.revision<1) throw new NodeContentUnavailable('A source draft has an unknown owner or revision.')
        const history = row.history ?? '[]'
        if (decodeDraftHistory(history).some(item => item.revision >= row.revision)) throw new NodeContentUnavailable('Invalid node draft history.')
        const versions=Buffer.from(history)
        const written=await db.query<{revision:string;body:Buffer;previous_versions:Buffer}>(`INSERT INTO node_content.composer_drafts(organization_id,project_id,runtime_id,account_id,draft_id,session_id,revision,body,previous_versions)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(organization_id,project_id,runtime_id,account_id,draft_id,session_id)
          DO UPDATE SET revision=excluded.revision,body=excluded.body,previous_versions=excluded.previous_versions WHERE composer_drafts.revision<excluded.revision OR
            (composer_drafts.revision=excluded.revision AND composer_drafts.body=excluded.body AND composer_drafts.previous_versions=excluded.previous_versions) RETURNING revision::text,body,previous_versions`,
        [b.organizationId,b.projectId,b.runtimeId,key[2],key[6],key[5],row.revision,Buffer.from(row.text),versions])
        if (written.rows[0]?.revision!==String(row.revision) || written.rows[0].body.toString('utf8')!==row.text || !written.rows[0].previous_versions.equals(versions)) throw new NodeContentUnavailable('A node draft differs from its source.')
        digest.update(JSON.stringify([row.identity,row.revision,row.text,...(row.history && row.history!=='[]' ? [row.history] : [])])+'\n')
        records++
      }
      after=rows.at(-1)!.identity
    }
    const total=await db.query<{count:string}>('SELECT count(*)::text count FROM node_content.composer_drafts WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3',
      [b.organizationId,b.projectId,b.runtimeId])
    if (total.rows[0]?.count!==String(records)) throw new NodeContentUnavailable('The project has unmatched node drafts.')
    await recordNodeContentDomainReceipt(db,{snapshotId:migration.snapshotId,sourceRevision:migration.sourceRevision,domain:'drafts',records,digest:digest.digest()})
  } }
}
