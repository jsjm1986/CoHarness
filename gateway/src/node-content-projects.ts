/** Workflow metadata is read on its owning computer after the caller's control-plane permissions have been checked. */
import type { PoolClient } from 'pg'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { publicNumber } from './postgres/runtime-context.ts'
import type { Queryable } from './postgres/database.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { CollaborationDeniedError } from './collaboration.ts'
import { NodeContentUnavailable,type NodeContentBinding,type NodeContentStore } from './node-content-store.ts'
import type { NodeContentPublication } from './node-content-publication.ts'

export interface NodeProjectDisplay {
  projectId:number
  runtimeId:RuntimeId
  nodeId:string
  name:string
  rootPath:string
}
export interface ProjectContentRef { content:(NodeContentBinding & {nameVersion?:string})|null }
export interface NodeProjectCreation {
  metadata:NodeProjectMetadata
  /** Set only when administrators select physical creation on this computer. */
  publication?:NodeContentPublication|(()=>NodeContentPublication)
  requirePhysical?:boolean
  ready?:()=>Promise<NodeContentStore>
}

/** Node-qualified metadata reads take one volume transaction for a page of previously authorized rows. */
export class NodeProjectMetadata {
  constructor(private readonly context:PostgresRuntimeContext,private readonly store:Pick<NodeContentStore,'read'|'write'>) {}

  /** @param rows - already authorized control bindings for this computer. @returns local names and roots keyed by internal project ID. */
  async lookup(rows:readonly ProjectContentRef[]):Promise<Map<string,{name:string;rootPath:string}>> {
    const bindings=[...new Map(rows.flatMap(row=>row.content?[[row.content.projectId,row.content] as const]:[])).values()]
    if (!bindings.length) return new Map()
    if (bindings.some(b=>b.organizationId!==this.context.organizationId || b.nodeId!==this.context.nodeId || !b.nameVersion)) throw new NodeContentUnavailable('Project metadata requires its owning computer.')
    const first=bindings[0]!
    const data=await this.store.read(first,async local=>(await local.query<{project_id:string;name:string;root_path:string}>(`SELECT s.project_id,node_content.project_name_at(s.organization_id,s.project_id,s.runtime_id,k."nameVersion") name,s.root_path
      FROM jsonb_to_recordset($1::jsonb) k("organizationId" uuid,"projectId" uuid,"nodeId" uuid,"runtimeId" uuid,"volumeId" uuid,"writerEpoch" bigint,"nameVersion" uuid)
      JOIN node_content.spaces s ON (s.organization_id,s.project_id,s.node_id,s.runtime_id,s.volume_id,s.writer_epoch)=
        (k."organizationId",k."projectId",k."nodeId",k."runtimeId",k."volumeId",k."writerEpoch") AND s.publication_state<>'retired' AND NOT EXISTS(SELECT FROM node_content.recovery_candidates rc
           WHERE rc.organization_id=s.organization_id AND rc.runtime_id=s.runtime_id AND rc.phase<>'active')`,[JSON.stringify(bindings)])).rows)
    if (data.length!==bindings.length) throw new NodeContentUnavailable('A project does not match its active volume.')
    return new Map(data.map(row=>[row.project_id,{name:row.name,rootPath:row.root_path}]))
  }

