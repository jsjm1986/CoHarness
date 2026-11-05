/** Inspect retained project payloads and finalize physical retirement only with independent media custody evidence. */
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { requiredNodeContentDomains } from './node-content-publication.ts'
import { NodeContentUnavailable,type NodeContentBinding,type NodeContentStore } from './node-content-store.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { transaction } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { RuntimeId } from './runtime-catalog.ts'

export const retirementDomains=['policy','wal','backups','replicas','cluster-media','other-projections'] as const
export type RetirementDomain=typeof retirementDomains[number]
interface Source {
  project_id:string;runtime_id:RuntimeId;source_retirement:'new'|'retiring'|'retired';binding:NodeContentBinding;
  job_id:string|null;revision:string|null;source_cluster_id:string|null;source_database_oid:number|null;original_cluster:boolean|null
}
interface Evidence {domain:RetirementDomain;verified_at:Date;recorded_by:string}
export interface RetirementChallenge {
  reviewId:string;organizationId:string;projectId:string;runtimeId:RuntimeId;nodeId:string;volumeId:string;writerEpoch:string;jobId:string;
  sourceRevision:string;sourceClusterId:string;sourceDatabaseOid:number;sourceSnapshotId:string;policyDigest:string;ownerCoverageDigest:string;backupInventoryDigest:string;openedAt:Date
}
export interface SourceRetirementStatus {
  projectId:number;nodeId:string;runtimeId:RuntimeId;writerEpoch:string;sourceRetirement:Source['source_retirement'];knownOrigin:boolean;
  originalClusterStillServing:boolean|null;retainedRelations:string[];reviewId:string|null;challenge:RetirementChallenge|null;evidence:Evidence[];outstanding:RetirementDomain[]
}

/** The owning Gateway performs reads and operator actions. External custody is recorded through separate verified identities. */
export class NodeContentSourceRetirement {
  constructor(private readonly context:PostgresRuntimeContext,private readonly ready:()=>Promise<NodeContentStore>){}

  private async source(control:PoolClient,actor:number,id:number):Promise<Source>{
    await lockAdministrator(control,this.context,actor)
    const r=(await control.query<Source>(`SELECT p.id project_id,b.runtime_id,b.source_retirement,harness.project_content_key(b.organization_id,b.project_id) binding,
      j.id job_id,j.source_revision::text revision,j.source_cluster_id,j.source_database_oid,
      j.source_cluster_id=harness.retirement_source_cluster() original_cluster
      FROM harness.projects p JOIN harness.project_content_placement b ON (b.organization_id,b.project_id)=(p.organization_id,p.id)
      LEFT JOIN harness.project_content_copy_jobs j ON j.organization_id=b.organization_id AND j.project_id=b.project_id AND j.runtime_id=b.runtime_id AND j.published
      WHERE p.organization_id=$1 AND p.public_id=$2 AND b.node_id=$3 FOR SHARE OF b,p`,[this.context.organizationId,id,this.context.nodeId])).rows[0]
    if(!r)throw new NodeContentUnavailable('The selected project does not have a published placement on this computer.')
    return r
  }

  /** @param actor - active administrator. @param id - project on this node. @param reviewId - optional exact review to inspect.
   * @returns retained source relations and external media domains still awaiting evidence. No files are modified.
   */
  report(actor:number,id:number,reviewId?:string):Promise<SourceRetirementStatus>{
    return transaction(this.context.pool,async control=>{
      const source=await this.source(control,actor,id),b=source.binding
      const retained=source.source_retirement==='new'?[]:(await control.query<{name:string}>(`SELECT name FROM harness.retained_project_payload($1,$2,$3) name UNION SELECT 'ambiguous_'||name FROM harness.ambiguous_project_payload($1,$2,$3) name ORDER BY 1`,
        [b.organizationId,b.projectId,b.runtimeId])).rows.map(r=>r.name)
      const review=(await control.query<RetirementChallenge>(`SELECT id "reviewId",organization_id "organizationId",project_id "projectId",runtime_id "runtimeId",node_id "nodeId",volume_id "volumeId",
        writer_epoch::text "writerEpoch",job_id "jobId",source_revision::text "sourceRevision",source_cluster_id "sourceClusterId",source_database_oid "sourceDatabaseOid",
        node_snapshot_id "sourceSnapshotId",encode(policy_digest,'hex') "policyDigest",encode(owner_coverage_digest,'hex') "ownerCoverageDigest",encode(backup_inventory_digest,'hex') "backupInventoryDigest",opened_at "openedAt"
        FROM harness.project_source_retirement_reviews WHERE organization_id=$1 AND project_id=$2
        AND node_id=$3 AND runtime_id=$4 AND volume_id=$5 AND writer_epoch=$6 AND ($7::uuid IS NULL OR id=$7) ORDER BY opened_at DESC,id LIMIT 1`,
      [b.organizationId,b.projectId,b.nodeId,b.runtimeId,b.volumeId,b.writerEpoch,reviewId??null])).rows[0]
      if(reviewId&&!review)throw new NodeContentUnavailable('The receipt does not belong to the selected project and writer.')
      const evidence=review?(await control.query<Evidence>(`SELECT domain,verified_at,recorded_by FROM harness.project_source_retirement_evidence WHERE review_id=$1 ORDER BY domain`,[review.reviewId])).rows:[]
      return {projectId:id,nodeId:b.nodeId,runtimeId:b.runtimeId,writerEpoch:b.writerEpoch,sourceRetirement:source.source_retirement,
        knownOrigin:source.source_cluster_id!==null&&source.source_database_oid!==null,originalClusterStillServing:source.original_cluster,retainedRelations:retained,
        reviewId:review?.reviewId??null,challenge:review??null,evidence,outstanding:source.source_retirement==='retiring'?retirementDomains.filter(d=>!evidence.some(r=>r.domain===d)):[]}
    })
  }

