/** Project membership is governed centrally; private roots, participants and interaction results stay on the owning volume. */
import type { Pool, PoolClient } from 'pg'
import { CollaborationDeniedError, type AccountConversationView, type CollaborationAction, type ConversationAccess, type ConversationCollaborationView } from './collaboration.ts'
import type { NodeContentBinding, NodeContentStore } from './node-content-store.ts'
import { NodeContentUnavailable } from './node-content-store.ts'
import { transaction, type Queryable } from './postgres/database.ts'
import { literalLikePattern } from './postgres/literal-like-pattern.ts'
import { publicNumber } from './postgres/runtime-context.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { readProjectActivity } from './node-content-activity.ts'
import type { ProjectActivityPage } from './services.ts'

export type CollaborationContentStore = Pick<NodeContentStore,'read'|'write'> & Partial<Pick<NodeContentStore,'confirmCollaborationRead'>>
type LocalRead = <T>(work:(tx:PoolClient)=>Promise<T>)=>Promise<T>
type Visibility = 'private' | 'project'
interface Actor { id: string; administrator: boolean; mode: 'rw' | 'ro'; project: number; nodeName: string; nameVersion:string; authority:string }
interface Root { session_id: string; root_session_id: string; creator_user_id: string; visibility: Visibility }
interface Person { id: string; public_id: string; display_name: string }

const visible = "(r.visibility='project' OR r.creator_user_id=$3 OR $4::boolean)"
const liveRoot = `r.status<>'deleted' AND NOT EXISTS(SELECT 1 FROM node_content.conversation_archive_records a
  WHERE a.organization_id=r.organization_id AND a.runtime_id=r.runtime_id AND a.root_session_id=r.id
    AND (a.state IN ('trash','purged') OR a.restored_at IS NULL))`

/** A local collaboration adapter can serve only its control-issued allocation. */
export class NodeContentCollaboration {
  constructor(private readonly control: Pool, private readonly store: CollaborationContentStore, private readonly binding: NodeContentBinding, private readonly generation?: number) {}

  private checkRuntime(id: RuntimeId): void {
    if (id !== this.binding.runtimeId) throw new CollaborationDeniedError('forbidden')
  }

  private async actor(source: Queryable, publicId: number, lock: boolean): Promise<Actor> {
    const b = this.binding
    const params = [b.organizationId, b.projectId, publicId, b.nodeId,b.runtimeId,b.volumeId,b.writerEpoch,this.generation??null]
    if (lock) {
      // Changes to project memberships and computer grants share these owner locks.
      const fenced = await source.query(`SELECT 1 FROM harness.users u JOIN harness.projects p ON p.organization_id=u.organization_id
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        WHERE u.organization_id=$1 AND u.public_id=$3 AND p.id=$2 FOR SHARE OF u,p,m`, params.slice(0,3))
      if (fenced.rowCount !== 1) throw new CollaborationDeniedError('not-member')
      await source.query(`SELECT 1 FROM harness.project_members pm JOIN harness.users u ON u.organization_id=pm.organization_id AND u.id=pm.user_id
        WHERE pm.organization_id=$1 AND pm.project_id=$2 AND u.public_id=$3 FOR SHARE OF pm`,params.slice(0,3))
    }
    const result = await source.query<{ id: string; administrator: boolean; mode: 'rw'|'ro'; public_id: string; node_name: string; name_version:string; authority:string }>(
      `SELECT u.id,(m.role='admin') administrator,CASE WHEN m.role='admin' THEN 'rw' ELSE member.access_mode END mode,
        p.public_id::text,n.name::text node_name,p.logical_name_id name_version,
        jsonb_build_array(m.xmin::text,member.xmin::text,grant_row.xmin::text,i.generation::text)::text authority FROM harness.project_content_placement placement
        JOIN harness.runtime_environments e ON e.id=placement.runtime_id AND e.organization_id=placement.organization_id AND e.retired_at IS NULL
        JOIN harness.instances i ON (i.organization_id,i.project_id,i.runtime_id,i.assigned_node_id)=(placement.organization_id,placement.project_id,placement.runtime_id,placement.node_id)
        JOIN harness.projects p ON p.id=placement.project_id AND p.organization_id=placement.organization_id AND p.kind='standard' AND p.status='active'
        JOIN harness.compute_nodes n ON n.id=placement.node_id AND n.organization_id=p.organization_id AND n.status='active'
        JOIN harness.organizations o ON o.id=p.organization_id AND o.status='active'
        JOIN harness.users u ON u.organization_id=p.organization_id AND u.public_id=$3 AND u.status='active' AND u.deleted_at IS NULL
        JOIN harness.memberships m ON m.organization_id=p.organization_id AND m.user_id=u.id AND m.status='active'
        JOIN harness.computer_use_permissions grant_row ON (grant_row.organization_id,grant_row.node_id,grant_row.user_id)=(placement.organization_id,placement.node_id,u.id) AND grant_row.enabled
        LEFT JOIN harness.project_members member ON member.organization_id=p.organization_id AND member.project_id=p.id AND member.user_id=u.id
        WHERE placement.organization_id=$1 AND p.id=$2 AND placement.node_id=$4 AND placement.runtime_id=$5
          AND placement.volume_id=$6 AND placement.writer_epoch=$7 AND (m.role='admin' OR member.user_id IS NOT NULL)
          AND (e.owner_kind,e.owner_id,e.node_id)=('project',p.id,n.id)
          AND ($8::bigint IS NULL OR i.generation=$8 AND i.desired_state='running' AND i.observed_state IN ('starting','ready')
            AND i.runtime_token_hash IS NOT NULL AND harness.runtime_node_execution_allowed(i.organization_id,i.assigned_node_id,i.node_connection_id,i.node_connection_epoch))
          ${lock?'FOR SHARE OF u,m,p,n,o,i,e,placement,grant_row':''}`, params)
    const row = result.rows[0]
    if (row === undefined) throw new CollaborationDeniedError('not-member')
    return { id: row.id, administrator: row.administrator, mode: row.mode, project: publicNumber(row.public_id,'project'), nodeName: row.node_name,nameVersion:row.name_version,authority:row.authority }
  }

