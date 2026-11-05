import {
  PersonalDocumentMigration,
  type PersonalDocumentMigrationOwner,
} from './node-content-personal-document-migration.ts'
/** Computer-owned document projection, identity-checked mutations and per-root history. */
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { NodeDocumentAdmin } from './node-content-documents-admin.ts'
import { verifyDocumentPublication, type DocumentRootInspector } from './node-content-documents-publication.ts'
import type { NodeContentCheckInput } from './node-content-publication.ts'
import { transaction } from './postgres/database.ts'
import {
  DocumentCatalogError,
  type DocumentCatalogProjectionBatch,
  type DocumentCatalogOverviewOptions,
  type DocumentCatalogMetrics,
  type DocumentCatalogRow,
  type PostgresDocumentCatalogService,
  type DocumentCatalogScope,
  type DocumentCatalogScopeHistoryRow,
  type DocumentCatalogSelection,
  type DocumentCatalogSelectionInput,
} from './postgres/document-catalog-service.ts'
import {
  type DocumentPlacement,
  type DocumentScopeGrant,
  NodeDocumentAuthority,
} from './node-content-documents-authority.ts'
import { documentRootUnavailable } from './node-content-documents-authority.ts'

type Cursor = { sequence: number; ordinal: number }
type Action = 'delete' | 'move' | 'ownership' | 'restore' | 'purge'
import { type NodeDocumentEntry, nodeDocumentColumns, nodeDocumentRow } from './node-content-documents-row.ts'
const samePosition = (left: Cursor, right: Cursor) => left.sequence === right.sequence && left.ordinal === right.ordinal
const owner = (value: string | undefined) =>
  value && /^user:[1-9][0-9]{0,14}$/u.test(value) ? Number(value.slice(5)) : null
function conflict(): never {
  throw new DocumentCatalogError('DOCUMENT_PROJECTION_CONFLICT', 409, 'The document identity or projection cursor changed.')
}

async function cursor(tx: PoolClient, rootId: string): Promise<Cursor> {
  const row = (
    await tx.query<Cursor>('SELECT sequence::float8, ordinal FROM node_content.document_roots WHERE root_id=$1', [rootId])
  ).rows[0]
  if (!row || !Number.isSafeInteger(row.sequence)) conflict()
  return row
}
/** All payloads stay on the designated volume. The control database sees opaque account IDs when resolving display names. */
export class NodeContentDocuments {
  readonly personalHistory: PersonalDocumentMigration
  readonly admin: NodeDocumentAdmin
  constructor(
    readonly authority: NodeDocumentAuthority,
    private readonly inspect?: DocumentRootInspector,
    personalHistory?: PersonalDocumentMigrationOwner,
  ) {
    this.personalHistory = new PersonalDocumentMigration(authority, personalHistory)
    this.admin = new NodeDocumentAdmin(authority, (ids) => this.ownerNames(ids))
  }

  /** Verify the actual UserDoc file, outbox and catalog before publishing the project volume. */
  verifyNodeContent(input: NodeContentCheckInput) {
    return verifyDocumentPublication(input, this.inspect)
  }

  async ownerOf(rootId: string): Promise<DocumentCatalogScope | null> {
    const row = (
      await this.authority.context.pool.query<{ kind: 'personal' | 'project'; publicId: number }>(
        `SELECT p.scope_kind kind,
      coalesce(u.public_id,j.public_id)::float8 "publicId" FROM harness.document_scope_placement p
      LEFT JOIN harness.users u ON p.scope_kind='personal' AND u.organization_id=p.organization_id AND u.id=p.scope_id
      LEFT JOIN harness.projects j ON p.scope_kind='project' AND j.organization_id=p.organization_id AND j.id=p.scope_id
      WHERE p.organization_id=$1 AND p.node_id=$2 AND p.root_id=$3`,
        [this.authority.context.organizationId, this.authority.context.nodeId, rootId],
      )
    ).rows[0]
    return !row
      ? null
      : row.kind === 'personal'
        ? { kind: 'personal', userId: row.publicId }
        : { kind: 'project', projectId: row.publicId }
  }

