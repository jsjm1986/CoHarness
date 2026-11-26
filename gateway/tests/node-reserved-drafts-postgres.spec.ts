/** Reserved project drafts keep exact creator authority through cancellation and first materialization. */
import { randomBytes, randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createPostgresPool, transaction } from '../src/postgres/database.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { reservedDraftFixture, reservedDraftTranscript } from './node-reserved-draft-fixture.ts'
import type { NodeDraftKey } from '../src/node-drafts.ts'

const governance=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL),contentUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_NODE_CONTENT_DATABASE_URL),pgdata=process.env.HGW_TEST_NODE_CONTENT_PGDATA
async function verifyProjectDraftRecovery(f: Awaited<ReturnType<typeof reservedDraftFixture>>): Promise<void> {
  const { control, content } = f
  const prepared = await f.prepare()
  const recover = (sessionId = prepared.sessionId, user = f.owner.id) =>
    f.request('/internal/runtime/session/draft/recover', 'POST', { sessionId }, user, true)
  const selection = { provider: 'project-provider', model: 'alternate', reasoningEffort: 'high' }
  const select = (target = prepared, user = f.owner.id) => f.request('/internal/runtime/session/draft/model', 'POST',
    { sessionId: target.sessionId, draftId: target.reservationId, selection }, user, true)
  const { organizationId, nodeId } = f.context
  const { runtimeId, projectId } = f.binding
  expect(await recover()).toMatchObject({ status: 200, body: {
    sessionId: prepared.sessionId, draftId: prepared.reservationId, visibility: 'private', cwd: expect.any(String),
  } })
  expect(await recover(prepared.sessionId, f.other.id)).toEqual({ status: 404, body: { error: 'conversation-not-found' } })
  expect((await select({ ...prepared, reservationId: randomUUID() })).status).toBe(404)
  expect((await select(prepared, f.other.id)).status).toBe(404)
  expect(await select()).toEqual({ status: 200, body: { saved: true } })
  expect(await recover()).toMatchObject({ status: 200, body: { modelSelection: selection } })
  expect((await content.query('SELECT model_selection FROM node_content.conversation_draft_reservations WHERE runtime_id=$1 AND session_id=$2',
    [runtimeId, prepared.sessionId])).rows).toEqual([{ model_selection: selection }])
  expect((await content.query('SELECT FROM node_content.conversation_sessions WHERE runtime_id=$1 AND id=$2',
    [runtimeId, prepared.sessionId])).rowCount).toBe(0)
  expect((await control.query('SELECT FROM harness.conversation_draft_reservations WHERE runtime_id=$1', [runtimeId])).rowCount).toBe(0)

  const mode = (access: 'rw' | 'ro') => control.query(`UPDATE harness.project_members SET access_mode=$4
    WHERE organization_id=$1 AND project_id=$2 AND user_id=$3`, [organizationId, projectId, f.ownerId, access])
  const read = f.store.read.bind(f.store)
  const revokeDuringRead = vi.spyOn(f.store, 'read').mockImplementationOnce(async (...args) => {
    const value = await read(...args)
    await mode('ro')
    return value
  })
  try {
    expect((await recover()).status).toBe(403)
    expect(revokeDuringRead).toHaveBeenCalled()
  } finally {
    revokeDuringRead.mockRestore()
    await mode('rw')
  }
  const grant = (allowed: boolean) => control.query(`UPDATE harness.computer_use_permissions SET enabled=$4
    WHERE organization_id=$1 AND node_id=$2 AND user_id=$3`, [organizationId, nodeId, f.ownerId, allowed])
  await grant(false)
  expect((await recover()).status).toBe(403)
  expect((await select()).status).toBe(403)
  await grant(true)

  const expired = await f.prepare()
  await content.query(`UPDATE node_content.conversation_draft_reservations
    SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE runtime_id=$1 AND session_id=$2`, [runtimeId, expired.sessionId])
  expect((await recover(expired.sessionId)).status).toBe(404)
  expect((await select(expired)).status).toBe(404)
  const archived = await f.prepare()
  await content.query(`INSERT INTO node_content.conversation_archive_records
    (organization_id,runtime_id,root_session_id,state,runtime_public_id) VALUES($1,$2,$3,'archived',$4)`,
  [organizationId, runtimeId, archived.sessionId, f.projectId])
  expect((await recover(archived.sessionId)).status).toBe(404)
  expect((await select(archived)).status).toBe(404)

  const wrongBinding = f.conversations.forRuntime({ organizationId, runtimeId }, {
    generation: 1, contentBinding: { ...f.binding, writerEpoch: (BigInt(f.binding.writerEpoch) + 1n).toString() },
  })
  await expect(wrongBinding.readReservedProjectDraft(prepared.sessionId, projectId, f.ownerId)).rejects
    .toThrow('does not match its active placement')

  const connection = randomUUID()
  await transaction(control, async tx => {
    await tx.query('UPDATE harness.deployment_topology SET legacy_initialization_required=true WHERE organization_id=$1', [organizationId])
    await tx.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,connection_id,connection_epoch,lease_expires_at,execution_ready)
      VALUES($1,$2,$3,$4,1,clock_timestamp()+interval '5 minutes',true)`,
    [organizationId, nodeId, randomBytes(32), connection])
    await tx.query('UPDATE harness.instances SET node_connection_id=$2,node_connection_epoch=1 WHERE runtime_id=$1', [runtimeId, connection])
  })
  try {
    expect((await recover()).status).toBe(200)
    await control.query("UPDATE harness.node_agents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE node_id=$1", [nodeId])
    expect((await recover()).status).toBe(401)
    expect((await select()).status).toBe(401)
  } finally {
    await transaction(control, async tx => {
      await tx.query('UPDATE harness.instances SET node_connection_id=NULL,node_connection_epoch=NULL WHERE runtime_id=$1', [runtimeId])
      await tx.query('DELETE FROM harness.node_agents WHERE organization_id=$1 AND node_id=$2', [organizationId, nodeId])
      await tx.query('UPDATE harness.deployment_topology SET legacy_initialization_required=false WHERE organization_id=$1', [organizationId])
    })
  }
}

it.skipIf(!governance||!contentUrl||!pgdata)('keeps unmaterialized drafts private, rejects cancelled authority, and preserves both tabs through first append',async()=>{
  const control=createPostgresPool(governance!,{max:3}),content=createPostgresPool(contentUrl!,{max:3})
  try{
    await using f=await reservedDraftFixture(control,content,pgdata!)
    await verifyProjectDraftRecovery(f)
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
    expect((await f.request(revokedUrl,'PUT',{revision:0,text:'retained after revocation'})).status).toBe(200)
    f.pauseFinalRead(async()=>{f.pauseFinalRead(undefined);await control.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',[f.context.organizationId,f.context.nodeId,f.ownerId])})
    expect((await f.request(revokedUrl)).status).toBe(403)
    const hidden = { status: 404, body: { error: 'runtime-catalog/not-found' } }
    const denied = { status: 403, body: { error: 'not-member' } }
    expect([denied, hidden]).toContainEqual(await f.request(revokedUrl,'PUT',{revision:1,text:'not authorized'}))
    await expect.poll(() => f.request(f.documentTarget(revoked.sessionId))).toEqual(hidden)
    expect((await content.query('SELECT revision::int,body FROM node_content.composer_drafts WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3',
      [f.context.organizationId,f.binding.runtimeId,revoked.sessionId])).rows)
      .toEqual([{ revision: 1, body: Buffer.from('retained after revocation') }])
  }finally{await Promise.all([control.end(),content.end()])}
})