  /** Read the selected local projects using current browser account or administrator authority.
   * @param actorUserId - verified organization account.
   * @param audience - an Admin request requires the current administrator role.
   * @param ids - bounded public project IDs.
   * @returns only authorized, physically placed projects on this node.
   */
  async authorizedMetadata(actorUserId:number,audience:'account'|'admin',ids:readonly number[]):Promise<NodeProjectDisplay[]> {
    if (ids.length>32 || ids.some(id=>!Number.isSafeInteger(id)||id<1)) throw new Error('Invalid project metadata selection.')
    const wanted=[...new Set(ids)]
    if (!wanted.length) return []
    const authorized=async()=>(await this.context.pool.query<{public_id:string;content:NodeContentBinding}>(`SELECT p.public_id::text,harness.project_content_key(o.id,p.id) content
      FROM harness.organizations o JOIN harness.users u ON u.organization_id=o.id AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
      JOIN harness.memberships m ON m.organization_id=o.id AND m.user_id=u.id AND m.status='active'
      JOIN harness.project_content_placement b ON b.organization_id=o.id AND b.node_id=$3
      JOIN harness.runtime_environments r ON r.organization_id=o.id AND r.id=b.runtime_id AND r.node_id=b.node_id AND r.retired_at IS NULL
      JOIN harness.projects p ON p.organization_id=o.id AND p.id=b.project_id AND p.status='active' AND p.kind='standard'
      JOIN harness.compute_nodes n ON n.organization_id=o.id AND n.id=b.node_id AND n.status='active'
      LEFT JOIN harness.project_members pm ON pm.organization_id=o.id AND pm.project_id=p.id AND pm.user_id=u.id
      WHERE o.id=$1 AND o.status='active' AND p.public_id=ANY($4::bigint[])
        AND CASE WHEN $5='admin' THEN m.role='admin'
          ELSE harness.computer_use_allowed(o.id,u.id,b.node_id) AND (m.role='admin' OR pm.user_id IS NOT NULL) END ORDER BY p.public_id`,
    [this.context.organizationId,actorUserId,this.context.nodeId,wanted,audience])).rows
    const rows=await authorized()
    if (rows.length!==wanted.length) throw new CollaborationDeniedError('forbidden')
    const names=await this.lookup(rows)
    if (JSON.stringify(await authorized())!==JSON.stringify(rows)) throw new CollaborationDeniedError('forbidden')
    return rows.map(row=>({projectId:publicNumber(row.public_id,'project'),runtimeId:row.content.runtimeId,nodeId:row.content.nodeId,
      ...names.get(row.content.projectId)!}))
  }

  /** Preserve the removal guard for members who still own private project conversations.
   * @param binding - exact project already locked by the control service.
   * @param userId - internal user identifier.
   * @returns whether removing membership would orphan a private root.
   */
  hasPrivateRoots(binding:NodeContentBinding,userId:string):Promise<boolean> {
    return this.store.read(binding,async local=>(await local.query(`SELECT FROM node_content.conversation_sessions
      WHERE organization_id=$1 AND runtime_id=$2 AND project_id=$3 AND creator_user_id=$4 AND id=root_session_id
        AND visibility='private' AND status<>'deleted' LIMIT 1`,[binding.organizationId,binding.runtimeId,binding.projectId,userId])).rowCount===1)
  }

  /** @param control - controlling transaction with management authority. @param binding - exact project. @param name - normalized local display name. */
  async rename(control:PoolClient,binding:NodeContentBinding,name:string):Promise<void> {
    if (binding.nodeId!==this.context.nodeId || binding.organizationId!==this.context.organizationId) throw new NodeContentUnavailable()
    const confirmed=await control.query<{version:string}>(`SELECT p.logical_name_id version FROM harness.project_content_placement b
      JOIN harness.projects p ON (p.organization_id,p.id)=(b.organization_id,b.project_id) WHERE b.organization_id=$1 AND b.project_id=$2
        AND b.runtime_id=$3 AND b.node_id=$4 AND b.volume_id=$5 AND b.writer_epoch=$6 FOR SHARE OF b,p`,[binding.organizationId,binding.projectId,binding.runtimeId,binding.nodeId,binding.volumeId,binding.writerEpoch])
    if (confirmed.rowCount!==1) throw new NodeContentUnavailable()
    await this.store.write(binding,async local=>{
      await local.query(`INSERT INTO node_content.project_name_versions(organization_id,project_id,runtime_id,version_id,name) VALUES($1,$2,$3,$4,$5)`,
        [binding.organizationId,binding.projectId,binding.runtimeId,confirmed.rows[0]!.version,name])
    })
  }


}

/** Resolve already authorized local rows. A missing node adapter cannot substitute a control alias for a filesystem path.
 * @param service - owning Gateway's node reader.
 * @param rows - actual storage keys from the same control query as authorization.
 * @returns local workflow metadata keyed by internal project identity.
 */
export function localProjectDisplays(service:NodeProjectMetadata|undefined,rows:readonly ProjectContentRef[]):Promise<Map<string,{name:string;rootPath:string}>> {
  if (!rows.some(row=>row.content)) return Promise.resolve(new Map())
  if (!service) throw new NodeContentUnavailable('The selected project requires its node metadata adapter.')
  return service.lookup(rows)
}