  async projectionCursor(root: DocumentPlacement, actor: number, id: string, admin: boolean) {
    if (id !== root.rootId) conflict()
    const grant = await this.authority.admit(actor, root, 'read', admin)
    return this.authority.apply(grant, false, admin, (tx) => cursor(tx, root.rootId))
  }

  async project(root: DocumentPlacement, actor: number, batch: DocumentCatalogProjectionBatch, admin: boolean) {
    if (batch.rootId !== root.rootId) conflict()
    // A read-only member may relay an already committed filesystem journal. The root owns and verifies that journal.
    const grant = await this.authority.admit(actor, root, 'read', admin)
    return this.authority.apply(
      grant,
      true,
      admin,
      async (tx) => {
        const position = await cursor(tx, root.rootId)
        if (samePosition(position, batch.next)) return position
        if (!samePosition(position, batch.after)) conflict()
        for (const change of batch.changes) {
          const doc = change.document
          const previous = (
            await tx.query<{ state: string; revision: string }>(
              'SELECT state,revision::text FROM node_content.document_entries WHERE root_id=$1 AND incarnation_id=$2',
              [root.rootId, doc.incarnationId],
            )
          ).rows[0]
          if (previous?.state === 'purged' || (previous && Number(previous.revision) >= doc.revision)) continue
          if (doc.state === 'active') {
            await tx.query(
              `UPDATE node_content.document_entries SET state='missing' WHERE root_id=$1 AND doc_id=$2 AND state='active'
            AND incarnation_id<>$3`,
              [root.rootId, doc.docId, doc.incarnationId],
            )
          }
          const row = (
            await tx.query<{ catalog_id: string }>(
              `INSERT INTO node_content.document_entries
          (organization_id,root_id,runtime_id,incarnation_id,revision,doc_id,directory_id,name,bytes,media_type,modified_at_ms,owner_public_id,
          origin,state,trash_id,trashed_at_ms,purge_after_ms,restored_at_ms,purged_at_ms)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          ON CONFLICT(root_id,incarnation_id) DO UPDATE SET updated_at=clock_timestamp(),revision=excluded.revision,doc_id=excluded.doc_id,directory_id=excluded.directory_id,
            name=excluded.name,bytes=excluded.bytes,media_type=excluded.media_type,modified_at_ms=excluded.modified_at_ms,
            state=excluded.state,trash_id=excluded.trash_id,trashed_at_ms=excluded.trashed_at_ms,purge_after_ms=excluded.purge_after_ms,
            restored_at_ms=coalesce(excluded.restored_at_ms,document_entries.restored_at_ms),purged_at_ms=excluded.purged_at_ms
          WHERE document_entries.state<>'purged' AND document_entries.revision<excluded.revision RETURNING catalog_id`,
              [
                root.organizationId,
                root.rootId,
                root.projectRuntimeId,
                doc.incarnationId,
                doc.revision,
                doc.docId,
                doc.docId.split('/').slice(0, -1).join('/'),
                doc.docId.split('/').at(-1),
                doc.bytes,
                doc.mediaType,
                Math.trunc(doc.modifiedAt),
                owner(doc.createdBy) ?? (root.kind === 'personal' ? root.publicId : null),
                doc.origin,
                doc.state,
                doc.trash?.trashId ?? null,
                doc.trash?.trashedAt ?? null,
                doc.trash?.purgeAfter ?? null,
                change.action === 'restore' ? change.committedAt : null,
                doc.state === 'purged' ? change.committedAt : null,
              ],
            )
          ).rows[0]
          const eventKind =
            doc.state === 'trash'
              ? 'deleted'
              : doc.state === 'purged'
                ? 'purged'
                : doc.state === 'missing'
                  ? 'missing'
                  : !previous
                    ? 'created'
                    : change.action === 'restore'
                      ? 'restored'
                      : 'updated'
          if (row)
            await tx.query(
              `INSERT INTO node_content.document_events(organization_id,root_id,runtime_id,catalog_id,
            actor_public_id,event_kind,occurred_at,detail) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7::float8/1000),$8::jsonb)`,
              [
                root.organizationId,
                root.rootId,
                root.projectRuntimeId,
                row.catalog_id,
                owner(change.actor),
                eventKind,
                change.committedAt,
                JSON.stringify({
                  source: 'identity-projection',
                  action: change.action,
                  rootId: root.rootId,
                  revision: doc.revision,
                  incarnationId: doc.incarnationId,
                  cursor: change.cursor,
                }),
              ],
            )
        }
        await tx.query(
          'UPDATE node_content.document_roots SET sequence=$2,ordinal=$3,revision=revision+1 WHERE root_id=$1',
          [root.rootId, batch.next.sequence, batch.next.ordinal],
        )
        return batch.next
      },
      undefined,
      'read',
    )
  }

