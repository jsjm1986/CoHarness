import {requireNodeContentRelations,type NodeContentCheckInput} from '../node-content-publication.ts'
import { getProjectContentBinding, NodeContentUnavailable, type NodeContentBinding, type NodeContentStore } from '../node-content-store.ts'
import { NodeContentCollaboration, type CollaborationContentStore } from '../node-content-collaboration.ts'
import { escapeLiteral, type PoolClient } from 'pg'
import type { RuntimeId } from '../runtime-catalog.ts'
import type { RuntimeCredentialSubject } from '../runtime-api.ts'
import { NodeProjectMetadata,localProjectDisplays } from '../node-content-projects.ts'
import {
  CollaborationDeniedError,
  type CollaborationAction,
  type ConversationAccess,
  type ConversationCollaborationView,
  type ProjectAuthorityView,
  type ProjectReadAuthorityView,
  type ProjectScopeView,
} from '../collaboration.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'
import { publicNumber } from './runtime-context.ts'
import { transaction } from './database.ts'
import type { ConversationVisibility } from './conversation-repository.ts'
import type { ProjectActivityPage } from '../services.ts'
import { readProjectActivity } from '../node-content-activity.ts'

interface AccessRow {
  session_id: string
  root_session_id: string
  project_id: string
  project_public_id: string
  visibility: Exclude<ConversationVisibility, 'personal'>
  creator_user_id: string
  creator_public_id: string
  access_mode: 'ro' | 'rw' | null
  administrator: boolean
  project_kind: 'standard' | 'steward'
}

interface LockedAuthority {
  userId: string
  accessMode: 'ro' | 'rw'
  administrator: boolean
}

/** PostgreSQL authority for project membership and shared-conversation access. */
export class PostgresCollaborationService {
  constructor(private readonly context: PostgresRuntimeContext, private readonly catalogEntryNodeId?: import('../runtime-catalog.ts').RuntimeNodeId,
    private readonly contentStore?: CollaborationContentStore,private readonly nodeProjects=contentStore?new NodeProjectMetadata(context,contentStore):undefined) {}

  /** Check local collaboration storage and the actual owning computer reader. */
  async verifyNodeContent(input:NodeContentCheckInput):Promise<void>{
    if(!this.contentStore?.confirmCollaborationRead || !this.nodeProjects || input.binding.nodeId!==this.context.nodeId || input.binding.organizationId!==this.context.organizationId) throw new NodeContentUnavailable()
    await requireNodeContentRelations(input.local,['conversation_sessions','conversation_participants','conversation_interaction_responses','project_name_versions','conversation_acl_versions'])
  }

  /** Open only the local collaboration service named by the authenticated credential.
   * @param binding - allocation returned by current control authorization.
   * @returns the local access/participation implementation.
   */
  forContent(binding: NodeContentBinding, generation?:number): NodeContentCollaboration {
    if (this.contentStore === undefined || binding.nodeId !== this.context.nodeId || binding.organizationId !== this.context.organizationId) throw new NodeContentUnavailable()
    return new NodeContentCollaboration(this.context.pool,this.contentStore,binding,generation)
  }

  /** Use the binding returned by the same live credential query that selected the Runtime.
   * @param subject - verified Runtime principal.
   * @returns access operations retaining account and membership revalidation.
   */
  forAuthenticatedRuntime(subject:RuntimeCredentialSubject): Pick<PostgresCollaborationService,'access'|'readableSessionIds'|'claimInteraction'> {
    return {
      access:(user,runtime,id,action)=>this.access(user,runtime,id,action,subject),
      readableSessionIds:(user,runtime,project,ids)=>this.readableSessionIds(user,runtime,project,ids,subject),
      claimInteraction:(user,runtime,id,kind,interaction,outcome,callId)=>this.claimInteraction(user,runtime,id,kind,interaction,outcome,callId,subject),
    }
  }

  private async localContent(runtimeId: RuntimeId,credential?:RuntimeCredentialSubject): Promise<NodeContentCollaboration | undefined> {
    if (credential !== undefined && (credential.organizationId!==this.context.organizationId || credential.target.runtimeId!==runtimeId)) {
      throw new CollaborationDeniedError('forbidden')
    }
    const binding = credential!==undefined ? credential.contentBinding : await getProjectContentBinding(this.context.pool,this.context.organizationId,runtimeId)
    return binding === undefined ? undefined : this.forContent(binding,credential?.generation)
  }

  private runtimePredicate(alias: string, runtimeId: RuntimeId): string {
    return `${alias}.runtime_namespace=${escapeLiteral(runtimeId)} AND EXISTS (
      SELECT 1 FROM harness.runtime_environments selected_runtime
      WHERE selected_runtime.organization_id=${alias}.organization_id AND selected_runtime.id=${alias}.runtime_id
        AND selected_runtime.node_id=${escapeLiteral(this.context.nodeId)}::uuid) AND NOT EXISTS(SELECT FROM harness.project_content_placement b WHERE b.organization_id=${alias}.organization_id AND b.runtime_id=${alias}.runtime_id)`
  }