  private async authorizedRead<T>(userId:number,work:(actor:Actor,read:LocalRead)=>Promise<T>):Promise<T> {
    const store=this.store,b=this.binding
    if (!store.confirmCollaborationRead) throw new NodeContentUnavailable('The conversation read verifier is unavailable.')
    const initial=await this.actor(this.control,userId,false)
    let revision:string|undefined
    const read:LocalRead=operation=>store.read(b,async local=>{
      const current=(await local.query<{revision:string}>(`SELECT revision::text FROM node_content.conversation_acl_versions
        WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3`,[b.organizationId,b.projectId,b.runtimeId])).rows[0]?.revision
      if (!current || revision&&revision!==current) throw new NodeContentUnavailable('The selected project conversation permissions changed.')
      revision=current
      return operation(local)
    },undefined,this.generation)
    const value=await work(initial,read)
    if (!revision) throw new NodeContentUnavailable('The selected project lacks a checked conversation snapshot.')
    const checked=revision
    return transaction(this.control,control=>store.confirmCollaborationRead!(b,checked,async()=>{
      const current=await this.actor(control,userId,false)
      if (current.id!==initial.id || current.project!==initial.project || current.mode!==initial.mode ||
          current.administrator!==initial.administrator || current.authority!==initial.authority || current.nameVersion!==initial.nameVersion) {
        throw new CollaborationDeniedError('forbidden')
      }
      return value
    },this.generation))
  }

  /** Deliver a project feature from the same content snapshot and final visibility check as the conversation list.
   * @param userId - authenticated account. @param projectId - public project. @param read - scoped local read.
   * @returns the feature's result while the requesting membership is still valid.
   */
  withProjectRead<T>(userId:number,projectId:number,read:(local:PoolClient,canWrite:boolean)=>Promise<T>):Promise<T>{
    return this.authorizedRead(userId,(actor,snapshot)=>{
      if(actor.project!==projectId) throw new CollaborationDeniedError('not-member')
      return snapshot(local=>read(local,actor.mode==='rw'))
    })
  }

  private async root(tx: PoolClient, session: string): Promise<Root> {
    const b = this.binding
    const result = await tx.query<Root>(`SELECT c.id session_id,r.id root_session_id,r.creator_user_id,r.visibility
      FROM node_content.conversation_sessions c JOIN node_content.conversation_sessions r
        ON r.organization_id=c.organization_id AND r.runtime_id=c.runtime_id AND r.id=c.root_session_id
      WHERE c.organization_id=$1 AND c.runtime_id=$2 AND c.id=$3 AND c.project_id=$4 AND c.status<>'deleted' AND r.status<>'deleted'`,
    [b.organizationId,b.runtimeId,session,b.projectId])
    if (result.rows[0] === undefined) throw new CollaborationDeniedError('conversation-not-found')
    return result.rows[0]
  }

