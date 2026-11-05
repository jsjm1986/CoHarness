/** Publish an empty personal UserDoc without changing its account, computer, directory or persistent file identities. */
import type { PoolClient } from 'pg'
import { transaction } from './postgres/database.ts'
import { DocumentCatalogError } from './postgres/document-catalog-service.ts'
import type { NodeDocumentAuthority } from './node-content-documents-authority.ts'
import type { DocumentRootWitness } from './node-content-documents-publication.ts'

/** Scoped predecessor inventory used to decide whether an empty root may publish automatically. */
export interface PersonalDocumentSource {
  fileCount: number
  historyCount: number
  transferCount: number
  checkpointCount: number
  identityMissing: number
}

/**
 * Count the retained predecessor. Older transfers without per-side computer identity require separate attribution.
 * @param tx - organization transaction protecting this account's directory.
 * @param org - organization UUID.
 * @param node - owning computer UUID.
 * @param owner - internal account UUID.
 * @returns source row counts, including obsolete records that prevent automatic publication.
 */
export async function personalDocumentSource(
  tx: PoolClient,
  org: string,
  node: string,
  owner: string,
): Promise<PersonalDocumentSource> {
  const row = (
    await tx.query<PersonalDocumentSource>(
      `WITH docs AS (SELECT id,runtime_incarnation_id,runtime_revision FROM harness.document_catalog
    WHERE organization_id=$1 AND node_id=$2 AND scope_kind='personal' AND scope_user_id=$3) SELECT
    (SELECT count(*)::float8 FROM docs) "fileCount",(SELECT count(*)::float8 FROM harness.document_history h JOIN docs ON docs.id=h.catalog_id WHERE h.organization_id=$1) "historyCount",
    (SELECT count(*)::float8 FROM harness.document_operations o WHERE o.organization_id=$1 AND $3::uuid IN(o.source_user_id,o.target_user_id)) "transferCount",
    (SELECT count(*)::float8 FROM harness.document_projection_checkpoints c WHERE c.organization_id=$1 AND c.node_id=$2 AND c.scope_kind='personal' AND c.scope_user_id=$3) "checkpointCount",
    (SELECT count(*)::float8 FROM docs WHERE runtime_incarnation_id IS NULL OR runtime_revision IS NULL) "identityMissing"`,
      [org, node, owner],
    )
  ).rows[0]
  if (!row) throw new DocumentCatalogError('DOCUMENT_STORE_UNAVAILABLE', 503, 'The original document index is unavailable.')
  return row
}

/**
 * Retain the account's computer grant and serialize the handoff with catalog writers.
 * @param tx - transaction that commits the publication or abandons it.
 * @param authority - Gateway serving this computer.
 * @param user - public account identifier on the request.
 * @returns the internal account UUID used in physical document ownership.
 */
export async function lockPersonalDocumentSource(
  tx: PoolClient,
  authority: NodeDocumentAuthority,
  user: number,
): Promise<string> {
  const { organizationId: org, nodeId: node } = authority.context
  const who = (
    await tx.query<{ id: string }>(
      `SELECT u.id FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id AND m.status='active'
    JOIN harness.node_user_accounts a ON a.organization_id=u.organization_id AND a.user_id=u.id AND a.node_id=$2
    JOIN harness.computer_use_permissions grant_row ON (grant_row.organization_id,grant_row.node_id,grant_row.user_id)=(a.organization_id,a.node_id,a.user_id) AND grant_row.enabled
    JOIN harness.compute_nodes n ON n.organization_id=a.organization_id AND n.id=a.node_id AND n.status='active'
    JOIN harness.organizations o ON o.id=u.organization_id AND o.status='active'
    WHERE u.organization_id=$1 AND u.public_id=$3 AND u.status='active' AND u.deleted_at IS NULL
      AND harness.computer_use_allowed($1,u.id,$2) FOR SHARE OF u,m,a,grant_row,n,o`,
      [org, node, user],
    )
  ).rows[0]
  if (!who) throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'The account needs access to this computer.')
  await tx.query(
    `INSERT INTO harness.document_scope_writers(organization_id,node_id,scope_kind,scope_id) VALUES($1,$2,'personal',$3) ON CONFLICT DO NOTHING`,
    [org, node, who.id],
  )
  await tx.query(
    `SELECT FROM harness.document_scope_writers WHERE organization_id=$1 AND node_id=$2 AND scope_kind='personal' AND scope_id=$3 FOR UPDATE`,
    [org, node, who.id],
  )
  return who.id
}

/**
 * Bind a proven UserDoc UUID to its original account and computer after the node-local data is available.
 * @param control - transaction holding the original scope and its current authorization.
 * @param authority - Gateway with a physically verified local database.
 * @param owner - internal account UUID.
 * @param witness - the filesystem owner's verified root and journal position.
 * @param beforePublication - durable import on the verified volume before the routing change commits.
 */
