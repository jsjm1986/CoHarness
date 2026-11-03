import type { ConversationSessionIdentity } from '../session-identity.ts'
import { escapeLiteral, type Pool, type PoolClient } from 'pg'
import type { RuntimeId, RuntimeNodeId } from '../runtime-catalog.ts'
import type { ConversationArchiveId } from '../archive-identity.ts'
import { lstat, realpath, unlink } from 'node:fs/promises'
import { dirname, parse } from 'node:path'
import { transaction } from './database.ts'
import { encodeSearchText, literalSearchParts } from './search-text.ts'
import { literalLikePattern } from './literal-like-pattern.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'
import { lockAdministrator } from './administrator-authority.ts'

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
  readonly runtime: ConversationArchiveRuntimeIdentity & { readonly runtimeId: RuntimeId }
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
const MAX_ARCHIVE_DETAIL_DESCENDANTS = 10_000
const MAX_ARCHIVE_DETAIL_EVENTS = 100_000
const MAX_ARCHIVE_DETAIL_EVENT_BYTES = 64 * 1024 * 1024

/** Stable refusal raised when an archive detail cannot fit the service budget. */
export class ConversationArchiveError extends Error {
  /** @param code - stable error code. @param status - HTTP status for admin callers. @param message - safe diagnostic. */
  constructor(readonly code: 'ARCHIVE_TOO_LARGE', readonly status: 413, message: string) {
    super(message)
    this.name = 'ConversationArchiveError'
  }
}