  private admit(actor: Actor, root: Root, action: CollaborationAction): void {
    const owner = actor.id === root.creator_user_id || actor.administrator
    if (!owner && root.visibility !== 'project' || action !== 'read' && actor.mode !== 'rw' || action === 'manage' && !owner) {
      throw new CollaborationDeniedError('forbidden')
    }
  }

  private async people(ids: string[]): Promise<Map<string,Person>> {
    if (ids.length === 0) return new Map()
    const result = await this.control.query<Person>('SELECT id,public_id::text,display_name FROM harness.users WHERE organization_id=$1 AND id=ANY($2::uuid[])',
      [this.binding.organizationId, [...new Set(ids)]])
    return new Map(result.rows.map(row => [row.id,row]))
  }

  /** Resolve effective authority on the inherited root.
   * @param userId - authenticated account. @param runtimeId - exact allocation. @param sessionId - target Session.
   * @param action - requested operation. @returns effective visible permissions.
   */
  async access(userId: number, runtimeId: RuntimeId, sessionId: string, action: CollaborationAction): Promise<ConversationAccess> {
    this.checkRuntime(runtimeId)
    return this.authorizedRead(userId,async (actor,read)=>{
    const root = await read(tx=>this.root(tx,sessionId))
    this.admit(actor,root,action)
    const creator = (await this.people([root.creator_user_id])).get(root.creator_user_id)
    if (creator === undefined) throw new NodeContentUnavailable('Session creator identity is unavailable.')
    return { sessionId,rootSessionId: root.root_session_id,projectId: actor.project,visibility: root.visibility,
      creatorUserId: publicNumber(creator.public_id,'user'), mode: actor.mode,canRead: true,canWrite: actor.mode==='rw',
      canManage: actor.mode === 'rw' && (actor.administrator || actor.id === root.creator_user_id) }
    })
  }

  /** Filter supplied Session ids before disclosure. @param userId - account. @param runtimeId - allocation.
   * @param projectId - public project id. @param ids - requested ids. @returns readable ids within this Runtime.
   */
  async readableSessionIds(userId: number, runtimeId: RuntimeId, projectId: number, ids: readonly string[]): Promise<string[]> {
    this.checkRuntime(runtimeId)
    return this.authorizedRead(userId,async (actor,read)=>{
    if (actor.project !== projectId) throw new CollaborationDeniedError('forbidden')
    return read(async tx=>(await tx.query<{ id: string }>(`SELECT c.id FROM node_content.conversation_sessions c
      JOIN node_content.conversation_sessions r ON r.organization_id=c.organization_id AND r.runtime_id=c.runtime_id AND r.id=c.root_session_id
      WHERE c.organization_id=$1 AND c.runtime_id=$2 AND ${visible} AND c.id=ANY($5::text[])
        AND c.status<>'deleted' AND r.status<>'deleted'`, [this.binding.organizationId,runtimeId,actor.id,actor.administrator,ids])).rows.map(r=>r.id))
    })
  }

  private change<T>(userId: number, sessionId: string, action: CollaborationAction, work: (tx: PoolClient, actor: Actor, root: Root)=>Promise<T>): Promise<T> {
    return transaction(this.control,async control => {
      const initial = await this.actor(control,userId,false)
      return this.store.write(this.binding,async tx => {
        const root = await this.root(tx,sessionId)
        this.admit(initial,root,action)
        const actor=await this.actor(control,userId,true)
        this.admit(actor,root,action)
        return work(tx,actor,root)
      },this.generation)
    })
  }

  /** Change inherited visibility after checking other contributors. @param userId - account. @param runtimeId - allocation.
   * @param sessionId - root or child Session. @param visibility - requested visibility.
   */
  setVisibility(userId: number, runtimeId: RuntimeId, sessionId: string, visibility: Visibility): Promise<void> {
    this.checkRuntime(runtimeId)
    return this.change(userId,sessionId,'manage',async (tx,_actor,root) => {
      if (visibility===root.visibility) return
      if (visibility==='private' && (await tx.query(`SELECT 1 FROM node_content.conversation_participants
        WHERE organization_id=$1 AND runtime_id=$2 AND conversation_id=$3 AND user_id<>$4 LIMIT 1`,
      [this.binding.organizationId,runtimeId,root.root_session_id,root.creator_user_id])).rowCount) throw new CollaborationDeniedError('visibility-locked')
      await tx.query(`UPDATE node_content.conversation_sessions SET visibility=$4,updated_at=now(),version=version+1
        WHERE organization_id=$1 AND runtime_id=$2 AND root_session_id=$3`, [this.binding.organizationId,runtimeId,root.root_session_id,visibility])
    })
  }

