import type { Pool, PoolClient } from 'pg'
import { lstat, unlink } from 'node:fs/promises'
import { transaction } from './database.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

/** Lifecycle state of one archived root conversation. */
export type ConversationArchiveState = 'archived' | 'trash' | 'purged'

/** Server-side filters accepted by the administrator archive list. */
export interface ConversationArchiveAdminFilter {
  readonly state?: ConversationArchiveState | 'all'
  /** Maintenance-only selector; ordinary archive views default to conversations. */
  readonly recordKind?: 'conversation' | 'empty-draft' | 'all'
  readonly query?: string
  readonly userId?: number
  readonly projectId?: number
  readonly fromMs?: number
  readonly toMs?: number
  readonly limit?: number
  readonly offset?: number
}

/** One old, completely blank root eligible for maintenance review. */
export interface EmptyDraftCandidate {
  readonly rootSessionId: string
  readonly runtime: { readonly kind: 'user' | 'project'; readonly id: number }
  readonly creator: { readonly id: number; readonly displayName: string } | null
  readonly project: { readonly id: number; readonly name: string } | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly eventCount: number
}

/** Bounded maintenance preview; no mutation occurs. */
export interface EmptyDraftPreview {
  readonly cutoff: number
  readonly candidates: readonly EmptyDraftCandidate[]
}

const DEFAULT_EMPTY_DRAFT_AGE_MS = 60 * 60 * 1000

/** One root conversation row shown by the Admin archive channel. */
export interface ConversationArchiveRow {
  readonly rootSessionId: string
  readonly title: string
  readonly creator: { readonly id: number; readonly displayName: string } | null
  readonly project: { readonly id: number; readonly name: string } | null
  readonly runtime: { readonly kind: 'user' | 'project'; readonly id: number }
  readonly workspace: { readonly path: string; readonly title: string; readonly position: number | null } | null
  readonly state: ConversationArchiveState
  readonly archivedAt: number
  readonly restoredAt: number | null
  readonly trashedAt: number | null
  readonly purgeAfter: number | null
  readonly syncState: 'pending' | 'synced' | 'conflict' | 'unavailable'
  readonly childCount: number
  readonly messageCount: number
  readonly updatedAt: number
  /** Present only for maintenance rows representing empty drafts. */
  readonly recordKind?: 'empty-draft'
}

/** One event returned by the built-in administrator conversation reader. */
export interface ConversationArchiveEvent {
  readonly sessionId: string
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: unknown
}

/** Detail response for one root conversation. */
export interface ConversationArchiveDetail {
  readonly record: ConversationArchiveRow
  readonly descendants: readonly { sessionId: string; parentSessionId: string | null; title: string }[]
  readonly events: readonly ConversationArchiveEvent[]
  readonly hasMore: boolean
}

/** Runtime metadata used to create or refresh an archive index record. */
export interface ConversationArchiveSnapshot {
  readonly rootSessionId: string
  readonly runtime: { readonly kind: 'user' | 'project'; readonly id: number }
  readonly projectId?: number
  readonly creatorUserId?: number
  readonly title?: string
  readonly workspace?: { readonly path: string; readonly title: string; readonly position?: number }
  readonly archivedAt?: number
  readonly syncRevision: number
  readonly messageCount?: number
  readonly search?: readonly {
    sessionId: string
    seq: number
    role: 'user' | 'assistant'
    content: string
    occurredAt: number
  }[]
}

/** Complete runtime archive carrier received over the authenticated loopback API. */
export interface ConversationArchiveRuntimeSnapshot {
  readonly runtime: { readonly kind: 'user' | 'project'; readonly id: number }
  readonly revision: number
  readonly archivedSessionIds: readonly string[]
  readonly sessions: readonly {
    sessionId: string
    rootSessionId?: string
    header: { createdAt?: number; cwd?: string; parentSession?: string; agentPreset?: string; draft?: boolean }
    title?: string
    messageCount?: number
    workspace?: { path: string; title: string; position: number }
  }[]
  readonly search?: readonly ArchiveSearchInput[]
}

/** Runtime event page returned when an administrator opens a personal archive. */
export interface ConversationArchiveRuntimeRead {
  readonly title?: string
  readonly descendants: readonly { sessionId: string; parentSessionId: string | null; title: string }[]
  readonly events: readonly ConversationArchiveEvent[]
  readonly hasMore: boolean
}

/** Callback used by the Gateway to start a runtime and read a personal transcript. */
export type ConversationArchiveRuntimeReader = (
  runtime: { readonly kind: 'user' | 'project'; readonly id: number },
  rootSessionId: string,
  fromSeq: number,
  limit: number,
) => Promise<ConversationArchiveRuntimeRead | undefined>

interface ArchiveSearchInput {
  readonly sessionId: string
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly occurredAt: number
}