  private async projectAuthorities(userId: number, projectId: number | undefined, directory: boolean,
    browserAccount = false): Promise<ProjectReadAuthorityView[]> {
    const result = await this.context.pool.query<{
      content:NodeContentBinding|null
      public_id: string
      name: string
      path: string
      access_mode: 'ro' | 'rw'
      administrator: boolean
      can_manage: boolean
      ui_theme_policy: ProjectAuthorityView['uiThemePolicy']
      kind: 'standard' | 'steward'
      node_id: NonNullable<ProjectAuthorityView['nodeId']>
      node_name: string
      origin: NonNullable<ProjectAuthorityView['origin']>
      owner: { id: string; username: string; displayName: string } | null
    }>(`SELECT p.public_id::text,p.name::text,pm.local_path path,harness.project_content_key(p.organization_id,p.id) content,p.kind,pm.node_id,node.name::text node_name,
      CASE WHEN p.kind='steward' THEN 'rw'::text
        WHEN membership.role='admin' THEN 'rw'::text
        WHEN membership.role='member' THEN member.access_mode ELSE NULL END access_mode,
      membership.role='admin' administrator,
      (membership.role='admin' OR COALESCE(p.owner_user_id=actor.id,false)) can_manage,
      p.ui_theme_policy,p.origin,
      CASE WHEN owner.id IS NULL THEN NULL ELSE jsonb_build_object('id',owner.public_id::text,
        'username',owner.username,'displayName',owner.display_name) END owner
      FROM harness.users actor
      JOIN harness.memberships membership ON membership.organization_id=actor.organization_id
        AND membership.user_id=actor.id AND membership.status='active'
      JOIN harness.projects p ON p.organization_id=actor.organization_id
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.status='active'
      JOIN harness.compute_nodes node ON node.organization_id=pm.organization_id AND node.id=pm.node_id
      LEFT JOIN harness.users owner ON owner.organization_id=p.organization_id AND owner.id=p.owner_user_id
      LEFT JOIN harness.project_members member ON member.organization_id=p.organization_id
        AND member.project_id=p.id AND member.user_id=actor.id
      WHERE actor.organization_id=$1 AND actor.public_id=$2 AND actor.status='active'
        AND (NOT $6::boolean OR EXISTS (SELECT 1 FROM harness.password_credentials credential
          WHERE credential.user_id=actor.id AND NOT credential.must_change_password))
        AND harness.computer_use_allowed(actor.organization_id,actor.id,pm.node_id)
        AND (($5::uuid IS NULL AND pm.node_id=$3)
          OR ($5::uuid IS NOT NULL AND harness.entry_node_visible(actor.organization_id,$5,pm.node_id)))
        AND p.status='active'
        -- The steward space keeps no member rows: admission needs an active
        -- administrator membership plus an enabled qualification row, so the
        -- lane can never outlive a role downgrade.
        AND (p.kind<>'steward' AND (membership.role='admin' OR member.user_id IS NOT NULL)
          OR p.kind='steward' AND membership.role='admin' AND EXISTS (
            SELECT 1 FROM harness.steward_access_policies sp
            WHERE sp.organization_id=actor.organization_id AND sp.user_id=actor.id AND sp.node_id=harness.project_node_id(p.organization_id,p.id) AND sp.enabled))
        AND ($4::bigint IS NULL OR p.public_id=$4)
      ORDER BY p.name,p.public_id`,
    [this.context.organizationId, userId, this.context.nodeId, projectId ?? null,
      directory ? this.catalogEntryNodeId ?? null : null, browserAccount])
    const display=directory?new Map<string,{name:string;rootPath:string}>():await localProjectDisplays(this.nodeProjects,result.rows)
    return result.rows.map(row => ({
      projectId: publicNumber(row.public_id, 'project'),
      name:row.content ? directory?'#'+row.public_id:display.get(row.content.projectId)!.name : row.name,
      path:row.content ? directory?'':display.get(row.content.projectId)!.rootPath : row.path,
      ...row.content&&directory?{metadataOnNode:true as const}:{ },
      mode: row.access_mode,
      nodeId: row.node_id,
      nodeName: row.node_name,
      origin: row.origin,
      owner: row.owner === null ? null : { ...row.owner, id: publicNumber(row.owner.id, 'project owner') },
      administrator: row.administrator,
      canManage: row.can_manage,
      uiThemePolicy: row.ui_theme_policy,
      kind: row.kind,
    }))
  }

