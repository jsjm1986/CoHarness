/** Typed mapping for a physical document entry, shared by account and administrative reads. */
import type { DocumentCatalogRow } from './postgres/document-catalog-service.ts'
import type { DocumentScopeGrant } from './node-content-documents-authority.ts'
import type { RuntimeNodeId } from './runtime-catalog.ts'

export type NodeDocumentEntry = {
  catalog_id: string
  doc_id: string
  directory_id: string
  name: string
  bytes: number
  media_type: string
  modified_at_ms: number
  owner_public_id: number | null
  previously_legacy: boolean | null
  origin: DocumentCatalogRow['ownerSource']
  state: DocumentCatalogRow['state']
  incarnation_id: string
  revision: number
  trash_id: string | null
  trashed_at_ms: number | null
  restored_at_ms: number | null
  purge_after_ms: number | null
  purged_at_ms: number | null
  lineage_root_id: string | null
}
export const nodeDocumentColumns = `catalog_id,doc_id,directory_id,name,bytes::float8,media_type,modified_at_ms::float8,
  owner_public_id::float8,origin,state,incarnation_id,revision::float8,trash_id,trashed_at_ms::float8,restored_at_ms::float8,
  purge_after_ms::float8,purged_at_ms::float8,lineage_root_id,previously_legacy`
export function nodeDocumentRow(
  row: NodeDocumentEntry,
  grant: DocumentScopeGrant,
  names: Map<number, string>,
): DocumentCatalogRow {
  const scope = grant.placement
  const displayName = row.owner_public_id === null ? undefined : names.get(row.owner_public_id)
  return {
    catalogId: row.catalog_id,
    scope: {
      kind: scope.kind,
      id: scope.publicId,
      nodeId: scope.nodeId as RuntimeNodeId,
      label: grant.label,
      ...(scope.kind === 'project' ? { mode: grant.mode } : {}),
    },
    docId: row.doc_id,
    directoryId: row.directory_id,
    name: row.name,
    bytes: row.bytes,
    mediaType: row.media_type,
    modifiedAt: row.modified_at_ms,
    owner: row.owner_public_id !== null && displayName !== undefined ? { id: row.owner_public_id, displayName } : null,
    ownerSource: row.origin,
    state: row.state,
    identity: { incarnationId: row.incarnation_id, revision: row.revision },
    trashId: row.trash_id,
    trashedAt: row.trashed_at_ms,
    restoredAt: row.restored_at_ms,
    purgeAfter: row.purge_after_ms,
    purgedAt: row.purged_at_ms,
    lineageRootId: row.lineage_root_id,
    legacy: row.previously_legacy ?? row.origin === 'legacy',
  }
}
