/** Explicit, evidence-bound publication of an existing personal catalog on its original computer. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { transaction } from './postgres/database.ts'
import { DocumentCatalogError } from './postgres/document-catalog-service.ts'
import {
  lockPersonalDocumentSource,
  personalDocumentSource,
  publishPersonalDocumentIdentity,
} from './node-content-personal-documents.ts'
import type { NodeDocumentAuthority } from './node-content-documents-authority.ts'
import type { DocumentRootWitness } from './node-content-documents-publication.ts'
import type { PeerProjectFileGate } from './peer-backup-file-gate.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

/** Current file incarnations and the exact projection position they represent. */
export interface PersonalDocumentHistoryWitness extends DocumentRootWitness {
  records: readonly {
    incarnationId: string
    revision: number
    docId: string
    state: string
    bytes: number
    mediaType: string
    trashId: string | null
  }[]
}
/** Local file owner and cross-process write exclusion for this computer’s personal roots. */
export interface PersonalDocumentMigrationOwner {
  inspect(
    owner: number,
    maxRows: number,
    cursor: { sequence: number; ordinal: number },
  ): Promise<PersonalDocumentHistoryWitness>
  gate: Pick<PeerProjectFileGate, 'exclusive'>
}
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const limits = z
  .object({
    nodeId: z.uuid(),
    maxRows: z.number().int().min(1).max(100000),
    maxBytes: z
      .number()
      .int()
      .min(1024)
      .max(512 * 1024 * 1024),
  })
  .strict()
const approval = limits.extend({ rootId: z.uuid(), catalogDigest: digest, physicalDigest: digest }).strict()
type Choices = z.infer<typeof limits>
const unavailable = (message: string): never => {
  throw new DocumentCatalogError('DOCUMENT_MIGRATION_UNAVAILABLE', 409, message)
}
const rowSig = (id: string, rev: number, path: string, state: string, bytes: number, media: string, trash: string | null) =>
  JSON.stringify([id, rev, path, state, bytes, media, trash])

const entryProjection = `SELECT row_to_json(r)::text body FROM(SELECT d.id catalog_id,d.organization_id,$4::uuid root_id,NULL::uuid runtime_id,d.runtime_incarnation_id incarnation_id,
            d.runtime_revision revision,d.runtime_doc_id doc_id,d.directory_id,d.name,d.bytes,d.media_type,d.modified_at_ms,u.public_id owner_public_id,d.owner_source origin,d.state,
            d.trash_action_id::text trash_id,(extract(epoch FROM d.trashed_at)*1000)::bigint trashed_at_ms,(extract(epoch FROM d.purge_after)*1000)::bigint purge_after_ms,
            (extract(epoch FROM d.restored_at)*1000)::bigint restored_at_ms,(extract(epoch FROM d.purged_at)*1000)::bigint purged_at_ms,d.updated_at,d.lineage_root_id,
            d.source_catalog_id,d.legacy previously_legacy FROM harness.document_catalog d LEFT JOIN harness.users u ON u.organization_id=d.organization_id AND u.id=d.owner_user_id
            WHERE d.organization_id=$1 AND d.node_id=$2 AND d.scope_kind='personal' AND d.scope_user_id=$3 ORDER BY d.id) r`
const eventProjection = `SELECT row_to_json(r)::text body FROM(SELECT h.organization_id,$4::uuid root_id,NULL::uuid runtime_id,h.id,h.catalog_id,h.operation_id,
            u.public_id actor_public_id,h.event_kind,h.created_at occurred_at,h.detail FROM harness.document_history h JOIN harness.document_catalog d ON d.id=h.catalog_id AND d.organization_id=h.organization_id
            LEFT JOIN harness.users u ON u.organization_id=h.organization_id AND u.id=h.actor_user_id WHERE d.organization_id=$1 AND d.node_id=$2 AND d.scope_kind='personal'
            AND d.scope_user_id=$3 ORDER BY h.id) r`