  async projectsForUser(userId: number): Promise<ProjectScopeView[]> {
    return (await this.projectAuthorities(userId, undefined, true)).map(({ administrator: _, ...project }) => project)
  }

  /** Final browser read admission uses current directory authority without loading node-owned names or paths. */
  async projectReadAuthorities(userId: number, projectId?: number): Promise<ProjectReadAuthorityView[]> {
    return this.projectAuthorities(userId, projectId, true, true)
  }

  async projectForUser(projectId: number, userId: number): Promise<ProjectAuthorityView | null> {
    return (await this.projectAuthorities(userId, projectId, false))[0] ?? null
  }

  async internalProject(projectId: number): Promise<{
    id: string
    publicId: number
    name: string
    path: string
    kind: 'standard' | 'steward'
  } | null> {
    const result = await this.context.pool.query<{
      id: string
      content:NodeContentBinding|null
      public_id: string
      name: string
      path: string
      kind: 'standard' | 'steward'
    }>(`SELECT p.id,p.public_id::text,p.name::text,pm.local_path path,p.kind,harness.project_content_key(p.organization_id,p.id) content
      FROM harness.projects p
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$2 AND pm.status='active'
      WHERE p.organization_id=$1 AND p.public_id=$3 AND p.status='active'`,
    [this.context.organizationId, this.context.nodeId, projectId])
    const row = result.rows[0]
    const display=await localProjectDisplays(this.nodeProjects,result.rows)
    return row === undefined ? null : {
      id: row.id,
      publicId: publicNumber(row.public_id, 'project'),
      name:row.content?display.get(row.content.projectId)!.name:row.name,
      path:row.content?display.get(row.content.projectId)!.rootPath:row.path,
      kind: row.kind,
    }
  }

  private async accessRow(queryable: PoolClient | PostgresRuntimeContext['pool'], userId: number, runtimeId: RuntimeId, sessionId: string): Promise<AccessRow | null> {
    const result = await queryable.query<AccessRow>(`SELECT c.id session_id,r.id root_session_id,
      p.id project_id,p.public_id::text project_public_id,r.visibility,r.creator_user_id,
      creator.public_id::text creator_public_id,p.kind project_kind,
      CASE WHEN p.kind='steward' THEN 'rw'::text
        WHEN membership.role='admin' THEN 'rw'::text
        WHEN membership.role='member' THEN member.access_mode ELSE NULL END access_mode,
      COALESCE(membership.role='admin',false) administrator
      FROM harness.conversation_sessions c
      JOIN harness.conversation_sessions r ON r.id=c.root_session_id AND r.organization_id=c.organization_id AND r.runtime_namespace=c.runtime_namespace
      JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id AND p.status='active'
      JOIN harness.users creator ON creator.id=r.creator_user_id AND creator.organization_id=r.organization_id
      LEFT JOIN harness.users actor ON actor.organization_id=r.organization_id AND actor.public_id=$2
        AND actor.status='active'
      LEFT JOIN harness.memberships membership ON membership.organization_id=r.organization_id
        AND membership.user_id=actor.id AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=r.organization_id
        AND member.project_id=r.project_id AND member.user_id=actor.id
      WHERE c.organization_id=$1 AND ${this.runtimePredicate('c', runtimeId)} AND c.id=$3 AND c.status<>'deleted' AND r.status<>'deleted'
        AND harness.project_computer_use_allowed(actor.organization_id,actor.id,p.id)
        AND (p.kind<>'steward' OR (membership.role='admin' AND EXISTS (
          SELECT 1 FROM harness.steward_access_policies sp
          WHERE sp.organization_id=actor.organization_id AND sp.user_id=actor.id AND sp.node_id=harness.project_node_id(p.organization_id,p.id) AND sp.enabled)))`,
    [this.context.organizationId, userId, sessionId])
    return result.rows[0] ?? null
  }

