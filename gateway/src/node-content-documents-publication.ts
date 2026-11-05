/** Publish a checked filesystem identity and its local catalog under the same governance and content transactions. */
import { createHash } from 'node:crypto'
import { recordNodeContentDomainReceipt, type NodeContentCheckInput } from './node-content-publication.ts'
import { NodeContentUnavailable } from './node-content-store.ts'
import type { ProjectOrigin } from './projects.ts'

export interface DocumentRootProbe {
  organizationId: string
  nodeId: string
  projectPublicId: number
  origin: ProjectOrigin
  projectPath: string
  cursor: { sequence: number; ordinal: number }
}
export interface DocumentRootWitness {
  rootId: string
  head: { sequence: number; ordinal: number }
  pending: boolean
  empty: boolean
}
export type DocumentRootInspector = (request: DocumentRootProbe) => Promise<DocumentRootWitness>

function unavailable(message: string): never {
  throw new NodeContentUnavailable(message)
}

/** A new root must be empty on disk. A migrated root needs its verified source receipt, caught-up outbox and exact local root identity. */
export async function verifyDocumentPublication(input: NodeContentCheckInput, inspect?: DocumentRootInspector) {
  if (!inspect) unavailable('The owning filesystem document service is unavailable.')
  const { control, local, binding: b } = input
  const source = (
    await control.query<{ id: number; origin: ProjectOrigin }>(
      `SELECT p.public_id::float8 id,p.origin FROM harness.projects p
    JOIN harness.runtime_environments r ON r.owner_kind='project' AND r.owner_id=p.id AND r.organization_id=p.organization_id AND r.id=$3 AND r.node_id=$4
    WHERE p.organization_id=$1 AND p.id=$2 AND r.retired_at IS NULL FOR SHARE OF p,r`,
      [b.organizationId, b.projectId, b.runtimeId, b.nodeId],
    )
  ).rows[0]
  const space = (
    await local.query<{ root_path: string }>(
      `SELECT root_path FROM node_content.spaces WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3
    AND node_id=$4 AND volume_id=$5 AND writer_epoch=$6 FOR UPDATE`,
      [b.organizationId, b.projectId, b.runtimeId, b.nodeId, b.volumeId, b.writerEpoch],
    )
  ).rows[0]
  if (!source || !space) unavailable('The document scope does not match its project allocation.')
  await control.query("SELECT harness.lock_document_scope_writer($1,$2,'project',$3,true)", [
    b.organizationId,
    b.nodeId,
    b.projectId,
  ])
  const old = (
    await control.query(
      `SELECT EXISTS(SELECT FROM harness.document_catalog WHERE organization_id=$1 AND scope_project_id=$2)
    OR EXISTS(SELECT FROM harness.document_projection_checkpoints WHERE organization_id=$1 AND scope_project_id=$2)
    OR EXISTS(SELECT FROM harness.document_operations WHERE organization_id=$1 AND (source_project_id=$2 OR target_project_id=$2)) retained`,
      [b.organizationId, b.projectId],
    )
  ).rows[0]
  if (old?.retained) unavailable('The shared document catalog or transfer history has not been reconciled.')
  const prior = (
    await local.query<{ root_id: string; sequence: number; ordinal: number; revision: string }>(
      `SELECT root_id,sequence::float8,ordinal,revision::text
    FROM node_content.document_roots WHERE organization_id=$1 AND scope_kind='project' AND scope_id=$2 AND node_id=$3
    AND runtime_id=$4 AND volume_id=$5 AND writer_epoch=$6 FOR UPDATE`,
      [b.organizationId, b.projectId, b.nodeId, b.runtimeId, b.volumeId, b.writerEpoch],
    )
  ).rows[0]
  const cursor = prior ? { sequence: prior.sequence, ordinal: prior.ordinal } : { sequence: 0, ordinal: 0 }
  const witness = await inspect({
    organizationId: b.organizationId,
    nodeId: b.nodeId,
    projectPublicId: source.id,
    origin: source.origin,
    projectPath: space.root_path,
    cursor,
  })
  if (
    witness.pending ||
    witness.head.sequence !== cursor.sequence ||
    witness.head.ordinal !== cursor.ordinal ||
    (prior && prior.root_id !== witness.rootId) ||
    (!prior && !witness.empty)
  )
    unavailable('The document filesystem and local catalog do not share a verified checkpoint.')
  if (input.migration && !witness.empty) {
    const verified = await local.query(
      `SELECT FROM node_content.migration_domain_receipts WHERE snapshot_id=$1 AND domain='documents'
      AND source_revision=$2 AND records>0`,
      [input.migration.snapshotId, input.migration.sourceRevision],
    )
    if (!prior || !verified.rowCount) unavailable('Document history and local files require independent migration evidence.')
  }
  if (input.migration && witness.empty) {
    const evidence = JSON.stringify([
      b.organizationId,
      b.nodeId,
      b.projectId,
      b.runtimeId,
      b.volumeId,
      b.writerEpoch,
      witness.rootId,
      cursor.sequence,
      cursor.ordinal,
    ])
    await recordNodeContentDomainReceipt(local, {
      snapshotId: input.migration.snapshotId,
      domain: 'documents',
      sourceRevision: input.migration.sourceRevision,
      digest: createHash('sha256').update(evidence).digest(),
      records: 0,
    })
  }
  if (!prior)
    await local.query(
      `INSERT INTO node_content.document_roots(organization_id,node_id,scope_kind,scope_id,root_id,volume_id,runtime_id,writer_epoch)
    VALUES($1,$2,'project',$3,$4,$5,$6,$7)`,
      [b.organizationId, b.nodeId, b.projectId, witness.rootId, b.volumeId, b.runtimeId, b.writerEpoch],
    )
  await control.query(
    `INSERT INTO harness.document_scope_placement(organization_id,node_id,scope_kind,scope_id,root_id,volume_id,project_runtime_id,writer_epoch,publication_revision)
    VALUES($1,$2,'project',$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,node_id,scope_kind,scope_id) DO NOTHING`,
    [
      b.organizationId,
      b.nodeId,
      b.projectId,
      witness.rootId,
      b.volumeId,
      b.runtimeId,
      b.writerEpoch,
      prior?.revision ?? '0',
    ],
  )
  const confirmed = await control.query(
    `SELECT FROM harness.document_scope_placement WHERE organization_id=$1 AND node_id=$2 AND scope_kind='project'
    AND scope_id=$3 AND root_id=$4 AND volume_id=$5 AND project_runtime_id=$6 AND writer_epoch=$7`,
    [b.organizationId, b.nodeId, b.projectId, witness.rootId, b.volumeId, b.runtimeId, b.writerEpoch],
  )
  if (!confirmed.rowCount) unavailable('The organization document placement differs from the verified file owner.')
}