  /** Claim one interaction response inside the owning content transaction. @param userId - responder. @param runtimeId - allocation.
   * @param sessionId - Session. @param kind - interaction kind. @param interactionId - idempotency identity.
   * @param outcome - response bytes. @param callId - tool call identity. @returns true for the first response.
   */
  claimInteraction(userId: number,runtimeId: RuntimeId,sessionId: string,kind: 'approval'|'question',interactionId: string,outcome: unknown,callId?: string): Promise<boolean> {
    this.checkRuntime(runtimeId)
    return this.change(userId,sessionId,'approve',async (tx,actor,root) => (await tx.query(`INSERT INTO node_content.conversation_interaction_responses
      (organization_id,runtime_id,interaction_kind,interaction_id,conversation_id,responder_user_id,outcome,call_id,has_answers)
      VALUES($1,$2,$3,$4,$5,$6,$7::json,$8,$9) ON CONFLICT(organization_id,runtime_namespace,interaction_kind,interaction_id) DO NOTHING`,
    [this.binding.organizationId,runtimeId,kind,interactionId,root.root_session_id,actor.id,JSON.stringify(outcome),callId??null,typeof outcome==='object' && outcome!==null && 'answers' in outcome && Array.isArray(outcome.answers)])).rowCount===1)
  }

  /** Read one actor's project timeline without exposing private roots.
   * @param userId - authenticated account.
   * @param projectId - public project id.
   * @param options - bounded page size and exact cursor.
   * @returns messages and question responses from the owning volume.
   */
  async listActivity(userId: number,projectId: number,options: { limit:number; before?:string }): Promise<ProjectActivityPage> {
    return this.authorizedRead(userId,async (actor,read)=>{
    const b=this.binding
    if (actor.project!==projectId) throw new CollaborationDeniedError('not-member')
    return readProjectActivity({query:(sql,params)=>read(tx=>tx.query(sql,params?[...params]:[]))},{schema:'node_content',organizationId:b.organizationId,runtimeId:b.runtimeId,
      coordinates:[b.organizationId,b.runtimeId,actor.id], ...options, people:ids=>this.people(ids),
      rootRelation:`FROM node_content.conversation_sessions r WHERE r.organization_id=$1 AND r.runtime_id=$2
        AND r.id=r.root_session_id AND r.status<>'deleted' AND (r.visibility='project' OR r.creator_user_id=$3 ${actor.administrator?'OR true':''})`})
    })
  }

