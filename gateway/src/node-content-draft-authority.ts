/** Browser-session authorization for a draft on one exact computer and Runtime. */
import type { Queryable } from './postgres/database.ts'
import type { NodeContentBinding } from './node-content-store.ts'
import type { NodeDraftKey } from './node-drafts.ts'
import { CollaborationDeniedError } from './collaboration.ts'

export interface DraftAuthority { actorId:string;administrator:boolean;mode:'rw'|'ro';projectId:string|null;binding:NodeContentBinding|null;witness:string }

/** Use the caller's sole control connection. A final write locks the actual rows that can revoke the selected scope.
 * @param db - governance query or the transaction retaining final writer authorization.
 * @param key - browser-selected actor, node, allocation and project. @param digest - hash of the verified incoming session cookie.
 * @param save - requires write permission. @param lock - retain revocable rows until a short commit finishes.
 * @returns current allocation, owner, account, and rights.
 */
export async function draftAuthority(db:Queryable,key:NodeDraftKey,digest:Buffer,save:boolean,lock=false):Promise<DraftAuthority>{
  const project=key.target!=='personal',target=project&&/^project:[1-9][0-9]*$/u.test(key.target)?Number(key.target.slice(8)):0
  if(digest.length!==32||project&&(!Number.isSafeInteger(target)||target<=0))throw new CollaborationDeniedError('forbidden')
  const args=[key.organizationId,key.nodeId,key.runtimeId,key.userId,digest,...(project?[target]:[])]
  if(lock&&project){
    await db.query(`SELECT m.user_id FROM harness.project_members m JOIN harness.projects p ON m.organization_id=p.organization_id AND m.project_id=p.id
      JOIN harness.users u ON u.organization_id=p.organization_id AND u.id=m.user_id WHERE p.organization_id=$1 AND p.public_id=$2 AND u.public_id=$3 FOR SHARE OF m`,[key.organizationId,target,key.userId])
    await db.query(`SELECT s.user_id FROM harness.steward_access_policies s JOIN harness.users u ON u.organization_id=s.organization_id AND u.id=s.user_id
      WHERE s.organization_id=$1 AND s.node_id=$2 AND u.public_id=$3 FOR SHARE OF s`,[key.organizationId,key.nodeId,key.userId])
  }
  const rows=await db.query<DraftAuthority>(`SELECT u.id "actorId",m.role='admin' administrator,${project?"CASE WHEN m.role='admin' THEN 'rw' ELSE pm.access_mode END":"'rw'"} mode,
      ${project?'p.id':'NULL::uuid'} "projectId",${project?'harness.project_content_key(p.organization_id,p.id)':'NULL::jsonb'} binding,
      jsonb_build_array(u.id,s.id,m.xmin::text,g.xmin::text,e.id,i.generation::text${project?',p.id,pm.xmin::text':''})::text witness
    FROM harness.auth_sessions s JOIN harness.organizations o ON o.id=s.organization_id AND o.status='active'
    JOIN harness.users u ON u.id=s.user_id AND u.organization_id=o.id AND u.public_id=$4 AND u.status='active' AND u.deleted_at IS NULL
    JOIN harness.password_credentials c ON c.user_id=u.id AND NOT c.must_change_password
    JOIN harness.memberships m ON m.organization_id=o.id AND m.user_id=u.id AND m.status='active'
    JOIN harness.computer_use_permissions g ON g.organization_id=o.id AND g.user_id=u.id AND g.node_id=$2 AND g.enabled
    JOIN harness.compute_nodes n ON n.organization_id=o.id AND n.id=g.node_id AND n.status='active'
    JOIN harness.runtime_environments e ON e.organization_id=o.id AND e.node_id=n.id AND e.id=$3 AND e.retired_at IS NULL
    JOIN harness.instances i ON (i.organization_id,i.assigned_node_id,i.runtime_id)=(o.id,n.id,e.id)
    ${project?`JOIN harness.projects p ON p.organization_id=o.id AND p.id=i.project_id AND e.owner_kind='project' AND e.owner_id=p.id AND p.public_id=$6 AND p.status='active'
      JOIN harness.project_mounts mt ON mt.organization_id=o.id AND mt.project_id=p.id AND mt.node_id=n.id AND mt.status='active'
      LEFT JOIN harness.project_members pm ON pm.organization_id=o.id AND pm.project_id=p.id AND pm.user_id=u.id`:''}
    WHERE s.organization_id=$1 AND s.token_hash=$5 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp()
      AND harness.entry_node_visible(o.id,n.id,n.id)
      AND ${project?`(p.kind='standard' AND (m.role='admin' OR pm.user_id IS NOT NULL) OR p.kind='steward' AND m.role='admin' AND EXISTS(
        SELECT FROM harness.steward_access_policies sp WHERE sp.organization_id=o.id AND sp.user_id=u.id AND sp.node_id=n.id AND sp.enabled))`:"i.user_id=u.id AND e.owner_kind='user' AND e.owner_id=u.id"}
    ${lock?'FOR SHARE OF s,o,u,c,m,g,n,e,i'+(project?',p,mt':''):''}`,args)
  const authority=rows.rows[0]
  if(!authority||save&&authority.mode!=='rw')throw new CollaborationDeniedError('forbidden')
  return authority
}

/** Read the inherited Session root on its recorded backend, retaining it only for a legacy write on the control transaction. */
export async function checkDraftSession(db:Queryable,schema:'harness'|'node_content',key:NodeDraftKey,actor:DraftAuthority,lock=false):Promise<void>{
  if(!actor.projectId||!key.sessionId)return
  const row=(await db.query<{visible:boolean}>(`SELECT r.visibility='project' OR r.creator_user_id=$5 OR $6 AS visible FROM ${schema}.conversation_sessions c
    JOIN ${schema}.conversation_sessions r ON (r.organization_id,r.runtime_id,r.id)=(c.organization_id,c.runtime_id,c.root_session_id)
    WHERE c.organization_id=$1 AND c.runtime_id=$2 AND c.project_id=$3 AND c.id=$4 AND c.status<>'deleted' AND r.project_id=$3 AND r.status<>'deleted'
    ${lock?'FOR SHARE OF c,r':''}`,[key.organizationId,key.runtimeId,actor.projectId,key.sessionId,actor.actorId,actor.administrator])).rows[0]
  if(!row||!row.visible)throw new CollaborationDeniedError('forbidden')
}

/** The same actor, placement, access and Runtime generation must survive a delayed draft operation. */
export function confirmDraftAuthority(before:DraftAuthority,after:DraftAuthority):void{
  const a=before.binding,b=after.binding
  if(before.actorId!==after.actorId||before.projectId!==after.projectId||before.mode!==after.mode||before.administrator!==after.administrator||before.witness!==after.witness||
    !!a!==!!b||a&&b&&(a.organizationId!==b.organizationId||a.projectId!==b.projectId||a.runtimeId!==b.runtimeId||a.nodeId!==b.nodeId||a.volumeId!==b.volumeId||a.writerEpoch!==b.writerEpoch)) {
    throw new CollaborationDeniedError('forbidden')
  }
}