  /** Open an explicit review of one policy digest and exact previously verified owner snapshot.
   * @param actor - current administrator. @param id - project on this computer.
   * @param input - reviewed Runtime, epoch and SHA-256 of the signed retention policy; authorizes investigation only.
   * @returns the review challenge to send to independent retention and media custodians.
   */
  async open(actor:number,id:number,input:{runtimeId:string;writerEpoch:string;policyDigest:string}):Promise<SourceRetirementStatus>{
    if(!/^[a-f0-9]{64}$/u.test(input.policyDigest))throw new Error('A SHA-256 retention-policy digest is required.')
    const review=await transaction(this.context.pool,async control=>{
      const source=await this.source(control,actor,id),b=source.binding
      if(!source.job_id||source.revision===null||!source.source_cluster_id||!source.source_database_oid||source.source_retirement!=='retiring'
         ||b.runtimeId!==input.runtimeId||b.writerEpoch!==input.writerEpoch)throw new NodeContentUnavailable('The original source or current writer is unknown. Preserve the historical copies.')
      const store=await this.ready()
      const receipts=await store.read(b,async local=>(await local.query<{id:string;domain:string;digest:string;records:string}>(`SELECT m.id,a.domain,encode(a.digest,'hex') digest,a.records::text
        FROM node_content.migration_snapshots m JOIN node_content.migration_domain_receipts a ON a.snapshot_id=m.id AND a.source_revision=m.source_revision
        WHERE m.organization_id=$1 AND m.project_id=$2 AND m.runtime_id=$3 AND m.writer_epoch=$4 AND m.job_id=$5 AND m.source_revision=$6
          AND m.verified AND m.materialized ORDER BY a.domain`,[b.organizationId,b.projectId,b.runtimeId,b.writerEpoch,source.job_id,source.revision])).rows)
      if(receipts.length!==requiredNodeContentDomains.length||requiredNodeContentDomains.some(domain=>!receipts.some(row=>row.domain===domain))||new Set(receipts.map(r=>r.id)).size!==1) {
        throw new NodeContentUnavailable('The destination does not prove all project domains for the original migration.')
      }
      const coverage=createHash('sha256').update(JSON.stringify(receipts)).digest()
      const args=[b.organizationId,b.projectId,b.runtimeId,b.nodeId,b.volumeId,b.writerEpoch,source.job_id,source.revision,source.source_cluster_id,
        source.source_database_oid,receipts[0]!.id,actor,Buffer.from(input.policyDigest,'hex'),coverage]
      const opened=await control.query<{id:string}>(`INSERT INTO harness.project_source_retirement_reviews(organization_id,project_id,runtime_id,node_id,volume_id,writer_epoch,
        job_id,source_revision,source_cluster_id,source_database_oid,node_snapshot_id,requested_by,policy_digest,owner_coverage_digest,backup_inventory_digest)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,u.id,$13,$14,harness.retirement_backup_inventory($1) FROM harness.users u WHERE u.organization_id=$1 AND u.public_id=$12 ON CONFLICT DO NOTHING RETURNING id`,args)
      if(opened.rowCount)return opened.rows[0]!.id
      const prior=(await control.query<{id:string}>(`SELECT id FROM harness.project_source_retirement_reviews WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 AND node_id=$4
        AND volume_id=$5 AND writer_epoch=$6 AND job_id=$7 AND source_revision=$8 AND source_cluster_id=$9 AND source_database_oid=$10 AND node_snapshot_id=$11
        AND policy_digest=$12 AND owner_coverage_digest=$13 AND backup_inventory_digest=harness.retirement_backup_inventory($1)`,[...args.slice(0,11),args[12],coverage])).rows[0]
      if(!prior)throw new NodeContentUnavailable('An earlier retirement review has different destination evidence.')
      return prior.id
    })
    return this.report(actor,id,review)
  }

  /** Mark a separately attested historical source retired. Does not erase a database or request media destruction.
   * @param actor - authenticated administrator. @param id - project. @param reviewId - previously authorized review challenge.
   * @returns its refreshed, storage-scoped status after the database guard verifies all current evidence.
   */
  async finalize(actor:number,id:number,reviewId:string):Promise<SourceRetirementStatus>{
    await transaction(this.context.pool,async control=>{
      const source=await this.source(control,actor,id),b=source.binding
      if(source.source_retirement==='new')throw new NodeContentUnavailable('This project was created directly on its content volume.')
      await control.query("SELECT set_config('hgw.source_retirement_review',$1,true)",[reviewId])
      await control.query(`UPDATE harness.project_content_placement SET source_retirement='retired' WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3
        AND node_id=$4 AND volume_id=$5 AND writer_epoch=$6 AND source_retirement='retiring'`,[b.organizationId,b.projectId,b.runtimeId,b.nodeId,b.volumeId,b.writerEpoch])
    })
    return this.report(actor,id,reviewId)
  }
}