  /** Page current visible project roots using the caller's already authenticated keyset cursor.
   * @param userId - authenticated account.
   * @param query - bounded fetch size including the lookahead row, literal filter and last visible key.
   * @returns authorized directory rows in display order.
   */
  async listProjectRows(userId: number, query: { limit: number; q?: string; afterTime?: number; afterId?: string; workspaceId?:string }): Promise<AccountConversationView[]> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 201 || (query.q?.length ?? 0) > 256
      || query.workspaceId!==undefined && (!query.workspaceId || query.workspaceId.length>512 || query.workspaceId.includes('\0'))
      || (query.afterTime === undefined) !== (query.afterId === undefined)
      || query.afterTime !== undefined && (!Number.isSafeInteger(query.afterTime) || query.afterTime < 0)) {
      throw new Error('invalid node content directory parameters')
    }
    return this.authorizedRead(userId,async (actor,read)=>{
    const b = this.binding, q = query.q ?? ''
    const rows=await read(async tx=>(await tx.query<{
      id:string; title:string|null; cwd:string|null; creator_user_id:string; visibility:Visibility; name:string
      ms:string; blank:boolean; visible_content_seq:string|null; prompt_ms:string|null
    }>(`SELECT r.id,r.title,r.cwd,r.creator_user_id,r.visibility,node_content.project_name_at(s.organization_id,s.project_id,s.runtime_id,$10) name,floor(extract(epoch FROM r.updated_at)*1000)::bigint::text ms,
      NOT r.has_visible_content blank,r.visible_content_seq::text,(extract(epoch FROM r.last_prompt_at)*1000)::bigint::text prompt_ms
      FROM node_content.conversation_sessions r JOIN node_content.spaces s ON s.runtime_id=r.runtime_id AND s.organization_id=r.organization_id
      WHERE r.organization_id=$1 AND r.runtime_id=$2 AND r.parent_session_id IS NULL AND ${visible} AND ${liveRoot}
        AND ($5='' OR r.title ILIKE $6 OR r.cwd ILIKE $6 OR r.id ILIKE $6)
        ${query.workspaceId===undefined?'':`AND EXISTS(SELECT FROM node_content.workspace_catalog w
          CROSS JOIN LATERAL jsonb_array_elements(w.items) item
          WHERE w.organization_id=r.organization_id AND w.project_id=r.project_id AND w.runtime_id=r.runtime_id
            AND item->>'workspaceId'=$11 AND item->'sessionIds' ? r.id)`}
        AND ($7::bigint IS NULL OR floor(extract(epoch FROM r.updated_at)*1000)::bigint<$7
          OR (floor(extract(epoch FROM r.updated_at)*1000)::bigint=$7 AND r.id COLLATE "C">$8))
      ORDER BY floor(extract(epoch FROM r.updated_at)*1000)::bigint DESC,r.id COLLATE "C" ASC LIMIT $9`, [b.organizationId,b.runtimeId,actor.id,actor.administrator,q,literalLikePattern(q),query.afterTime??null,query.afterId??null,query.limit,actor.nameVersion,...query.workspaceId===undefined?[]:[query.workspaceId]])).rows)
    const people=await this.people(rows.map(row=>row.creator_user_id))
    return rows.map((row):AccountConversationView=>{
      const person=people.get(row.creator_user_id)
      if (!person) throw new NodeContentUnavailable('Session creator identity is unavailable.')
      return {sessionId:row.id,runtime:{kind:'project',projectId:actor.project,projectName:row.name,runtimeId:b.runtimeId,
        nodeId:b.nodeId as NonNullable<AccountConversationView['runtime']['nodeId']>,nodeName:actor.nodeName},
        ...row.title===null?{}:{title:row.title},...row.cwd===null?{}:{cwd:row.cwd},visibility:row.visibility,
        creatorUserId:publicNumber(person.public_id,'user'),creatorDisplayName:person.display_name,updatedAt:Number(row.ms),
        blank:row.blank,...row.visible_content_seq===null?{}:{visibleContentSeq:Number(row.visible_content_seq)},
        ...row.prompt_ms===null?{}:{lastPromptAt:Number(row.prompt_ms)},canWrite:actor.mode==='rw'}
    })
    })
  }

  /** List visible roots and contributor metadata for one project. @param userId - account. @param runtimeId - allocation.
   * @param projectId - public project id. @returns collaboration rows visible to the account.
   */
  async listConversations(userId:number,runtimeId:RuntimeId,projectId:number):Promise<ConversationCollaborationView[]> {
    this.checkRuntime(runtimeId)
    return this.authorizedRead(userId,async (actor,read)=>{
    const b=this.binding
    if (actor.project!==projectId) throw new CollaborationDeniedError('forbidden')
    const rows=await read(async tx=>(await tx.query<{id:string;creator_user_id:string;visibility:Visibility;ms:string;
      participants:{id:string;count:string;at:string}[]}>(`SELECT r.id,r.creator_user_id,r.visibility,(extract(epoch FROM r.updated_at)*1000)::bigint::text ms,
      COALESCE((SELECT json_agg(json_build_object('id',p.user_id,'count',p.contribution_count::text,'at',(extract(epoch FROM p.last_contributed_at)*1000)::bigint::text)
        ORDER BY p.last_contributed_at DESC,p.user_id) FROM node_content.conversation_participants p
        WHERE p.organization_id=r.organization_id AND p.runtime_id=r.runtime_id AND p.conversation_id=r.id),'[]'::json) participants
      FROM node_content.conversation_sessions r WHERE r.organization_id=$1 AND r.runtime_id=$2 AND r.parent_session_id IS NULL
        AND ${visible} AND ${liveRoot} ORDER BY r.updated_at DESC,r.id`,[b.organizationId,runtimeId,actor.id,actor.administrator])).rows)
    const people=await this.people(rows.flatMap(row=>[row.creator_user_id,...row.participants.map(p=>p.id)]))
    return rows.map(row=>{
      const person=people.get(row.creator_user_id)
      if(!person) throw new NodeContentUnavailable('Session creator identity is unavailable.')
      return {sessionId:row.id,creatorUserId:publicNumber(person.public_id,'user'),creatorDisplayName:person.display_name,
        visibility:row.visibility,updatedAt:Number(row.ms),participants:row.participants.map(p=>{
          const contributor=people.get(p.id)
          if (!contributor) throw new NodeContentUnavailable('Contributor identity is unavailable.')
          return {userId:publicNumber(contributor.public_id,'user'),displayName:contributor.display_name,
            contributionCount:Number(p.count),lastContributedAt:Number(p.at)}
        })}
    })
    })
  }
}
