/** Hold a real node table while a separate governance transaction commits revocation. */
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import { expect } from 'vitest'
import { CollaborationDeniedError } from '../src/collaboration.ts'
import { NodeContentCollaboration } from '../src/node-content-collaboration.ts'
import type { NodeContentBinding, NodeContentStore } from '../src/node-content-store.ts'

/** Check every collaboration read, plus a visibility change on the node's independent connection. */
export async function verifySlowConversationRevocation(control:Pool,content:Pool,store:NodeContentStore,b:NodeContentBinding,
  member:{id:string;public_id:string},session:string):Promise<void> {
  const acl=new NodeContentCollaboration(control,store,b),uid=Number(member.public_id)
  const project=Number((await control.query('SELECT public_id FROM harness.projects WHERE id=$1',[b.projectId])).rows[0].public_id)
  const ops=[()=>acl.access(uid,b.runtimeId,session,'write'),()=>acl.readableSessionIds(uid,b.runtimeId,project,[session]),
    ()=>acl.listActivity(uid,project,{limit:10}),()=>acl.listProjectRows(uid,{limit:10}),()=>acl.listConversations(uid,b.runtimeId,project)]
  const facts=[
    ["UPDATE harness.project_members SET access_mode='ro' WHERE organization_id=$1 AND project_id=$2 AND user_id=$3", "UPDATE harness.project_members SET access_mode='rw' WHERE organization_id=$1 AND project_id=$2 AND user_id=$3", [b.organizationId,b.projectId,member.id]],
    ["UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3", "UPDATE harness.computer_use_permissions SET enabled=true WHERE organization_id=$1 AND node_id=$2 AND user_id=$3",[b.organizationId,b.nodeId,member.id]],
    ["UPDATE harness.users SET status='disabled' WHERE id=$1", "UPDATE harness.users SET status='active' WHERE id=$1",[member.id]],
    ['DELETE FROM harness.project_members WHERE organization_id=$1 AND project_id=$2 AND user_id=$3', "INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw')",[b.organizationId,b.projectId,member.id]],
    ["UPDATE harness.organizations SET status='disabled' WHERE id=$1", "UPDATE harness.organizations SET status='active' WHERE id=$1",[b.organizationId]],
  ] as const
  for(const [index,begin] of ops.entries()) {
    const [revoke,restore,args]=facts[index]!, lock=await content.connect()
    let read:Promise<unknown>|undefined, revoked=false
    try {
      await lock.query('BEGIN'); await lock.query('LOCK TABLE node_content.conversation_sessions IN ACCESS EXCLUSIVE MODE')
      read=begin()
      void read.catch(()=>undefined)
      const waiting=await content.query(`SELECT current_database() db`)
      const deadline=Date.now()+6000
      while(!(await content.query(`SELECT FROM pg_locks l JOIN pg_stat_activity a ON l.pid=a.pid WHERE a.datname=$1
        AND l.relation='node_content.conversation_sessions'::regclass AND NOT l.granted LIMIT 1`,[waiting.rows[0].db])).rowCount) {
        if(Date.now()>deadline)throw new Error('The authorized reader did not reach its content query.')
        await delay(10)
      }
      await control.query(revoke,[...args]); revoked=true; await lock.query('COMMIT')
      await expect(read).rejects.toBeInstanceOf(CollaborationDeniedError)
    } finally {
      await lock.query('ROLLBACK'); lock.release()
      if(read)await Promise.allSettled([read])
      if(revoked) await control.query(restore,[...args])
    }
  }
  let changed=false
  const watched={read:store.read.bind(store),write:store.write.bind(store),confirmCollaborationRead:async <T>(key:NodeContentBinding,revision:string,work:()=>Promise<T>,generation?:number)=>{
    await content.query("UPDATE node_content.conversation_sessions SET visibility='private' WHERE organization_id=$1 AND runtime_id=$2 AND id=$3",[b.organizationId,b.runtimeId,session])
    changed=true
    return store.confirmCollaborationRead(key,revision,work,generation)
  }}
  try {
    await expect(new NodeContentCollaboration(control,watched,b).listProjectRows(uid,{limit:10})).rejects.toMatchObject({status:503})
    expect(changed).toBe(true)
  } finally {await content.query("UPDATE node_content.conversation_sessions SET visibility='project' WHERE organization_id=$1 AND runtime_id=$2 AND id=$3",[b.organizationId,b.runtimeId,session])}
}
