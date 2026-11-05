/** Exercise the owner, administrator and stale publisher against separate governance and project databases. */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { expect } from 'vitest'
import { NodeArchiveRouter } from '../src/node-archive-router.ts'
import { ConversationArchiveService } from '../src/postgres/conversation-archive-service.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { NodeContentBinding, NodeContentStore } from '../src/node-content-store.ts'

export async function verifyPublishedArchive(ctx:PostgresRuntimeContext, content:Pool, store:NodeContentStore,b:NodeContentBinding,
  user:{id:string;public_id:string},sessionId:string):Promise<void> {
  const {rows:[project]}=await ctx.pool.query<{public_id:string}>('SELECT public_id::text FROM harness.projects WHERE organization_id=$1 AND id=$2',[b.organizationId,b.projectId])
  const operator=(await ctx.pool.query<{id:string;public_id:string}>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
    VALUES($1,$2,'Archive operator','/operator') RETURNING id,public_id::text`,[ctx.organizationId,randomUUID()])).rows[0]!
  await ctx.pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')",[ctx.organizationId,operator.id])
  await ctx.pool.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture',false)",[operator.id])
  await content.query("UPDATE node_content.spaces SET publication_state='published' WHERE organization_id=$1 AND runtime_id=$2",[b.organizationId,b.runtimeId])
  const archive=new NodeArchiveRouter(ctx,30,store), actor=Number(operator.public_id)
  const target={kind:'project' as const,id:Number(project!.public_id),runtimeId:b.runtimeId}
  const subject={organizationId:b.organizationId,projectInternalId:b.projectId,contentBinding:b,target,generation:1}
  const runtime=archive.forCredential(subject), title='local-only '+randomUUID(), text='original\u0000entry '+randomUUID()
  const snapshot={runtime:target,revision:1,archivedSessionIds:[sessionId],sessions:[{sessionId,header:{},title,messageCount:1}],
    search:[{sessionId,seq:10,role:'user' as const,content:text,occurredAt:1234}]}
  expect(await runtime.syncRuntimeSnapshot(snapshot,target)).toEqual([])
  const matching=await archive.adminList({query:text,limit:10},actor)
  expect(matching).toHaveLength(1)
  const id=matching[0]!.archiveId
  expect(matching[0]).toMatchObject({title,rootSessionId:sessionId,creator:{id:Number(user.public_id)},runtime:{runtimeId:b.runtimeId}})
  await expect(archive.adminList({query:text},Number(user.public_id))).rejects.toThrow()
  expect((await archive.exportDetail(id,actor))?.events).toHaveLength(1)
  expect((await archive.status(id,actor))?.archiveId).toBe(id)
  expect(await runtime.hasPendingCommands(target)).toBe(false)
  await archive.setState(id,'trash',actor,'archive-'+randomUUID())
  const [trash]=await runtime.syncRuntimeSnapshot({...snapshot,revision:2},target)
  expect(trash?.action).toBe('trash')
  expect(await runtime.acknowledgeCommand(trash!.id,2,undefined,target)).toBe(true)
  await archive.setState(id,'archived',actor)
  const [restore]=await runtime.syncRuntimeSnapshot({...snapshot,revision:3},target)
  expect(restore?.action).toBe('restore')
  expect(await runtime.acknowledgeCommand(restore!.id,3,undefined,target)).toBe(true)
  await expect(archive.forCredential({...subject,generation:0}).syncRuntimeSnapshot(snapshot,target)).rejects.toThrow()
  await expect(new ConversationArchiveService(ctx).syncSnapshot({runtime:target,rootSessionId:sessionId,syncRevision:1,title})).rejects.toMatchObject({code:'23514'})
  expect((await ctx.pool.query('SELECT FROM harness.conversation_archive_records WHERE organization_id=$1 AND runtime_id=$2',[b.organizationId,b.runtimeId])).rowCount).toBe(0)
  expect((await ctx.pool.query('SELECT FROM harness.conversation_archive_search WHERE organization_id=$1 AND runtime_id=$2',[b.organizationId,b.runtimeId])).rowCount).toBe(0)
}
