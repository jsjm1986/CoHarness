/** A document root belongs to an account on one computer or a project on its published volume. */
import type { PoolClient } from 'pg'
import type { UserDocLocation } from '@deepseek-ai/dsh-userdoc'
import type { RuntimeId, RuntimeNodeId } from './runtime-catalog.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { DocumentCatalogError, type DocumentCatalogScope } from './postgres/document-catalog-service.ts'
import type { DocumentTransferScope } from './document-transfer.ts'
import type { NodeContentBinding, NodeContentStore } from './node-content-store.ts'

/** Opaque published identifiers. The file path and document owner history remain on the node. */
export interface DocumentPlacement {
  organizationId: string
  nodeId: string
  kind: 'personal' | 'project'
  scopeId: string
  publicId: number
  rootId: string
  volumeId: string
  writerEpoch: string
  nameVersion?: string | null
  projectRuntimeId: RuntimeId | null
}
export interface DocumentScopeGrant {
  placement: DocumentPlacement
  actor: number
  label: string
  role: 'admin' | 'member'
  mode: 'ro' | 'rw'
  projectOwner: boolean
}
interface LocationReader {
  resolve(actor: number, scope: DocumentTransferScope, action: 'read' | 'write'): Promise<UserDocLocation>
}

export function documentRootUnavailable(): never {
  throw new DocumentCatalogError(
    'DOCUMENT_STORE_UNAVAILABLE',
    503,
    'The designated document root is unavailable on its computer.',
  )
}

/** Resolve and revalidate current organization permissions for a physical document root. No Runtime is started. */
export class NodeDocumentAuthority {
  constructor(
    readonly context: PostgresRuntimeContext,
    private readonly locations: LocationReader,
    readonly volume?: Pick<NodeContentStore, 'read' | 'write' | 'readVolume' | 'writeVolume'>,
  ) {}

  /** Null is reserved for an unpublished legacy root; a published project can never fall back to the organization catalog. */
  async placement(scope: DocumentCatalogScope, nodeId = this.context.nodeId): Promise<DocumentPlacement | null> {
    const personal = scope.kind === 'personal'
    const result = await this.context.pool.query<DocumentPlacement & { projectPublished: boolean }>(
      `SELECT p.organization_id "organizationId",
      p.node_id "nodeId",p.scope_kind kind,p.scope_id "scopeId",s.public_id::float8 "publicId",p.root_id "rootId",p.volume_id "volumeId",
      p.writer_epoch::text "writerEpoch",p.project_runtime_id "projectRuntimeId",
      ${personal ? 'false' : 'EXISTS(SELECT FROM harness.project_content_placement c WHERE c.organization_id=s.organization_id AND c.project_id=s.id)'} "projectPublished"
      FROM harness.${personal ? 'users' : 'projects'} s LEFT JOIN harness.document_scope_placement p ON p.organization_id=s.organization_id
        AND p.scope_kind=$3 AND p.scope_id=s.id AND p.node_id=$2 WHERE s.organization_id=$1 AND s.public_id=$4`,
      [this.context.organizationId, nodeId, scope.kind, personal ? scope.userId : scope.projectId],
    )
    const row = result.rows[0]
    if (row?.rootId) return row
    if (row?.projectPublished) documentRootUnavailable()
    return null
  }

  /** Discover currently visible placements from opaque control records; aggregate callers group by node without contacting Runtimes. */
  async readable(actor: number, allNodes: boolean): Promise<DocumentScopeGrant[]> {
    const records = await this.context.pool.query<
      DocumentPlacement & { role: 'admin' | 'member'; mode: 'ro' | 'rw'; label: string; projectOwner: boolean }
    >(
      `WITH actor AS (
      SELECT u.id,m.role,u.organization_id FROM harness.users u JOIN harness.memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id
        AND m.status='active' JOIN harness.organizations o ON o.id=u.organization_id AND o.status='active'
      WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
    ) SELECT p.organization_id "organizationId",p.node_id "nodeId",p.scope_kind kind,p.scope_id "scopeId",p.root_id "rootId",p.volume_id "volumeId",
      p.project_runtime_id "projectRuntimeId",p.writer_epoch::text "writerEpoch",j.logical_name_id "nameVersion",coalesce(u.public_id,j.public_id)::float8 "publicId",
      CASE WHEN p.scope_kind='personal' THEN '个人文档' ELSE j.name::text END label, actor.role,
      CASE WHEN p.scope_kind='personal' OR actor.role='admin' THEN 'rw' ELSE m.access_mode END mode,coalesce(j.owner_user_id=actor.id,false) "projectOwner"
      FROM harness.document_scope_placement p JOIN actor ON actor.organization_id=p.organization_id
      LEFT JOIN harness.users u ON p.scope_kind='personal' AND u.organization_id=p.organization_id AND u.id=p.scope_id
      LEFT JOIN harness.projects j ON p.scope_kind='project' AND j.organization_id=p.organization_id AND j.id=p.scope_id
      LEFT JOIN harness.project_members m ON m.organization_id=j.organization_id AND m.project_id=j.id AND m.user_id=actor.id
      WHERE ($4 OR p.node_id=$3) AND harness.entry_node_visible(p.organization_id,$3,p.node_id)
        AND harness.computer_use_allowed(p.organization_id,actor.id,p.node_id) AND (
          p.scope_kind='personal' AND (p.scope_id=actor.id OR actor.role='admin') AND u.id IS NOT NULL OR
          p.scope_kind='project' AND j.status='active' AND harness.project_computer_use_allowed(p.organization_id,actor.id,j.id)
          AND (m.user_id IS NOT NULL OR actor.role='admin') AND (j.kind<>'steward' OR actor.role='admin' AND EXISTS(
            SELECT FROM harness.steward_access_policies s WHERE s.organization_id=p.organization_id AND s.node_id=p.node_id AND s.user_id=actor.id AND s.enabled)))
      ORDER BY p.node_id,p.root_id`,
      [this.context.organizationId, actor, this.context.nodeId, allNodes],
    )
    return records.rows.map(({ role, mode, label, projectOwner, ...placement }) => ({
      placement,
      role,
      mode,
      label,
      projectOwner,
      actor,
    }))
  }

