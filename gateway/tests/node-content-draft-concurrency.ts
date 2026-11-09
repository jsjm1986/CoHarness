/** Exercise both draft layouts with an actual one-connection governance pool and one-connection content pool. */
import { createHash,randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import { expect } from 'vitest'
import { CollaborationDeniedError } from '../src/collaboration.ts'
import { LocalNodeDrafts,type NodeDraftKey,type NodeDraftOperation } from '../src/node-drafts.ts'
import { projectNodeDrafts } from '../src/project-node-drafts.ts'
import { NodeContentStore,type NodeContentBinding } from '../src/node-content-store.ts'
import { PostgresConversationStore } from '../src/postgres/conversation-repository.ts'
import { createPostgresPool } from '../src/postgres/database.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { RuntimeId,RuntimeNodeId } from '../src/runtime-catalog.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

/** Keep a real relation blocked until auth revocation commits from another caller. No token or project source is reused outside the fixture. */
async function whileWaiting(db:Pool,table:string,read:()=>Promise<unknown>,revoke:()=>Promise<unknown>):Promise<void>{
  const lock=await db.connect();let pending:Promise<unknown>|undefined
  try {
    await lock.query('BEGIN'); await lock.query('LOCK TABLE '+table+' IN ACCESS EXCLUSIVE MODE')
    pending=read();void pending.catch(()=>undefined)
    const deadline=Date.now()+8000
    while(!(await db.query(`SELECT FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.relation=$1::regclass AND NOT l.granted LIMIT 1`,[table])).rowCount){
      if(Date.now()>deadline)throw new Error('The draft did not reach the blocked data relation.')
      await delay(10)
    }
    await revoke(); await lock.query('COMMIT');await expect(pending).rejects.toBeInstanceOf(CollaborationDeniedError)
  }finally{await lock.query('ROLLBACK');lock.release();if(pending)await Promise.allSettled([pending])}
}

export async function verifyOneConnectionDrafts(context:PostgresRuntimeContext,physicalId:number,legacyId:number,stateRoot:string):Promise<void>{
  const governance=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL),content=postgresTestDatabaseUrl(process.env.HGW_TEST_NODE_CONTENT_DATABASE_URL)
  const dataDirectory=process.env.HGW_TEST_NODE_CONTENT_PGDATA
  if(!governance||!content||!dataDirectory)throw new Error('Independent disposable draft databases required.')
  const control=createPostgresPool(governance,{max:1,connectionTimeoutMillis:2500}),local=createPostgresPool(content,{max:1,connectionTimeoutMillis:2500})
  const observer=createPostgresPool(content,{max:2}),disk=new LocalNodeDrafts(stateRoot)
  const org=context.organizationId,node=context.nodeId as RuntimeNodeId,main=context.pool
  try {
    const rows=(await main.query<{project_id:string;public_id:number;runtime_id:RuntimeId;binding:NodeContentBinding|null}>(`SELECT p.id project_id,p.public_id::float8 public_id,i.runtime_id,
      harness.project_content_key(p.organization_id,p.id) binding FROM harness.projects p JOIN harness.instances i ON i.organization_id=p.organization_id AND i.project_id=p.id
      WHERE p.organization_id=$1 AND p.public_id=ANY($2::bigint[]) ORDER BY p.public_id`,[org,[physicalId,legacyId]])).rows
    const b=rows.find(r=>r.public_id===physicalId)?.binding
    if(!b)throw new Error('Missing physical test project.')
    const store=await NodeContentStore.open({pool:local,organizationId:org,nodeId:node,volumeId:b.volumeId,dataDirectory,proofTimeoutMs:5000})
    const drafts=projectNodeDrafts({...context,pool:control},disk,store)
    const user=(await main.query<{id:string;public_id:number}>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
      VALUES($1,$2,'Draft member','/synthetic/draft') RETURNING id,public_id::float8`,[org,randomUUID()])).rows[0]!
    await main.query("INSERT INTO harness.memberships(organization_id,user_id,role,status) VALUES($1,$2,'member','active')",[org,user.id])
    await main.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',[org,node,user.id])
    await main.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'synthetic-no-login',false)",[user.id])
    const digest=createHash('sha256').update(randomUUID()).digest()
    await main.query("INSERT INTO harness.auth_sessions(organization_id,user_id,token_hash,created_at,expires_at,absolute_expires_at,last_seen_at) VALUES($1,$2,$3,now(),now()+interval '1 hour',now()+interval '1 hour',now())",[org,user.id,digest])
    for(const row of rows){
      await main.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw')",[org,row.project_id,user.id])
      const sessionId=randomUUID(),coordinates={organizationId:org,runtimeId:row.runtime_id}
      const repo=new PostgresConversationStore(main,store).forRuntime(coordinates,row.binding?{generation:0,contentBinding:row.binding}:undefined)
      await repo.append(sessionId,randomUUID(),[{seq:0,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',participant:{userId:user.public_id}},content:[{type:'text',text:'Draft fixture'}]}}],
        {...coordinates,id:sessionId,creatorUserId:user.id,projectId:row.project_id,visibility:'project',sessionFormatVersion:1,createdAt:1,cwd:'/synthetic'})
      const key:NodeDraftKey={organizationId:org,nodeId:node,runtimeId:row.runtime_id,userId:user.public_id,target:'project:'+row.public_id,sessionId,draftId:randomUUID()}
      const otherTab={...key,draftId:randomUUID()},first={kind:'save',value:{revision:0,text:'my draft'}} as const
      const apply=(op:NodeDraftOperation,k=key)=>drafts.applyAuthenticated!(k,op,digest)
      expect(await apply(first)).toEqual({status:200,value:{revision:1,text:'my draft'}})
      expect(await apply(first)).toEqual({status:200,value:{revision:1,text:'my draft'}})
      expect(await apply({kind:'save',value:{revision:0,text:'conflict'}})).toEqual({status:409})
      expect(await apply({kind:'read'},otherTab)).toEqual({status:200,value:{revision:0,text:''}})
      await expect(drafts.applyAuthenticated!(key,{kind:'read'},Buffer.alloc(32))).rejects.toBeInstanceOf(CollaborationDeniedError)
      for(const op of [{kind:'read'},{kind:'save',value:{revision:1,text:'must not commit'}}] as const){
        const reauthorize=()=>main.query('UPDATE harness.auth_sessions SET revoked_at=NULL WHERE organization_id=$1 AND token_hash=$2',[org,digest])
        try {
          await whileWaiting(row.binding?observer:main,row.binding?'node_content.composer_drafts':'harness.conversation_sessions',()=>apply(op),()=>
            (row.binding?control:main).query('UPDATE harness.auth_sessions SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND token_hash=$2',[org,digest]))
        }finally {await reauthorize()}
        expect(await apply({kind:'read'})).toEqual({status:200,value:{revision:1,text:'my draft'}})
      }
      expect(await apply({kind:'save',value:{revision:1,text:'new on the original tab'}})).toMatchObject({status:200})
      const pinned={kind:'read',revision:1} as const
      expect(await apply(pinned)).toEqual({status:200,value:{revision:1,text:'my draft',currentRevision:2}})
      expect(await apply(pinned,otherTab)).toEqual({status:410})
      await expect(drafts.applyAuthenticated!(key,pinned,Buffer.alloc(32))).rejects.toBeInstanceOf(CollaborationDeniedError)
      await expect(drafts.applyAuthenticated!({...key,userId:key.userId+1000},pinned,digest)).rejects.toThrow()
      await expect(drafts.applyAuthenticated!({...key,runtimeId:randomUUID() as RuntimeId},pinned,digest)).rejects.toThrow()
      await main.query('UPDATE harness.auth_sessions SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND token_hash=$2',[org,digest])
      try {await expect(apply(pinned)).rejects.toBeInstanceOf(CollaborationDeniedError)}
      finally {await main.query('UPDATE harness.auth_sessions SET revoked_at=NULL WHERE organization_id=$1 AND token_hash=$2',[org,digest])}
    }
  }finally{await disk.close();await Promise.all([control.end(),local.end(),observer.end()])}
}