export async function publishPersonalDocumentIdentity(
  control: PoolClient,
  authority: NodeDocumentAuthority,
  owner: string,
  witness: DocumentRootWitness,
  beforePublication?: (volumeId: string) => Promise<void>,
): Promise<void> {
  const { organizationId: org, nodeId: node } = authority.context,
    store = authority.volume
  if (!store) throw new DocumentCatalogError('DOCUMENT_STORE_UNAVAILABLE', 503, 'This computer has no content volume.')
  const v = await store.writeVolume(async (tx) => {
    const volume = (
      await tx.query<{ volume_id: string; cluster_id: string; database_oid: string }>(
        'SELECT volume_id,cluster_id,database_oid::text FROM node_content.volume WHERE organization_id=$1 AND node_id=$2',
        [org, node],
      )
    ).rows[0]
    if (!volume)
      throw new DocumentCatalogError('DOCUMENT_STORE_UNAVAILABLE', 503, 'This computer does not own the selected volume.')
    const record = await tx.query(
      `INSERT INTO node_content.document_roots(organization_id,node_id,scope_kind,scope_id,root_id,volume_id,writer_epoch,sequence,ordinal)
      VALUES($1,$2,'personal',$3,$4,$5,1,$6,$7) ON CONFLICT(root_id) DO UPDATE SET root_id=excluded.root_id WHERE
        (document_roots.organization_id,document_roots.node_id,document_roots.scope_kind,document_roots.scope_id,document_roots.volume_id,
        document_roots.writer_epoch,document_roots.sequence,document_roots.ordinal)=(excluded.organization_id,excluded.node_id,excluded.scope_kind,
        excluded.scope_id,excluded.volume_id,excluded.writer_epoch,excluded.sequence,excluded.ordinal) AND document_roots.runtime_id IS NULL RETURNING revision`,
      [org, node, owner, witness.rootId, volume.volume_id, witness.head.sequence, witness.head.ordinal],
    )
    if (!record.rowCount)
      throw new DocumentCatalogError(
        'DOCUMENT_IDENTITY_STALE',
        409,
        'The personal document identity already belongs to another root.',
      )
    return { ...volume, revision: record.rows[0].revision }
  })
  const known = await control.query(
    `INSERT INTO harness.node_content_volumes(organization_id,node_id,volume_id,cluster_id,database_oid)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(volume_id) DO UPDATE SET cluster_id=excluded.cluster_id WHERE
    (node_content_volumes.organization_id,node_content_volumes.node_id,node_content_volumes.cluster_id,node_content_volumes.database_oid)=
    (excluded.organization_id,excluded.node_id,excluded.cluster_id,excluded.database_oid) RETURNING 1`,
    [org, node, v.volume_id, v.cluster_id, v.database_oid],
  )
  if (!known.rowCount)
    throw new DocumentCatalogError('DOCUMENT_STORE_UNAVAILABLE', 503, 'The selected content volume has a different owner.')
  await beforePublication?.(v.volume_id)
  await control.query(
    `INSERT INTO harness.document_scope_placement(organization_id,node_id,scope_kind,scope_id,root_id,volume_id,writer_epoch,publication_revision)
    VALUES($1,$2,'personal',$3,$4,$5,1,$6)`,
    [org, node, owner, witness.rootId, v.volume_id, v.revision],
  )
}

/**
 * Publish a new, empty personal directory or check the identity of one already published.
 * @param authority - Gateway owning this account's local directory.
 * @param user - public account identifier.
 * @param inspect - filesystem check at the requested journal position.
 */
export async function publishNewPersonalDocumentRoot(
  authority: NodeDocumentAuthority,
  user: number,
  inspect: (cursor: { sequence: number; ordinal: number }) => Promise<DocumentRootWitness>,
) {
  if (!authority.volume) return
  const { organizationId: org, nodeId: node } = authority.context
  await transaction(authority.context.pool, async (tx) => {
    const owner = await lockPersonalDocumentSource(tx, authority, user)
    const published = (
      await tx.query<{ root_id: string }>(
        `SELECT root_id FROM harness.document_scope_placement WHERE organization_id=$1 AND node_id=$2 AND scope_kind='personal' AND scope_id=$3`,
        [org, node, owner],
      )
    ).rows[0]
    if (published) {
      const cursor = await authority.volume!.readVolume(
        async (local) =>
          (
            await local.query<{ sequence: number; ordinal: number }>(
              'SELECT sequence::float8,ordinal FROM node_content.document_roots WHERE organization_id=$1 AND node_id=$2 AND root_id=$3 AND scope_id=$4 AND runtime_id IS NULL',
              [org, node, published.root_id, owner],
            )
          ).rows[0],
      )
      if (!cursor || (await inspect(cursor)).rootId !== published.root_id)
        throw new DocumentCatalogError(
          'DOCUMENT_IDENTITY_STALE',
          409,
          'The active UserDoc identity differs from its published scope.',
        )
      return
    }
    const prior = await personalDocumentSource(tx, org, node, owner)
    if (prior.fileCount || prior.historyCount || prior.transferCount || prior.checkpointCount) return
    const proof = await inspect({ sequence: 0, ordinal: 0 })
    if (!proof.empty || proof.pending || proof.head.sequence || proof.head.ordinal) return
    await publishPersonalDocumentIdentity(tx, authority, owner, proof)
  })
}