interface ArchiveDbRow {
  root_session_id: string
  title: string | null
  creator_public_id: string | null
  creator_display_name: string | null
  project_public_id: string | null
  project_name: string | null
  runtime_kind: 'user' | 'project'
  runtime_public_id: string
  workspace_path: string | null
  workspace_title: string | null
  workspace_position: number | null
  state: ConversationArchiveState
  archived_at_ms: string
  restored_at_ms: string | null
  trashed_at_ms: string | null
  purge_after_ms: string | null
  sync_state: 'pending' | 'synced' | 'conflict' | 'unavailable'
  child_count: string
  message_count: string
  updated_at_ms: string
  record_kind: 'conversation' | 'empty-draft'
}

interface EmptyDraftDbRow {
  root_session_id: string
  runtime_kind: 'user' | 'project'
  runtime_public_id: string
  creator_public_id: string | null
  creator_display_name: string | null
  project_public_id: string | null
  project_name: string | null
  created_at_ms: string
  updated_at_ms: string
  event_count: string
}

function safeNumber(value: string | number | null, label: string, nullable = false): number | null {
  if (value === null && nullable) return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is outside the safe integer range`)
  return number
}

function boundedLimit(value: number | undefined, maximum = 200): number {
  return Math.min(Math.max(value ?? 50, 1), maximum)
}

function boundedOffset(value: number | undefined): number {
  return Math.min(Math.max(value ?? 0, 0), Number.MAX_SAFE_INTEGER)
}

function archiveRow(row: ArchiveDbRow): ConversationArchiveRow {
  return {
    rootSessionId: row.root_session_id,
    title: row.title ?? '未命名对话',
    creator: row.creator_public_id === null || row.creator_display_name === null
      ? null
      : { id: publicNumber(row.creator_public_id, 'creator'), displayName: row.creator_display_name },
    project: row.project_public_id === null || row.project_name === null
      ? null
      : { id: publicNumber(row.project_public_id, 'project'), name: row.project_name },
    runtime: { kind: row.runtime_kind, id: publicNumber(row.runtime_public_id, 'runtime') },
    workspace: row.workspace_path === null || row.workspace_title === null
      ? null
      : { path: row.workspace_path, title: row.workspace_title, position: row.workspace_position },
    state: row.state,
    archivedAt: safeNumber(row.archived_at_ms, 'archived time')!,
    restoredAt: safeNumber(row.restored_at_ms, 'restored time', true),
    trashedAt: safeNumber(row.trashed_at_ms, 'trashed time', true),
    purgeAfter: safeNumber(row.purge_after_ms, 'purge time', true),
    syncState: row.sync_state,
    childCount: safeNumber(row.child_count, 'child count')!,
    messageCount: safeNumber(row.message_count, 'message count')!,
    updatedAt: safeNumber(row.updated_at_ms, 'updated time')!,
    ...(row.record_kind === 'empty-draft' ? { recordKind: 'empty-draft' as const } : {}),
  }
}

const ARCHIVE_COLUMNS = `a.root_session_id,
  COALESCE(a.title,r.title) title,
  creator.public_id::text creator_public_id,creator.display_name creator_display_name,
  project.public_id::text project_public_id,project.name::text project_name,
  a.runtime_kind,a.runtime_public_id::text,
  a.workspace_path,a.workspace_title,a.workspace_position,a.state,
  (extract(epoch FROM a.archived_at)*1000)::bigint::text archived_at_ms,
  (extract(epoch FROM a.restored_at)*1000)::bigint::text restored_at_ms,
  (extract(epoch FROM a.trashed_at)*1000)::bigint::text trashed_at_ms,
  (extract(epoch FROM a.purge_after)*1000)::bigint::text purge_after_ms,
  a.sync_state,
  (SELECT COUNT(*) FROM harness.conversation_sessions child
    WHERE child.organization_id=a.organization_id AND child.root_session_id=a.root_session_id
      AND child.id<>a.root_session_id AND child.status<>'deleted')::text child_count,
  a.message_count::text message_count,
  (extract(epoch FROM COALESCE(r.updated_at,a.updated_at))*1000)::bigint::text updated_at_ms,
  a.record_kind`

/** PostgreSQL archive index and lifecycle service used by Admin and runtime sync. */
export class ConversationArchiveService {
  private runtimeReader?: ConversationArchiveRuntimeReader

  constructor(private readonly context: PostgresRuntimeContext, private readonly retentionDays = 30) {}

  /** Install the Gateway-owned callback used to hydrate personal transcript bodies. */
  setRuntimeReader(reader: ConversationArchiveRuntimeReader): void {
    this.runtimeReader = reader
  }

  /** List root archive rows with organization-scoped filters and bounded pagination. */
  async adminList(filter: ConversationArchiveAdminFilter = {}): Promise<readonly ConversationArchiveRow[]> {
    const clauses = ['a.organization_id=$1']
    const values: unknown[] = [this.context.organizationId]
    const add = (clause: string, value: unknown): void => {
      values.push(value)
      clauses.push(clause.replace('?', `$${String(values.length)}`))
    }
    if (filter.recordKind === undefined || filter.recordKind === 'conversation') {
      clauses.push("a.record_kind='conversation'")
    } else if (filter.recordKind !== 'all') {
      add('a.record_kind=?', filter.recordKind)
    }
    if (filter.state !== undefined && filter.state !== 'all') add('a.state=?', filter.state)
    if (filter.userId !== undefined) add('creator.public_id=?', filter.userId)
    if (filter.projectId !== undefined) add('project.public_id=?', filter.projectId)
    if (filter.fromMs !== undefined) add('a.archived_at >= to_timestamp(?/1000.0)', filter.fromMs)
    if (filter.toMs !== undefined) add('a.archived_at <= to_timestamp(?/1000.0)', filter.toMs)
    if (filter.recordKind !== 'empty-draft' && filter.state !== 'purged' && filter.state !== 'all') {
      clauses.push('(a.message_count > 0)')
    }
    if (filter.query !== undefined && filter.query.trim() !== '') {
      const needle = `%${filter.query.trim()}%`
      values.push(needle)
      const arg = `$${String(values.length)}`
      clauses.push(`(a.root_session_id ILIKE ${arg} OR COALESCE(a.title,r.title,'') ILIKE ${arg}
        OR EXISTS (SELECT 1 FROM harness.conversation_search cs
          JOIN harness.conversation_sessions csi ON csi.id=cs.session_id
          WHERE csi.organization_id=a.organization_id AND csi.root_session_id=a.root_session_id AND cs.content ILIKE ${arg})
        OR EXISTS (SELECT 1 FROM harness.conversation_archive_search cas
          WHERE cas.organization_id=a.organization_id AND cas.root_session_id=a.root_session_id AND cas.content ILIKE ${arg}))`)
    }
    const limit = boundedLimit(filter.limit)
    const offset = boundedOffset(filter.offset)
    values.push(limit)
    const limitArg = `$${String(values.length)}`
    values.push(offset)
    const offsetArg = `$${String(values.length)}`
    const result = await this.context.pool.query<ArchiveDbRow>(`SELECT ${ARCHIVE_COLUMNS}
      FROM harness.conversation_archive_records a
      LEFT JOIN harness.conversation_sessions r
        ON r.organization_id=a.organization_id AND r.id=a.root_session_id AND r.status<>'deleted'
      LEFT JOIN harness.users creator ON creator.organization_id=a.organization_id
        AND creator.id=COALESCE(a.creator_user_id,r.creator_user_id)
      LEFT JOIN harness.projects project ON project.organization_id=a.organization_id
        AND project.id=COALESCE(a.project_id,r.project_id)
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.archived_at DESC,a.root_session_id LIMIT ${limitArg} OFFSET ${offsetArg}`, values)
    return result.rows.map(archiveRow)
  }

  /** Inspect old roots that contain no visible content anywhere in their tree. */
  async previewEmptyDrafts(options: { olderThanMs?: number; limit?: number } = {}): Promise<EmptyDraftPreview> {
    const age = options.olderThanMs ?? DEFAULT_EMPTY_DRAFT_AGE_MS
    if (!Number.isSafeInteger(age) || age < 0) throw new Error('invalid empty-draft age')
    const cutoff = Date.now() - age
    const limit = boundedLimit(options.limit, 200)
    const result = await this.context.pool.query<EmptyDraftDbRow>(`SELECT r.id root_session_id,
      CASE WHEN r.project_id IS NULL THEN 'user' ELSE 'project' END runtime_kind,
      CASE WHEN r.project_id IS NULL THEN creator.public_id ELSE project.public_id END::text runtime_public_id,
      creator.public_id::text creator_public_id,creator.display_name creator_display_name,
      project.public_id::text project_public_id,project.name::text project_name,
      (extract(epoch FROM r.created_at)*1000)::bigint::text created_at_ms,
      (extract(epoch FROM r.updated_at)*1000)::bigint::text updated_at_ms,
      r.event_count::text event_count
      FROM harness.conversation_sessions r
      LEFT JOIN harness.users creator ON creator.organization_id=r.organization_id AND creator.id=r.creator_user_id
      LEFT JOIN harness.projects project ON project.organization_id=r.organization_id AND project.id=r.project_id
      WHERE r.organization_id=$1 AND r.root_session_id=r.id AND r.status<>'deleted'
        AND r.has_visible_content=false AND r.updated_at <= to_timestamp($2/1000.0)
        AND NOT EXISTS (
          SELECT 1 FROM harness.conversation_sessions child
          WHERE child.organization_id=r.organization_id AND child.root_session_id=r.root_session_id
            AND child.has_visible_content=true AND child.status<>'deleted'
        )
        AND NOT EXISTS (
          SELECT 1 FROM harness.conversation_draft_reservations d
          WHERE d.organization_id=r.organization_id AND d.session_id=r.id AND d.lease_expires_at > now()
        )
      ORDER BY r.updated_at,r.id LIMIT $3`, [this.context.organizationId, cutoff, limit])
    return {
      cutoff,
      candidates: result.rows.map(row => ({
        rootSessionId: row.root_session_id,
        runtime: { kind: row.runtime_kind, id: publicNumber(row.runtime_public_id, 'runtime') },
        creator: row.creator_public_id === null || row.creator_display_name === null
          ? null
          : { id: publicNumber(row.creator_public_id, 'creator'), displayName: row.creator_display_name },
        project: row.project_public_id === null || row.project_name === null
          ? null
          : { id: publicNumber(row.project_public_id, 'project'), name: row.project_name },
        createdAt: safeNumber(row.created_at_ms, 'created time')!,
        updatedAt: safeNumber(row.updated_at_ms, 'updated time')!,
        eventCount: safeNumber(row.event_count, 'event count')!,
      })),
    }
  }

  /** Move reviewed blank roots into the recoverable archive trash. */
  async trashEmptyDrafts(rootSessionIds: readonly string[], actorUserId: number): Promise<readonly string[]> {
    if (rootSessionIds.length === 0 || rootSessionIds.length > 200) throw new Error('invalid empty-draft batch')
    const actor = await this.internalUserId(this.context.pool, actorUserId)
    if (actor === null) throw new Error('archive actor not found')
    const trashed = await transaction(this.context.pool, async client => {
      const result: string[] = []
      for (const rootSessionId of rootSessionIds) {
        const row = await client.query<{
          id: string; project_id: string | null; creator_user_id: string
        }>(`SELECT r.id,r.project_id,r.creator_user_id
          FROM harness.conversation_sessions r
          WHERE r.organization_id=$1 AND r.id=$2 AND r.root_session_id=r.id AND r.status<>'deleted'
            AND r.has_visible_content=false
            AND NOT EXISTS (SELECT 1 FROM harness.conversation_sessions child
              WHERE child.organization_id=r.organization_id AND child.root_session_id=r.id
                AND child.has_visible_content=true AND child.status<>'deleted')
          FOR UPDATE`, [this.context.organizationId, rootSessionId])
        const current = row.rows[0]
        if (current === undefined) continue
        const existing = await client.query<{ state: ConversationArchiveState; sync_revision: string }>(`SELECT state,sync_revision::text
          FROM harness.conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2 FOR UPDATE`,
        [this.context.organizationId, rootSessionId])
        if (existing.rows[0]?.state === 'purged' || existing.rows[0]?.state === 'trash') continue
        const owner = await client.query<{
          runtime_public_id: string
        }>(`SELECT CASE WHEN r.project_id IS NULL THEN u.public_id ELSE p.public_id END::text runtime_public_id
          FROM harness.conversation_sessions r
          LEFT JOIN harness.users u ON u.organization_id=r.organization_id AND u.id=r.creator_user_id
          LEFT JOIN harness.projects p ON p.organization_id=r.organization_id AND p.id=r.project_id
          WHERE r.organization_id=$1 AND r.id=$2`, [this.context.organizationId, rootSessionId])
        const ownerRow = owner.rows[0]
        if (ownerRow === undefined) continue
        const nextRevision = Number(existing.rows[0]?.sync_revision ?? 0) + 1
        const purgeAfter = Date.now() + this.retentionDays * 86_400_000
        await client.query(`INSERT INTO harness.conversation_archive_records(
          organization_id,root_session_id,runtime_kind,runtime_public_id,project_id,creator_user_id,
          message_count,state,archived_by_user_id,trashed_at,trashed_by_user_id,purge_after,sync_revision,sync_state,record_kind,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,0,'trash',$7,now(),$7,to_timestamp($8/1000.0),$9,'synced','empty-draft',now())
          ON CONFLICT (organization_id,root_session_id) DO UPDATE SET state='trash',trashed_at=now(),
            purge_after=EXCLUDED.purge_after,trashed_by_user_id=$7,record_kind='empty-draft',sync_revision=$9,
            sync_state='synced',updated_at=now()`, [
          this.context.organizationId,
          rootSessionId,
          current.project_id === null ? 'user' : 'project',
          ownerRow.runtime_public_id,
          current.project_id,
          current.creator_user_id,
          actor,
          purgeAfter,
          nextRevision,
        ])
        await client.query(`INSERT INTO harness.conversation_archive_commands(
          organization_id,root_session_id,action,requested_by_user_id,desired_revision
        ) VALUES($1,$2,'trash',$3,$4)`, [this.context.organizationId, rootSessionId, actor, nextRevision])
        result.push(rootSessionId)
      }
      return result
    })
    return trashed
  }

  /** Load one root archive record and its first event page. */
  async detail(rootSessionId: string, fromSeq = 0, limit = 200): Promise<ConversationArchiveDetail | null> {
    return await this.detailPage(rootSessionId, fromSeq, limit, 200)
  }

  /** Load a larger bounded page for the administrator JSON export. */
  async exportDetail(rootSessionId: string): Promise<ConversationArchiveDetail | null> {
    return await this.detailPage(rootSessionId, 0, 100_000, 100_000)
  }

  private async detailPage(
    rootSessionId: string,
    fromSeq: number,
    limit: number,
    maximum: number,
  ): Promise<ConversationArchiveDetail | null> {
    const result = await this.context.pool.query<ArchiveDbRow>(`SELECT ${ARCHIVE_COLUMNS}
      FROM harness.conversation_archive_records a
      LEFT JOIN harness.conversation_sessions r
        ON r.organization_id=a.organization_id AND r.id=a.root_session_id AND r.status<>'deleted'
      LEFT JOIN harness.users creator ON creator.organization_id=a.organization_id
        AND creator.id=COALESCE(a.creator_user_id,r.creator_user_id)
      LEFT JOIN harness.projects project ON project.organization_id=a.organization_id
        AND project.id=COALESCE(a.project_id,r.project_id)
      WHERE a.organization_id=$1 AND a.root_session_id=$2`, [this.context.organizationId, rootSessionId])
    const row = result.rows[0]
    if (row === undefined) return null
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('invalid archive detail pagination')
    }
    const boundedFrom = Math.max(fromSeq, 0)
    const bounded = boundedLimit(limit, maximum)
    const descendants = await this.context.pool.query<{
      id: string; parent_session_id: string | null; title: string | null
    }>(`SELECT id,parent_session_id,title FROM harness.conversation_sessions
      WHERE organization_id=$1 AND root_session_id=$2 AND status<>'deleted'
      ORDER BY created_at,id`, [this.context.organizationId, rootSessionId])
    const events = await this.context.pool.query<{
      session_id: string; seq: string; event_type: string; occurred_at_ms: string; event: unknown
    }>(`SELECT e.session_id,e.seq::text,e.event_type,
      (extract(epoch FROM e.occurred_at)*1000)::bigint::text occurred_at_ms,e.event
      FROM harness.conversation_events e
      JOIN harness.conversation_sessions s ON s.id=e.session_id AND s.organization_id=$1
      WHERE s.root_session_id=$2 AND s.status<>'deleted' AND e.seq >= $3
      ORDER BY e.occurred_at,e.session_id,e.seq LIMIT $4`,
    [this.context.organizationId, rootSessionId, boundedFrom, bounded + 1])
    let projectedRecord = archiveRow(row)
    let projectedDescendants = descendants.rows.map(item => ({
        sessionId: item.id,
        parentSessionId: item.parent_session_id,
        title: item.title ?? '未命名会话',
      }))
    let projectedEvents = events.rows.slice(0, bounded).map(event => ({
        sessionId: event.session_id,
        seq: safeNumber(event.seq, 'event sequence')!,
        type: event.event_type,
        time: safeNumber(event.occurred_at_ms, 'event time')!,
        data: event.event,
      }))
    let projectedHasMore = events.rows.length > bounded
    if (row.runtime_kind === 'user' && row.state !== 'purged' && this.runtimeReader !== undefined) {
      try {
        const remote = await this.runtimeReader(
          { kind: row.runtime_kind, id: publicNumber(row.runtime_public_id, 'runtime') },
          rootSessionId,
          Math.max(fromSeq, 0),
          bounded,
        )
        if (remote !== undefined) {
          projectedRecord = remote.title === undefined ? projectedRecord : { ...projectedRecord, title: remote.title }
          projectedDescendants = [...remote.descendants]
          projectedEvents = [...remote.events]
          projectedHasMore = remote.hasMore
        }
      } catch (_error: unknown) {
        // The archive index remains readable while an offline personal runtime catches up.
        projectedRecord = { ...projectedRecord, syncState: 'unavailable' }
      }
    }
    return {
      record: projectedRecord,
      descendants: projectedDescendants,
      events: projectedEvents,
      hasMore: projectedHasMore,
    }
  }

  /** Create or refresh an archive row from a runtime snapshot. */
  async syncSnapshot(snapshot: ConversationArchiveSnapshot): Promise<void> {
    await transaction(this.context.pool, async client => {
      const creator = snapshot.creatorUserId === undefined
        ? null : await this.internalUserId(client, snapshot.creatorUserId)
      const project = snapshot.projectId === undefined
        ? null : await this.internalProjectId(client, snapshot.projectId)
      const prior = await client.query<{ state: ConversationArchiveState; sync_revision: string }>(`SELECT state,sync_revision::text
        FROM harness.conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2 FOR UPDATE`,
      [this.context.organizationId, snapshot.rootSessionId])
      if (prior.rows[0]?.state === 'purged') return
      await client.query(`INSERT INTO harness.conversation_archive_records(
        organization_id,root_session_id,runtime_kind,runtime_public_id,project_id,creator_user_id,title,
        workspace_path,workspace_title,workspace_position,message_count,archived_at,sync_revision,sync_state,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12/1000.0),$13,'synced',now())
      ON CONFLICT (organization_id,root_session_id) DO UPDATE SET
        runtime_kind=EXCLUDED.runtime_kind,runtime_public_id=EXCLUDED.runtime_public_id,
        project_id=COALESCE(EXCLUDED.project_id,conversation_archive_records.project_id),
        creator_user_id=COALESCE(EXCLUDED.creator_user_id,conversation_archive_records.creator_user_id),
        title=COALESCE(EXCLUDED.title,conversation_archive_records.title),
        workspace_path=EXCLUDED.workspace_path,
        workspace_title=EXCLUDED.workspace_title,
        workspace_position=EXCLUDED.workspace_position,
        message_count=GREATEST(conversation_archive_records.message_count,EXCLUDED.message_count),
        sync_revision=GREATEST(conversation_archive_records.sync_revision,EXCLUDED.sync_revision),
        sync_state='synced',last_sync_error=NULL,updated_at=now()
      WHERE EXCLUDED.sync_revision >= conversation_archive_records.sync_revision`, [
        this.context.organizationId, snapshot.rootSessionId, snapshot.runtime.kind, snapshot.runtime.id,
        project, creator, snapshot.title ?? null, snapshot.workspace?.path ?? null,
        snapshot.workspace?.title ?? null, snapshot.workspace?.position ?? null, snapshot.messageCount ?? 0,
        snapshot.archivedAt ?? Date.now(), snapshot.syncRevision,
      ])
      if (snapshot.search !== undefined) {
        for (const item of snapshot.search) {
          await client.query(`INSERT INTO harness.conversation_archive_search(
            organization_id,root_session_id,session_id,event_seq,role,content,occurred_at
          ) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0))
          ON CONFLICT (organization_id,session_id,event_seq) DO UPDATE SET
            root_session_id=EXCLUDED.root_session_id,role=EXCLUDED.role,content=EXCLUDED.content,occurred_at=EXCLUDED.occurred_at`, [
            this.context.organizationId, snapshot.rootSessionId, item.sessionId, item.seq,
            item.role, item.content, item.occurredAt,
          ])
        }
      }
    })
  }

  /** Persist one complete runtime snapshot and return commands awaiting acknowledgement. */
  async syncRuntimeSnapshot(snapshot: ConversationArchiveRuntimeSnapshot): Promise<readonly { id: string; rootSessionId: string; action: 'restore' | 'trash' | 'purge' }[]> {
    const bySession = new Map(snapshot.sessions.map(item => [item.sessionId, item]))
    const parents = new Map(snapshot.sessions.map(item => [
      item.sessionId, item.header.parentSession === undefined ? undefined : item.header.parentSession,
    ]))
    const rootFor = (sessionId: string): string => {
      const explicit = bySession.get(sessionId)?.rootSessionId
      if (explicit !== undefined && (explicit === sessionId || bySession.has(explicit))) return explicit
      const seen = new Set<string>()
      let current = sessionId
      while (true) {
        if (seen.has(current)) throw new Error(`session lineage cycle at '${current}'`)
        seen.add(current)
        const parent = parents.get(current)
        if (parent === undefined) return current
        current = parent
      }
    }
    const searchBySession = new Map<string, ArchiveSearchInput[]>()
    for (const item of snapshot.search ?? []) {
      const list = searchBySession.get(item.sessionId)
      if (list === undefined) searchBySession.set(item.sessionId, [item])
      else list.push(item)
    }
    const grouped = new Map<string, string[]>()
    for (const sessionId of snapshot.archivedSessionIds) {
      const rootSessionId = rootFor(sessionId)
      const group = grouped.get(rootSessionId)
      if (group === undefined) grouped.set(rootSessionId, [sessionId])
      else group.push(sessionId)
    }
    for (const [rootSessionId, sessionIds] of grouped) {
      const root = bySession.get(rootSessionId) ?? bySession.get(sessionIds[0] ?? rootSessionId)
      const workspace = root?.workspace ?? sessionIds.map(sessionId => bySession.get(sessionId)?.workspace)
        .find(value => value !== undefined)
      const search = sessionIds.flatMap(sessionId => searchBySession.get(sessionId) ?? [])
      const messageCount = sessionIds.reduce((total, sessionId) => {
        const item = bySession.get(sessionId)
        return total + (item?.messageCount ?? searchBySession.get(sessionId)?.length ?? 0)
      }, 0)
      await this.syncSnapshot({
        rootSessionId,
        runtime: snapshot.runtime,
        ...(snapshot.runtime.kind === 'project' ? { projectId: snapshot.runtime.id } : { creatorUserId: snapshot.runtime.id }),
        syncRevision: snapshot.revision,
        ...(root?.title === undefined ? {} : { title: root.title }),
        ...(workspace === undefined ? {} : { workspace }),
        messageCount,
        ...(search.length === 0 ? {} : { search }),
      })
    }
    const pending = await this.context.pool.query<{
      id: string; root_session_id: string; action: 'restore' | 'trash' | 'purge'
    }>(`SELECT c.id::text,c.root_session_id,c.action
      FROM harness.conversation_archive_commands c
      JOIN harness.conversation_archive_records a
        ON a.organization_id=c.organization_id AND a.root_session_id=c.root_session_id
      WHERE c.organization_id=$1 AND a.runtime_kind=$2 AND a.runtime_public_id=$3 AND c.status='pending'
      ORDER BY c.requested_at,c.id`, [this.context.organizationId, snapshot.runtime.kind, snapshot.runtime.id])
    return pending.rows.map(row => ({ id: row.id, rootSessionId: row.root_session_id, action: row.action }))
  }

  /** Mark a runtime command applied or failed and update the archive sync state. */
  async acknowledgeCommand(commandId: string, runtimeRevision: number, error?: string): Promise<void> {
    await transaction(this.context.pool, async client => {
      const status = error === undefined ? 'applied' : 'failed'
      const row = await client.query<{ root_session_id: string; desired_revision: string; status: string }>(`SELECT root_session_id,desired_revision::text,status
        FROM harness.conversation_archive_commands WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [this.context.organizationId, commandId])
      const command = row.rows[0]
      if (command === undefined) return
      if (command.status !== 'pending') return
      const desiredRevision = Number(command.desired_revision)
      if (!Number.isSafeInteger(runtimeRevision) || runtimeRevision < 0) throw new Error('invalid runtime archive revision')
      await client.query(`UPDATE harness.conversation_archive_commands
        SET status=$2,error=$3,applied_at=CASE WHEN $2='applied' THEN now() ELSE NULL END
        WHERE organization_id=$1 AND id=$4`, [this.context.organizationId, status, error ?? null, commandId])
      const root = command.root_session_id
      if (root === undefined) return
      await client.query(`UPDATE harness.conversation_archive_records SET sync_revision=GREATEST(sync_revision,$3),
        sync_state=$4,last_sync_error=$5,updated_at=now() WHERE organization_id=$1 AND root_session_id=$2`, [
        this.context.organizationId, root, Math.max(runtimeRevision, desiredRevision), error === undefined ? 'synced' : 'conflict', error ?? null,
      ])
    })
  }

  /** Move one archive row between archived and trash, recording a retryable command. */
  async setState(rootSessionId: string, state: Exclude<ConversationArchiveState, 'purged'>, actorUserId: number, idempotencyKey?: string): Promise<ConversationArchiveRow | null> {
    return await transaction(this.context.pool, async client => {
      const actor = await this.internalUserId(client, actorUserId)
      if (actor === null) throw new Error('archive actor not found')
      if (idempotencyKey !== undefined) {
        const prior = await client.query<{ root_session_id: string; action: 'restore' | 'trash' | 'purge' }>(`SELECT root_session_id,action
          FROM harness.conversation_archive_commands
          WHERE organization_id=$1 AND idempotency_key=$2`, [this.context.organizationId, idempotencyKey])
        if (prior.rows[0] !== undefined) {
          const requestedAction = state === 'archived' ? 'restore' : 'trash'
          if (prior.rows[0].action !== requestedAction || prior.rows[0].root_session_id !== rootSessionId) {
            throw new Error('archive-idempotency-key-reused')
          }
          return await this.detailForClient(client, prior.rows[0].root_session_id)
        }
      }
      const row = await client.query<{ state: ConversationArchiveState; runtime_kind: 'user' | 'project'; runtime_public_id: string; sync_revision: string }>(`SELECT state,runtime_kind,runtime_public_id::text,sync_revision::text
        FROM harness.conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2 FOR UPDATE`, [this.context.organizationId, rootSessionId])
      const current = row.rows[0]
      if (current === undefined) return null
      if (current.state === 'purged') throw new Error('archive-already-purged')
      const nextRevision = Number(current.sync_revision) + 1
      const now = new Date()
      if (state === 'archived') {
        await client.query(`UPDATE harness.conversation_archive_records SET state='archived',restored_at=now(),restored_by_user_id=$3,
          purge_after=NULL,sync_revision=$4,sync_state='pending',last_sync_error=NULL,updated_at=now()
          WHERE organization_id=$1 AND root_session_id=$2`, [this.context.organizationId, rootSessionId, actor, nextRevision])
      } else {
        const purgeAfter = new Date(now.getTime() + this.retentionDays * 86_400_000)
        await client.query(`UPDATE harness.conversation_archive_records SET state='trash',trashed_at=now(),trashed_by_user_id=$3,
          purge_after=$4,sync_revision=$5,sync_state='pending',last_sync_error=NULL,updated_at=now()
          WHERE organization_id=$1 AND root_session_id=$2`, [this.context.organizationId, rootSessionId, actor, purgeAfter, nextRevision])
      }
      await client.query(`INSERT INTO harness.conversation_archive_commands(
        organization_id,root_session_id,action,requested_by_user_id,desired_revision,idempotency_key
      ) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (organization_id,idempotency_key) DO NOTHING`, [
        this.context.organizationId, rootSessionId, state === 'archived' ? 'restore' : 'trash', actor, nextRevision,
        idempotencyKey ?? null,
      ])
      return await this.detailForClient(client, rootSessionId)
    })
  }

  /** Permanently purge one root tree from PostgreSQL and leave its tombstone. */
  async purge(rootSessionId: string, actorUserId?: number, idempotencyKey?: string): Promise<boolean> {
    const result = await transaction(this.context.pool, async client => {
      const actor = actorUserId === undefined ? null : await this.internalUserId(client, actorUserId)
      if (actorUserId !== undefined && actor === null) throw new Error('archive actor not found')
      if (idempotencyKey !== undefined) {
        const prior = await client.query<{ root_session_id: string; action: 'restore' | 'trash' | 'purge' }>(`SELECT root_session_id,action
          FROM harness.conversation_archive_commands
          WHERE organization_id=$1 AND idempotency_key=$2`, [this.context.organizationId, idempotencyKey])
        if (prior.rows[0] !== undefined) {
          if (prior.rows[0].action !== 'purge' || prior.rows[0].root_session_id !== rootSessionId) {
            throw new Error('archive-idempotency-key-reused')
          }
          return { found: true, paths: [] as string[] }
        }
      }
      const row = await client.query<{ state: ConversationArchiveState; sync_revision: string }>(`SELECT state,sync_revision::text
        FROM harness.conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2 FOR UPDATE`, [this.context.organizationId, rootSessionId])
      const current = row.rows[0]
      if (current === undefined) return { found: false, paths: [] as string[] }
      if (current.state === 'purged') return { found: true, paths: [] as string[] }
      const nextRevision = Number(current.sync_revision) + 1
      const files = await client.query<{ local_path: string }>(`SELECT DISTINCT f.local_path
        FROM harness.content_files f JOIN harness.conversation_sessions s
          ON s.id=f.session_id AND s.organization_id=f.organization_id
        WHERE f.organization_id=$1 AND s.root_session_id=$2`, [this.context.organizationId, rootSessionId])
      await client.query(`DELETE FROM harness.content_files WHERE organization_id=$1 AND session_id IN
        (SELECT id FROM harness.conversation_sessions WHERE organization_id=$1 AND root_session_id=$2)`, [this.context.organizationId, rootSessionId])
      await client.query(`DELETE FROM harness.conversation_events WHERE session_id IN
        (SELECT id FROM harness.conversation_sessions WHERE organization_id=$1 AND root_session_id=$2)`, [this.context.organizationId, rootSessionId])
      await client.query(`DELETE FROM harness.conversation_search WHERE session_id IN
        (SELECT id FROM harness.conversation_sessions WHERE organization_id=$1 AND root_session_id=$2)`, [this.context.organizationId, rootSessionId])
      await client.query(`DELETE FROM harness.conversation_sessions
        WHERE organization_id=$1 AND root_session_id=$2`, [this.context.organizationId, rootSessionId])
      await client.query(`DELETE FROM harness.conversation_archive_search WHERE organization_id=$1 AND root_session_id=$2`, [this.context.organizationId, rootSessionId])
      await client.query(`UPDATE harness.conversation_archive_records SET state='purged',purge_after=NULL,
        sync_revision=$3,sync_state='pending',updated_at=now() WHERE organization_id=$1 AND root_session_id=$2`, [this.context.organizationId, rootSessionId, nextRevision])
      await client.query(`INSERT INTO harness.conversation_archive_commands(
        organization_id,root_session_id,action,requested_by_user_id,desired_revision,idempotency_key
      ) VALUES($1,$2,'purge',$3,$4,$5) ON CONFLICT (organization_id,idempotency_key) DO NOTHING`, [
        this.context.organizationId, rootSessionId, actor, nextRevision, idempotencyKey ?? null,
      ])
      return { found: true, paths: files.rows.map(row => row.local_path) }
    })
    if (!result.found) return false
    for (const path of result.paths) {
      try {
        const file = await lstat(path)
        if (file.isFile() || file.isSymbolicLink()) await unlink(path)
      } catch (_error: unknown) {
        // The durable database purge is authoritative; an unavailable local file
        // is retained for the deployment's separate storage-reconciliation pass.
      }
    }
    return true
  }

  /** Purge trash records whose configured recovery window has elapsed. */
  async purgeDue(limit = 50): Promise<number> {
    const due = await this.context.pool.query<{ root_session_id: string }>(`SELECT root_session_id
      FROM harness.conversation_archive_records
      WHERE organization_id=$1 AND state='trash' AND purge_after IS NOT NULL AND purge_after <= now()
      ORDER BY purge_after,root_session_id LIMIT $2`, [this.context.organizationId, Math.min(Math.max(limit, 1), 200)])
    let purged = 0
    for (const row of due.rows) if (await this.purge(row.root_session_id)) purged++
    return purged
  }

  private async detailForClient(client: PoolClient, rootSessionId: string): Promise<ConversationArchiveRow> {
    const result = await client.query<ArchiveDbRow>(`SELECT ${ARCHIVE_COLUMNS}
      FROM harness.conversation_archive_records a
      LEFT JOIN harness.conversation_sessions r ON r.organization_id=a.organization_id AND r.id=a.root_session_id
      LEFT JOIN harness.users creator ON creator.organization_id=a.organization_id AND creator.id=COALESCE(a.creator_user_id,r.creator_user_id)
      LEFT JOIN harness.projects project ON project.organization_id=a.organization_id AND project.id=COALESCE(a.project_id,r.project_id)
      WHERE a.organization_id=$1 AND a.root_session_id=$2`, [this.context.organizationId, rootSessionId])
    const row = result.rows[0]
    if (row === undefined) throw new Error('archive record disappeared')
    return archiveRow(row)
  }

  private async internalUserId(client: Pool | PoolClient, publicId: number): Promise<string | null> {
    const result = await client.query<{ id: string }>(`SELECT id FROM harness.users
      WHERE organization_id=$1 AND public_id=$2 AND status='active' AND deleted_at IS NULL`, [this.context.organizationId, publicId])
    return result.rows[0]?.id ?? null
  }

  private async internalProjectId(client: Pool | PoolClient, publicId: number): Promise<string | null> {
    const result = await client.query<{ id: string }>(`SELECT id FROM harness.projects
      WHERE organization_id=$1 AND public_id=$2 AND status='active'`, [this.context.organizationId, publicId])
    return result.rows[0]?.id ?? null
  }
}
