/** Independent source-storage witness ingestion. No application endpoint signs custody evidence. */
import { createHash,createPublicKey,verify } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { transaction } from './postgres/database.ts'
import { retirementDomains } from './node-content-source-retirement.ts'

const sha=z.string().regex(/^[a-f0-9]{64}$/u)
const claim=z.object({version:z.literal(1),reviewId:z.uuid(),organizationId:z.uuid(),projectId:z.uuid(),runtimeId:z.uuid(),nodeId:z.uuid(),volumeId:z.uuid(),
  writerEpoch:z.string().regex(/^[1-9]\d*$/u),jobId:z.uuid(),sourceRevision:z.string().regex(/^(0|[1-9]\d*)$/u),sourceClusterId:z.string().regex(/^\d+$/u),
  sourceDatabaseOid:z.number().int().positive(),sourceSnapshotId:z.uuid(),policyDigest:sha,ownerCoverageDigest:sha,backupInventoryDigest:sha,domain:z.enum(retirementDomains),
  method:z.enum(['policy-authorizes-erasure','wal-inventory-erased','backup-inventory-erased-or-rewritten','replicas-rebuilt','original-cluster-media-erased','derived-stores-erased-or-rewritten']),
  inventoryDigest:sha,evidenceDigest:sha,resourceCount:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),verifiedAt:z.iso.datetime(),result:z.literal('verified-clear')}).strict()
const methods:Record<z.infer<typeof claim>['domain'],z.infer<typeof claim>['method']>={policy:'policy-authorizes-erasure',wal:'wal-inventory-erased',
  backups:'backup-inventory-erased-or-rewritten',replicas:'replicas-rebuilt','cluster-media':'original-cluster-media-erased','other-projections':'derived-stores-erased-or-rewritten'}
export const custodyEnvelopeSchema=z.object({version:z.literal(1),payload:z.base64().max(16_384),signature:z.base64().length(88)}).strict()
export const custodyKeySchema=z.object({domain:z.enum(retirementDomains),publicKey:z.string().min(1).max(4096)}).strict()
type Challenge=z.infer<typeof claim>

/** Verify signed, bounded evidence using an independently configured custodian's public key; require its matching PostgreSQL login.
 * @param database - dedicated custody login for the selected storage domain. @param key - pinned domain and Ed25519 public key.
 * @param packet - signed external storage-inventory result. @returns only the review ID and accepted coverage domain.
 */
export async function recordSourceCustody(database:Pool,key:z.infer<typeof custodyKeySchema>,packet:z.infer<typeof custodyEnvelopeSchema>):Promise<{reviewId:string;domain:Challenge['domain']}>{
  const payload=Buffer.from(packet.payload,'base64'),signature=Buffer.from(packet.signature,'base64'),pub=createPublicKey(key.publicKey)
  if(pub.asymmetricKeyType!=='ed25519'||signature.length!==64||!verify(null,payload,pub,signature))throw new Error('The independent custody signature was rejected.')
  const value=claim.parse(JSON.parse(payload.toString('utf8'))) as Challenge
  if(value.domain!==key.domain||value.method!==methods[value.domain]||value.domain==='cluster-media'&&value.resourceCount===0)throw new Error('The signed inspection does not cover the requested media domain.')
  const fingerprint=createHash('sha256').update(pub.export({type:'spki',format:'der'})).digest()
  const proof=createHash('sha256').update(payload).update(signature).digest()
  await transaction(database,async tx=>{
    const expected=await tx.query<{session_user:string}>(`SELECT SESSION_USER FROM harness.project_source_retirement_reviews r JOIN harness.project_content_placement b
      ON (b.organization_id,b.project_id,b.runtime_id,b.node_id,b.volume_id,b.writer_epoch)=(r.organization_id,r.project_id,r.runtime_id,r.node_id,r.volume_id,r.writer_epoch)
      WHERE r.id=$1 AND r.organization_id=$2 AND r.project_id=$3 AND r.runtime_id=$4 AND r.node_id=$5 AND r.volume_id=$6 AND r.writer_epoch=$7
        AND r.job_id=$8 AND r.source_revision=$9 AND r.source_cluster_id=$10 AND r.source_database_oid=$11 AND r.node_snapshot_id=$12
        AND r.policy_digest=$13 AND r.owner_coverage_digest=$14 AND r.opened_at<=$15 AND b.source_retirement='retiring' AND r.backup_inventory_digest=$16`,
    [value.reviewId,value.organizationId,value.projectId,value.runtimeId,value.nodeId,value.volumeId,value.writerEpoch,value.jobId,value.sourceRevision,value.sourceClusterId,
      value.sourceDatabaseOid,value.sourceSnapshotId,Buffer.from(value.policyDigest,'hex'),Buffer.from(value.ownerCoverageDigest,'hex'),value.verifiedAt,Buffer.from(value.backupInventoryDigest,'hex')])
    if(expected.rows[0]?.session_user!=='hgw_retire_'+value.domain.replaceAll('-','_'))throw new Error('The signed inspection requires the current review and separate domain login.')
    const args=[value.reviewId,value.domain,Buffer.from(value.inventoryDigest,'hex'),proof,fingerprint,value.verifiedAt,value.resourceCount]
    const prior=await tx.query(`SELECT FROM harness.project_source_retirement_evidence WHERE review_id=$1 AND domain=$2 AND inventory_digest=$3
      AND proof_digest=$4 AND signer_fingerprint=$5 AND verified_at=$6 AND observed_resources=$7`,args)
    if(!prior.rowCount)await tx.query(`INSERT INTO harness.project_source_retirement_evidence(review_id,domain,inventory_digest,proof_digest,signer_fingerprint,verified_at,observed_resources,recorded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,SESSION_USER)`,args)
  })
  return {reviewId:value.reviewId,domain:value.domain}
}