  private async lockedAccessRow(
    client: PoolClient,
    userId: number,
    runtimeId: RuntimeId,
    sessionId: string,
    rootLock: 'share' | 'update',
  ): Promise<{ access: AccessRow; authority: LockedAuthority | null } | null> {
    const lock = rootLock === 'update' ? 'FOR UPDATE OF r' : 'FOR SHARE OF r'
    const result = await client.query<AccessRow>(`SELECT c.id session_id,r.id root_session_id,
      p.id project_id,p.public_id::text project_public_id,r.visibility,r.creator_user_id,
      creator.public_id::text creator_public_id,p.kind project_kind,NULL::text access_mode,false administrator
      FROM harness.conversation_sessions c
      JOIN harness.conversation_sessions r ON r.id=c.root_session_id AND r.organization_id=c.organization_id AND r.runtime_namespace=c.runtime_namespace
      JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id AND p.status='active'
      JOIN harness.users creator ON creator.id=r.creator_user_id AND creator.organization_id=r.organization_id
      WHERE c.organization_id=$1 AND ${this.runtimePredicate('c', runtimeId)} AND c.id=$2 AND c.status<>'deleted' AND r.status<>'deleted'
        AND (p.kind<>'steward' OR EXISTS (
          SELECT 1 FROM harness.users ua
          JOIN harness.memberships um ON um.organization_id=ua.organization_id
            AND um.user_id=ua.id AND um.status='active' AND um.role='admin'
          JOIN harness.steward_access_policies sp ON sp.organization_id=ua.organization_id
            AND sp.user_id=ua.id AND sp.node_id=harness.project_node_id(p.organization_id,p.id) AND sp.enabled
          WHERE ua.organization_id=$1 AND ua.public_id=$3 AND ua.status='active'))
      ${lock}`, [this.context.organizationId, sessionId, userId])
    const access = result.rows[0]
    if (access === undefined) return null
    const actor = await client.query<{ user_id: string; organization_role: 'admin' | 'member' }>(`SELECT
      actor.id user_id,membership.role organization_role
      FROM harness.users actor
      JOIN harness.memberships membership ON membership.user_id=actor.id
        AND membership.organization_id=actor.organization_id AND membership.status='active'
      WHERE actor.organization_id=$1 AND actor.public_id=$2 AND actor.status='active' AND actor.deleted_at IS NULL
      FOR SHARE OF actor,membership`, [this.context.organizationId, userId])
    const current = actor.rows[0]
    if (current === undefined) return { access, authority: null }
    if ((await client.query('SELECT harness.project_computer_use_allowed($1,$2,$3) allowed',
      [this.context.organizationId, current.user_id, access.project_id])).rows[0]?.allowed !== true) return { access, authority: null }
    const project = await client.query(`SELECT 1 FROM harness.projects
      WHERE organization_id=$1 AND id=$2 AND status='active'`, [this.context.organizationId, access.project_id])
    if (project.rowCount === 0) return { access, authority: null }
    // Policy writers hold the account's update lock; this share lock protects a fresh qualification read.
    if (access.project_kind === 'steward') {
      const qualification = current.organization_role === 'admin' && (await client.query(`SELECT 1 FROM harness.steward_access_policies
        WHERE organization_id=$1 AND user_id=$2 AND node_id=harness.project_node_id($1,$3) AND enabled`, [this.context.organizationId, current.user_id, access.project_id])).rowCount === 1
      if (!qualification) return { access, authority: null }
      return {
        access: { ...access, access_mode: 'rw', administrator: true },
        authority: {
          userId: current.user_id,
          accessMode: 'rw',
          administrator: true,
        },
      }
    }
    if (current.organization_role === 'admin') {
      return {
        access: { ...access, access_mode: 'rw', administrator: true },
        authority: { userId: current.user_id, accessMode: 'rw', administrator: true },
      }
    }
    const membership = await client.query<{ user_id: string; access_mode: 'ro' | 'rw' }>(`SELECT
      member.user_id,member.access_mode
      FROM harness.project_members member
      WHERE member.organization_id=$1 AND member.project_id=$2 AND member.user_id=$3
      FOR SHARE OF member`, [this.context.organizationId, access.project_id, current.user_id])
    const member = membership.rows[0]
    return {
      access: { ...access, access_mode: member?.access_mode ?? null },
      authority: member === undefined ? null : {
        userId: member.user_id,
        accessMode: member.access_mode,
        administrator: false,
      },
    }
  }

  async access(userId: number, runtimeId: RuntimeId, sessionId: string, action: CollaborationAction,credential?:RuntimeCredentialSubject): Promise<ConversationAccess> {
    const local = await this.localContent(runtimeId,credential)
    if (local !== undefined) return local.access(userId,runtimeId,sessionId,action)
    const row = await this.accessRow(this.context.pool, userId, runtimeId, sessionId)
    if (row === null) throw new CollaborationDeniedError('conversation-not-found')
    if (row.access_mode === null) throw new CollaborationDeniedError('not-member')
    const creatorUserId = publicNumber(row.creator_public_id, 'user')
    const isCreator = creatorUserId === userId
    const canRead = row.administrator || row.visibility === 'project' || isCreator
    const canWrite = row.access_mode === 'rw' && canRead
    const canManage = row.access_mode === 'rw' && (row.administrator || isCreator)
    if (!canRead || (action === 'write' && !canWrite) || (action === 'approve' && !canWrite)
      || (action === 'manage' && !canManage)) {
      throw new CollaborationDeniedError('forbidden')
    }
    return {
      sessionId: row.session_id,
      rootSessionId: row.root_session_id,
      projectId: publicNumber(row.project_public_id, 'project'),
      visibility: row.visibility,
      creatorUserId,
      mode: row.access_mode,
      canRead: true,
      canWrite,
      canManage,
    }
  }