/** One root conversation row shown by the Admin archive channel. */
export interface ConversationArchiveRow {
  readonly archiveId: ConversationArchiveId
  readonly rootSessionId: string
  readonly title: string
  /** Shortest safe preview of the earliest user-visible message, when indexed. */
  readonly contentPreview: string | null
  readonly creator: { readonly id: number; readonly displayName: string } | null
  readonly project: { readonly id: number; readonly name: string } | null
  readonly runtime: ConversationArchiveRuntimeIdentity
  readonly workspace: { readonly path: string; readonly title: string; readonly position: number | null } | null
  readonly state: ConversationArchiveState
  readonly archivedAt: number
  readonly restoredAt: number | null
  readonly trashedAt: number | null
  readonly purgeAfter: number | null
  readonly syncState: 'pending' | 'synced' | 'conflict' | 'unavailable'
  /** The last runtime refusal; retained until an explicit replacement request. */
  readonly lastSyncError?: string
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
  readonly runtime: ConversationArchiveRuntimeIdentity
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

/** One bounded runtime archive projection batch received over the authenticated loopback API. */
export interface ConversationArchiveRuntimeSnapshot {
  readonly runtime: ConversationArchiveRuntimeIdentity
  readonly revision: number
  readonly archivedSessionIds: readonly string[]
  readonly sessions: readonly {
    sessionId: string
    rootSessionId?: string
    header: { createdAt?: number; cwd?: string; parentSession?: string; agentPreset?: string; draft?: boolean }
    title?: string
    messageCount?: number
    rootMessageCount?: number
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

/**
 * Carry the authenticated administrator through a personal Runtime start and transcript read.
 * @param runtime - exact owning Runtime and computer.
 * @param rootSessionId - archived conversation root.
 * @param fromSeq - first requested event sequence.
 * @param limit - bounded event count.
 * @param administratorUserId - authenticated administrator; omitted only by trusted internal readers.
 * @returns the owning Runtime page, or absence while its transcript is unavailable.
 */
export type ConversationArchiveRuntimeReader = (
  runtime: ConversationArchiveRuntimeIdentity,
  rootSessionId: string,
  fromSeq: number,
  limit: number,
  administratorUserId?: number,
) => Promise<ConversationArchiveRuntimeRead | undefined>

interface ArchiveSearchInput {
  readonly sessionId: string
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly occurredAt: number
}

const MAX_ARCHIVE_SEARCH_ROWS = 20_000
const MAX_ARCHIVE_SEARCH_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_SEARCH_CONTENT_BYTES = 64 * 1024
/** Fixed SQL batch size; five typed arrays stay well below PostgreSQL parameter limits. */
const ARCHIVE_SEARCH_BATCH_SIZE = 1_000
const ARCHIVE_COMMAND_BATCH_SIZE = 1_000
const ARCHIVE_FILE_CLEANUP_BATCH_SIZE = 200
const ARCHIVE_FILE_CLEANUP_LEASE_MS = 5 * 60 * 1_000
const ARCHIVE_FILE_CLEANUP_INITIAL_BACKOFF_MS = 5 * 1_000
const ARCHIVE_FILE_CLEANUP_MAX_BACKOFF_MS = 60 * 60 * 1_000

/** Validate and deduplicate runtime search rows before they enter a transaction. */
function normalizeArchiveSearch(search: readonly ArchiveSearchInput[] | undefined): readonly ArchiveSearchInput[] {
  if (search === undefined) return []
  if (search.length > MAX_ARCHIVE_SEARCH_ROWS) {
    throw new ConversationArchiveError('ARCHIVE_TOO_LARGE', 413, 'archive search exceeds the row limit')
  }
  let totalBytes = 0
  const unique = new Map<string, ArchiveSearchInput>()
  for (const item of search) {
    if (item.sessionId.length === 0 || item.sessionId.length > 512
      || !Number.isSafeInteger(item.seq) || item.seq < 0
      || (item.role !== 'user' && item.role !== 'assistant')
      || !Number.isSafeInteger(item.occurredAt) || item.occurredAt < 0) {
      throw new Error('invalid archive search row')
    }
    const contentBytes = Buffer.byteLength(item.content, 'utf8')
    if (contentBytes > MAX_ARCHIVE_SEARCH_CONTENT_BYTES) {
      throw new ConversationArchiveError('ARCHIVE_TOO_LARGE', 413, 'archive search row exceeds the content limit')
    }
    totalBytes += contentBytes
    if (totalBytes > MAX_ARCHIVE_SEARCH_TOTAL_BYTES) {
      throw new ConversationArchiveError('ARCHIVE_TOO_LARGE', 413, 'archive search exceeds the byte limit')
    }
    // Runtime retries can repeat a session/seq row. Preserve the previous
    // loop's last-write-wins behavior without triggering a PostgreSQL
    // cardinality violation inside one multi-row INSERT.
    unique.set(JSON.stringify([item.sessionId, item.seq]), item)
  }
  return [...unique.values()]
}

/** Public runtime identity supplied by an authenticated runtime caller. */
export interface ConversationArchiveRuntimeIdentity {
  readonly runtimeId?: RuntimeId
  readonly nodeId?: RuntimeNodeId
  readonly kind: 'user' | 'project'
  readonly id: number
}

/** Outcome of one safe filesystem cleanup attempt. */
type ContentFileCleanupResult =
  | { readonly status: 'deleted' | 'missing' | 'retained' }
  | { readonly status: 'deferred'; readonly error: string }

/**
 * Remove one database-recorded content file without traversing a replaced
 * parent symlink. Content paths are legacy records, so the database service
 * cannot assume a single configured root; rejecting a non-canonical parent is
 * safer than attempting a recursive cleanup through an untrusted path.
 */
async function unlinkContentFile(path: string): Promise<ContentFileCleanupResult> {
  // Walk every ancestor, not only the immediate parent. A replaced grandparent
  // can otherwise redirect an apparently ordinary child path outside the
  // originally recorded tree. Refuse cleanup when any component is link-shaped
  // or cannot be inspected; the durable archive purge remains authoritative and
  // a later reconciler can retry the skipped file safely.
  let parent = dirname(path)
  const root = parse(parent).root
  while (parent !== root) {
    let parentEntry
    try {
      parentEntry = await lstat(parent)
    } catch (error: unknown) {
      return isMissingPathError(error)
        ? { status: 'missing' }
        : { status: 'deferred', error: errorMessage(error) }
    }
    if (parentEntry.isSymbolicLink()) {
      // macOS exposes /var (and sometimes /tmp) as a root-level alias into
      // /private. Those OS-owned aliases are not an archive-controlled
      // component; permit only the exact /private/<alias> mapping and keep
      // rejecting links below it.
      const canonical = await realpath(parent).catch(() => undefined)
      const rootAlias = parent.startsWith('/') && !parent.slice(1).includes('/')
        && canonical === `/private${parent}`
      if (!rootAlias) return { status: 'deferred', error: 'refused a symbolic-link parent' }
    } else if (!parentEntry.isDirectory()) {
      return { status: 'deferred', error: 'parent is not a directory' }
    }
    parent = dirname(parent)
  }
  let parentEntry
  try {
    parentEntry = await lstat(root)
  } catch (error: unknown) {
    return isMissingPathError(error)
      ? { status: 'missing' }
      : { status: 'deferred', error: errorMessage(error) }
  }
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
    return { status: 'deferred', error: 'filesystem root is not a real directory' }
  }
  let file
  try {
    file = await lstat(path)
  } catch (error: unknown) {
    return isMissingPathError(error)
      ? { status: 'missing' }
      : { status: 'deferred', error: errorMessage(error) }
  }
  if (!file.isFile() && !file.isSymbolicLink()) {
    return { status: 'deferred', error: 'refused to remove a non-file path' }
  }
  try {
    await unlink(path)
    return { status: 'deleted' }
  } catch (error: unknown) {
    return isMissingPathError(error)
      ? { status: 'missing' }
      : { status: 'deferred', error: errorMessage(error) }
  }
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ArchiveDbRow {
  archive_id: ConversationArchiveId
  root_session_id: string
  title: string | null
  creator_public_id: string | null
  creator_display_name: string | null
  project_public_id: string | null
  project_name: string | null
  runtime_kind: 'user' | 'project'
  runtime_public_id: string
  runtime_id: RuntimeId | null
  node_id: RuntimeNodeId | null
  workspace_path: string | null
  workspace_title: string | null
  workspace_position: number | null
  state: ConversationArchiveState
  archived_at_ms: string
  restored_at_ms: string | null
  trashed_at_ms: string | null
  purge_after_ms: string | null
  sync_state: 'pending' | 'synced' | 'conflict' | 'unavailable'
  last_sync_error: string | null
  child_count: string
  message_count: string
  updated_at_ms: string
  content_preview?: string | null
  record_kind: 'conversation' | 'empty-draft'
}

interface ArchiveFileCleanupDbRow {
  id: string
  archive_id: ConversationArchiveId
  local_path: string
  attempts: number
}

interface EmptyDraftDbRow {
  root_session_id: string
  runtime_kind: 'user' | 'project'
  runtime_public_id: string
  runtime_id: RuntimeId
  node_id: RuntimeNodeId
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

function nextArchiveRevision(value: string | number, label: string): number {
  const current = safeNumber(value, label) as number
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exhausted the non-negative safe-integer range`)
  }
  return current + 1
}

function boundedLimit(value: number | undefined, maximum = 200): number {
  return Math.min(Math.max(value ?? 50, 1), maximum)
}

function boundedOffset(value: number | undefined): number {
  return Math.min(Math.max(value ?? 0, 0), Number.MAX_SAFE_INTEGER)
}

/** Reject a runtime read that exceeds the same work budget as the SQL fallback. */
function assertRuntimeReadBudget(
  value: ConversationArchiveRuntimeRead,
  limit: number,
): void {
  if (value.descendants.length > MAX_ARCHIVE_DETAIL_DESCENDANTS
    || value.events.length > limit) {
    throw new ConversationArchiveError('ARCHIVE_TOO_LARGE', 413, 'runtime archive detail exceeds the response budget')
  }
  let encoded: string | undefined
  try { encoded = JSON.stringify(value) } catch { encoded = undefined }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_ARCHIVE_DETAIL_EVENT_BYTES) {
    throw new ConversationArchiveError('ARCHIVE_TOO_LARGE', 413, 'runtime archive detail exceeds the event byte limit')
  }
}

function archiveRow(row: ArchiveDbRow): ConversationArchiveRow {
  return {
    archiveId: row.archive_id,
    rootSessionId: row.root_session_id,
    title: row.title ?? '未命名对话',
    contentPreview: row.content_preview?.replace(/[\r\n]+/g, ' ') ?? null,
    creator: row.creator_public_id === null || row.creator_display_name === null
      ? null
      : { id: publicNumber(row.creator_public_id, 'creator'), displayName: row.creator_display_name },
    project: row.project_public_id === null || row.project_name === null
      ? null
      : { id: publicNumber(row.project_public_id, 'project'), name: row.project_name },
    runtime: { kind: row.runtime_kind, id: publicNumber(row.runtime_public_id, 'runtime'),
      ...(row.runtime_id === null ? {} : { runtimeId: row.runtime_id }), ...(row.node_id === null ? {} : { nodeId: row.node_id }) },
    workspace: row.workspace_path === null || row.workspace_title === null
      ? null
      : { path: row.workspace_path, title: row.workspace_title, position: row.workspace_position },
    state: row.state,
    archivedAt: safeNumber(row.archived_at_ms, 'archived time')!,
    restoredAt: safeNumber(row.restored_at_ms, 'restored time', true),
    trashedAt: safeNumber(row.trashed_at_ms, 'trashed time', true),
    purgeAfter: safeNumber(row.purge_after_ms, 'purge time', true),
    syncState: row.sync_state,
    ...row.last_sync_error === null ? {} : { lastSyncError: row.last_sync_error },
    childCount: safeNumber(row.child_count, 'child count')!,
    messageCount: safeNumber(row.message_count, 'message count')!,
    updatedAt: safeNumber(row.updated_at_ms, 'updated time')!,
    ...(row.record_kind === 'empty-draft' ? { recordKind: 'empty-draft' as const } : {}),
  }
}

/** Legacy unassigned rows require their recorded owner before they can read or delete Session data. */
function archiveSessionSql(session: string, archive = 'a'): string {
  return `${session}.organization_id=${archive}.organization_id AND ${session}.root_session_id=${archive}.root_session_id
    AND ${session}.runtime_id IS NOT DISTINCT FROM ${archive}.runtime_id
    AND (${archive}.runtime_id IS NOT NULL
      OR (${archive}.runtime_kind='project' AND ${archive}.project_id IS NOT NULL AND ${session}.project_id=${archive}.project_id)
      OR (${archive}.runtime_kind='user' AND ${archive}.creator_user_id IS NOT NULL
        AND ${session}.project_id IS NULL AND ${session}.creator_user_id=${archive}.creator_user_id))`
}

/** Maintenance excludes archived roots and preserves a restoration for the full inactivity window. */
function activeDraftArchiveSql(root: string, cutoff: string): string {
  return `NOT EXISTS(SELECT 1 FROM harness.conversation_archive_records lifecycle
    WHERE lifecycle.organization_id=${root}.organization_id AND lifecycle.root_session_id=${root}.id
      AND lifecycle.runtime_id IS NOT DISTINCT FROM ${root}.runtime_id
      AND (lifecycle.state<>'archived' OR lifecycle.restored_at IS NULL
        OR lifecycle.restored_at>to_timestamp(${cutoff}/1000.0)))`
}

const ARCHIVE_COLUMNS = `a.archive_id,a.root_session_id,
  harness.human_session_title(COALESCE(a.title,r.title)) title,
  COALESCE(
    (SELECT harness.conversation_search_text(cs.content,cs.content_nul_parts,160)
      FROM harness.conversation_search cs
      JOIN harness.conversation_sessions csi ON csi.organization_id=cs.organization_id AND csi.runtime_namespace=cs.runtime_namespace AND csi.id=cs.session_id
      WHERE ${archiveSessionSql('csi')}
        AND cs.role='user' AND harness.human_session_title(cs.content) IS NOT NULL
      ORDER BY cs.occurred_at,cs.event_seq LIMIT 1),
    (SELECT harness.conversation_search_text(cas.content,cas.content_nul_parts,160)
      FROM harness.conversation_archive_search cas
      WHERE cas.organization_id=a.organization_id AND cas.archive_id=a.archive_id
        AND cas.role='user' AND harness.human_session_title(cas.content) IS NOT NULL
      ORDER BY cas.occurred_at,cas.event_seq LIMIT 1)
  ) content_preview,
  creator.public_id::text creator_public_id,creator.display_name creator_display_name,
  project.public_id::text project_public_id,project.name::text project_name,
  a.runtime_kind,a.runtime_public_id::text,a.runtime_id,a.node_id,
  a.workspace_path,a.workspace_title,a.workspace_position,a.state,
  (extract(epoch FROM a.archived_at)*1000)::bigint::text archived_at_ms,
  (extract(epoch FROM a.restored_at)*1000)::bigint::text restored_at_ms,
  (extract(epoch FROM a.trashed_at)*1000)::bigint::text trashed_at_ms,
  (extract(epoch FROM a.purge_after)*1000)::bigint::text purge_after_ms,
  a.sync_state,a.last_sync_error,
  (SELECT COUNT(*) FROM harness.conversation_sessions child
    WHERE ${archiveSessionSql('child')}
      AND child.id<>a.root_session_id AND child.status<>'deleted')::text child_count,
  a.message_count::text message_count,
  (extract(epoch FROM COALESCE(r.updated_at,a.updated_at))*1000)::bigint::text updated_at_ms,
  a.record_kind`

/** PostgreSQL archive index and lifecycle service used by Admin and runtime sync. */
export class ConversationArchiveService {
  private runtimeReader?: ConversationArchiveRuntimeReader
  private readonly nodeSql: string

  constructor(private readonly context: PostgresRuntimeContext, private readonly retentionDays = 30) {
    this.nodeSql = `${escapeLiteral(context.nodeId)}::uuid`
  }

  private nodeRows(table: 'conversation_archive_records' | 'conversation_archive_file_cleanup'): string {
    return `(SELECT * FROM harness.${table} WHERE node_id=${this.nodeSql})`
  }

  private async administratorRead<T>(actorUserId: number | undefined, read: (database: Pool | PoolClient) => Promise<T>): Promise<T> {
    if (actorUserId === undefined) return read(this.context.pool)
    return transaction(this.context.pool, async client => {
      await lockAdministrator(client, this.context, actorUserId)
      return read(client)
    })
  }

  private async runtimeIdentity(database: Pool | PoolClient, runtime: ConversationArchiveRuntimeIdentity): Promise<RuntimeId | undefined> {
    const result = await database.query<{ runtime_id: RuntimeId }>(`SELECT i.runtime_id FROM harness.instances i
      LEFT JOIN harness.users account ON account.organization_id=i.organization_id AND account.id=i.user_id
      LEFT JOIN harness.projects project ON project.organization_id=i.organization_id AND project.id=i.project_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END=$3
        AND COALESCE(account.public_id,project.public_id)=$4 AND ($5::uuid IS NULL OR i.runtime_id=$5) LIMIT 2`,
    [this.context.organizationId, this.context.nodeId, runtime.kind, runtime.id, runtime.runtimeId ?? null])
    if (result.rows.length > 1) throw new Error('archive operation requires an exact local Runtime assignment')
    return result.rows[0]?.runtime_id
  }

  /** Install the Gateway-owned callback used to hydrate personal transcript bodies. */
  setRuntimeReader(reader: ConversationArchiveRuntimeReader): void {
    this.runtimeReader = reader
  }

  /** Queue one archive tree's filesystem paths inside its purge transaction. */
  private async enqueueFileCleanup(
    client: PoolClient,
    archiveId: ConversationArchiveId,
    paths: readonly string[],
  ): Promise<void> {
    const unique = [...new Set(paths)]
    if (unique.length === 0) return
    if (unique.some(path => path.length === 0 || path.length > 4_096)) {
      throw new Error('archive content path is outside the cleanup path limit')
    }
    await client.query(`INSERT INTO harness.conversation_archive_file_cleanup(node_id,
        organization_id,archive_id,local_path
      ) SELECT ${this.nodeSql},$1,$2,path FROM unnest($3::text[]) AS path
      ON CONFLICT (organization_id,archive_id,local_path) DO NOTHING`, [
      this.context.organizationId, archiveId, unique,
    ])
  }

  /** Claim a bounded cleanup page with a lease so another Gateway cannot race it. */
  private async claimFileCleanupRows(
    archiveId: ConversationArchiveId | undefined,
    limit = ARCHIVE_FILE_CLEANUP_BATCH_SIZE,
  ): Promise<ArchiveFileCleanupDbRow[]> {
    const pageLimit = Math.min(Math.max(limit, 1), ARCHIVE_FILE_CLEANUP_BATCH_SIZE)
    return await transaction(this.context.pool, async client => {
      const values: unknown[] = [this.context.organizationId]
      const rootClause = archiveId === undefined ? '' : ' AND archive_id=$2'
      if (archiveId !== undefined) values.push(archiveId)
      values.push(pageLimit)
      const limitArg = `$${String(values.length)}`
      const rows = await client.query<ArchiveFileCleanupDbRow>(`SELECT id::text,archive_id,local_path,attempts
        FROM ${this.nodeRows('conversation_archive_file_cleanup')} conversation_archive_file_cleanup
        WHERE organization_id=$1${rootClause}
          AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now())
        ORDER BY next_attempt_at,created_at,id
        LIMIT ${limitArg} FOR UPDATE SKIP LOCKED`, values)
      if (rows.rows.length === 0) return []
      const ids = rows.rows.map(row => row.id)
      await client.query(`UPDATE harness.conversation_archive_file_cleanup
        SET attempts=attempts+1,lease_until=now()+($2::bigint*interval '1 millisecond')
        WHERE node_id=${this.nodeSql} AND organization_id=$1 AND id=ANY($3::uuid[])`, [
        this.context.organizationId, ARCHIVE_FILE_CLEANUP_LEASE_MS, ids,
      ])
      return rows.rows
    })
  }

  /** Read remaining database references for a cleanup page in one indexed query. */
  private async referencedContentPaths(paths: readonly string[]): Promise<Set<string> | undefined> {
    if (paths.length === 0) return new Set()
    try {
      const references = await this.context.pool.query<{ local_path: string }>(`SELECT file.local_path
        FROM harness.content_files file JOIN harness.conversation_sessions session ON session.id=file.session_id AND session.organization_id=file.organization_id AND session.runtime_namespace=file.runtime_namespace
        LEFT JOIN harness.runtime_environments runtime ON runtime.organization_id=session.organization_id AND runtime.id=session.runtime_id
        WHERE file.organization_id=$1 AND file.local_path=ANY($2::text[]) AND (runtime.node_id=$3 OR session.runtime_id IS NULL)`,
      [this.context.organizationId, paths, this.context.nodeId])
      return new Set(references.rows.map(row => row.local_path))
    } catch {
      return undefined
    }
  }

  /** Check one path's remaining database references before unlinking it. */
  private async cleanupFilePath(
    path: string,
    references?: ReadonlySet<string>,
  ): Promise<ContentFileCleanupResult> {
    const knownReferences = references ?? await this.referencedContentPaths([path])
    if (knownReferences === undefined) {
      return { status: 'deferred', error: 'content reference check failed' }
    }
    if (knownReferences.has(path)) return { status: 'retained' }
    return await unlinkContentFile(path)
  }

  /** Complete or reschedule a claimed task within its organization and computer. */
  private async finishFileCleanup(
    row: ArchiveFileCleanupDbRow,
    outcome: ContentFileCleanupResult,
  ): Promise<void> {
    if (outcome.status !== 'deferred') {
      await this.context.pool.query(`DELETE FROM harness.conversation_archive_file_cleanup
        WHERE node_id=${this.nodeSql} AND organization_id=$1 AND id=$2`, [this.context.organizationId, row.id])
      return
    }
    const attempts = Math.min(row.attempts + 1, 30)
    const backoff = Math.min(
      ARCHIVE_FILE_CLEANUP_MAX_BACKOFF_MS,
      ARCHIVE_FILE_CLEANUP_INITIAL_BACKOFF_MS * 2 ** Math.min(attempts - 1, 16),
    )
    await this.context.pool.query(`UPDATE harness.conversation_archive_file_cleanup
      SET lease_until=NULL,last_error=$3,
          next_attempt_at=now()+($4::bigint*interval '1 millisecond')
      WHERE node_id=${this.nodeSql} AND organization_id=$1 AND id=$2`, [
      this.context.organizationId, row.id, outcome.error.slice(0, 2_048), backoff,
    ])
  }

  /** Process a claimed page serially, limiting filesystem and database pressure. */
  private async processFileCleanupRows(rows: readonly ArchiveFileCleanupDbRow[]): Promise<number> {
    const references = await this.referencedContentPaths([...new Set(rows.map(row => row.local_path))])
    let completed = 0
    for (const row of rows) {
      const outcome = references === undefined
        ? { status: 'deferred' as const, error: 'content reference check failed' }
        : await this.cleanupFilePath(row.local_path, references)
      await this.finishFileCleanup(row, outcome)
      if (outcome.status !== 'deferred') completed += 1
    }
    return completed
  }

  /** Retry due archive-file cleanup tasks left by a prior purge or failed worker. */
  async cleanupDue(limit = ARCHIVE_FILE_CLEANUP_BATCH_SIZE): Promise<number> {
    const rows = await this.claimFileCleanupRows(undefined, limit)
    return await this.processFileCleanupRows(rows)
  }

  /**
   * List bounded archive metadata, retaining current administrator qualification through the database read.
   * @param filter - organization-scoped archive filters and pagination.
   * @param actorUserId - authenticated administrator; omission permits trusted internal reads.
   * @returns matching roots on this computer.
   */
  async adminList(filter: ConversationArchiveAdminFilter = {}, actorUserId?: number): Promise<readonly ConversationArchiveRow[]> {
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
      // Maintenance rows carry no message count by construction; hiding them
      // would make a trashed empty draft unreachable from every archive view.
      clauses.push("(a.message_count > 0 OR a.record_kind='empty-draft')")
    }
    if (filter.query !== undefined && filter.query.trim() !== '') {
      const query = filter.query.trim()
      values.push(literalLikePattern(encodeSearchText(query).text))
      const arg = `$${String(values.length)}`
      values.push(literalSearchParts(query))
      const parts = `$${String(values.length)}::text[]`
      const title = query.includes('\u0000') ? '' : `a.root_session_id ILIKE ${arg} OR COALESCE(harness.human_session_title(COALESCE(a.title,r.title)),'') ILIKE ${arg} OR `
      clauses.push(`(${title}EXISTS (SELECT 1 FROM harness.conversation_search cs
          JOIN harness.conversation_sessions csi ON csi.organization_id=cs.organization_id AND csi.runtime_namespace=cs.runtime_namespace AND csi.id=cs.session_id
          WHERE ${archiveSessionSql('csi')} AND cs.content ILIKE ${arg}
            AND harness.conversation_search_literal(cs.content,cs.content_nul_parts,${parts}))
        OR EXISTS (SELECT 1 FROM harness.conversation_archive_search cas
          WHERE cas.organization_id=a.organization_id AND cas.archive_id=a.archive_id AND cas.content ILIKE ${arg}
            AND harness.conversation_search_literal(cas.content,cas.content_nul_parts,${parts})))`)
    }
    const limit = boundedLimit(filter.limit)
    const offset = boundedOffset(filter.offset)
    values.push(limit)
    const limitArg = `$${String(values.length)}`
    values.push(offset)
    const offsetArg = `$${String(values.length)}`
    const result = await this.administratorRead(actorUserId, database => database.query<ArchiveDbRow>(`SELECT ${ARCHIVE_COLUMNS}
      FROM ${this.nodeRows('conversation_archive_records')} a
      LEFT JOIN harness.conversation_sessions r
        ON ${archiveSessionSql('r')} AND r.id=a.root_session_id AND r.status<>'deleted'
      LEFT JOIN harness.users creator ON creator.organization_id=a.organization_id
        AND creator.id=COALESCE(a.creator_user_id,r.creator_user_id)
      LEFT JOIN harness.projects project ON project.organization_id=a.organization_id
        AND project.id=COALESCE(a.project_id,r.project_id)
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.archived_at DESC,a.archive_id LIMIT ${limitArg} OFFSET ${offsetArg}`, values))
    return result.rows.map(archiveRow)
  }

  /**
   * Inspect blank roots under current administrator qualification.
   * @param options - minimum age and bounded result count.
   * @param actorUserId - authenticated administrator; omission permits trusted internal reads.
   * @returns evaluated cutoff and eligible roots on this computer.
   */
  async previewEmptyDrafts(options: { olderThanMs?: number; limit?: number } = {}, actorUserId?: number): Promise<EmptyDraftPreview> {
    return this.administratorRead(actorUserId, async database => {
      const age = options.olderThanMs ?? DEFAULT_EMPTY_DRAFT_AGE_MS
      if (!Number.isSafeInteger(age) || age < 0) throw new Error('invalid empty-draft age')
      const cutoff = Math.max(0, Date.now() - age)
      if (cutoff === 0) return { cutoff, candidates: [] }
      const limit = boundedLimit(options.limit, 200)
      const result = await database.query<EmptyDraftDbRow>(`SELECT r.id root_session_id,r.runtime_id,${this.nodeSql} node_id,
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
          AND EXISTS(SELECT 1 FROM harness.runtime_environments runtime WHERE runtime.id=r.runtime_id AND runtime.organization_id=r.organization_id AND runtime.node_id=${this.nodeSql})
          AND r.has_visible_content=false AND r.updated_at <= to_timestamp($2/1000.0)
          AND ${activeDraftArchiveSql('r', '$2')}
          AND NOT EXISTS (
            SELECT 1 FROM harness.conversation_sessions child
            WHERE child.organization_id=r.organization_id AND child.runtime_namespace=r.runtime_namespace AND child.root_session_id=r.root_session_id
              AND child.status<>'deleted'
              AND (child.has_visible_content=true OR child.updated_at>to_timestamp($2/1000.0))
          )
          AND NOT EXISTS (
            SELECT 1 FROM harness.conversation_draft_reservations d
            LEFT JOIN harness.conversation_sessions leased
              ON leased.organization_id=d.organization_id AND leased.id=d.session_id
                AND (d.runtime_id IS NULL OR leased.runtime_namespace=d.runtime_namespace)
            WHERE d.organization_id=r.organization_id AND (d.runtime_id IS NULL OR d.runtime_namespace=r.runtime_namespace) AND d.lease_expires_at>now()
              AND (d.session_id=r.id OR (leased.root_session_id=r.id AND leased.status<>'deleted'))
          )
        ORDER BY r.updated_at,r.id LIMIT $3`, [this.context.organizationId, cutoff, limit])
      return {
        cutoff,
        candidates: result.rows.map(row => ({
          rootSessionId: row.root_session_id,
          runtime: { kind: row.runtime_kind, id: publicNumber(row.runtime_public_id, 'runtime'),
        runtimeId: row.runtime_id, nodeId: row.node_id },
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
    })
  }

  /**
   * Move reviewed blank roots into recoverable trash, retaining current administrator authority until commit.
   * @param sessions - reviewed Host roots with their exact Runtime UUIDs on the owning computer.
   * @param actorUserId - authenticated administrator's public identity.
   * @param cutoff - preview cutoff in milliseconds; defaults to the standard draft age.
   * @returns roots that still qualify and were moved to trash.
   */
  async trashEmptyDrafts(sessions: readonly ConversationSessionIdentity[], actorUserId: number, cutoff?: number): Promise<readonly ConversationSessionIdentity[]> {
    if (sessions.length === 0 || sessions.length > 200) throw new Error('invalid empty-draft batch')
    const resolvedCutoff = cutoff ?? Math.max(0, Date.now() - DEFAULT_EMPTY_DRAFT_AGE_MS)
    if (!Number.isSafeInteger(resolvedCutoff) || resolvedCutoff < 0 || resolvedCutoff > Date.now()) {
      throw new Error('invalid empty-draft cutoff')
    }
    const trashed = await transaction(this.context.pool, async client => {
      await lockAdministrator(client, this.context, actorUserId)
      const actor = await this.internalUserId(client, actorUserId)
      if (actor === null) throw new Error('archive actor not found')
      const result: ConversationSessionIdentity[] = []
      for (const { rootSessionId, runtimeId } of sessions) {
        const locked = await client.query<{
          id: string; project_id: string | null; creator_user_id: string; runtime_id: RuntimeId
        }>(`SELECT r.id,r.project_id,r.creator_user_id,r.runtime_id
          FROM harness.conversation_sessions r
          WHERE r.organization_id=$1 AND r.id=$2 AND r.runtime_id=$3 AND r.root_session_id=r.id
            AND EXISTS(SELECT 1 FROM harness.runtime_environments runtime WHERE runtime.id=r.runtime_id AND runtime.organization_id=r.organization_id AND runtime.node_id=${this.nodeSql})
          FOR UPDATE`, [this.context.organizationId, rootSessionId, runtimeId])
        const current = locked.rows[0]
        if (current === undefined) continue
        // Re-check eligibility after acquiring the root lock: this statement's
        // snapshot sees reservations, content, and updates committed while the
        // lock was held by a reservation or append transaction.
        const eligible = await client.query(`SELECT r.id
          FROM harness.conversation_sessions r
          WHERE r.organization_id=$1 AND r.id=$2 AND r.runtime_id=$4 AND r.status<>'deleted'
            AND r.has_visible_content=false
            AND r.updated_at <= to_timestamp($3/1000.0)
            AND ${activeDraftArchiveSql('r', '$3')}
            AND NOT EXISTS (SELECT 1 FROM harness.conversation_sessions child
              WHERE child.organization_id=r.organization_id AND child.runtime_namespace=r.runtime_namespace AND child.root_session_id=r.id
                AND child.status<>'deleted'
                AND (child.has_visible_content=true OR child.updated_at>to_timestamp($3/1000.0)))
            AND NOT EXISTS (
              SELECT 1 FROM harness.conversation_draft_reservations d
              LEFT JOIN harness.conversation_sessions leased
                ON leased.organization_id=d.organization_id AND leased.id=d.session_id
                AND (d.runtime_id IS NULL OR leased.runtime_namespace=d.runtime_namespace)
              WHERE d.organization_id=r.organization_id AND (d.runtime_id IS NULL OR d.runtime_namespace=r.runtime_namespace) AND d.lease_expires_at>now()
                AND (d.session_id=r.id OR (leased.root_session_id=r.id AND leased.status<>'deleted'))
            )`, [this.context.organizationId, rootSessionId, resolvedCutoff, runtimeId])
        if (eligible.rows[0] === undefined) continue
        const existing = await client.query<{ state: ConversationArchiveState; sync_revision: string; restored_at: Date | null }>(`SELECT state,sync_revision::text,restored_at
          FROM ${this.nodeRows('conversation_archive_records')} conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2 AND runtime_id=$3 FOR UPDATE`,
        [this.context.organizationId, rootSessionId, current.runtime_id])
        const prior = existing.rows[0]
        if (prior !== undefined && (prior.state !== 'archived' || prior.restored_at === null
          || prior.restored_at.getTime() > resolvedCutoff)) continue
        const owner = await client.query<{
          runtime_public_id: string
        }>(`SELECT CASE WHEN r.project_id IS NULL THEN u.public_id ELSE p.public_id END::text runtime_public_id
          FROM harness.conversation_sessions r
          LEFT JOIN harness.users u ON u.organization_id=r.organization_id AND u.id=r.creator_user_id
          LEFT JOIN harness.projects p ON p.organization_id=r.organization_id AND p.id=r.project_id
          WHERE r.organization_id=$1 AND r.id=$2 AND r.runtime_id=$3`, [this.context.organizationId, rootSessionId, runtimeId])
        const ownerRow = owner.rows[0]
        if (ownerRow === undefined) continue
        const nextRevision = nextArchiveRevision(existing.rows[0]?.sync_revision ?? 0, 'archive sync revision')
        const purgeAfter = Date.now() + this.retentionDays * 86_400_000
        const archived = await client.query<{ archive_id: ConversationArchiveId }>(`INSERT INTO harness.conversation_archive_records(node_id,runtime_id,
          organization_id,root_session_id,runtime_kind,runtime_public_id,project_id,creator_user_id,
          message_count,state,archived_by_user_id,trashed_at,trashed_by_user_id,purge_after,sync_revision,sync_state,record_kind,updated_at
        ) VALUES(${this.nodeSql},$10,$1,$2,$3,$4,$5,$6,0,'trash',$7,now(),$7,to_timestamp($8/1000.0),$9,'synced','empty-draft',now())
          ON CONFLICT (organization_id,runtime_id,root_session_id) DO UPDATE SET state='trash',trashed_at=now(),
            purge_after=EXCLUDED.purge_after,trashed_by_user_id=$7,record_kind='empty-draft',sync_revision=$9,
            sync_state='synced',updated_at=now() RETURNING archive_id`, [
          this.context.organizationId,
          rootSessionId,
          current.project_id === null ? 'user' : 'project',
          ownerRow.runtime_public_id,
          current.project_id,
          current.creator_user_id,
          actor,
          purgeAfter,
          nextRevision,
          current.runtime_id,
        ])
        await client.query(`INSERT INTO harness.conversation_archive_commands(
          organization_id,archive_id,action,requested_by_user_id,desired_revision
        ) VALUES($1,$2,'trash',$3,$4)`, [this.context.organizationId, archived.rows[0]!.archive_id, actor, nextRevision])
        result.push({ rootSessionId, runtimeId })
      }
      return result
    })
    return trashed
  }

  /**
   * Load an archive page with current administrator qualification before database access and after Runtime work.
   * @param archiveId - immutable archive identity on this computer.
   * @param fromSeq - first requested event sequence.
   * @param limit - bounded event count.
   * @param actorUserId - authenticated administrator; omission permits trusted internal reads.
   * @returns the archive page, or null when absent.
   */
  async detail(archiveId: ConversationArchiveId, fromSeq = 0, limit = 200, actorUserId?: number): Promise<ConversationArchiveDetail | null> {
    return await this.detailPage(archiveId, fromSeq, limit, 200, actorUserId)
  }

  /**
   * Load a larger bounded administrator export with qualification checked after Runtime work.
   * @param archiveId - immutable archive identity on this computer.
   * @param actorUserId - authenticated administrator; omission permits trusted internal reads.
   * @returns export metadata and events, or null when absent.
   */
  async exportDetail(archiveId: ConversationArchiveId, actorUserId?: number): Promise<ConversationArchiveDetail | null> {
    return await this.detailPage(archiveId, 0, 100_000, 100_000, actorUserId)
  }

  private async detailPage(
    archiveId: ConversationArchiveId,
    fromSeq: number,
    limit: number,
    maximum: number,
    actorUserId: number | undefined,
  ): Promise<ConversationArchiveDetail | null> {
    const local = await this.administratorRead(actorUserId, async database => {
      const result = await database.query<ArchiveDbRow>(`SELECT ${ARCHIVE_COLUMNS}
        FROM ${this.nodeRows('conversation_archive_records')} a
        LEFT JOIN harness.conversation_sessions r
          ON ${archiveSessionSql('r')} AND r.id=a.root_session_id AND r.status<>'deleted'
        LEFT JOIN harness.users creator ON creator.organization_id=a.organization_id
          AND creator.id=COALESCE(a.creator_user_id,r.creator_user_id)
        LEFT JOIN harness.projects project ON project.organization_id=a.organization_id
          AND project.id=COALESCE(a.project_id,r.project_id)
        WHERE a.organization_id=$1 AND a.archive_id=$2`, [this.context.organizationId, archiveId])
      const row = result.rows[0]
      if (row === undefined) return null
      if (!Number.isSafeInteger(fromSeq) || fromSeq < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('invalid archive detail pagination')
      }
      const boundedFrom = Math.max(fromSeq, 0)
      const bounded = boundedLimit(limit, maximum)
      const descendants = await database.query<{
        id: string; parent_session_id: string | null; title: string | null
      }>(`SELECT s.id,s.parent_session_id,harness.human_session_title(s.title) title FROM harness.conversation_sessions s
        JOIN ${this.nodeRows('conversation_archive_records')} a ON ${archiveSessionSql('s')}
        WHERE a.organization_id=$1 AND a.archive_id=$2 AND s.status<>'deleted'
        ORDER BY s.created_at,s.id LIMIT $3`, [this.context.organizationId, archiveId, MAX_ARCHIVE_DETAIL_DESCENDANTS + 1])
      if (descendants.rows.length > MAX_ARCHIVE_DETAIL_DESCENDANTS) {
        throw new ConversationArchiveError('ARCHIVE_TOO_LARGE', 413, 'archive detail exceeds the descendant limit')
      }
      const events = await database.query<{
        session_id: string; seq: string; event_type: string; occurred_at_ms: string; event: unknown
      }>(`SELECT e.session_id,e.seq::text,e.event_type,
        (extract(epoch FROM e.occurred_at)*1000)::bigint::text occurred_at_ms,e.event
        FROM harness.conversation_events e
        JOIN harness.conversation_sessions s ON s.id=e.session_id AND s.organization_id=$1 AND s.organization_id=e.organization_id AND s.runtime_namespace=e.runtime_namespace
        JOIN ${this.nodeRows('conversation_archive_records')} a ON ${archiveSessionSql('s')}
        WHERE a.archive_id=$2 AND s.status<>'deleted' AND e.seq >= $3
        ORDER BY e.occurred_at,e.session_id,e.seq LIMIT $4`,
      [this.context.organizationId, archiveId, boundedFrom, bounded + 1])
      let projectedRecord = archiveRow(row)
      let projectedDescendants = descendants.rows.map(item => ({
          sessionId: item.id,
          parentSessionId: item.parent_session_id,
          title: item.title ?? '未命名会话',
        }))
      let eventBytes = 0
      const projectedEventsAll = events.rows.map(event => {
        const projected = {
          sessionId: event.session_id,
          seq: safeNumber(event.seq, 'event sequence')!,
          type: event.event_type,
          time: safeNumber(event.occurred_at_ms, 'event time')!,
          data: event.event,
        }
        eventBytes += Buffer.byteLength(JSON.stringify(projected), 'utf8')
        if (eventBytes > MAX_ARCHIVE_DETAIL_EVENT_BYTES) {
          throw new ConversationArchiveError('ARCHIVE_TOO_LARGE', 413, 'archive detail exceeds the event byte limit')
        }
        return projected
      })
      let projectedEvents = projectedEventsAll.slice(0, bounded)
      let projectedHasMore = events.rows.length > bounded
      return { row, bounded, projectedRecord, projectedDescendants, projectedEvents, projectedHasMore }
    })
    if (local === null) return null
    const { row, bounded } = local
    let { projectedRecord, projectedDescendants, projectedEvents, projectedHasMore } = local
    if (row.runtime_kind === 'user' && row.runtime_id !== null && row.state !== 'purged' && this.runtimeReader !== undefined) {
      try {
        await this.administratorRead(actorUserId, async () => undefined)
        const remote = await this.runtimeReader(
          { kind: row.runtime_kind, id: publicNumber(row.runtime_public_id, 'runtime'), runtimeId: row.runtime_id,
            ...(row.node_id === null ? {} : { nodeId: row.node_id }) },
          row.root_session_id,
          Math.max(fromSeq, 0),
          bounded,
          actorUserId,
        )
        if (remote !== undefined) {
          assertRuntimeReadBudget(remote, bounded)
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
    await this.administratorRead(actorUserId, async () => undefined)
    return {
      record: projectedRecord,
      descendants: projectedDescendants,
      events: projectedEvents,
      hasMore: projectedHasMore,
    }
  }

  /**
   * Create or refresh a Runtime-local archive without changing its durable archive identity.
   * @param snapshot - metadata and search events for one root in its owning Runtime.
   * @returns the stable archive identity, including when a stale projection is ignored.
   */
  async syncSnapshot(snapshot: ConversationArchiveSnapshot): Promise<ConversationArchiveId> {
    if (!Number.isSafeInteger(snapshot.syncRevision) || snapshot.syncRevision < 0) {
      throw new Error('invalid runtime archive revision')
    }
    const search = normalizeArchiveSearch(snapshot.search)
    return transaction(this.context.pool, async client => {
      const runtimeId = await this.runtimeIdentity(client, snapshot.runtime)
      if (runtimeId === undefined) throw new Error('archive Runtime is unavailable on this computer')
      const creator = snapshot.creatorUserId === undefined
        ? null : await this.internalUserId(client, snapshot.creatorUserId)
      const project = snapshot.projectId === undefined
        ? null : await this.internalProjectId(client, snapshot.projectId)
      const prior = await client.query<{
        archive_id: ConversationArchiveId; state: ConversationArchiveState; sync_revision: string
      }>(`SELECT archive_id,state,sync_revision::text FROM harness.conversation_archive_records
        WHERE organization_id=$1 AND runtime_id=$2 AND root_session_id=$3 FOR UPDATE`,
      [this.context.organizationId, runtimeId, snapshot.rootSessionId])
      const existing = prior.rows[0]
      if (existing?.state === 'purged') {
        await this.requeueTombstonePurge(client, existing.archive_id, existing.sync_revision)
        return existing.archive_id
      }
      const upsert = await client.query<{ archive_id: ConversationArchiveId }>(`INSERT INTO harness.conversation_archive_records(node_id,runtime_id,
        organization_id,root_session_id,runtime_kind,runtime_public_id,project_id,creator_user_id,title,
        workspace_path,workspace_title,workspace_position,message_count,archived_at,sync_revision,sync_state,updated_at
      ) VALUES(${this.nodeSql},$14,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12/1000.0),$13,'synced',now())
      ON CONFLICT (organization_id,runtime_id,root_session_id) DO UPDATE SET
        project_id=COALESCE(EXCLUDED.project_id,conversation_archive_records.project_id),
        creator_user_id=COALESCE(EXCLUDED.creator_user_id,conversation_archive_records.creator_user_id),
        title=COALESCE(EXCLUDED.title,conversation_archive_records.title),
        workspace_path=EXCLUDED.workspace_path,
        workspace_title=EXCLUDED.workspace_title,
        workspace_position=EXCLUDED.workspace_position,
        message_count=GREATEST(conversation_archive_records.message_count,EXCLUDED.message_count),
        sync_revision=GREATEST(conversation_archive_records.sync_revision,EXCLUDED.sync_revision),
        sync_state=CASE WHEN EXISTS(SELECT 1 FROM harness.conversation_archive_commands c
          WHERE c.organization_id=conversation_archive_records.organization_id
            AND c.archive_id=conversation_archive_records.archive_id AND c.status='pending') THEN 'pending'
          WHEN conversation_archive_records.sync_state='conflict' THEN 'conflict' ELSE 'synced' END,
        last_sync_error=CASE WHEN conversation_archive_records.sync_state='conflict'
          THEN conversation_archive_records.last_sync_error ELSE NULL END,updated_at=now()
      WHERE conversation_archive_records.runtime_kind=EXCLUDED.runtime_kind
        AND conversation_archive_records.runtime_public_id=EXCLUDED.runtime_public_id
        AND EXCLUDED.sync_revision>=conversation_archive_records.sync_revision
        AND conversation_archive_records.state<>'purged'
      RETURNING archive_id`, [
        this.context.organizationId, snapshot.rootSessionId, snapshot.runtime.kind, snapshot.runtime.id,
        project, creator, snapshot.title ?? null, snapshot.workspace?.path ?? null,
        snapshot.workspace?.title ?? null, snapshot.workspace?.position ?? null, snapshot.messageCount ?? 0,
        snapshot.archivedAt ?? Date.now(), snapshot.syncRevision, runtimeId,
      ])
      let archiveId = upsert.rows[0]?.archive_id
      if (archiveId === undefined) {
        const stored = await client.query<{ archive_id: ConversationArchiveId; state: ConversationArchiveState; sync_revision: string }>(`SELECT archive_id,state,sync_revision::text
          FROM harness.conversation_archive_records WHERE organization_id=$1 AND runtime_id=$2 AND root_session_id=$3`,
        [this.context.organizationId, runtimeId, snapshot.rootSessionId])
        archiveId = stored.rows[0]?.archive_id
        if (archiveId === undefined) throw new Error('archive record disappeared during synchronization')
        if (stored.rows[0]?.state === 'purged') await this.requeueTombstonePurge(client, archiveId, stored.rows[0].sync_revision)
        return archiveId
      }
      for (let offset = 0; offset < search.length; offset += ARCHIVE_SEARCH_BATCH_SIZE) {
        const batch = search.slice(offset, offset + ARCHIVE_SEARCH_BATCH_SIZE).map(item => ({ ...item, encoded: encodeSearchText(item.content) }))
        const indexed = await client.query(`INSERT INTO harness.conversation_archive_search(
          organization_id,archive_id,runtime_id,session_id,event_seq,role,content,occurred_at,content_nul_parts
        ) SELECT $1,$2,$3,item.session_id,item.event_seq,item.role,item.content,
            to_timestamp(item.occurred_at_ms/1000.0),
            CASE WHEN item.nul_parts IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(item.nul_parts)) END
          FROM unnest($4::text[],$5::bigint[],$6::text[],$7::text[],$8::bigint[],$9::jsonb[])
            AS item(session_id,event_seq,role,content,occurred_at_ms,nul_parts)
        ON CONFLICT (organization_id,runtime_id,session_id,event_seq) DO UPDATE SET
          role=EXCLUDED.role,content=EXCLUDED.content,occurred_at=EXCLUDED.occurred_at,content_nul_parts=EXCLUDED.content_nul_parts
        WHERE conversation_archive_search.archive_id=EXCLUDED.archive_id`, [
          this.context.organizationId, archiveId, runtimeId,
          batch.map(item => item.sessionId), batch.map(item => item.seq),
          batch.map(item => item.role), batch.map(item => item.encoded.text), batch.map(item => item.occurredAt),
          batch.map(item => item.encoded.nulParts === null ? null : JSON.stringify(item.encoded.nulParts)),
        ])
        if (indexed.rowCount !== batch.length) throw new Error('archive search session belongs to a different root in this Runtime')
      }
      return archiveId
    })
  }

  private async requeueTombstonePurge(client: PoolClient, archiveId: ConversationArchiveId, storedRevision: string): Promise<void> {
    const revision = safeNumber(storedRevision, 'archive sync revision')!
    await client.query(`INSERT INTO harness.conversation_archive_commands(
      organization_id,archive_id,action,desired_revision
    ) SELECT $1,$2,'purge',$3
      WHERE NOT EXISTS(SELECT 1 FROM harness.conversation_archive_commands c
        WHERE c.organization_id=$1 AND c.archive_id=$2 AND c.status='pending')`, [
      this.context.organizationId, archiveId, revision,
    ])
  }

  /** Persist one idempotent runtime projection batch and return a bounded command page. */
  async syncRuntimeSnapshot(
    snapshot: ConversationArchiveRuntimeSnapshot,
    caller?: ConversationArchiveRuntimeIdentity,
  ): Promise<readonly { id: string; rootSessionId: string; action: 'restore' | 'trash' | 'purge' }[]> {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new Error('invalid runtime archive revision')
    }
    if (caller !== undefined
      && (caller.kind !== snapshot.runtime.kind || caller.id !== snapshot.runtime.id
        || caller.runtimeId !== undefined && snapshot.runtime.runtimeId !== undefined && caller.runtimeId !== snapshot.runtime.runtimeId)) {
      throw new Error('archive snapshot runtime identity does not match the authenticated runtime')
    }
    const runtimeId = await this.runtimeIdentity(this.context.pool, caller ?? snapshot.runtime)
    if (runtimeId === undefined) throw new Error('archive Runtime is unavailable on this computer')
    const runtime = { ...snapshot.runtime, runtimeId }
    const bySession = new Map(snapshot.sessions.map(item => [item.sessionId, item]))
    const parents = new Map(snapshot.sessions.map(item => [
      item.sessionId, item.header.parentSession === undefined ? undefined : item.header.parentSession,
    ]))
    const rootFor = (sessionId: string): string => {
      const explicit = bySession.get(sessionId)?.rootSessionId
      if (explicit !== undefined) return explicit
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
    const search = normalizeArchiveSearch(snapshot.search)
    const searchBySession = new Map<string, ArchiveSearchInput[]>()
    for (const item of search) {
      const list = searchBySession.get(item.sessionId)
      if (list === undefined) searchBySession.set(item.sessionId, [item])
      else list.push(item)
    }
    if (caller !== undefined) {
      // Lineage claims are identities too: a derived root or a declared
      // parentSession pointing at another runtime's tree is checked against
      // stored ownership exactly like an explicit rootSessionId.
      const checkedIds = [
        ...snapshot.archivedSessionIds,
        ...snapshot.sessions.map(item => item.sessionId),
        ...snapshot.sessions.flatMap(item => item.rootSessionId === undefined ? [] : [item.rootSessionId]),
        ...(snapshot.search ?? []).map(item => item.sessionId),
        ...snapshot.sessions.flatMap(item => item.header.parentSession === undefined ? [] : [item.header.parentSession]),
        ...snapshot.sessions.map(item => rootFor(item.sessionId)),
      ]
      await this.assertRuntimeSessionOwnership(runtime, checkedIds,
        snapshot.sessions.map(item => ({
          sessionId: item.sessionId,
          rootSessionId: rootFor(item.sessionId),
        })))
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
      const partialMessageCount = sessionIds.reduce((total, sessionId) => {
        const item = bySession.get(sessionId)
        return total + (item?.messageCount ?? searchBySession.get(sessionId)?.length ?? 0)
      }, 0)
      const rootMessageCount = sessionIds.reduce<number | undefined>((total, sessionId) => {
        const candidate = bySession.get(sessionId)?.rootMessageCount
        return candidate === undefined ? total : Math.max(total ?? 0, candidate)
      }, undefined)
      await this.syncSnapshot({
        rootSessionId,
        runtime,
        ...(snapshot.runtime.kind === 'project' ? { projectId: snapshot.runtime.id } : { creatorUserId: snapshot.runtime.id }),
        syncRevision: snapshot.revision,
        ...(root?.title === undefined ? {} : { title: root.title }),
        ...(workspace === undefined ? {} : { workspace }),
        messageCount: rootMessageCount ?? partialMessageCount,
        ...(search.length === 0 ? {} : { search }),
      })
    }
    const pending = await this.context.pool.query<{
      id: string; root_session_id: string; action: 'restore' | 'trash' | 'purge'
    }>(`SELECT c.id::text,a.root_session_id,c.action
      FROM harness.conversation_archive_commands c
      JOIN ${this.nodeRows('conversation_archive_records')} a
        ON a.organization_id=c.organization_id AND a.archive_id=c.archive_id
      WHERE c.organization_id=$1 AND a.runtime_kind=$2 AND a.runtime_public_id=$3 AND c.status='pending' AND a.runtime_id=$5
      ORDER BY c.requested_at,c.id LIMIT $4`, [
      this.context.organizationId, snapshot.runtime.kind, snapshot.runtime.id, ARCHIVE_COMMAND_BATCH_SIZE, runtimeId,
    ])
    return pending.rows.map(row => ({ id: row.id, rootSessionId: row.root_session_id, action: row.action }))
  }

  /**
   * Check for queued commands without scanning or uploading Session histories.
   * @param runtime - authenticated runtime kind and public identity.
   * @returns whether this runtime has an unapplied command.
   */
  async hasPendingCommands(runtime: ConversationArchiveRuntimeIdentity): Promise<boolean> {
    const runtimeId = await this.runtimeIdentity(this.context.pool, runtime)
    if (runtimeId === undefined) return false
    const result = await this.context.pool.query(`SELECT 1 FROM harness.conversation_archive_commands c
      JOIN ${this.nodeRows('conversation_archive_records')} a
        ON a.organization_id=c.organization_id AND a.archive_id=c.archive_id
      WHERE c.organization_id=$1 AND a.runtime_kind=$2 AND a.runtime_public_id=$3 AND c.status='pending' AND a.runtime_id=$4 LIMIT 1`,
    [this.context.organizationId, runtime.kind, runtime.id, runtimeId])
    return result.rows.length > 0
  }

  /** Mark a runtime command applied or failed and update the archive sync state. */
  async acknowledgeCommand(
    commandId: string,
    runtimeRevision: number,
    error?: string,
    caller?: ConversationArchiveRuntimeIdentity,
  ): Promise<boolean> {
    return transaction(this.context.pool, async client => {
      const status = error === undefined ? 'applied' : 'failed'
      const runtimeId = caller === undefined ? null : await this.runtimeIdentity(client, caller)
      if (runtimeId === undefined) return false
      const owner = await client.query<{ archive_id: ConversationArchiveId }>(`SELECT a.archive_id
        FROM ${this.nodeRows('conversation_archive_records')} a JOIN harness.conversation_archive_commands c
          ON a.organization_id=c.organization_id AND a.archive_id=c.archive_id
        WHERE c.organization_id=$1 AND c.id=$2
          AND ($3::text IS NULL OR (a.runtime_kind=$3 AND a.runtime_public_id=$4 AND a.runtime_id=$5)) FOR UPDATE OF a`,
      [this.context.organizationId, commandId, caller?.kind ?? null, caller?.id ?? null, runtimeId])
      if (owner.rows[0] === undefined) return false
      const row = await client.query<{ archive_id: ConversationArchiveId; desired_revision: string; status: string; action: string }>(`SELECT
        archive_id,desired_revision::text,status,action FROM harness.conversation_archive_commands
        WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [this.context.organizationId, commandId])
      const command = row.rows[0]
      if (command === undefined) return false
      if (command.status !== 'pending') return command.status === status
      const desiredRevision = Number(command.desired_revision)
      if (!Number.isSafeInteger(runtimeRevision) || runtimeRevision < 0) throw new Error('invalid runtime archive revision')
      if (!Number.isSafeInteger(desiredRevision) || desiredRevision < 0) {
        throw new Error('stored archive revision is outside the safe integer range')
      }
      if (error === undefined && command.action === 'purge') await this.purgeStoredTree(client, command.archive_id)
      await client.query(`UPDATE harness.conversation_archive_commands
        SET status=$2,error=$3,applied_at=CASE WHEN $2='applied' THEN now() ELSE NULL END
        WHERE organization_id=$1 AND id=$4`, [this.context.organizationId, status, error ?? null, commandId])
      const archiveId = command.archive_id
      await client.query(`UPDATE harness.conversation_archive_records SET sync_revision=GREATEST(sync_revision,$3),
        sync_state=$4,last_sync_error=$5,updated_at=now() WHERE node_id=${this.nodeSql} AND organization_id=$1 AND archive_id=$2`, [
        this.context.organizationId, archiveId, Math.max(runtimeRevision, desiredRevision), error === undefined ? 'synced' : 'conflict', error ?? null,
      ])
      return true
    })
  }

  /**
   * Move one archive row between archived and trash, retaining current administrator authority until commit.
   * @param archiveId - owning computer's archive record.
   * @param state - requested recoverable archive state.
   * @param actorUserId - authenticated administrator's public identity.
   * @param idempotencyKey - optional key for the same root and action; retries require current authority.
   * @returns current archive metadata, or null when unavailable on this computer.
   */
  async setState(archiveId: ConversationArchiveId, state: Exclude<ConversationArchiveState, 'purged'>, actorUserId: number, idempotencyKey?: string): Promise<ConversationArchiveRow | null> {
    return await transaction(this.context.pool, async client => {
      await lockAdministrator(client, this.context, actorUserId)
      const actor = await this.internalUserId(client, actorUserId)
      if (actor === null) throw new Error('archive actor not found')
      if (idempotencyKey !== undefined) {
        const prior = await client.query<{ archive_id: ConversationArchiveId; action: 'restore' | 'trash' | 'purge' }>(`SELECT archive_id,action
          FROM harness.conversation_archive_commands
          WHERE organization_id=$1 AND idempotency_key=$2`, [this.context.organizationId, idempotencyKey])
        if (prior.rows[0] !== undefined) {
          const requestedAction = state === 'archived' ? 'restore' : 'trash'
          if (prior.rows[0].action !== requestedAction || prior.rows[0].archive_id !== archiveId) {
            throw new Error('archive-idempotency-key-reused')
          }
          return await this.findRecord(client, prior.rows[0].archive_id)
        }
      }
      const row = await client.query<{ state: ConversationArchiveState; runtime_kind: 'user' | 'project'; runtime_public_id: string; sync_revision: string }>(`SELECT state,runtime_kind,runtime_public_id::text,sync_revision::text
        FROM ${this.nodeRows('conversation_archive_records')} conversation_archive_records WHERE organization_id=$1 AND archive_id=$2 FOR UPDATE`, [this.context.organizationId, archiveId])
      const current = row.rows[0]
      if (current === undefined) return null
      if (current.state === 'purged') throw new Error('archive-already-purged')
      if (await this.pendingPurge(client, archiveId)) throw new Error('archive-purge-pending')
      await this.supersedeCommands(client, archiveId)
      const nextRevision = nextArchiveRevision(current.sync_revision, 'archive sync revision')
      const now = new Date()
      if (state === 'archived') {
        await client.query(`UPDATE harness.conversation_archive_records SET state='archived',restored_at=now(),restored_by_user_id=$3,
          purge_after=NULL,sync_revision=$4,sync_state='pending',last_sync_error=NULL,updated_at=now()
          WHERE node_id=${this.nodeSql} AND organization_id=$1 AND archive_id=$2`, [this.context.organizationId, archiveId, actor, nextRevision])
      } else {
        const purgeAfter = new Date(now.getTime() + this.retentionDays * 86_400_000)
        await client.query(`UPDATE harness.conversation_archive_records SET state='trash',trashed_at=now(),trashed_by_user_id=$3,
          purge_after=$4,sync_revision=$5,sync_state='pending',last_sync_error=NULL,updated_at=now()
          WHERE node_id=${this.nodeSql} AND organization_id=$1 AND archive_id=$2`, [this.context.organizationId, archiveId, actor, purgeAfter, nextRevision])
      }
      await client.query(`INSERT INTO harness.conversation_archive_commands(
        organization_id,archive_id,action,requested_by_user_id,desired_revision,idempotency_key
      ) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (organization_id,idempotency_key) DO NOTHING`, [
        this.context.organizationId, archiveId, state === 'archived' ? 'restore' : 'trash', actor, nextRevision,
        idempotencyKey ?? null,
      ])
      return await this.detailForClient(client, archiveId)
    })
  }

  /**
   * Queue permanent cleanup; durable data remains until its runtime confirms idle resource release.
   * @param archiveId - owning computer's archived conversation.
   * @param actorUserId - administrator rechecked and retained until commit; omission permits trusted maintenance.
   * @param idempotencyKey - optional identity of this permanent cleanup request.
   * @returns whether the archive exists and its cleanup request is accepted.
   */
  async purge(archiveId: ConversationArchiveId, actorUserId?: number, idempotencyKey?: string): Promise<boolean> {
    return transaction(this.context.pool, async client => {
      if (actorUserId !== undefined) await lockAdministrator(client, this.context, actorUserId)
      const actor = actorUserId === undefined ? null : await this.internalUserId(client, actorUserId)
      if (actorUserId !== undefined && actor === null) throw new Error('archive actor not found')
      if (idempotencyKey !== undefined) {
        const prior = await client.query<{ archive_id: ConversationArchiveId; action: 'restore' | 'trash' | 'purge' }>(`SELECT archive_id,action
          FROM harness.conversation_archive_commands
          WHERE organization_id=$1 AND idempotency_key=$2`, [this.context.organizationId, idempotencyKey])
        if (prior.rows[0] !== undefined) {
          if (prior.rows[0].action !== 'purge' || prior.rows[0].archive_id !== archiveId) throw new Error('archive-idempotency-key-reused')
          return (await this.findRecord(client, archiveId)) !== null
        }
      }
      const row = await client.query<{ state: ConversationArchiveState; sync_revision: string; sync_state: string }>(`SELECT state,sync_revision::text,sync_state
        FROM ${this.nodeRows('conversation_archive_records')} conversation_archive_records WHERE organization_id=$1 AND archive_id=$2 FOR UPDATE`, [this.context.organizationId, archiveId])
      const current = row.rows[0]
      if (current === undefined) return false
      if (current.state === 'purged' && current.sync_state === 'synced') return true
      if (await this.pendingPurge(client, archiveId)) return true
      const nextRevision = nextArchiveRevision(current.sync_revision, 'archive sync revision')
      await this.supersedeCommands(client, archiveId)
      await client.query(`UPDATE harness.conversation_archive_records SET sync_revision=$3,sync_state='pending',last_sync_error=NULL,updated_at=now()
        WHERE node_id=${this.nodeSql} AND organization_id=$1 AND archive_id=$2`, [this.context.organizationId, archiveId, nextRevision])
      await client.query(`INSERT INTO harness.conversation_archive_commands(
        organization_id,archive_id,action,requested_by_user_id,desired_revision,idempotency_key
      ) VALUES($1,$2,'purge',$3,$4,$5)`, [this.context.organizationId, archiveId, actor, nextRevision, idempotencyKey ?? null])
      return true
    })
  }

  /**
   * Finish a record whose commands can no longer reach their runtime.  A
   * pending purge executes against Gateway-stored data immediately; pending
   * restore/trash requests are retired as unconfirmed so the row stops
   * waiting on an acknowledgement that may never arrive.
   * @param archiveId - owning computer's archive record.
   * @param actorUserId - administrator rechecked and retained until commit; omission permits trusted maintenance.
   * @returns current archive metadata, or null when unavailable on this computer.
   */
  async settle(archiveId: ConversationArchiveId, actorUserId?: number): Promise<ConversationArchiveRow | null> {
    return transaction(this.context.pool, async client => {
      if (actorUserId !== undefined) await lockAdministrator(client, this.context, actorUserId)
      const row = await client.query<{ state: ConversationArchiveState; sync_revision: string; sync_state: string }>(
        `SELECT state,sync_revision::text,sync_state FROM ${this.nodeRows('conversation_archive_records')} conversation_archive_records
        WHERE organization_id=$1 AND archive_id=$2 FOR UPDATE`,
      [this.context.organizationId, archiveId])
      const current = row.rows[0]
      if (current === undefined) return null
      const pending = await client.query<{ id: string; action: 'restore' | 'trash' | 'purge' }>(
        `SELECT id::text,action FROM harness.conversation_archive_commands
        WHERE organization_id=$1 AND archive_id=$2 AND status='pending'
        ORDER BY requested_at,id FOR UPDATE`, [this.context.organizationId, archiveId])
      const purgePending = pending.rows.some(command => command.action === 'purge')
      if (purgePending) {
        await this.purgeStoredTree(client, archiveId)
      }
      if (pending.rows.length > 0) {
        // A settled purge is marked applied because purgeStoredTree is the
        // Gateway-owned half of it; any surviving runtime residue is removed
        // by the purge command re-queued on the next snapshot announcement.
        await client.query(`UPDATE harness.conversation_archive_commands
          SET status=CASE WHEN action='purge' AND $3::boolean THEN 'applied' ELSE 'failed' END,
              error=CASE WHEN action='purge' AND $3::boolean THEN NULL ELSE 'settled by administrator without runtime confirmation' END,
              applied_at=CASE WHEN action='purge' AND $3::boolean THEN now() ELSE NULL END
          WHERE organization_id=$1 AND archive_id=$2 AND status='pending'`,
        [this.context.organizationId, archiveId, purgePending])
      }
      if (purgePending) {
        await client.query(`UPDATE harness.conversation_archive_records
          SET sync_state='synced',last_sync_error=NULL,updated_at=now()
          WHERE node_id=${this.nodeSql} AND organization_id=$1 AND archive_id=$2`, [this.context.organizationId, archiveId])
      } else if (pending.rows.length > 0 || (current.state === 'purged' && current.sync_state !== 'synced')) {
        // Retired restore/trash commands mean the runtime never applied the
        // requested state; keep that divergence visible instead of claiming
        // a synchronized archive.
        await client.query(`UPDATE harness.conversation_archive_records
          SET sync_state=CASE WHEN state='purged' THEN 'synced' ELSE 'conflict' END,
              last_sync_error=CASE WHEN state='purged' THEN NULL ELSE 'settled by administrator without runtime confirmation' END,
              updated_at=now()
          WHERE node_id=${this.nodeSql} AND organization_id=$1 AND archive_id=$2`, [this.context.organizationId, archiveId])
      }
      return await this.detailForClient(client, archiveId)
    })
  }

  private async pendingPurge(client: PoolClient, archiveId: ConversationArchiveId): Promise<boolean> {
    const result = await client.query(`SELECT 1 FROM harness.conversation_archive_commands
      WHERE organization_id=$1 AND archive_id=$2 AND action='purge' AND status='pending' LIMIT 1`,
    [this.context.organizationId, archiveId])
    return result.rows.length > 0
  }

  private async supersedeCommands(client: PoolClient, archiveId: ConversationArchiveId): Promise<void> {
    await client.query(`UPDATE harness.conversation_archive_commands SET status='failed',error='superseded by a newer archive request'
      WHERE organization_id=$1 AND archive_id=$2 AND status='pending'`, [this.context.organizationId, archiveId])
  }

  private async purgeStoredTree(client: PoolClient, archiveId: ConversationArchiveId): Promise<void> {
    await client.query(`SELECT s.id FROM harness.conversation_sessions s
      JOIN ${this.nodeRows('conversation_archive_records')} a ON ${archiveSessionSql('s')}
      WHERE a.organization_id=$1 AND a.archive_id=$2 AND s.id=a.root_session_id FOR UPDATE OF s`,
    [this.context.organizationId, archiveId])
    const ownedSessions = `SELECT s.organization_id,s.runtime_namespace,s.id FROM harness.conversation_sessions s
      JOIN ${this.nodeRows('conversation_archive_records')} a ON ${archiveSessionSql('s')}
      WHERE a.organization_id=$1 AND a.archive_id=$2`
    const files = await client.query<{ local_path: string }>(`SELECT DISTINCT f.local_path
      FROM harness.content_files f WHERE (f.organization_id,f.runtime_namespace,f.session_id) IN (${ownedSessions})`,
    [this.context.organizationId, archiveId])
    await this.enqueueFileCleanup(client, archiveId, files.rows.map(row => row.local_path))
    await client.query(`DELETE FROM harness.content_files WHERE (organization_id,runtime_namespace,session_id) IN (${ownedSessions})`, [this.context.organizationId, archiveId])
    await client.query(`DELETE FROM harness.conversation_events WHERE (organization_id,runtime_namespace,session_id) IN (${ownedSessions})`, [this.context.organizationId, archiveId])
    await client.query(`DELETE FROM harness.conversation_search WHERE (organization_id,runtime_namespace,session_id) IN (${ownedSessions})`, [this.context.organizationId, archiveId])
    await client.query(`DELETE FROM harness.conversation_draft_reservations WHERE (organization_id,runtime_namespace,session_id) IN (${ownedSessions})`, [this.context.organizationId, archiveId])
    await client.query(`DELETE FROM harness.conversation_sessions WHERE (organization_id,runtime_namespace,id) IN (${ownedSessions})`, [this.context.organizationId, archiveId])
    await client.query(`DELETE FROM harness.conversation_archive_search WHERE organization_id=$1 AND archive_id=$2`, [this.context.organizationId, archiveId])
    await client.query(`UPDATE harness.conversation_archive_records SET state='purged',purge_after=NULL,updated_at=now()
      WHERE node_id=${this.nodeSql} AND organization_id=$1 AND archive_id=$2`, [this.context.organizationId, archiveId])
  }

  /** Queue cleanup for trash whose recovery window elapsed; runtimes must confirm resource release. */
  async purgeDue(limit = 50): Promise<number> {
    const due = await this.context.pool.query<{ archive_id: ConversationArchiveId }>(`SELECT archive_id
      FROM ${this.nodeRows('conversation_archive_records')} conversation_archive_records
      WHERE organization_id=$1 AND state='trash' AND purge_after IS NOT NULL AND purge_after <= now()
      ORDER BY purge_after,archive_id LIMIT $2`, [this.context.organizationId, Math.min(Math.max(limit, 1), 200)])
    let purged = 0
    for (const row of due.rows) if (await this.purge(row.archive_id)) purged++
    await this.cleanupDue(ARCHIVE_FILE_CLEANUP_BATCH_SIZE)
    return purged
  }

  /** Verify runtime-supplied session identities before projecting archive state. */
  private async assertRuntimeSessionOwnership(
    runtime: ConversationArchiveRuntimeIdentity,
    sessionIds: readonly string[],
    rootPairs: readonly { sessionId: string; rootSessionId: string }[] = [],
  ): Promise<void> {
    const unique = [...new Set(sessionIds)]
    if (unique.length === 0) return
    if (unique.length > 10_000 || unique.some(id => id.length === 0 || id.length > 512)) {
      throw new Error('archive snapshot contains invalid or too many session ids')
    }
    const owner = runtime.kind === 'project'
      ? await this.internalProjectId(this.context.pool, runtime.id)
      : await this.internalUserId(this.context.pool, runtime.id)
    if (owner === null) throw new Error('archive runtime owner is unavailable')
    const runtimeId = await this.runtimeIdentity(this.context.pool, runtime)
    if (runtimeId === undefined) throw new Error('archive Runtime is unavailable on this computer')
    // Runtime-local sessions have no conversation_sessions row until the gateway
    // materializes one, so ownership is enforced only against existing rows.
    const result = await this.context.pool.query<{ id: string; root_session_id: string; owned: boolean }>(`SELECT s.id,s.root_session_id,
        (s.runtime_id=$5 AND (($3::text='project' AND s.project_id=$4::uuid)
          OR ($3::text='user' AND s.project_id IS NULL AND s.creator_user_id=$4::uuid))) AS owned
      FROM harness.conversation_sessions s
      WHERE s.organization_id=$1 AND s.runtime_id=$5 AND s.id=ANY($2::text[])`, [
      this.context.organizationId,
      unique,
      runtime.kind,
      owner,
      runtimeId,
    ])
    if (result.rows.some(row => !row.owned)) {
      throw new Error('archive snapshot contains a session outside the authenticated runtime')
    }
    const roots = new Map(result.rows.map(row => [row.id, row.root_session_id]))
    for (const pair of rootPairs) {
      const stored = roots.get(pair.sessionId)
      if (stored !== undefined && stored !== pair.rootSessionId) {
        throw new Error('archive snapshot contains a session with an incorrect lineage root')
      }
    }

  }

  /**
   * Read operation metadata under current administrator qualification without contacting its Runtime.
   * @param archiveId - immutable archive identity on this computer.
   * @param actorUserId - authenticated administrator; omission permits trusted internal reads.
   * @returns the current metadata, or null when absent.
   */
  async status(archiveId: ConversationArchiveId, actorUserId?: number): Promise<ConversationArchiveRow | null> {
    return this.administratorRead(actorUserId, database => this.findRecord(database, archiveId))
  }

  private async detailForClient(client: PoolClient, archiveId: ConversationArchiveId): Promise<ConversationArchiveRow> {
    const row = await this.findRecord(client, archiveId)
    if (row === null) throw new Error('archive record disappeared')
    return row
  }

  private async findRecord(client: Pool | PoolClient, archiveId: ConversationArchiveId): Promise<ConversationArchiveRow | null> {
    const result = await client.query<ArchiveDbRow>(`SELECT ${ARCHIVE_COLUMNS}
      FROM ${this.nodeRows('conversation_archive_records')} a
      LEFT JOIN harness.conversation_sessions r ON ${archiveSessionSql('r')} AND r.id=a.root_session_id
      LEFT JOIN harness.users creator ON creator.organization_id=a.organization_id AND creator.id=COALESCE(a.creator_user_id,r.creator_user_id)
      LEFT JOIN harness.projects project ON project.organization_id=a.organization_id AND project.id=COALESCE(a.project_id,r.project_id)
      WHERE a.organization_id=$1 AND a.archive_id=$2`, [this.context.organizationId, archiveId])
    const row = result.rows[0]
    return row === undefined ? null : archiveRow(row)
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