  async authorize(
    root: DocumentPlacement,
    actor: number,
    action: Action,
    requested: readonly DocumentCatalogSelectionInput[],
    admin: boolean,
  ) {
    const grant = await this.authority.admit(actor, root, 'write', admin)
    return this.authority.apply(
      grant,
      false,
      admin,
      async (tx) => {
        const state = action === 'restore' || action === 'purge' ? 'trash' : 'active'
        const rows = (
          await tx.query<NodeDocumentEntry>(
            `SELECT ${nodeDocumentColumns} FROM node_content.document_entries WHERE root_id=$1 AND doc_id=ANY($2::text[])
        AND state=$3 ORDER BY catalog_id`,
            [root.rootId, requested.map((x) => x.docId), state],
          )
        ).rows
        const selections: DocumentCatalogSelection[] = []
        for (const item of requested) {
          const matching = rows.filter(
            (row) => row.doc_id === item.docId && (!item.trashId || row.trash_id === item.trashId),
          )
          const row = matching[0]
          if (!row) throw new DocumentCatalogError('DOCUMENT_NOT_FOUND', 404, 'The selected document is missing.')
          if (matching.length !== 1)
            throw new DocumentCatalogError(
              'DOCUMENT_IDENTITY_AMBIGUOUS',
              409,
              'Select the exact document version before changing it.',
            )
          if (
            (item.revision !== undefined && item.revision !== row.revision) ||
            (item.incarnationId !== undefined && item.incarnationId !== row.incarnation_id)
          ) {
            throw new DocumentCatalogError('DOCUMENT_IDENTITY_STALE', 409, 'The selected document version has changed.')
          }
          if (
            !admin &&
            row.owner_public_id !== actor &&
            (root.kind === 'personal' || (grant.role !== 'admin' && !grant.projectOwner))
          ) {
            throw new DocumentCatalogError('DOCUMENT_NOT_OWNER', 403, 'Only the document owner can modify this document.')
          }
          selections.push({
            docId: row.doc_id,
            incarnationId: row.incarnation_id,
            revision: row.revision,
            state,
            ...(row.trash_id ? { trashId: row.trash_id } : {}),
          })
        }
        return { allowed: true as const, selections }
      },
      undefined,
      'write',
    )
  }

