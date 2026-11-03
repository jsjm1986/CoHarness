import { escapeLiteral, type PoolClient } from 'pg'
import type { RuntimeId } from '../runtime-catalog.ts'
import {
  CollaborationDeniedError,
  type CollaborationAction,
  type ConversationAccess,
  type ConversationCollaborationView,
  type ProjectAuthorityView,
  type ProjectScopeView,
  type ProjectThemePolicy,
} from '../collaboration.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'
import { publicNumber } from './runtime-context.ts'
import { transaction } from './database.ts'
import type { ConversationVisibility } from './conversation-repository.ts'
import type { ProjectActivityItem, ProjectActivityPage } from '../services.ts'

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

interface ActivityRow {
  kind: 'message' | 'answer'
  session_id: string
  seq: string
  ts: Date
  text: string | null
  actor_label: string | null
  actor_uid: string
  question_args: string | null
  outcome: unknown
  conversation_title: string | null
  cursor_ts: string
  entry_id: string
}

interface ActivityCursor {
  ts: string
  sessionId: string
  seq: number
  /** Absent for millisecond cursors issued before individual answer identifiers were included. */
  entryId?: string
}

/** Decode a Runtime-qualified precision-preserving cursor; unscoped, foreign or malformed input reads the first page. */
function parseActivityCursor(raw: string | undefined, organizationId: string, runtimeId: RuntimeId): ActivityCursor | undefined {
  if (raw === undefined) return undefined
  if (raw.startsWith('v2.')) {
    const encoded = raw.slice(3), bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded) return undefined
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) } catch { return undefined }
    if (!Array.isArray(value) || value.length !== 6 || value[0] !== organizationId || value[1] !== runtimeId) return undefined
    const [, , ts, sessionId, seq, entryId] = value as unknown[]
    if (typeof ts !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(ts)
      || ts.startsWith('0000') || !Number.isFinite(Date.parse(ts))
      || new Date(ts).toISOString().slice(0, 23) !== ts.slice(0, 23)
      || typeof sessionId !== 'string' || sessionId === '' || sessionId.includes('\0')
      || typeof entryId !== 'string' || entryId === '' || entryId.includes('\0')
      || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < -1) return undefined
    return { ts, sessionId, seq, entryId }
  }
  return undefined
}

/** Render a claimed answer's selected labels and custom text into one bounded line. */
function answerSummary(outcome: unknown): string {
  const answers = (outcome as { answers?: unknown } | null)?.answers
  if (!Array.isArray(answers)) return ''
  return answers.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return ''
    const item = entry as { selected?: unknown; custom?: unknown }
    const selected = Array.isArray(item.selected)
      ? item.selected.filter((label): label is string => typeof label === 'string').join('、')
      : ''
    return [selected, typeof item.custom === 'string' ? item.custom : '']
      .filter(text => text !== '').join('：')
  }).filter(text => text !== '').join('；').slice(0, 300)
}