/** Admin approval is bound to one account, node, immutable filesystem UUID, exact original rows and current UserDoc journal position. */
export class PersonalDocumentMigration {
  constructor(
    private readonly authority: NodeDocumentAuthority,
    private readonly owner?: PersonalDocumentMigrationOwner,
  ) {}

  private async inspect(tx: PoolClient, actor: number, user: number, choices: Choices) {
    const { organizationId: org, nodeId } = this.authority.context
    if (!this.authority.volume || !this.owner || choices.nodeId !== nodeId)
      unavailable('Select this account’s owning computer and configured content volume.')
    await lockAdministrator(tx, this.authority.context, actor)
    const scope = await lockPersonalDocumentSource(tx, this.authority, user)
    const known = (
      await tx.query(
        `SELECT root_id FROM harness.document_scope_placement WHERE organization_id=$1 AND node_id=$2 AND scope_id=$3 AND scope_kind='personal'`,
        [org, nodeId, scope],
      )
    ).rows[0]
    const prior = await personalDocumentSource(tx, org, nodeId, scope)
    const blockers: string[] = []
    if (known) blockers.push('already-published')
    if (prior.transferCount) blockers.push('legacy-transfers-require-attribution')
    if (prior.identityMissing) blockers.push('original-incarnation-missing')
    if (prior.fileCount + prior.historyCount > choices.maxRows) blockers.push('row-budget')
    if (prior.checkpointCount !== 1) blockers.push('single-checkpoint-required')
    if (blockers.length) return { user, scope, prior, blockers, rootId: known?.root_id as string | undefined }
    const checkpoint = (
      await tx.query(
        "SELECT root_id,sequence::text,ordinal FROM harness.document_projection_checkpoints WHERE organization_id=$1 AND node_id=$2 AND scope_kind='personal' AND scope_user_id=$3",
        [org, nodeId, scope],
      )
    ).rows[0]
    if (!checkpoint) unavailable('The document checkpoint is unavailable.')
    const projected = await tx.query<{ bytes: string }>(
      'SELECT coalesce(sum(octet_length(body)),0)::text bytes FROM ((' +
        entryProjection +
        ') UNION ALL (' +
        eventProjection +
        ')) selected',
      [org, nodeId, scope, checkpoint.root_id],
    )
    if (BigInt(projected.rows[0]!.bytes) > BigInt(choices.maxBytes)) {
      blockers.push('byte-budget')
      return { user, scope, prior, blockers, rootId: checkpoint.root_id as string }
    }
    const proof = await this.owner!.inspect(user, choices.maxRows, {
      sequence: Number(checkpoint.sequence),
      ordinal: checkpoint.ordinal,
    })
    if (
      !checkpoint ||
      checkpoint.root_id !== proof.rootId ||
      String(proof.head.sequence) !== checkpoint.sequence ||
      proof.head.ordinal !== checkpoint.ordinal ||
      proof.pending
    )
      blockers.push('file-journal-not-reconciled')
    const physical = new Map(
      proof.records.map((row) => [
        row.incarnationId,
        rowSig(row.incarnationId, row.revision, row.docId, row.state, row.bytes, row.mediaType, row.trashId),
      ]),
    )
    const items = (
      await tx.query(
        `SELECT runtime_incarnation_id id,runtime_revision::float8 revision,runtime_doc_id path,state,bytes::float8 bytes,media_type media,trash_action_id trash
      FROM harness.document_catalog WHERE organization_id=$1 AND node_id=$2 AND scope_kind='personal' AND scope_user_id=$3 ORDER BY runtime_incarnation_id`,
        [org, nodeId, scope],
      )
    ).rows
    if (
      physical.size !== proof.records.length ||
      physical.size !== items.length ||
      items.some(
        (row) => physical.get(row.id) !== rowSig(row.id, row.revision, row.path, row.state, row.bytes, row.media, row.trash),
      )
    )
      blockers.push('catalog-file-version-mismatch')
    const catalogDigest = (
      await tx.query('SELECT harness.personal_document_source_digest($1,$2,$3) digest', [org, nodeId, scope])
    ).rows[0]!.digest as string
    const physicalDigest = createHash('sha256')
      .update(JSON.stringify([org, nodeId, scope, proof.rootId, proof.head, ...[...physical.values()].sort()]))
      .digest('hex')
    const staged = await this.authority.volume!.readVolume(
      async (local) =>
        (
          await local.query(
            `SELECT d.root_id,d.sequence::text,d.ordinal,i.catalog_digest,i.physical_digest FROM node_content.document_roots d
       LEFT JOIN node_content.personal_document_imports i ON i.organization_id=d.organization_id AND i.root_id=d.root_id
       WHERE d.organization_id=$1 AND d.node_id=$2 AND d.scope_kind='personal' AND d.scope_id=$3`,
            [org, nodeId, scope],
          )
        ).rows[0],
    )
    if (
      staged &&
      (staged.root_id !== proof.rootId ||
        staged.sequence !== String(proof.head.sequence) ||
        staged.ordinal !== proof.head.ordinal ||
        (staged.catalog_digest !== null &&
          (staged.catalog_digest !== catalogDigest || staged.physical_digest !== physicalDigest)))
    ) {
      blockers.push('staged-history-needs-reconciliation')
    }
    return { user, scope, prior, blockers, rootId: proof.rootId, proof, catalogDigest, physicalDigest }
  }
  /**
   * Compare the retained catalog, physical file identities, and any staged import.
   * @param actor - authenticated public administrator ID.
   * @param user - public ID of the account whose files remain on this computer.
   * @param raw - selected computer and maximum rows and bytes for this inspection.
   * @returns source counts, blockers and fingerprints to use when publishing this selection.
   */
  async preflight(actor: number, user: number, raw: unknown) {
    const parsed = limits.safeParse(raw)
    if (!parsed.success)
      throw new DocumentCatalogError('DOCUMENT_MIGRATION_INPUT', 400, 'Select a computer and valid inspection limits.')
    const choices = parsed.data
    const check = await transaction(this.authority.context.pool, (db) => this.inspect(db, actor, user, choices))
    return {
      nodeId: choices.nodeId,
      user,
      rootId: check.rootId,
      counts: check.prior,
      blockers: check.blockers,
      catalogDigest: check.catalogDigest,
      physicalDigest: check.physicalDigest,
      ready: !check.blockers.length,
    }
  }
  /**
   * Publish an inspected root while the current authorization and the file-writer lock are held.
   * @param actor - authenticated public administrator ID.
   * @param user - public ID of the original account.
   * @param raw - confirmed scope, budgets, root UUID and both fingerprints returned by preflight.
   * @returns the original UserDoc UUID and its newly published placement.
   */
  async publish(actor: number, user: number, raw: unknown) {
    const parsed = approval.safeParse(raw)
    if (!parsed.success)
      throw new DocumentCatalogError('DOCUMENT_MIGRATION_INPUT', 400, 'Select the complete personal document preflight.')
    const selected = parsed.data,
      { nodeId, maxRows, maxBytes } = selected,
      org = this.authority.context.organizationId
    if (!this.owner || !this.authority.volume) unavailable('This computer has no personal document migration service.')
    return this.owner!.gate.exclusive(user, () =>
      transaction(this.authority.context.pool, async (control) => {
        const checked = await this.inspect(control, actor, user, { nodeId, maxRows, maxBytes })
        if (
          !checked.proof ||
          checked.blockers.length ||
          checked.rootId !== selected.rootId ||
          checked.catalogDigest !== selected.catalogDigest ||
          checked.physicalDigest !== selected.physicalDigest
        )
          unavailable('The selected document history or ownership has changed. Refresh the preflight.')
        const scope = checked.scope,
          proof = checked.proof!,
          { rootId, catalogDigest, physicalDigest } = selected
        await publishPersonalDocumentIdentity(control, this.authority, scope, proof, async (volumeId) => {
          await this.authority.volume!.writeVolume(async (local) => {
            const existing = (
              await local.query(
                'SELECT catalog_digest,physical_digest FROM node_content.personal_document_imports WHERE root_id=$1 FOR UPDATE',
                [rootId],
              )
            ).rows[0]
            if (existing) {
              if (existing.catalog_digest !== catalogDigest || existing.physical_digest !== physicalDigest)
                unavailable('A different historical import already occupies this root.')
              return
            }
            let total = 0,
              records = 0
            const copy = async (projection: string, target: 'document_entries' | 'document_events') => {
              await control.query('DECLARE history_copy NO SCROLL CURSOR FOR ' + projection, [org, nodeId, scope, rootId])
              try {
                for (;;) {
                  const batch = await control.query<{ body: string }>('FETCH FORWARD 64 FROM history_copy')
                  if (!batch.rowCount) break
                  records += batch.rows.length
                  total += batch.rows.reduce((bytes, row) => bytes + Buffer.byteLength(row.body), 0)
                  if (records > maxRows || total > maxBytes)
                    unavailable('The historical import exceeds its approved limits.')
                  const json = '[' + batch.rows.map((row) => row.body).join(',') + ']'
                  await local.query(
                    `INSERT INTO node_content.${target}
                    SELECT * FROM json_populate_recordset(NULL::node_content.${target},$1::json)`,
                    [json],
                  )
                }
              } finally {
                await control.query('CLOSE history_copy')
              }
            }
            await copy(entryProjection, 'document_entries')
            await copy(eventProjection, 'document_events')
            await local.query('SELECT node_content.advance_document_event_sequence()')
            await local.query(
              `INSERT INTO node_content.personal_document_imports(organization_id,node_id,user_id,root_id,volume_id,catalog_digest,physical_digest,
            source_count,history_count,sequence,ordinal) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [
                org,
                nodeId,
                scope,
                rootId,
                volumeId,
                catalogDigest,
                physicalDigest,
                checked.prior.fileCount,
                checked.prior.historyCount,
                proof.head.sequence,
                proof.head.ordinal,
              ],
            )
          })
          await control.query(
            `INSERT INTO harness.personal_document_imports(organization_id,node_id,user_id,root_id,volume_id,actor_id,catalog_digest,physical_digest,
          source_count,history_count,sequence,ordinal) VALUES($1,$2,$3,$4,$5,(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$6),$7,$8,$9,$10,$11,$12)`,
            [
              org,
              nodeId,
              scope,
              rootId,
              volumeId,
              actor,
              catalogDigest,
              physicalDigest,
              checked.prior.fileCount,
              checked.prior.historyCount,
              proof.head.sequence,
              proof.head.ordinal,
            ],
          )
        })
        await control.query(
          `INSERT INTO harness.audit_events(organization_id,actor_user_id,action,resource_type,resource_id,detail)
        SELECT $1,id,'admin.personal-documents.publish','personal-documents',$3,'{}' FROM harness.users WHERE organization_id=$1 AND public_id=$2`,
          [org, actor, rootId],
        )
        return { nodeId, user, rootId, published: true }
      }),
    ).catch((error: unknown) => {
      if (error instanceof PeerBackupError && error.code === 'peer-backup/project-files-busy')
        throw new DocumentCatalogError(
          'DOCUMENT_MIGRATION_BUSY',
          409,
          'A document operation is still using this personal space.',
        )
      if (error instanceof PeerBackupError && error.code === 'peer-backup/file-fence-unavailable')
        throw new DocumentCatalogError('DOCUMENT_STORE_UNAVAILABLE', 503, 'The personal document write lock is unavailable.')
      throw error
    })
  }
}