  /** Read a single root with keyset pagination. Filters and permission are applied before the page limit. */
  async list(
    root: DocumentPlacement,
    actor: number,
    input: { query?: string; after?: string; limit: number; state?: NodeDocumentEntry['state']; admin?: boolean },
    signal?: AbortSignal,
  ) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200 || (input.query?.length ?? 0) > 255) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document page.')
    }
    const grant = await this.authority.admit(actor, root, 'read', !!input.admin)
    return this.authority.apply(
      grant,
      false,
      !!input.admin,
      async (tx) => {
        const rows = (
          await tx.query<NodeDocumentEntry>(
            `SELECT ${nodeDocumentColumns} FROM node_content.document_entries WHERE root_id=$1
        AND ($2::uuid IS NULL OR catalog_id>$2) AND state=$3 AND strpos(lower(doc_id),lower($4))>0
        ORDER BY catalog_id LIMIT $5`,
            [root.rootId, input.after ?? null, input.state ?? 'active', input.query ?? '', input.limit + 1],
          )
        ).rows
        const page = rows.slice(0, input.limit)
        const names = await this.ownerNames(page.map((row) => row.owner_public_id))
        return {
          documents: page.map((row) => nodeDocumentRow(row, grant, names)),
          nextCursor: rows.length > input.limit ? page.at(-1)!.catalog_id : undefined,
        }
      },
      signal,
    )
  }

  /** Read one authorized node page; filenames and counts never pass through the control database. */
  async overview(actor: number, filters: DocumentCatalogOverviewOptions, offset: number, limit: number) {
    const before = await this.authority.readable(actor, false)
    const metrics: DocumentCatalogMetrics = {
      total: 0,
      active: 0,
      deleted: 0,
      personal: 0,
      project: 0,
      bytes: 0,
      operations24h: 0,
      failures24h: 0,
      trash: 0,
      purged: 0,
    }
    if (!before.length) return { documents: [] as DocumentCatalogRow[], totalDocuments: 0, metrics }
    if (!this.authority.volume) documentRootUnavailable()
    const roots = new Map(before.map((grant) => [grant.placement.rootId, grant]))
    const sort = filters.sort ?? 'date-desc'
    const order = {
      'date-asc': 'd.modified_at_ms ASC',
      'date-desc': 'd.modified_at_ms DESC',
      'name-asc': 'lower(d.name) COLLATE "C" ASC',
      'name-desc': 'lower(d.name) COLLATE "C" DESC',
      'size-asc': 'd.bytes ASC',
      'size-desc': 'd.bytes DESC',
    }[sort]
    const page = await this.authority.volume.readVolume(async (tx) => {
      const ids = [...roots.keys()]
      const matched = ` FROM node_content.document_entries d JOIN node_content.document_roots r USING(root_id)
        WHERE r.organization_id=$1 AND r.node_id=$2 AND r.root_id=ANY($3::uuid[]) AND d.state='active'`
      const text =
        "(d.media_type LIKE 'text/%' OR d.media_type IN ('application/json','application/xml','application/x-yaml','application/javascript') OR d.media_type LIKE '%+json' OR d.media_type LIKE '%+xml')"
      const filter = ` AND strpos(lower(d.name),lower($4))>0 AND (CASE $5::text WHEN 'all' THEN true WHEN 'image' THEN d.media_type LIKE 'image/%'
        WHEN 'pdf' THEN d.media_type='application/pdf' WHEN 'text' THEN ${text}
        WHEN 'other' THEN NOT(d.media_type LIKE 'image/%' OR d.media_type='application/pdf' OR ${text}) ELSE false END)`
      const args = [this.authority.context.organizationId, this.authority.context.nodeId, ids]
      const keyed = [...args, filters.query?.trim() ?? '', filters.type ?? 'all']
      const available = (
        await tx.query<{ root_id: string; name: string | null; revision: string }>(
          `SELECT r.root_id,CASE WHEN s.project_id IS NOT NULL THEN node_content.project_name_at(r.organization_id,r.scope_id,r.runtime_id,names.version) END name,r.revision::text FROM node_content.document_roots r
        JOIN unnest($3::uuid[],$4::uuid[]) names(id,version) ON names.id=r.root_id
        LEFT JOIN node_content.spaces s ON s.organization_id=r.organization_id AND s.runtime_id=r.runtime_id
        WHERE r.organization_id=$1 AND r.node_id=$2 AND r.root_id=ANY($3::uuid[]) AND
          (r.scope_kind='personal' OR s.publication_state='published' AND s.writer_epoch=r.writer_epoch AND s.volume_id=r.volume_id
             AND NOT EXISTS(SELECT FROM node_content.recovery_candidates c WHERE c.organization_id=s.organization_id
               AND c.runtime_id=s.runtime_id AND c.phase<>'active')) ORDER BY r.root_id`,
          [...args, ids.map((id) => roots.get(id)!.placement.nameVersion ?? null)],
        )
      ).rows
      if (available.length !== ids.length) documentRootUnavailable()
      for (const row of available) if (row.name !== null) roots.get(row.root_id)!.label = row.name
      const result = (
        await tx.query<NodeDocumentEntry & { root_id: string }>(
          `SELECT d.root_id,${nodeDocumentColumns
            .split(',')
            .map((column) => 'd.' + column.trim())
            .join(',')} ${matched}${filter}
        ORDER BY ${order},d.catalog_id LIMIT $6 OFFSET $7`,
          [...keyed, limit, offset],
        )
      ).rows
      const total = (await tx.query<{ n: number }>('SELECT count(*)::float8 n' + matched + filter, keyed)).rows[0]!.n
      const sizes = (
        await tx.query<{ count: number; personal: number; project: number; bytes: number }>(
          `SELECT count(*)::float8 count,
        count(*) FILTER (WHERE r.scope_kind='personal')::float8 personal,count(*) FILTER (WHERE r.scope_kind='project')::float8 project,
        coalesce(sum(d.bytes),0)::float8 bytes` + matched,
          args,
        )
      ).rows[0]!
      const names = await this.ownerNames(result.map((row) => row.owner_public_id))
      return {
        revision: createHash('sha256')
          .update(JSON.stringify(available.map((row) => [row.root_id, row.revision])))
          .digest('hex'),
        documents: result.map((row) => nodeDocumentRow(row, roots.get(row.root_id)!, names)),
        totalDocuments: total,
        metrics: {
          ...metrics,
          total: sizes.count,
          active: sizes.count,
          personal: sizes.personal,
          project: sizes.project,
          bytes: sizes.bytes,
        },
      }
    })
    const current = new Map((await this.authority.readable(actor, false)).map((grant) => [grant.placement.rootId, grant]))
    if (
      current.size !== roots.size ||
      before.some(
        (old) =>
          current.get(old.placement.rootId)?.mode !== old.mode ||
          current.get(old.placement.rootId)?.placement.writerEpoch !== old.placement.writerEpoch ||
          current.get(old.placement.rootId)?.placement.nameVersion !== old.placement.nameVersion,
      )
    ) {
      throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'Document access changed during the query.')
    }
    return page
  }

  /** Read scope-bound history without exposing names or messages to the organization database. */
  async history(root: DocumentPlacement, actor: number, limit = 200): Promise<readonly DocumentCatalogScopeHistoryRow[]> {
    const grant = await this.authority.admit(actor, root, 'read')
    const count = Math.max(1, Math.min(500, Math.trunc(limit) || 200))
    return this.authority.apply(grant, false, false, async (tx) => {
      const rows = (
        await tx.query<{
          id: number
          eventKind: string
          actorId: number | null
          operationId: string | null
          detail: unknown
          createdAt: number
          catalogId: string | null
          documentName: string | null
        }>(
          `SELECT e.id::float8 id,e.event_kind "eventKind",
        e.actor_public_id::float8 "actorId",e.operation_id "operationId",e.detail,extract(epoch FROM e.occurred_at)*1000::float8 "createdAt",
        e.catalog_id "catalogId",d.name "documentName" FROM node_content.document_events e LEFT JOIN node_content.document_entries d
        ON d.root_id=e.root_id AND d.catalog_id=e.catalog_id WHERE e.root_id=$1 ORDER BY e.id DESC LIMIT $2`,
          [root.rootId, count],
        )
      ).rows
      const names = await this.ownerNames(rows.map((row) => row.actorId))
      return rows.map(({ actorId, ...row }) => {
        const displayName = actorId === null ? undefined : names.get(actorId)
        return { ...row, actor: actorId !== null && displayName !== undefined ? { id: actorId, displayName } : null }
      })
    })
  }

  /** Move logical ownership only after checking the project's current owner and active destination member. */
  async transferOwnership(actor: number, catalogId: string, nextOwner: number): Promise<boolean> {
    const grants = await this.authority.readable(actor, false)
    if (!grants.length) return false
    const store = this.authority.volume
    if (!store) documentRootUnavailable()
    const roots = grants.map((g) => g.placement.rootId)
    const row = (
      await store.readVolume((tx) =>
        tx.query<{ root_id: string }>(
          "SELECT root_id FROM node_content.document_entries WHERE root_id=ANY($1::uuid[]) AND catalog_id=$2 AND state='active'",
          [roots, catalogId],
        ),
      )
    ).rows[0]
    if (!row) return false
    const grant = grants.find((g) => g.placement.rootId === row.root_id)!
    if (grant.placement.kind !== 'project' || (grant.role !== 'admin' && !grant.projectOwner))
      throw new DocumentCatalogError(
        'DOCUMENT_OWNERSHIP_FORBIDDEN',
        403,
        'Only a project owner or administrator may transfer ownership.',
      )
    const target = async () =>
      !!(
        await this.authority.context.pool.query(
          `SELECT FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      JOIN harness.project_members j ON j.organization_id=u.organization_id AND j.user_id=u.id AND j.project_id=$3
      WHERE u.organization_id=$1 AND u.public_id=$2 AND u.deleted_at IS NULL AND u.status='active' AND m.status='active'
        AND harness.project_computer_use_allowed(u.organization_id,u.id,j.project_id)`,
          [this.authority.context.organizationId, nextOwner, grant.placement.scopeId],
        )
      ).rowCount
    if (!(await target()))
      throw new DocumentCatalogError(
        'DOCUMENT_OWNER_NOT_MEMBER',
        409,
        'The new owner must be an active member on this computer.',
      )
    await this.authority.apply(grant, true, false, async (tx) => {
      const changed = await tx.query(
        `UPDATE node_content.document_entries SET owner_public_id=$3,updated_at=clock_timestamp()
        WHERE root_id=$1 AND catalog_id=$2 AND state='active'`,
        [row.root_id, catalogId, nextOwner],
      )
      if (!changed.rowCount) conflict()
      await tx.query(
        `INSERT INTO node_content.document_events(organization_id,root_id,runtime_id,catalog_id,actor_public_id,event_kind,occurred_at,detail)
        VALUES($1,$2,$3,$4,$5,'ownership-transferred',now(),jsonb_build_object('ownerUserId',$6::bigint))`,
        [grant.placement.organizationId, row.root_id, grant.placement.projectRuntimeId, catalogId, actor, nextOwner],
      )
      if (!(await target()))
        throw new DocumentCatalogError('DOCUMENT_OWNER_NOT_MEMBER', 409, 'The selected project membership changed.')
    })
    return true
  }

  /** Queue scope-local transfer history using only opaque node, file and actor IDs in the organization database. */
  async enqueueTransfer(
    input: Parameters<PostgresDocumentCatalogService['recordCopy']>[0],
  ): Promise<{ operationId: string; targetCatalogId: null } | null> {
    const org = this.authority.context.organizationId
    const sourceNode = input.sourceNodeId ?? this.authority.context.nodeId
    const targetNode = input.targetNodeId ?? this.authority.context.nodeId
    const [source, target] = await Promise.all([
      this.authority.placement(input.source, sourceNode),
      this.authority.placement(input.targetScope, targetNode),
    ])
    if (!source && !target) return null
    const op = input.operationId ?? randomUUID()
    const item = createHash('sha256')
      .update(op + '\0' + input.sourceDocId)
      .digest('hex')
    const rows = [
      {
        direction: 'source',
        scope: input.source,
        node: sourceNode,
        root: source,
        peer: targetNode,
        identity: input.sourceIdentity,
        path: input.sourceDocId,
      },
      {
        direction: 'target',
        scope: input.targetScope,
        node: targetNode,
        root: target,
        peer: sourceNode,
        identity: input.target?.identity,
        path: input.target?.docId,
      },
    ]
    await transaction(this.authority.context.pool, async (db) => {
      const actor = (
        await db.query<{ id: string }>(
          `SELECT u.id FROM harness.users u JOIN harness.memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL AND m.status='active'`,
          [org, input.actorUserId],
        )
      ).rows[0]
      if (!actor) throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'Document access has been revoked.')
      for (const row of rows) {
        if (row.root) {
          if (input.target && !row.identity)
            throw new DocumentCatalogError('DOCUMENT_IDENTITY_STALE', 409, 'A published copy requires both file identities.')
          await db.query(
            `INSERT INTO harness.document_transfer_delivery(organization_id,node_id,root_id,operation_id,direction,item_id,
            counterpart_node_id,actor_id,incarnation_id,succeeded) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT(root_id,operation_id,direction,item_id,succeeded) DO NOTHING`,
            [
              org,
              row.node,
              row.root.rootId,
              op,
              row.direction,
              item,
              row.peer,
              actor.id,
              row.identity?.incarnationId ?? null,
              !!input.target,
            ],
          )
        } else if (row.path) {
          // Only this legacy side's path may be resolved by the shared index.
          const key = row.scope.kind === 'personal' ? 'scope_user_id' : 'scope_project_id'
          const domain = row.scope.kind === 'personal' ? 'users' : 'projects'
          const id = row.scope.kind === 'personal' ? row.scope.userId : row.scope.projectId
          const record = (
            await db.query<{ id: string }>(
              `SELECT c.id FROM harness.document_catalog c JOIN harness.${domain} s
            ON s.id=c.${key} AND s.organization_id=c.organization_id WHERE c.organization_id=$1 AND c.node_id=$2 AND s.public_id=$3
            AND c.runtime_doc_id=$4 AND ($5::uuid IS NULL OR c.runtime_incarnation_id=$5) ORDER BY (c.state='active') DESC,c.id LIMIT 1 FOR UPDATE OF c`,
              [org, row.node, id, row.path, row.identity?.incarnationId ?? null],
            )
          ).rows[0]
          if (!record) continue
          const event = input.target ? (row.direction === 'source' ? 'copied-out' : 'copied-in') : 'denied'
          await db.query(
            `INSERT INTO harness.document_history(organization_id,catalog_id,actor_user_id,event_kind,detail)
            SELECT $1,$2,$3,$4,jsonb_build_object('nodeCopy',$5::text,'item',$6::text,'peer',$7::text)
            WHERE NOT EXISTS(SELECT FROM harness.document_history h WHERE h.organization_id=$1 AND h.catalog_id=$2
              AND h.event_kind=$4 AND h.detail->>'nodeCopy'=$5 AND h.detail->>'item'=$6)`,
            [org, record.id, actor.id, event, op, item, row.peer],
          )
        }
      }
    })
    return { operationId: op, targetCatalogId: null }
  }

  /** A failed node leaves opaque work pending. Repeated delivery cannot duplicate a file or its history entry. */
  async deliverPending(limit: number): Promise<void> {
    if (!this.authority.volume) return
    for (let i = 0; i < limit; i++) {
      const claim = randomUUID()
      const db = this.authority.context.pool
      const item = (
        await db.query<{
          operation_id: string
          root_id: string
          scope_kind: 'project' | 'personal'
          public_id: number
          direction: 'source' | 'target'
          actor: number
          item_id: string
          counterpart_node_id: string
          incarnation_id: string | null
          succeeded: boolean
        }>(
          `WITH selected AS (
        SELECT d.ctid FROM harness.document_transfer_delivery d WHERE d.organization_id=$1 AND d.node_id=$2 AND d.delivered_at IS NULL
          AND d.retry_at<=clock_timestamp() ORDER BY d.created_at LIMIT 1 FOR UPDATE SKIP LOCKED), claimed AS (
        UPDATE harness.document_transfer_delivery d SET claim=$3,retry_at=clock_timestamp()+interval '1 minute' FROM selected
          WHERE d.ctid=selected.ctid RETURNING d.*)
        SELECT d.operation_id,d.root_id,p.scope_kind,coalesce(u.public_id,j.public_id)::float8 public_id,d.direction,actor.public_id::float8 actor,
          d.item_id,d.counterpart_node_id,d.incarnation_id,d.succeeded FROM claimed d JOIN harness.document_scope_placement p
          ON p.organization_id=d.organization_id AND p.root_id=d.root_id AND p.node_id=d.node_id
        JOIN harness.users actor ON actor.organization_id=d.organization_id AND actor.id=d.actor_id
        LEFT JOIN harness.users u ON p.scope_kind='personal' AND p.scope_id=u.id LEFT JOIN harness.projects j ON p.scope_kind='project' AND p.scope_id=j.id`,
          [this.authority.context.organizationId, this.authority.context.nodeId, claim],
        )
      ).rows[0]
      if (!item) return
      let error: string | null = null
      try {
        const scope: DocumentCatalogScope =
          item.scope_kind === 'personal'
            ? { kind: 'personal', userId: item.public_id }
            : { kind: 'project', projectId: item.public_id }
        const root = await this.authority.placement(scope)
        if (!root || root.rootId !== item.root_id) documentRootUnavailable()
        await this.recordTransfer(root, item.actor, {
          operationId: item.operation_id,
          direction: item.direction,
          itemId: item.item_id,
          incarnationId: item.incarnation_id ?? undefined,
          counterpartNodeId: item.counterpart_node_id,
          success: item.succeeded,
        })
      } catch (cause) {
        error = cause instanceof DocumentCatalogError ? cause.code : 'DOCUMENT_STORE_UNAVAILABLE'
      }
      await db.query(
        `UPDATE harness.document_transfer_delivery SET delivered_at=CASE WHEN $3::text IS NULL THEN now() END,claim=NULL,last_error=$3
        WHERE organization_id=$1 AND claim=$2`,
        [this.authority.context.organizationId, claim, error],
      )
    }
  }

  /** A durable transfer records only the local side and the other computer's opaque ID. Retry is idempotent by operation and selection. */
  private async recordTransfer(
    root: DocumentPlacement,
    actor: number,
    input: {
      operationId: string
      direction: 'source' | 'target'
      itemId: string
      incarnationId?: string
      counterpartNodeId: string
      success: boolean
    },
  ): Promise<void> {
    await this.authority.applyClaimedHistory(root, async (tx) => {
      const doc = (
        await tx.query<{ catalog_id: string }>(
          `SELECT catalog_id FROM node_content.document_entries
        WHERE root_id=$1 AND incarnation_id=$2`,
          [root.rootId, input.incarnationId ?? null],
        )
      ).rows[0]
      if (input.success && !doc)
        throw new DocumentCatalogError('DOCUMENT_IDENTITY_STALE', 409, 'The copied document has not been projected.')
      const inserted = await tx.query(
        `INSERT INTO node_content.document_receipts(organization_id,root_id,runtime_id,operation_id,direction,
        item_id,counterpart_node_id,catalog_id,state,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
        ON CONFLICT(root_id,operation_id,direction,item_id) DO NOTHING RETURNING operation_id`,
        [
          root.organizationId,
          root.rootId,
          root.projectRuntimeId,
          input.operationId,
          input.direction,
          input.itemId,
          input.counterpartNodeId,
          doc?.catalog_id ?? null,
          input.success ? 'copied' : 'failed',
        ],
      )
      if (inserted.rowCount)
        await tx.query(
          `INSERT INTO node_content.document_events(organization_id,root_id,runtime_id,catalog_id,operation_id,
        actor_public_id,event_kind,occurred_at,detail) VALUES($1,$2,$3,$4,$5,$6,$7,now(),'{}')`,
          [
            root.organizationId,
            root.rootId,
            root.projectRuntimeId,
            doc?.catalog_id ?? null,
            input.operationId,
            actor,
            input.success ? (input.direction === 'source' ? 'copied-out' : 'copied-in') : 'denied',
          ],
        )
    })
  }

  private async ownerNames(ids: readonly (number | null)[]) {
    const unique = [...new Set(ids.filter((value): value is number => value !== null))]
    if (!unique.length) return new Map<number, string>()
    const rows = (
      await this.authority.context.pool.query<{ id: number; name: string }>(
        'SELECT public_id::float8 id,display_name name FROM harness.users WHERE organization_id=$1 AND public_id=ANY($2::bigint[])',
        [this.authority.context.organizationId, unique],
      )
    ).rows
    return new Map(rows.map((row) => [row.id, row.name]))
  }
}