/** Extract the asked question texts from a serialized tool-call arguments payload. */
function questionText(raw: string | null): string | undefined {
  if (raw === null) return undefined
  try {
    const questions = (JSON.parse(raw) as { questions?: unknown }).questions
    if (!Array.isArray(questions)) return undefined
    const text = questions
      .map(entry => (entry as { question?: unknown }).question)
      .filter((question): question is string => typeof question === 'string' && question !== '')
      .join('；').slice(0, 300)
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** Normalize one UNION feed row into the wire item; `seq` -1 marks an unanchored answer. */
function activityItem(row: ActivityRow): ProjectActivityItem {
  const seq = Number(row.seq)
  if (row.kind === 'message') {
    return {
      kind: 'message', sessionId: row.session_id, conversationTitle: row.conversation_title,
      actorUserId: publicNumber(row.actor_uid, 'user'), actorLabel: row.actor_label ?? '',
      occurredAt: row.ts.toISOString(), seq, text: row.text ?? '',
    }
  }
  const question = questionText(row.question_args)
  return {
    kind: 'answer', sessionId: row.session_id, conversationTitle: row.conversation_title,
    actorUserId: publicNumber(row.actor_uid, 'user'), actorLabel: row.actor_label ?? '',
    occurredAt: row.ts.toISOString(), seq: seq < 0 ? null : seq,
    text: answerSummary(row.outcome),
    ...(question === undefined ? {} : { questionText: question }),
    outcome: row.outcome,
  }
}

/** PostgreSQL authority for project membership and shared-conversation access. */
export class PostgresCollaborationService {
  constructor(private readonly context: PostgresRuntimeContext, private readonly catalogEntryNodeId?: import('../runtime-catalog.ts').RuntimeNodeId) {}

  private runtimePredicate(alias: string, runtimeId: RuntimeId): string {
    return `${alias}.runtime_namespace=${escapeLiteral(runtimeId)} AND EXISTS (
      SELECT 1 FROM harness.runtime_environments selected_runtime
      WHERE selected_runtime.organization_id=${alias}.organization_id AND selected_runtime.id=${alias}.runtime_id
        AND selected_runtime.node_id=${escapeLiteral(this.context.nodeId)}::uuid)`
  }

  private async projectAuthorities(userId: number, projectId: number | undefined, directory: boolean): Promise<ProjectAuthorityView[]> {
    const result = await this.context.pool.query<{
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
    }>(`SELECT p.public_id::text,p.name::text,pm.local_path path,p.kind,pm.node_id,node.name::text node_name,
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
      directory ? this.catalogEntryNodeId ?? null : null])
    return result.rows.map(row => ({
      projectId: publicNumber(row.public_id, 'project'),
      name: row.name,
      path: row.path,
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
      public_id: string
      name: string
      path: string
      kind: 'standard' | 'steward'
    }>(`SELECT p.id,p.public_id::text,p.name::text,pm.local_path path,p.kind
      FROM harness.projects p
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$2 AND pm.status='active'
      WHERE p.organization_id=$1 AND p.public_id=$3 AND p.status='active'`,
    [this.context.organizationId, this.context.nodeId, projectId])
    const row = result.rows[0]
    return row === undefined ? null : {
      id: row.id,
      publicId: publicNumber(row.public_id, 'project'),
      name: row.name,
      path: row.path,
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

  async access(userId: number, runtimeId: RuntimeId, sessionId: string, action: CollaborationAction): Promise<ConversationAccess> {
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
  async listAccountConversations(userId: number): Promise<import('../collaboration.ts').AccountConversationView[]> {
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
    }>(`SELECT r.id session_id,r.runtime_id,environment.node_id,node.name::text node_name,p.public_id::text project_public_id,p.name::text project_name,
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
      ORDER BY r.updated_at DESC,r.runtime_namespace,r.id`, [this.context.organizationId, userId, this.catalogEntryNodeId ?? null])
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

  async readableSessionIds(userId: number, runtimeId: RuntimeId, projectId: number, sessionIds: readonly string[]): Promise<string[]> {
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
  ): Promise<boolean> {
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
    if (await this.projectForUser(projectId, userId) === null) throw new CollaborationDeniedError('not-member')
    const before = parseActivityCursor(options.before, this.context.organizationId, runtimeId)
    const result = await this.context.pool.query<ActivityRow>(`WITH visible AS (
      SELECT r.organization_id,r.runtime_namespace,r.id,COALESCE(to_json(harness.human_session_title(r.title)), (SELECT harness.conversation_search_text(search.content,search.content_nul_parts,80)
        FROM harness.conversation_search search
        WHERE search.organization_id=r.organization_id AND search.runtime_namespace=r.runtime_namespace AND search.session_id=r.id AND search.role='user'
          AND harness.human_session_title(search.content) IS NOT NULL
        ORDER BY search.occurred_at,search.event_seq LIMIT 1)) title
      FROM harness.conversation_sessions r
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
          OR p.kind<>'steward' AND (membership.role='admin' OR member.user_id IS NOT NULL))
    ), feed AS (
      SELECT 'message'::text kind,e.organization_id,e.runtime_namespace,e.session_id,e.seq,e.occurred_at ts,
        harness.conversation_search_text(search_row.content,search_row.content_nul_parts,500) text,
        (e.query_fields->>'actorLabelJson')::json actor_label,
        e.query_fields->>'actorUid' actor_uid,
        NULL::json question_args,NULL::jsonb outcome,'message:' || e.seq::text entry_id
      FROM harness.conversation_search search_row
      JOIN harness.conversation_events e ON e.organization_id=search_row.organization_id AND e.runtime_namespace=search_row.runtime_namespace AND e.session_id=search_row.session_id
        AND e.seq=search_row.event_seq
      JOIN visible v ON v.organization_id=e.organization_id AND v.runtime_namespace=e.runtime_namespace AND v.id=e.session_id
      WHERE search_row.role='user' AND e.query_fields->>'actorUid' IS NOT NULL
      UNION ALL
      SELECT 'answer',c.organization_id,c.runtime_namespace,c.conversation_id,COALESCE(res.seq,-1),c.responded_at,
        NULL,to_json(u.display_name),u.public_id::text,
        (call_args.query_fields->>'argumentsJson')::json,c.outcome,'question:' || c.interaction_id
      FROM harness.conversation_interaction_responses c
      JOIN visible v ON v.organization_id=c.organization_id AND v.runtime_namespace=c.runtime_namespace AND v.id=c.conversation_id
      JOIN harness.users u ON u.id=c.responder_user_id AND u.organization_id=c.organization_id
      LEFT JOIN harness.conversation_events res ON res.organization_id=c.organization_id AND res.runtime_namespace=c.runtime_namespace AND res.session_id=c.conversation_id
        AND res.event_type='tool/result' AND res.query_fields->>'callId'=c.call_id
      LEFT JOIN harness.conversation_events call_args ON call_args.organization_id=c.organization_id AND call_args.runtime_namespace=c.runtime_namespace AND call_args.session_id=c.conversation_id
        AND call_args.event_type='tool/call' AND call_args.query_fields->>'callId'=c.call_id
      WHERE c.interaction_kind='question' AND jsonb_typeof(c.outcome->'answers')='array'
    )
    SELECT f.*,v.title conversation_title,
      to_char(f.ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_ts
    FROM feed f JOIN visible v ON v.organization_id=f.organization_id AND v.runtime_namespace=f.runtime_namespace AND v.id=f.session_id
    WHERE ($4::timestamptz IS NULL OR f.ts<$4 OR (f.ts=$4 AND (
      f.session_id>$5 OR (f.session_id=$5 AND (
        f.seq<$6::bigint OR (f.seq=$6::bigint AND $7::text IS NOT NULL AND f.entry_id>$7))))))
    ORDER BY f.ts DESC,f.session_id,f.seq DESC,f.entry_id LIMIT $8`,
      [this.context.organizationId, projectId, userId,
        before?.ts ?? null, before?.sessionId ?? '', before?.seq ?? 0, before?.entryId ?? null,
        Math.min(Math.max(options.limit, 1), 200) + 1])
    const rows = result.rows.slice(0, Math.min(Math.max(options.limit, 1), 200))
    const items = rows.map(row => activityItem(row))
    const last = result.rows.length > rows.length ? rows.at(-1) : undefined
    return {
      items,
      ...(last === undefined ? {} : { nextBefore: 'v2.' + Buffer.from(JSON.stringify([
        this.context.organizationId, runtimeId, last.cursor_ts, last.session_id, Number(last.seq), last.entry_id,
      ])).toString('base64url') }),
    }
  }

}
