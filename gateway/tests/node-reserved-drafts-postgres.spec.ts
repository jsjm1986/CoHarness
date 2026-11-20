/** Reserved project drafts keep exact creator authority through cancellation and first materialization. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createPostgresPool } from '../src/postgres/database.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { reservedDraftFixture, reservedDraftTranscript } from './node-reserved-draft-fixture.ts'
import type { NodeDraftKey } from '../src/node-drafts.ts'

const governance=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL),contentUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_NODE_CONTENT_DATABASE_URL),pgdata=process.env.HGW_TEST_NODE_CONTENT_PGDATA
it.skipIf(!governance||!contentUrl||!pgdata)('keeps unmaterialized drafts private, rejects cancelled authority, and preserves both tabs through first append',async()=>{
  const control=createPostgresPool(governance!,{max:3}),content=createPostgresPool(contentUrl!,{max:3})
  try{
    await using f=await reservedDraftFixture(control,content,pgdata!)
    await reservedDraftTranscript(f)
    const prepared=await f.prepare(),url=f.draft(prepared.sessionId,prepared.editorId)
    expect((await f.request(url,'PUT',{revision:0,text:'retained draft'})).status).toBe(200)
    const params=[f.context.organizationId,f.binding.runtimeId,prepared.sessionId]
    f.pauseFinalRead(async()=>{f.pauseFinalRead(undefined);await content.query('DELETE FROM node_content.conversation_draft_reservations WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3',params)})
    expect((await f.request(url)).status).toBe(403)
    expect((await f.request(url,'PUT',{revision:1,text:'must not overwrite'})).status).toBe(403)
    expect((await f.request(f.documentTarget(prepared.sessionId))).status).toBe(409)
    expect((await content.query('SELECT body FROM node_content.composer_drafts WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3',params)).rows[0]!.body.toString()).toBe('retained draft')
    const expired=await f.prepare(),expiredUrl=f.draft(expired.sessionId,expired.editorId)
    await content.query("UPDATE node_content.conversation_draft_reservations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3",[...params.slice(0,2),expired.sessionId])
    expect((await f.request(expiredUrl)).status).toBe(403)
    expect((await f.request(expiredUrl,'PUT',{revision:0,text:'expired'})).status).toBe(403)
    expect((await f.request(f.documentTarget(expired.sessionId))).status).toBe(409)
    const expiring=await f.prepare(),expiringUrl=f.draft(expiring.sessionId,expiring.editorId)
    f.pauseFinalRead(async()=>{f.pauseFinalRead(undefined);await content.query("UPDATE node_content.conversation_draft_reservations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3",[...params.slice(0,2),expiring.sessionId])})
    expect((await f.request(expiringUrl)).status).toBe(403)
    const contended=await f.prepare(),contendedUrl=f.draft(contended.sessionId,contended.editorId),held=await content.connect()
    try{
      await held.query('BEGIN')
      await held.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`conversation:${JSON.stringify([f.context.organizationId,f.binding.runtimeId,contended.sessionId])}`])
      expect((await f.request(contendedUrl)).status).toBe(503)
      expect((await f.request(f.documentTarget(contended.sessionId))).status).toBe(503)
      await held.query('COMMIT')
      expect((await f.request(contendedUrl)).status).toBe(200)
      await held.query('BEGIN')
      await held.query('SELECT FROM node_content.conversation_draft_reservations WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3 FOR UPDATE',[...params.slice(0,2),contended.sessionId])
      expect((await f.request(contendedUrl)).status).toBe(503)
      expect((await f.request(f.documentTarget(contended.sessionId))).status).toBe(503)
      await held.query('COMMIT')
    }finally{await held.query('ROLLBACK');held.release()}
    for(const action of ['cancel','materialize'] as const){
      const delayed=await f.prepare(),delayedUrl=f.draft(delayed.sessionId,delayed.editorId)
      expect((await f.request(delayedUrl,'PUT',{revision:0,text:action+' retained'})).status).toBe(200)
      let writer:Promise<unknown>|undefined
      f.retainFinalRead(async()=>{
        f.retainFinalRead(undefined)
        writer=action==='cancel'
          ? f.request('/internal/runtime/session/draft/release','POST',{sessionId:delayed.sessionId,draftId:delayed.reservationId},f.owner.id,true).then(result=>expect(result.status,JSON.stringify(result.body)).toBe(200))
          : f.request('/internal/runtime/session/append','POST',{sessionId:delayed.sessionId,batchId:randomUUID(),creationAuthorization:delayed.authorization,events:[]},f.owner.id,true).then(result=>expect(result.status,JSON.stringify(result.body)).toBe(200))
        void writer.catch(()=>undefined)
        await expect.poll(async()=>(await content.query("SELECT FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND (query LIKE '%conversation_draft_reservations%' OR query LIKE '%pg_advisory_xact_lock%')")).rowCount,{timeout:5000}).toBeGreaterThan(0)
      })
      try{expect(await f.request(delayedUrl)).toEqual({status:200,body:{revision:1,text:action+' retained'}})}finally{f.retainFinalRead(undefined);if(writer)await writer}
      expect((await f.request(delayedUrl)).status).toBe(action==='cancel'?403:200)
    }
    const first=await f.prepare(),firstUrl=f.draft(first.sessionId,first.editorId)
    expect((await f.request(firstUrl,'PUT',{revision:0,text:'before first append'})).status).toBe(200)
    f.pauseFinalRead(async()=>{
      f.pauseFinalRead(undefined)
      const result=await f.request('/internal/runtime/session/append','POST',{sessionId:first.sessionId,batchId:randomUUID(),creationAuthorization:first.authorization,events:[]},f.owner.id,true)
      expect(result.status,JSON.stringify(result.body)).toBe(200)
    })
    expect(await f.request(firstUrl)).toEqual({status:200,body:{revision:1,text:'before first append'}})
    await control.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2",[f.context.organizationId,f.otherId])
    expect((await f.request(firstUrl,'GET',undefined,f.other.id)).status).toBe(403)
    expect((await f.request(f.documentTarget(first.sessionId),'GET',undefined,f.other.id)).status).toBe(403)
    await content.query('UPDATE node_content.conversation_sessions SET closed_at=clock_timestamp() WHERE organization_id=$1 AND runtime_id=$2 AND id=$3',[...params.slice(0,2),first.sessionId])
    expect((await f.request(f.documentTarget(first.sessionId))).status).toBe(409)
    await content.query("UPDATE node_content.conversation_sessions SET status='deleted' WHERE organization_id=$1 AND runtime_id=$2 AND id=$3",[...params.slice(0,2),first.sessionId])
    expect((await f.request(firstUrl)).status).toBe(403)
    expect((await f.request(f.documentTarget(first.sessionId))).status).toBe(409)
    const archived=await f.prepare()
    await content.query("INSERT INTO node_content.conversation_archive_records(organization_id,runtime_id,root_session_id,state,runtime_public_id) VALUES($1,$2,$3,'archived',$4)",[...params.slice(0,2),archived.sessionId,f.projectId])
    expect((await f.request(f.draft(archived.sessionId,archived.editorId))).status).toBe(403)
    expect((await f.request(f.documentTarget(archived.sessionId))).status).toBe(409)
    await content.query("UPDATE node_content.conversation_sessions SET status='active',closed_at=NULL WHERE organization_id=$1 AND runtime_id=$2 AND id=$3",[...params.slice(0,2),first.sessionId])
    await content.query("INSERT INTO node_content.conversation_archive_records(organization_id,runtime_id,root_session_id,state,runtime_public_id) VALUES($1,$2,$3,'archived',$4)",[...params.slice(0,2),first.sessionId,f.projectId])
    expect((await f.request(f.documentTarget(first.sessionId))).status).toBe(409)
    const legacy=(await control.query<{id:string;public_id:number}>('INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id) VALUES($1,$2,$3,$3) RETURNING id,public_id::float8',[f.context.organizationId,randomUUID(),f.ownerId])).rows[0]!
    await control.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)',[f.context.organizationId,legacy.id,f.context.nodeId,'/synthetic/legacy'])
    await control.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw')",[f.context.organizationId,legacy.id,f.ownerId])
    const allocation=(await control.query<{runtime_id:NodeDraftKey['runtimeId']}>('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,47301) RETURNING runtime_id',[f.context.organizationId,legacy.id,f.context.nodeId])).rows[0]!
    const legacySession=randomUUID(),reservation=randomUUID(),repo=f.conversations.forRuntime({organizationId:f.context.organizationId,runtimeId:allocation.runtime_id})
    await repo.reserveDraft({organizationId:f.context.organizationId,runtimeId:allocation.runtime_id,scopeKey:'fixture',draftId:reservation,sessionId:legacySession,userId:f.ownerId,projectId:legacy.id,cwd:'/synthetic/legacy',visibility:'private'})
    const digest=(await control.query<{token_hash:Buffer}>('SELECT token_hash FROM harness.auth_sessions WHERE organization_id=$1 AND user_id=$2',[f.context.organizationId,f.ownerId])).rows[0]!.token_hash
    const legacyKey:NodeDraftKey={organizationId:f.context.organizationId,nodeId:f.context.nodeId as NodeDraftKey['nodeId'],runtimeId:allocation.runtime_id,userId:f.owner.id,target:'project:'+legacy.public_id,sessionId:legacySession,draftId:randomUUID()}
    expect(await f.drafts.applyAuthenticated!(legacyKey,{kind:'save',value:{revision:0,text:'legacy private'}},digest)).toEqual({status:200,value:{revision:1,text:'legacy private'}})
    expect(await f.drafts.applyAuthenticated!(legacyKey,{kind:'read'},digest)).toEqual({status:200,value:{revision:1,text:'legacy private'}})
    expect(await f.drafts.reservedSessionAuthenticated!(legacyKey,digest)).toBe(true)
    await repo.releaseDraftForOwner({organizationId:f.context.organizationId,draftId:reservation,sessionId:legacySession,userId:f.ownerId,projectId:legacy.id})
    expect(await f.drafts.reservedSessionAuthenticated!(legacyKey,digest)).toBe(false)
    await expect(f.drafts.applyAuthenticated!(legacyKey,{kind:'read'},digest)).rejects.toMatchObject({code:'forbidden'})
    const revoked=await f.prepare(),revokedUrl=f.draft(revoked.sessionId,revoked.editorId)
    f.pauseFinalRead(async()=>{f.pauseFinalRead(undefined);await control.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',[f.context.organizationId,f.context.nodeId,f.ownerId])})
    expect((await f.request(revokedUrl)).status).toBe(403)
    expect((await f.request(revokedUrl,'PUT',{revision:0,text:'not authorized'})).status).toBe(403)
    expect((await f.request(f.documentTarget(revoked.sessionId))).status).toBe(403)
  }finally{await Promise.all([control.end(),content.end()])}
})
