/** Administrator document rows, counters, addresses and operation history on the assigned physical computer. */
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import {
  DocumentCatalogError,
  type DocumentCatalogAdminFilter,
  type DocumentCatalogAdminPage,
  type DocumentCatalogDetail,
  type DocumentCatalogMetrics,
  type DocumentCatalogRow,
  type DocumentCatalogTarget,
} from './postgres/document-catalog-service.ts'
import { type NodeDocumentEntry, nodeDocumentColumns, nodeDocumentRow } from './node-content-documents-row.ts'
import {
  type DocumentPlacement,
  type DocumentScopeGrant,
  NodeDocumentAuthority,
  documentRootUnavailable,
} from './node-content-documents-authority.ts'

export const documentUpdateTime = Symbol('Precise catalog update time')
type TimedRow = DocumentCatalogRow & { [documentUpdateTime]?: number }
type AdminEntry = NodeDocumentEntry & { root_id: string; sort_time: number; label: string | null }
type Names = (ids: readonly (number | null)[]) => Promise<Map<number, string>>
const selected = nodeDocumentColumns
  .split(',')
  .map((column) => 'd.' + column.trim())
  .join(',')
const emptyMetrics = (): DocumentCatalogMetrics => ({
  total: 0,
  active: 0,
  trash: 0,
  purged: 0,
  deleted: 0,
  personal: 0,
  project: 0,
  bytes: 0,
  operations24h: 0,
  failures24h: 0,
})
const cursor = z.tuple([
  z.literal('node-doc-admin'),
  z.string(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
])
const changed = () =>
  new DocumentCatalogError('DOCUMENT_DIRECTORY_CHANGED', 409, 'The document directory changed. Refresh to continue.')

/** One active administrator and the current entry scope are required, including on a second read after an independent node query. */
export class NodeDocumentAdmin {
  constructor(
    private readonly authority: NodeDocumentAuthority,
    private readonly names: Names,
  ) {}

  private async placements(actor?: number): Promise<Map<string, DocumentScopeGrant>> {
    const db = this.authority.context
    if (actor === undefined) {
      const any = await db.pool.query(
        'SELECT FROM harness.document_scope_placement WHERE organization_id=$1 AND node_id=$2 LIMIT 1',
        [db.organizationId, db.nodeId],
      )
      if (any.rowCount)
        throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'A current administrator is required.')
      return new Map()
    }
    const result = await db.pool.query<DocumentPlacement & { admitted: boolean }>(
      `WITH actor AS (SELECT FROM harness.users u
      JOIN harness.organizations o ON o.id=u.organization_id AND o.status='active' JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      WHERE u.organization_id=$1 AND u.public_id=$3 AND u.status='active' AND u.deleted_at IS NULL AND m.role='admin' AND m.status='active'),
      roots AS (SELECT p.organization_id "organizationId",p.node_id "nodeId",p.scope_kind kind,p.scope_id "scopeId",
      coalesce(u.public_id,j.public_id)::float8 "publicId",p.root_id "rootId",j.logical_name_id "nameVersion",p.volume_id "volumeId",p.writer_epoch::text "writerEpoch",p.project_runtime_id "projectRuntimeId"
      FROM harness.document_scope_placement p LEFT JOIN harness.users u ON p.scope_kind='personal' AND p.scope_id=u.id AND u.organization_id=p.organization_id
      LEFT JOIN harness.projects j ON p.scope_kind='project' AND p.scope_id=j.id AND j.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.node_id=$2 AND harness.entry_node_visible(p.organization_id,$2,p.node_id) AND EXISTS(TABLE actor))
      SELECT EXISTS(TABLE actor) admitted,r.* FROM (VALUES(1)) x LEFT JOIN roots r ON true ORDER BY r."rootId"`,
      [db.organizationId, db.nodeId, actor],
    )
    if (!result.rows[0]?.admitted)
      throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'A current administrator is required.')
    return new Map(
      result.rows
        .filter((row) => row.rootId)
        .map((placement) => [
          placement.rootId,
          {
            placement,
            actor,
            label: placement.kind === 'personal' ? '个人文档' : '项目文档',
            role: 'admin',
            mode: 'rw',
            projectOwner: false,
          },
        ]),
    )
  }

  private async read<T>(
    actor: number | undefined,
    work: (tx: PoolClient, roots: Map<string, DocumentScopeGrant>) => Promise<T>,
  ): Promise<T | undefined> {
    const roots = await this.placements(actor)
    if (!roots.size) return undefined
    const db = this.authority.volume
    if (!db) documentRootUnavailable()
    let result: T
    try {
      result = await db.readVolume(async (tx) => {
        const verified = await tx.query<{ root_id: string; label: string | null }>(
          `SELECT r.root_id,CASE WHEN s.project_id IS NOT NULL THEN node_content.project_name_at(r.organization_id,r.scope_id,r.runtime_id,names.version) END label
          FROM node_content.document_roots r JOIN unnest($3::uuid[],$4::uuid[]) names(id,version) ON names.id=r.root_id
          JOIN node_content.volume v ON v.organization_id=r.organization_id AND v.volume_id=r.volume_id AND v.node_id=r.node_id
          LEFT JOIN node_content.spaces s ON s.organization_id=r.organization_id AND s.runtime_id=r.runtime_id
          WHERE r.organization_id=$1 AND r.node_id=$2 AND r.root_id=ANY($3::uuid[]) AND
           (r.scope_kind='personal' OR (s.publication_state='published' AND s.writer_epoch=r.writer_epoch AND NOT EXISTS(
             SELECT FROM node_content.recovery_candidates rc WHERE rc.organization_id=s.organization_id AND rc.runtime_id=s.runtime_id AND rc.phase<>'active')))`,
          [
            this.authority.context.organizationId,
            this.authority.context.nodeId,
            [...roots.keys()],
            [...roots.values()].map((g) => g.placement.nameVersion ?? null),
          ],
        )
        if (verified.rowCount !== roots.size) documentRootUnavailable()
        for (const row of verified.rows) if (row.label !== null) roots.get(row.root_id)!.label = row.label
        return work(tx, roots)
      })
    } catch (error) {
      if (error instanceof DocumentCatalogError) throw error
      documentRootUnavailable()
    }
    const current = await this.placements(actor)
    if (
      roots.size !== current.size ||
      [...roots].some(
        ([key, g]) =>
          current.get(key)?.placement.writerEpoch !== g.placement.writerEpoch ||
          current.get(key)?.placement.nameVersion !== g.placement.nameVersion,
      )
    )
      throw changed()
    return result
  }

  async page(
    actor: number | undefined,
    filter: DocumentCatalogAdminFilter,
    legacy: (offset: number, limit: number) => Promise<readonly TimedRow[]>,
  ): Promise<DocumentCatalogAdminPage | undefined> {
    return this.read(actor, async (tx, roots) => {
      const size = filter.limit ?? 200
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            actor,
            this.authority.context.organizationId,
            this.authority.context.nodeId,
            ...roots.keys(),
            filter.scopeKind,
            filter.projectId,
            filter.ownerUserId,
            filter.state,
            filter.query?.trim(),
          ]),
        )
        .digest('base64url')
      let lo = 0,
        no = 0,
        skip = filter.offset ?? 0
      if (filter.cursor) {
        try {
          const token = cursor.parse(JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8')))
          if (token[1] !== fingerprint) throw changed()
          lo = token[2]
          no = token[3]
          skip = 0
        } catch {
          throw changed()
        }
      }
      const ids = [...roots.values()]
        .filter(
          (g) =>
            (!filter.scopeKind || g.placement.kind === filter.scopeKind) &&
            (filter.projectId === undefined ||
              (g.placement.kind === 'project' && g.placement.publicId === filter.projectId)),
        )
        .map((g) => g.placement.rootId)
      const take = Math.max(2, Math.min(1000, size + 1))
      let old: readonly TimedRow[] = [],
        oi = 0,
        node: AdminEntry[] = [],
        ni = 0,
        oldDone = false,
        nodeDone = false
      const result: TimedRow[] = []
      const pending: { index: number; entry: AdminEntry; grant: DocumentScopeGrant }[] = []
      let more = false
      for (;;) {
        if (oi === old.length && !oldDone) {
          old = await legacy(lo, take)
          oi = 0
          oldDone = old.length < take
        }
        if (ni === node.length && !nodeDone) {
          node = (
            await tx.query<AdminEntry>(
              `SELECT d.root_id,${selected},(extract(epoch FROM d.updated_at)*1000000)::float8 sort_time
            FROM node_content.document_entries d WHERE d.root_id=ANY($1::uuid[]) AND ($2::text IS NULL OR d.state=$2)
              AND ($3::bigint IS NULL OR d.owner_public_id=$3) AND (strpos(lower(d.doc_id),lower($4))>0 OR strpos(lower(d.name),lower($4))>0)
            ORDER BY d.updated_at DESC,d.catalog_id LIMIT $5 OFFSET $6`,
              [
                ids,
                filter.state === 'all' ? null : filter.state === 'deleted' ? 'trash' : (filter.state ?? null),
                filter.ownerUserId ?? null,
                filter.query?.trim() ?? '',
                take,
                no,
              ],
            )
          ).rows
          ni = 0
          nodeDone = node.length < take
        }
        const a = old[oi],
          b = node[ni]
        if (!a && !b) break
        if (result.length === size) {
          more = true
          break
        }
        const first =
          !!a &&
          (!b ||
            (a[documentUpdateTime] ?? a.modifiedAt * 1000) > b.sort_time ||
            ((a[documentUpdateTime] ?? a.modifiedAt * 1000) === b.sort_time && a.catalogId < b.catalog_id))
        if (first) {
          oi++
          lo++
        } else {
          ni++
          no++
        }
        if (skip) {
          skip--
          continue
        }
        if (first) result.push(a!)
        else {
          const g = roots.get(b!.root_id)!
          pending.push({ index: result.length, entry: b!, grant: g })
          result.push(nodeDocumentRow(b!, g, new Map()))
        }
      }
      const names = await this.names(pending.map((item) => item.entry.owner_public_id))
      for (const item of pending) result[item.index] = nodeDocumentRow(item.entry, item.grant, names)
      return {
        documents: result,
        ...(more
          ? { nextCursor: Buffer.from(JSON.stringify(['node-doc-admin', fingerprint, lo, no])).toString('base64url') }
          : {}),
      }
    })
  }

  async metrics(actor?: number): Promise<DocumentCatalogMetrics | undefined> {
    return this.read(actor, async (tx, roots) => {
      const ids = [...roots.keys()]
      const r = (
        await tx.query<Record<string, number>>(
          `SELECT count(*)::float8 total,count(*) FILTER(WHERE d.state='active')::float8 active,
        count(*) FILTER(WHERE d.state='trash')::float8 trash,count(*) FILTER(WHERE d.state='purged')::float8 purged,
        count(*) FILTER(WHERE d.state<>'active')::float8 deleted,count(*) FILTER(WHERE r.scope_kind='personal' AND d.state='active')::float8 personal,
        count(*) FILTER(WHERE r.scope_kind='project' AND d.state='active')::float8 project,coalesce(sum(d.bytes) FILTER(WHERE d.state='active'),0)::float8 bytes,
        (SELECT count(DISTINCT operation_id)::float8 FROM node_content.document_receipts WHERE root_id=ANY($1::uuid[]) AND occurred_at>now()-interval '24 hours') "operations24h",
        (SELECT count(DISTINCT operation_id)::float8 FROM node_content.document_receipts WHERE root_id=ANY($1::uuid[]) AND state='failed' AND occurred_at>now()-interval '24 hours') "failures24h"
        FROM node_content.document_entries d JOIN node_content.document_roots r USING(root_id) WHERE d.root_id=ANY($1::uuid[])`,
          [ids],
        )
      ).rows[0]
      return Object.assign(emptyMetrics(), r)
    })
  }

  async lookup(actor: number | undefined, id: string, full: boolean): Promise<DocumentCatalogDetail | null | undefined> {
    return this.read(actor, async (tx, roots) => {
      const entry = (
        await tx.query<AdminEntry>(
          `SELECT d.root_id,${selected} FROM node_content.document_entries d
        WHERE d.root_id=ANY($1::uuid[]) AND d.catalog_id=$2`,
          [[...roots.keys()], id],
        )
      ).rows[0]
      if (!entry) return null
      const g = roots.get(entry.root_id)!
      const events = full
        ? (
            await tx.query<{
              id: number
              kind: string
              actor: number | null
              op: string | null
              detail: unknown
              at: number
            }>(
              `SELECT id::float8,event_kind kind,actor_public_id::float8 actor,
        operation_id op,detail,(extract(epoch FROM occurred_at)*1000)::float8 at FROM node_content.document_events WHERE root_id=$1 AND catalog_id=$2 ORDER BY id DESC LIMIT 500`,
              [entry.root_id, id],
            )
          ).rows
        : []
      const copies = full
        ? (
            await tx.query<{ op: string; state: string; at: number; direction: string }>(
              `SELECT operation_id op,state,
        (extract(epoch FROM occurred_at)*1000)::float8 at,direction FROM node_content.document_receipts WHERE root_id=$1 AND catalog_id=$2 ORDER BY occurred_at DESC LIMIT 500`,
              [entry.root_id, id],
            )
          ).rows
        : []
      const people = await this.names([entry.owner_public_id, ...events.map((item) => item.actor)])
      return {
        document: nodeDocumentRow(entry, g, people),
        history: events.map((item) => ({
          id: item.id,
          eventKind: item.kind,
          actor:
            item.actor !== null && people.has(item.actor)
              ? {
                  id: item.actor,
                  displayName: people.get(item.actor)!,
                }
              : null,
          operationId: item.op,
          detail: item.detail,
          createdAt: item.at,
        })),
        copies: copies.map((item) => ({
          operationId: item.op,
          status: item.state,
          source: { name: entry.name, docId: entry.doc_id },
          targetDocId: item.direction === 'target' ? entry.doc_id : null,
          error: item.state === 'failed' ? { code: 'DOCUMENT_TRANSFER_FAILED', message: 'Document transfer failed.' } : null,
          createdAt: item.at,
        })),
      }
    })
  }

  target(row: DocumentCatalogRow): DocumentCatalogTarget {
    if (!row.scope.id) documentRootUnavailable()
    return {
      catalogId: row.catalogId,
      scope:
        row.scope.kind === 'personal'
          ? { kind: 'personal', userId: row.scope.id }
          : { kind: 'project', projectId: row.scope.id },
      docId: row.docId,
      directoryId: row.directoryId,
      name: row.name,
      state: row.state,
      ...(row.identity ? { identity: row.identity } : {}),
      ...(row.trashId ? { trashId: row.trashId } : {}),
    }
  }
}