  async listConversations(userId: number, runtimeId: RuntimeId, projectId: number): Promise<ConversationCollaborationView[]> {
    const local = await this.localContent(runtimeId)
    if (local !== undefined) return local.listConversations(userId,runtimeId,projectId)
    if (await this.projectForUser(projectId, userId) === null) throw new CollaborationDeniedError('not-member')
    const result = await this.context.pool.query<{
      session_id: string
      creator_public_id: string
      creator_display_name: string
      visibility: Exclude<ConversationVisibility, 'personal'>
      updated_at_ms: string
      participants: Array<{
        userId: string
        displayName: string
        contributionCount: string
        lastContributedAt: string
      }> | null
    }>(`SELECT r.id session_id,creator.public_id::text creator_public_id,
      creator.display_name creator_display_name,r.visibility,
      (extract(epoch FROM r.updated_at)*1000)::bigint::text updated_at_ms,
      COALESCE(jsonb_agg(jsonb_build_object(
        'userId',participant.public_id::text,
        'displayName',participant.display_name,
        'contributionCount',cp.contribution_count::text,
        'lastContributedAt',(extract(epoch FROM cp.last_contributed_at)*1000)::bigint::text
      ) ORDER BY cp.last_contributed_at DESC) FILTER (WHERE cp.user_id IS NOT NULL),'[]'::jsonb) participants
      FROM harness.conversation_sessions r
      JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id
      JOIN harness.users creator ON creator.id=r.creator_user_id AND creator.organization_id=r.organization_id
      JOIN harness.users actor ON actor.organization_id=r.organization_id
        AND actor.public_id=$3 AND actor.status='active'
      JOIN harness.memberships membership ON membership.organization_id=r.organization_id
        AND membership.user_id=actor.id AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=r.organization_id
        AND member.project_id=r.project_id AND member.user_id=actor.id
      LEFT JOIN harness.conversation_participants cp ON cp.conversation_id=r.id
        AND cp.organization_id=r.organization_id AND cp.runtime_namespace=r.runtime_namespace
      LEFT JOIN harness.users participant ON participant.id=cp.user_id
        AND participant.organization_id=cp.organization_id
      WHERE r.organization_id=$1 AND ${this.runtimePredicate('r', runtimeId)} AND p.public_id=$2 AND r.id=r.root_session_id
        AND harness.project_computer_use_allowed(actor.organization_id,actor.id,p.id)
        AND r.status<>'deleted'
        AND (membership.role='admin' OR r.visibility='project' OR creator.id=actor.id)
        AND (p.kind='steward' AND membership.role='admin' AND EXISTS (
            SELECT 1 FROM harness.steward_access_policies sp
            WHERE sp.organization_id=actor.organization_id AND sp.user_id=actor.id AND sp.node_id=harness.project_node_id(p.organization_id,p.id) AND sp.enabled)
          OR p.kind<>'steward' AND (membership.role='admin' OR member.user_id IS NOT NULL))
      GROUP BY r.organization_id,r.runtime_namespace,r.id,creator.public_id,creator.display_name
      ORDER BY r.updated_at DESC,r.runtime_namespace,r.id`, [this.context.organizationId, projectId, userId])
    return result.rows.map(row => ({
      sessionId: row.session_id,
      creatorUserId: publicNumber(row.creator_public_id, 'user'),
      creatorDisplayName: row.creator_display_name,
      visibility: row.visibility,
      participants: (row.participants ?? []).map(participant => ({
        userId: publicNumber(participant.userId, 'user'),
        displayName: participant.displayName,
        contributionCount: Number(participant.contributionCount),
        lastContributedAt: Number(participant.lastContributedAt),
      })),
      updatedAt: Number(row.updated_at_ms),
    }))
  }