  /** Recheck the account, serving computer and project role. Cross-account personal access requires an administrative operation. */
  async admit(
    actor: number,
    placement: DocumentPlacement,
    action: 'read' | 'write',
    administrator = false,
  ): Promise<DocumentScopeGrant> {
    if (placement.nodeId !== this.context.nodeId || placement.organizationId !== this.context.organizationId)
      documentRootUnavailable()
    const who = (
      await this.context.pool.query<{ role: 'admin' | 'member'; projectOwner: boolean }>(
        `SELECT m.role,
      EXISTS(SELECT FROM harness.projects p WHERE p.organization_id=u.organization_id AND p.id=$4 AND p.owner_user_id=u.id) "projectOwner"
      FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id AND m.status='active'
      JOIN harness.organizations o ON o.id=u.organization_id AND o.status='active' JOIN harness.compute_nodes n ON n.organization_id=o.id AND n.id=$3
      WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
        AND harness.entry_node_visible(u.organization_id,$3,$3)
        AND ($5 AND m.role='admin' OR harness.computer_use_allowed(u.organization_id,u.id,$3))`,
        [placement.organizationId, actor, placement.nodeId, placement.scopeId, administrator],
      )
    ).rows[0]
    if (!who || (administrator && who.role !== 'admin'))
      throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'Document access has been revoked.')
    if (placement.kind === 'personal' && actor !== placement.publicId) {
      if (!administrator || who.role !== 'admin')
        throw new DocumentCatalogError('DOCUMENT_NOT_OWNER', 403, 'This personal document belongs to another account.')
      return { placement, actor, label: '个人文档', role: who.role, mode: 'rw', projectOwner: false }
    }
    const scope: DocumentTransferScope =
      placement.kind === 'personal'
        ? { kind: 'personal', nodeId: placement.nodeId as RuntimeNodeId }
        : { kind: 'project', projectId: placement.publicId, nodeId: placement.nodeId as RuntimeNodeId }
    const location = await this.locations.resolve(actor, scope, action)
    return { placement, actor, role: who.role, mode: location.mode, label: location.name, projectOwner: who.projectOwner }
  }

  /** All reads verify the authoritative node. Writes recheck the account before committing the local revision. */
  async apply<T>(
    grant: DocumentScopeGrant,
    mutation: boolean,
    administrator: boolean,
    work: (tx: PoolClient) => Promise<T>,
    signal?: AbortSignal,
    permission: 'read' | 'write' = mutation ? 'write' : 'read',
  ): Promise<T> {
    return this.withRoot(
      grant.placement,
      mutation,
      async (tx) => {
        const result = await work(tx)
        signal?.throwIfAborted()
        await this.admit(grant.actor, grant.placement, permission, administrator)
        return result
      },
      signal,
    )
  }

  /** Persist the immutable history of an already admitted copy after the source actor may have left the organization. */
  async applyClaimedHistory<T>(root: DocumentPlacement, work: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.withRoot(root, true, work)
  }

  private async withRoot<T>(
    root: DocumentPlacement,
    mutation: boolean,
    work: (tx: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const store = this.volume
    if (!store || root.organizationId !== this.context.organizationId || root.nodeId !== this.context.nodeId)
      documentRootUnavailable()
    const local = async (tx: PoolClient) => {
      const checked = await tx.query(
        `SELECT FROM node_content.document_roots r JOIN node_content.volume v ON v.volume_id=r.volume_id AND v.node_id=r.node_id
        AND v.organization_id=r.organization_id WHERE r.organization_id=$1 AND r.node_id=$2 AND r.scope_kind=$3 AND r.scope_id=$4 AND r.root_id=$5
        AND r.volume_id=$6 AND r.writer_epoch=$7 AND r.runtime_id IS NOT DISTINCT FROM $8::uuid ${mutation ? 'FOR UPDATE OF r' : ''}`,
        [
          root.organizationId,
          root.nodeId,
          root.kind,
          root.scopeId,
          root.rootId,
          root.volumeId,
          root.writerEpoch,
          root.projectRuntimeId,
        ],
      )
      if (checked.rowCount !== 1) documentRootUnavailable()
      return work(tx)
    }
    if (!root.projectRuntimeId) return mutation ? store.writeVolume(local, signal) : store.readVolume(local, signal)
    const binding: NodeContentBinding = {
      organizationId: root.organizationId,
      nodeId: root.nodeId,
      projectId: root.scopeId,
      runtimeId: root.projectRuntimeId,
      writerEpoch: root.writerEpoch,
      volumeId: root.volumeId,
    }
    return mutation ? store.write(binding, local) : store.read(binding, local, signal)
  }
}
