/** Physical project placement is published only when each installed content owner can serve its live data. */
import type { PoolClient } from 'pg'
import { NodeContentUnavailable, type NodeContentBinding } from './node-content-store.ts'

/** Required for an ordinary project even when it has no data at creation. */
export const requiredNodeContentDomains = ['sessions','execution','collaboration','workspace','documents','search','archive',
  'progress','memory','plugins','drafts'] as const
export type NodeContentDomain = typeof requiredNodeContentDomains[number]

/** Record the source owner's verified typed readback for a domain in this snapshot.
 * @param local - existing node transaction containing the checked data.
 * @param evidence - exact source revision, row count and SHA-256 of the verified manifest.
 */
export async function recordNodeContentDomainReceipt(local:PoolClient,evidence:{
  snapshotId:string;domain:NodeContentDomain;sourceRevision:string;digest:Buffer;records:number
}):Promise<void>{
  if (evidence.digest.length!==32 || !Number.isSafeInteger(evidence.records) || evidence.records<0) throw new NodeContentUnavailable('Invalid migration evidence.')
  const result=await local.query(`INSERT INTO node_content.migration_domain_receipts(snapshot_id,domain,source_revision,digest,records)
    SELECT id,$2,source_revision,$4,$5 FROM node_content.migration_snapshots WHERE id=$1 AND source_revision=$3 AND verified
    ON CONFLICT(snapshot_id,domain) DO UPDATE SET domain=excluded.domain
    WHERE migration_domain_receipts.source_revision=excluded.source_revision AND migration_domain_receipts.digest=excluded.digest
      AND migration_domain_receipts.records=excluded.records`,[evidence.snapshotId,evidence.domain,evidence.sourceRevision,evidence.digest,evidence.records])
  if (result.rowCount!==1) throw new NodeContentUnavailable('The migration evidence conflicts with its snapshot.')
}

/** The owning service verifies its node storage and all read/write paths during the prospective publication transaction. */
export type NodeContentDomainChecks = Partial<Record<NodeContentDomain, (input: {
  control: PoolClient
  local: PoolClient
  binding: NodeContentBinding
  migration?: {jobId:string;snapshotId:string;sourceRevision:string}
}) => Promise<void>>>
export type NodeContentCheckInput=Parameters<NonNullable<NodeContentDomainChecks['sessions']>>[0]

/** Verify that the serving Gateway role can use the reviewed tables required by the mounted adapter.
 * @param local - already verified node transaction.
 * @param tables - fixed relation names selected by a concrete domain implementation.
 */
export async function requireNodeContentRelations(local:PoolClient,tables:readonly string[]):Promise<void>{
  const result=await local.query(`SELECT name FROM unnest($1::text[]) name LEFT JOIN pg_class c ON c.oid=to_regclass('node_content.'||name)
    WHERE c.oid IS NULL OR NOT (has_table_privilege(c.oid,'SELECT') AND has_table_privilege(c.oid,'INSERT')
      AND has_table_privilege(c.oid,'UPDATE') AND has_table_privilege(c.oid,'DELETE')) LIMIT 1`,[tables])
  if (result.rowCount) throw new NodeContentUnavailable('A project content adapter lacks its required local table or database privileges.')
}

/** Server assembly supplies the domain implementations. An uninstalled implementation keeps the project in its previous layout. */
export class NodeContentPublication {
  constructor(private readonly checks: NodeContentDomainChecks = {}) {}

  /** @returns domains with no registered read/write implementation. */
  missing(): NodeContentDomain[] { return requiredNodeContentDomains.filter(domain=>this.checks[domain]===undefined) }

  /** Verify the same allocation under the control lock and verified node transaction used for publication.
   * @param input - exact organization, space, allocation, epoch and both existing transactions.
   */
  async assertReady(input: { control:PoolClient; local:PoolClient; binding:NodeContentBinding; migration?:{jobId:string;snapshotId:string;sourceRevision:string} }): Promise<void> {
    const missing=this.missing()
    if (missing.length) throw new NodeContentUnavailable('Project content services are not ready: '+missing.join(', ')+'.')
    for (const domain of requiredNodeContentDomains) await this.checks[domain]!(input)
    if (input.migration) {
      const receipts=await input.local.query<{domain:NodeContentDomain}>(`SELECT a.domain FROM node_content.migration_domain_receipts a
        JOIN node_content.migration_snapshots s ON s.id=a.snapshot_id AND s.source_revision=a.source_revision
        WHERE a.snapshot_id=$1 AND s.job_id=$2 AND a.source_revision=$3 AND s.organization_id=$4 AND s.project_id=$5 AND s.runtime_id=$6
          AND s.writer_epoch=$7 AND s.verified AND s.materialized`,
      [input.migration.snapshotId,input.migration.jobId,input.migration.sourceRevision,input.binding.organizationId,
        input.binding.projectId,input.binding.runtimeId,input.binding.writerEpoch])
      const verified=new Set(receipts.rows.map(r=>r.domain))
      const absent=requiredNodeContentDomains.filter(domain=>!verified.has(domain))
      if (absent.length) throw new NodeContentUnavailable('Project migration evidence is incomplete: '+absent.join(', ')+'.')
    }
  }
}