  /**
   * List roots whose owning Runtime computer remains accessible to this account.
   * @param userId - authenticated account public number.
   * @returns authorized personal/project metadata; another Runtime's computer grant cannot expose a personal root.
   */
  async listAccountConversations(userId: number, page?: { runtimeId: RuntimeId; query: string; afterTime: number | null;
    afterId: string; limit: number; workspaceId?: string | null; excludePublished?: boolean }): Promise<import('../collaboration.ts').AccountConversationView[]> {
    const result = await this.context.pool.query<{
      session_id: string
      runtime_id: import('../runtime-catalog.ts').RuntimeId | null
      node_id: import('../runtime-catalog.ts').RuntimeNodeId | null
      node_name: string | null
      project_public_id: string | null
      project_name: string | null
      title: string | null
      cwd: string | null
      visibility: 'personal' | 'project' | 'private'
      creator_public_id: string
      creator_display_name: string
      updated_at_ms: string
      has_visible_content: boolean
      visible_content_seq: string | null
      last_prompt_at_ms: string | null
      can_write: boolean
    }>(`${page === undefined ? '' : 'WITH visible AS ('}SELECT r.id session_id,r.runtime_id,environment.node_id,node.name::text node_name,p.public_id::text project_public_id,p.name::text project_name,
      COALESCE(to_json(harness.human_session_title(r.title)), (SELECT harness.conversation_search_text(search.content,search.content_nul_parts,80) FROM harness.conversation_search search
        WHERE search.organization_id=r.organization_id AND search.runtime_namespace=r.runtime_namespace AND search.session_id=r.id AND search.role='user'
          AND harness.human_session_title(search.content) IS NOT NULL
        ORDER BY search.occurred_at,search.event_seq LIMIT 1)) title,
      r.cwd,r.visibility,creator.public_id::text creator_public_id,
      creator.display_name creator_display_name,
      (extract(epoch FROM r.updated_at)*1000)::bigint::text updated_at_ms,
      r.has_visible_content,r.visible_content_seq::text,
      (extract(epoch FROM r.last_prompt_at)*1000)::bigint::text last_prompt_at_ms,
      CASE WHEN p.id IS NULL THEN true
        WHEN p.kind='steward' THEN true
        WHEN membership.role='admin' THEN true
        ELSE member.access_mode='rw' END can_write
      FROM harness.conversation_sessions r
      LEFT JOIN harness.runtime_environments environment ON environment.organization_id=r.organization_id AND environment.id=r.runtime_id
      LEFT JOIN harness.compute_nodes node ON node.organization_id=environment.organization_id AND node.id=environment.node_id
      JOIN harness.users creator ON creator.id=r.creator_user_id AND creator.organization_id=r.organization_id
      JOIN harness.users actor ON actor.organization_id=r.organization_id
        AND actor.public_id=$2 AND actor.status='active'
      LEFT JOIN harness.memberships membership ON membership.organization_id=actor.organization_id
        AND membership.user_id=actor.id AND membership.status='active'
      LEFT JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id
        AND p.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=r.organization_id
        AND member.project_id=r.project_id AND member.user_id=actor.id
      WHERE r.organization_id=$1 AND r.id=r.root_session_id AND r.status<>'deleted'
        AND ($3::uuid IS NULL OR harness.entry_node_visible(r.organization_id,$3,environment.node_id))
        AND NOT EXISTS (SELECT 1 FROM harness.conversation_archive_records archive
          WHERE archive.organization_id=r.organization_id AND archive.root_session_id=r.id AND archive.runtime_id=r.runtime_id
            AND (archive.state IN ('trash','purged') OR archive.restored_at IS NULL))
        AND ((r.project_id IS NULL AND r.creator_user_id=actor.id AND EXISTS(SELECT 1 FROM harness.instances i
            WHERE i.organization_id=r.organization_id AND i.user_id=actor.id AND i.runtime_id=r.runtime_id
              AND harness.computer_use_allowed(i.organization_id,actor.id,i.assigned_node_id)))
          OR (p.id IS NOT NULL
            AND harness.project_computer_use_allowed(actor.organization_id,actor.id,p.id)
            AND (membership.role='admin' OR r.visibility='project' OR r.creator_user_id=actor.id)
            AND (p.kind='steward' AND membership.role='admin' AND EXISTS (
                SELECT 1 FROM harness.steward_access_policies sp
                WHERE sp.organization_id=actor.organization_id AND sp.user_id=actor.id AND sp.node_id=harness.project_node_id(p.organization_id,p.id) AND sp.enabled)
              OR p.kind<>'steward' AND (membership.role='admin' OR member.user_id IS NOT NULL))))
        AND NOT EXISTS (SELECT 1 FROM harness.project_content_placement b WHERE b.organization_id=r.organization_id AND b.runtime_id=r.runtime_id)
        AND NOT EXISTS (SELECT 1 FROM harness.personal_directory_placement b WHERE b.organization_id=r.organization_id AND b.runtime_id=r.runtime_id)
      ${page === undefined ? 'ORDER BY r.updated_at DESC,r.runtime_namespace,r.id' : `AND r.runtime_id=$4
        AND ($10::text IS NULL OR EXISTS(SELECT 1 FROM harness.runtime_workspace_catalog rc,LATERAL jsonb_array_elements(rc.items) w
          WHERE rc.organization_id=r.organization_id AND rc.runtime_id=r.runtime_id AND w->>'workspaceId'=$10 AND (w->'sessionIds') ? r.id))
        AND (NOT $9::boolean OR NOT EXISTS (SELECT 1 FROM harness.runtime_workspace_catalog c,
          LATERAL jsonb_array_elements(c.conversations) v WHERE c.organization_id=r.organization_id
            AND c.runtime_id=r.runtime_id AND v->>'sessionId'=r.id)) ) SELECT * FROM visible
        WHERE ($5::text='' OR strpos(lower(concat_ws(' ',title #>> '{}',cwd,session_id)),lower($5))>0)
        AND ($6::bigint IS NULL OR updated_at_ms::bigint < $6 OR (updated_at_ms::bigint=$6 AND session_id COLLATE "C" > $7))
        ORDER BY updated_at_ms::bigint DESC,session_id COLLATE "C" LIMIT $8`}`, [this.context.organizationId, userId, this.catalogEntryNodeId ?? null,
          ...(page === undefined ? [] : [page.runtimeId, page.query, page.afterTime, page.afterId, page.limit, page.excludePublished === true, page.workspaceId ?? null])])
    return result.rows.map(row => ({
      sessionId: row.session_id,
      runtime: { ...(row.project_public_id === null
        ? { kind: 'personal' as const }
        : { kind: 'project' as const, projectId: publicNumber(row.project_public_id, 'project'), projectName: row.project_name ?? 'Project' }),
        ...(row.runtime_id === null ? {} : { runtimeId: row.runtime_id }),
        ...(row.node_id === null ? {} : { nodeId: row.node_id }),
        ...(row.node_name === null ? {} : { nodeName: row.node_name }),
      },
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.cwd === null ? {} : { cwd: row.cwd }),
      visibility: row.visibility,
      creatorUserId: publicNumber(row.creator_public_id, 'user'),
      creatorDisplayName: row.creator_display_name,
      updatedAt: Number(row.updated_at_ms),
      blank: !row.has_visible_content,
      ...(row.visible_content_seq === null ? {} : { visibleContentSeq: Number(row.visible_content_seq) }),
      ...(row.last_prompt_at_ms === null ? {} : { lastPromptAt: Number(row.last_prompt_at_ms) }),
      canWrite: row.can_write,
    }))
  }

  async readableSessionIds(userId: number, runtimeId: RuntimeId, projectId: number, sessionIds: readonly string[],credential?:RuntimeCredentialSubject): Promise<string[]> {
    const local = await this.localContent(runtimeId,credential)
    if (local !== undefined) return local.readableSessionIds(userId,runtimeId,projectId,sessionIds)
    if (sessionIds.length === 0) return []
    const result = await this.context.pool.query<{ session_id: string }>(`SELECT c.id session_id
      FROM unnest($4::text[]) requested(session_id)
      JOIN harness.conversation_sessions c ON c.id=requested.session_id
        AND c.organization_id=$1 AND ${this.runtimePredicate('c', runtimeId)} AND c.status<>'deleted'
      JOIN harness.conversation_sessions r ON r.id=c.root_session_id
        AND r.organization_id=c.organization_id AND r.runtime_namespace=c.runtime_namespace AND r.status<>'deleted'
      JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id
        AND p.public_id=$3 AND p.status='active'
      JOIN harness.users actor ON actor.organization_id=r.organization_id
        AND actor.public_id=$2 AND actor.status='active'
      JOIN harness.memberships membership ON membership.organization_id=r.organization_id
        AND membership.user_id=actor.id AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=r.organization_id
        AND member.project_id=r.project_id AND member.user_id=actor.id
      -- Admission already requires an administrator, whose role bypasses the
      -- visibility gate; keep the arm flat rather than re-checking visibility.
      WHERE harness.project_computer_use_allowed(actor.organization_id,actor.id,p.id)
        AND (p.kind='steward' AND membership.role='admin' AND EXISTS (
          SELECT 1 FROM harness.steward_access_policies sp
          WHERE sp.organization_id=actor.organization_id AND sp.user_id=actor.id AND sp.node_id=harness.project_node_id(p.organization_id,p.id) AND sp.enabled)
        OR p.kind<>'steward' AND (membership.role='admin' OR (member.user_id IS NOT NULL
          AND (r.visibility='project' OR r.creator_user_id=actor.id))))`,
    [this.context.organizationId, userId, projectId, sessionIds])
    return result.rows.map(row => row.session_id)
  }

  async setVisibility(userId: number, runtimeId: RuntimeId, sessionId: string, visibility: 'project' | 'private'): Promise<void> {
    const local = await this.localContent(runtimeId)
    if (local !== undefined) return local.setVisibility(userId,runtimeId,sessionId,visibility)
    await transaction(this.context.pool, async (client) => {
      const locked = await this.lockedAccessRow(client, userId, runtimeId, sessionId, 'update')
      if (locked === null) throw new CollaborationDeniedError('conversation-not-found')
      const creatorUserId = publicNumber(locked.access.creator_public_id, 'user')
      if (locked.authority?.accessMode !== 'rw'
        || (!locked.authority.administrator && creatorUserId !== userId)) {
        throw new CollaborationDeniedError('forbidden')
      }
      if (locked.access.visibility === visibility) return
      if (visibility === 'private') {
        const others = await client.query<{ present: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM harness.conversation_participants
          WHERE organization_id=$1 AND runtime_namespace=${escapeLiteral(runtimeId)} AND conversation_id=$2 AND user_id<>$3
        ) present`, [this.context.organizationId, locked.access.root_session_id, locked.access.creator_user_id])
        if (others.rows[0]?.present === true) throw new CollaborationDeniedError('visibility-locked')
      }
      await client.query(`UPDATE harness.conversation_sessions SET visibility=$3,updated_at=now(),version=version+1
        WHERE organization_id=$1 AND ${this.runtimePredicate('conversation_sessions', runtimeId)} AND root_session_id=$2`,
      [this.context.organizationId, locked.access.root_session_id, visibility])
    })
  }

  async claimInteraction(
    userId: number,
    runtimeId: RuntimeId,
    sessionId: string,
    kind: 'approval' | 'question',
    interactionId: string,
    outcome: unknown,
    callId?: string,
    credential?:RuntimeCredentialSubject,
  ): Promise<boolean> {
    const local = await this.localContent(runtimeId,credential)
    if (local !== undefined) return local.claimInteraction(userId,runtimeId,sessionId,kind,interactionId,outcome,callId)
    return transaction(this.context.pool, async (client) => {
      const locked = await this.lockedAccessRow(client, userId, runtimeId, sessionId, 'share')
      if (locked === null) throw new CollaborationDeniedError('conversation-not-found')
      const creatorUserId = publicNumber(locked.access.creator_public_id, 'user')
      if (locked.authority?.accessMode !== 'rw'
        || (!locked.authority.administrator
          && locked.access.visibility === 'private' && creatorUserId !== userId)) {
        throw new CollaborationDeniedError('forbidden')
      }
      const responderId = locked.authority.userId
      const inserted = await client.query(`INSERT INTO harness.conversation_interaction_responses(
        organization_id,runtime_id,interaction_kind,interaction_id,conversation_id,responder_user_id,outcome,call_id
      ) VALUES($1,$8,$2,$3,$4,$5,$6::jsonb,$7)
      ON CONFLICT(organization_id,runtime_namespace,interaction_kind,interaction_id) DO NOTHING`,
      [this.context.organizationId, kind, interactionId, locked.access.root_session_id, responderId, JSON.stringify(outcome), callId ?? null, runtimeId])
      return inserted.rowCount === 1
    })
  }

  /**
   * Read one page of member-activity rows for a project, newest first.
   * @param userId - requesting member's public id; visibility matches listConversations.
   * @param runtimeId - authenticated Runtime UUID whose roots feed the page.
   * @param projectId - project public id whose root conversations feed the page.
   * @param options - row cap (clamped to 200) and an opaque `before` cursor; malformed cursors read the first page.
   * @returns normalized feed rows plus the cursor that resumes after the last row.
   */
  async listActivity(
    userId: number,
    runtimeId: RuntimeId,
    projectId: number,
    options: { limit: number; before?: string },
  ): Promise<ProjectActivityPage> {
    const local = await this.localContent(runtimeId)
    if (local !== undefined) return local.listActivity(userId,projectId,options)
    if (await this.projectForUser(projectId, userId) === null) throw new CollaborationDeniedError('not-member')
    return readProjectActivity(this.context.pool, { schema:'harness',organizationId:this.context.organizationId,runtimeId,
      coordinates:[this.context.organizationId,projectId,userId],...options,rootRelation:`FROM harness.conversation_sessions r
      JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id
      JOIN harness.users creator ON creator.id=r.creator_user_id AND creator.organization_id=r.organization_id
      JOIN harness.users actor ON actor.organization_id=r.organization_id
        AND actor.public_id=$3 AND actor.status='active'
      JOIN harness.memberships membership ON membership.organization_id=r.organization_id
        AND membership.user_id=actor.id AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=r.organization_id
        AND member.project_id=r.project_id AND member.user_id=actor.id
      WHERE r.organization_id=$1 AND ${this.runtimePredicate('r', runtimeId)} AND p.public_id=$2 AND r.id=r.root_session_id AND r.status<>'deleted'
        AND harness.project_computer_use_allowed(actor.organization_id,actor.id,p.id)
        AND (membership.role='admin' OR r.visibility='project' OR creator.id=actor.id)
        AND (p.kind='steward' AND membership.role='admin' AND EXISTS (
            SELECT 1 FROM harness.steward_access_policies sp
            WHERE sp.organization_id=actor.organization_id AND sp.user_id=actor.id AND sp.node_id=harness.project_node_id(p.organization_id,p.id) AND sp.enabled)
          OR p.kind<>'steward' AND (membership.role='admin' OR member.user_id IS NOT NULL))` })
  }

}
