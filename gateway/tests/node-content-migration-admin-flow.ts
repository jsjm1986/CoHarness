/** Run fresh-project placement and operator-driven migration with the services mounted by a Gateway. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { NodeArchiveRouter } from '../src/node-archive-router.ts'
import { NodeContentDocuments } from '../src/node-content-documents.ts'
import { NodeDocumentAuthority } from '../src/node-content-documents-authority.ts'
import { NodeContentMigrationAdmin } from '../src/node-content-migration-admin.ts'
import { NodeContentPublication, requiredNodeContentDomains } from '../src/node-content-publication.ts'
import { NodeProjectMetadata } from '../src/node-content-projects.ts'
import { NodeProjectFiles } from '../src/node-content-files.ts'
import { nodeCorePublicationChecks } from '../src/node-content-core-publication.ts'
import type { NodeContentStore } from '../src/node-content-store.ts'
import type { ProjectNameMacAuthority } from '../src/node-content-project-names.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'
import { PostgresDocumentLocations } from '../src/postgres/document-locations.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresConversationStore } from '../src/postgres/conversation-repository.ts'
import type { PostgresProgressService } from '../src/postgres/progress-service.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { InstanceManager } from '../src/instances.ts'
import { createDocumentCatalogHandlers } from '../src/document-catalog.ts'
import { LocalDocumentBroker } from '../src/documents-local.ts'
import { LocalNodeDrafts } from '../src/node-drafts.ts'
import { projectNodeDrafts } from '../src/project-node-drafts.ts'
import { PostgresWorkspaceCatalog } from '../src/workspace-catalog.ts'
import { PostgresPluginState } from '../src/plugin-state.ts'
import { GatewayExecutionIdentity } from '../src/execution-identity.ts'
import type { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'
import { verifyOneConnectionDrafts } from './node-content-draft-concurrency.ts'
import { verifySourceRetirement } from './node-content-retirement-flow.ts'
import { testConfig } from './test-config.ts'

/** Exercise all installed storage owners, filesystem document proof and the supervisor’s process-owned publication lease. */
export async function verifyAdminProjectMigration(context:PostgresRuntimeContext, store:NodeContentStore, authority:ProjectNameMacAuthority,
  progress:PostgresProgressService, owner:GatewayModelBudget, actor:number, member:number, directory:string):Promise<void> {
  const cfg=testConfig(join(directory,'migration-admin'))
  await Promise.all([cfg.projectRuntimesRoot,cfg.stateRoot].map(path=>mkdir(path,{recursive:true,mode:0o700})))
  const node=context.nodeId as RuntimeNodeId, metadata=new NodeProjectMetadata(context,store), files=new NodeProjectFiles(cfg,context,store)
  const repository=new PostgresInstanceRepository(context,cfg.instancePortBase,metadata,files)
  const manager=new InstanceManager(repository,cfg,undefined,undefined,undefined,owner)
  const legacy=new PostgresProjectService(context,cfg,node,{metadata})
  const collaboration=new PostgresCollaborationService(context,node,store,metadata), conversations=new PostgresConversationStore(context.pool,store)
  const execution=new GatewayExecutionIdentity(context.pool,node,store), plugins=new PostgresPluginState(context,store,files)
  const workspace=new PostgresWorkspaceCatalog(context,node,undefined,store),legacyDrafts=new LocalNodeDrafts(cfg.stateRoot),drafts=projectNodeDrafts(context,legacyDrafts,store)
  const archive=new NodeArchiveRouter(context,cfg.archiveRetentionDays,store)
  const locations=new PostgresDocumentLocations(context,cfg.runtimeCatalog,node)
  const documents:NodeContentDocuments=new NodeContentDocuments(new NodeDocumentAuthority(context,locations,store),input=>broker.inspectPublicationRoot(input))
  const catalog=new PostgresDocumentCatalogService(context,cfg.archiveRetentionDays,node,documents)
  const broker:LocalDocumentBroker=new LocalDocumentBroker({cfg,nodeId:node,organizationId:context.organizationId,projects:legacy,
    users:new PostgresUserService(context,cfg),collaboration,catalog:createDocumentCatalogHandlers(catalog,new PostgresAuditService(context))})
  const publication=new NodeContentPublication({...nodeCorePublicationChecks({conversations,collaboration,execution,progress,plugins,files}),
    workspace:input=>workspace.verifyNodeContent(input),drafts:input=>drafts.verifyNodeContent(input),documents:input=>documents.verifyNodeContent(input),
    archive:input=>archive.verifyNodeContent(input,'archive'),search:input=>archive.verifyNodeContent(input,'search')})
  const projects=new PostgresProjectService(context,cfg,node,{metadata,publication,requirePhysical:true,ready:async()=>store})
  const admin=new NodeContentMigrationAdmin(context,async()=>store,manager,publication)
  try {
    const create=(project:PostgresProjectService,name:string)=>project.createManaged({name,ownerUserId:actor,actorUserId:actor},authority)
    const fresh=await create(projects,'fresh-private-'+randomUUID())
    await expect(admin.preflight(actor,fresh.id)).resolves.toMatchObject({storage:'node',sourceRetirement:'new',canPrepare:false,canPublish:false})
    const source=await create(legacy,'existing-private-'+randomUUID())
    await verifyOneConnectionDrafts(context,fresh.id,source.id,cfg.stateRoot)
    const directoryPage=await admin.choices(actor)
    expect(directoryPage.items.find(p=>p.id===fresh.id)?.name).toBeNull()
    const original=await admin.preflight(actor,source.id), target={nodeId:node,runtimeId:original.runtimeId}
    expect(original).toMatchObject({storage:'shared',canPrepare:true,canPublish:false,blockers:['prepare-required']})
    await expect(admin.preflight(member,source.id)).rejects.toMatchObject({code:'forbidden'})
    await expect(admin.prepare(actor,source.id,{...target,nodeId:randomUUID()})).rejects.toMatchObject({code:'forbidden'})
    const staged=await admin.prepare(actor,source.id,target)
    expect(staged).toMatchObject({storage:'shared',canPublish:true})
    if(!staged.snapshot)throw new Error('Missing prepared snapshot')
    const intent={...target,generation:staged.generation,snapshot:staged.snapshot}
    await context.pool.query("UPDATE harness.instances SET desired_state='running',observed_state='ready' WHERE runtime_id=$1",[target.runtimeId])
    await expect(admin.publish(actor,source.id,intent)).rejects.toMatchObject({status:409})
    expect((await admin.preflight(actor,source.id)).blockers).toContain('runtime-busy')
    await context.pool.query("UPDATE harness.instances SET desired_state='stopped',observed_state='stopped' WHERE runtime_id=$1",[target.runtimeId])
    const active=await admin.publish(actor,source.id,intent)
    expect(active).toMatchObject({storage:'node',sourceRetirement:'retiring',canPrepare:false,canPublish:false})
    expect((await admin.publish(actor,source.id,intent)).sourceRetirement).toBe('retiring')
    const placement=(await context.pool.query('SELECT b.*,p.name::text alias,m.local_path mount FROM harness.project_content_placement b JOIN harness.projects p ON p.id=b.project_id JOIN harness.project_mounts m ON m.project_id=p.id WHERE b.runtime_id=$1',[target.runtimeId])).rows[0]
    expect(placement.alias).toBe('hgw-project-'+placement.project_id)
    expect(placement.mount).toBe('urn:hgw:project:'+placement.project_id)
    expect((await projects.getById(source.id))?.name).toBe(source.name)
    const domains=await store.readVolume(async db=>(await db.query<{domain:string}>('SELECT domain FROM node_content.migration_domain_receipts WHERE snapshot_id=$1 ORDER BY domain',[intent.snapshot.id])).rows.map(r=>r.domain))
    expect(domains).toEqual([...requiredNodeContentDomains].sort())
    await verifySourceRetirement(context,store,actor,source.id)
  } finally { await Promise.all([broker.dispose(),legacyDrafts.close()]) }
}
