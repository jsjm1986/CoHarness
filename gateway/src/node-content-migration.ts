/** Durable project copy snapshots. The source keeps serving until a separately verified, quiescent publication. */
import { createHash, randomUUID } from 'node:crypto'
import { escapeIdentifier, type Pool, type PoolClient } from 'pg'
import { NodeContentUnavailable, type NodeContentBinding, type NodeContentStore } from './node-content-store.ts'
import { transaction } from './postgres/database.ts'
import {projectNamePolicy} from './node-content-project-names.ts'
import type { RuntimeStopLease } from './instances.ts'
import { NodeContentPublication,recordNodeContentDomainReceipt, type NodeContentDomain } from './node-content-publication.ts'

const relations = {
  conversation_sessions:['id'],conversation_events:['session_id','seq'],conversation_search:['session_id','event_seq'],
  conversation_append_batches:['batch_id'],conversation_participants:['conversation_id','user_id'],
  conversation_interaction_responses:['interaction_kind','interaction_id'],conversation_draft_reservations:['scope_key','draft_id'],
  conversation_migrations:['id'],conversation_migrated_events:['migration_id','seq'],execution_sessions:['id'],execution_inputs:['id'],
  execution_scopes:['id'],execution_relays:['id'],desktop_session_confirmations:['id'],
  project_journal:['id'],project_journal_state:['project_id'],project_journal_requests:['request_id'],
  project_journal_materials:['runtime_namespace','receipt'],plugin_states:['runtime_id'],
  conversation_archive_records:['archive_id'],conversation_archive_search:['session_id','event_seq'],
  conversation_archive_commands:['id'],conversation_archive_file_cleanup:['id'],content_files:['id'],
} as const
type Relation = keyof typeof relations
interface ManifestEntry { columns:string[]; rows:number; sha256:string }
type Manifest=Record<Relation,ManifestEntry>
interface Snapshot { id:string;jobId:string;sourceRevision:string }
interface CopyJob { id:string;source_revision:string;published:boolean }
const qualifiedOrder=(columns:readonly string[]):string=>columns.map(escapeIdentifier).join(',')
const ownerColumn=(table:Relation):'project_id'|'runtime_id'=>table.startsWith('project_journal')?'project_id':'runtime_id'
const scopedValues=(b:NodeContentBinding,t:Relation):string[]=>[b.organizationId,ownerColumn(t)==='project_id'?b.projectId:b.runtimeId]
const jobCoordinates=(b:NodeContentBinding):string[]=>[b.organizationId,b.projectId,b.runtimeId,b.nodeId,b.volumeId]
const coreManifestDomains:Partial<Record<NodeContentDomain,Relation[]>>={
  sessions:['conversation_sessions','conversation_events','conversation_search','conversation_append_batches','conversation_draft_reservations','conversation_migrations','conversation_migrated_events'],
  collaboration:['conversation_participants','conversation_interaction_responses'],
  execution:['execution_sessions','execution_inputs','execution_scopes','execution_relays','desktop_session_confirmations'],
  progress:['project_journal','project_journal_state','project_journal_requests','project_journal_materials'],
  search:['conversation_search','conversation_archive_search'],
  archive:['conversation_archive_records','conversation_archive_search','conversation_archive_commands','conversation_archive_file_cleanup','content_files'],
}

/** The online source snapshot, byte-level verification and final write barrier are independent of Runtime startup. */
export class NodeContentMigration {
  constructor(private readonly control:Pool, private readonly store:Pick<NodeContentStore,'read'|'write'>,private readonly b:NodeContentBinding) {}

  /** Register change capture before taking a source snapshot.
   * @param query - optional current authority transaction.
   * @returns the stable operation ID; repeated calls for the same target resume the same job.
   */
  async register(query: Pick<PoolClient, 'query'> = this.control):Promise<string> {
    const binding=this.b
    const result=await query.query<{id:string}>(`INSERT INTO harness.project_content_copy_jobs(organization_id,project_id,runtime_id,node_id,volume_id)
      SELECT $1,$2,$3,$4,$5 FROM harness.runtime_environments r WHERE r.organization_id=$1 AND r.owner_kind='project' AND r.owner_id=$2
        AND r.id=$3 AND r.node_id=$4 AND r.retired_at IS NULL
        AND NOT EXISTS(SELECT FROM harness.project_content_placement b WHERE b.organization_id=$1 AND b.project_id=$2)
      ON CONFLICT(organization_id,project_id) DO UPDATE SET id=project_content_copy_jobs.id
      WHERE NOT project_content_copy_jobs.published AND (project_content_copy_jobs.runtime_id,project_content_copy_jobs.node_id,project_content_copy_jobs.volume_id)=
        (excluded.runtime_id,excluded.node_id,excluded.volume_id) RETURNING id`,jobCoordinates(binding))
    if (!result.rows[0]) throw new NodeContentUnavailable('The project already has another source or migration destination.')
    return result.rows[0].id
  }

  /** Copy bounded batches from one repeatable source snapshot. Previously committed identical copies are reused.
   * @param signal - optional operator cancellation.
   * @returns the local snapshot identity and the source write counter it covers.
   */
  async copy(signal?:AbortSignal):Promise<Snapshot> {
    const b=this.b
    return transaction(this.control,async source=>{
      await source.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      await source.query("SET LOCAL TIME ZONE 'UTC'")
      await source.query("SET LOCAL DateStyle='ISO, YMD'")
      const job=(await source.query<CopyJob>(`SELECT id,source_revision::text,published FROM harness.project_content_copy_jobs
        WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 AND node_id=$4 AND volume_id=$5
          AND pg_snapshot_xmin(pg_current_snapshot())>registered_xid`,jobCoordinates(b))).rows[0]
      if (!job || job.published) throw new NodeContentUnavailable('Wait for transactions predating migration registration, then retry the online snapshot.')
      const uncertain=await source.query(`SELECT FROM harness.ambiguous_project_payload($1,$2,$3)
        UNION ALL SELECT FROM harness.conversation_archive_records a JOIN harness.projects p ON p.id=$2 AND p.organization_id=$1
        WHERE a.organization_id=$1 AND a.runtime_kind='project' AND (a.project_id=$2 OR a.runtime_public_id=p.public_id)
          AND (a.legacy_unassigned OR a.runtime_id IS DISTINCT FROM $3 OR a.node_id IS DISTINCT FROM $4)
        UNION ALL SELECT FROM harness.content_files f JOIN harness.conversation_sessions c ON c.organization_id=f.organization_id AND c.id=f.session_id
          WHERE f.organization_id=$1 AND c.project_id=$2 AND c.runtime_id=$3 AND f.runtime_id IS NULL LIMIT 1`,[b.organizationId,b.projectId,b.runtimeId,b.nodeId])
      if (uncertain.rowCount) throw new NodeContentUnavailable('A historical archive or file lacks a verified Runtime and node assignment.')
      return this.store.write(b,async destination=>{
        const previous=(await destination.query<{id:string}>(`SELECT id FROM node_content.migration_snapshots WHERE job_id=$1 AND source_revision=$2 AND verified`,[job.id,job.source_revision])).rows[0]
        if (previous) return {id:previous.id,jobId:job.id,sourceRevision:job.source_revision}
        const id=randomUUID(),manifest:Partial<Manifest>={}
        await destination.query(`INSERT INTO node_content.migration_snapshots(id,job_id,organization_id,runtime_id,project_id,writer_epoch,source_revision,manifest)
          VALUES($1,$2,$3,$4,$5,$6,$7,'{}')`,[id,job.id,b.organizationId,b.runtimeId,b.projectId,b.writerEpoch,job.source_revision])
        for (const [table,order] of Object.entries(relations) as [Relation,readonly string[]][]) {
          signal?.throwIfAborted()
          const columns=(await source.query<{attname:string}>(`SELECT a.attname FROM pg_attribute a WHERE a.attrelid=$1::regclass
            AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum`,['harness.'+table])).rows.map(row=>row.attname)
          const inherited=table==='conversation_archive_commands'||table==='conversation_archive_file_cleanup'
          const projection=columns.map(name=>'r.'+escapeIdentifier(name)+'::text')
          if (inherited) {columns.push('runtime_id');projection.push('a.runtime_id::text')}
          if (!columns.includes(ownerColumn(table)) || !columns.includes('organization_id')) throw new NodeContentUnavailable('A migration source lacks its project or Runtime identity.')
          const sourceRows=inherited ? `harness.${escapeIdentifier(table)} r JOIN harness.conversation_archive_records a
            ON a.organization_id=r.organization_id AND a.archive_id=r.archive_id WHERE a.organization_id=$1 AND a.runtime_id=$2`
            : `harness.${escapeIdentifier(table)} r WHERE r.organization_id=$1 AND r.${ownerColumn(table)}=$2`
          await source.query(`DECLARE copy_rows NO SCROLL CURSOR FOR SELECT ARRAY[${projection.join(',')}] v FROM ${sourceRows}
            ORDER BY ${order.map(name=>'r.'+escapeIdentifier(name)).join(',')}`,scopedValues(b,table))
          const digest=createHash('sha256')
          let count=0,batch=0
          while (true) {
            signal?.throwIfAborted()
            const entries=(await source.query<{v:(string|null)[]}>('FETCH FORWARD 16 FROM copy_rows')).rows
            if (!entries.length) break
            const body=JSON.stringify(entries.map(row=>row.v)),sum=createHash('sha256').update(body).digest()
            await destination.query('INSERT INTO node_content.migration_batches(snapshot_id,relation,batch,body,digest) VALUES($1,$2,$3,$4,$5)',[id,table,batch++,body,sum])
            digest.update(sum);count+=entries.length
          }
          await source.query('CLOSE copy_rows')
          manifest[table]={columns,rows:count,sha256:digest.digest('hex')}
        }
        await destination.query('UPDATE node_content.migration_snapshots SET manifest=$2 WHERE id=$1',[id,manifest])
        await this.verifyAt(destination,id,manifest as Manifest)
        await destination.query('UPDATE node_content.migration_snapshots SET verified=true WHERE id=$1',[id])
        return {id,jobId:job.id,sourceRevision:job.source_revision}
      })
    },signal)
  }

  private async verifyAt(local:PoolClient,id:string,manifest:Manifest):Promise<void>{
    for (const table of Object.keys(relations) as Relation[]) {
      const entry=manifest[table],digest=createHash('sha256')
      let seen=0,last=-1
      // Hashes are recalculated by PostgreSQL against the persisted payload; only digests traverse the connection.
      await local.query(`DECLARE verify_batches NO SCROLL CURSOR FOR SELECT batch,encode(digest,'hex') recorded,
        encode(sha256(convert_to(body,'UTF8')),'hex') actual,json_array_length(body::json) n FROM node_content.migration_batches
        WHERE snapshot_id=$1 AND relation=$2 ORDER BY batch`,[id,table])
      while (true) {
        const batch=(await local.query<{batch:number;recorded:string;actual:string;n:number}>('FETCH FORWARD 256 FROM verify_batches')).rows
        if (!batch.length) break
        for (const row of batch) {
          if (row.batch!==++last || row.actual!==row.recorded) throw new NodeContentUnavailable('A persisted migration batch failed verification.')
          digest.update(Buffer.from(row.actual,'hex'));seen+=row.n
        }
      }
      await local.query('CLOSE verify_batches')
      if (!entry || seen!==entry.rows || digest.digest('hex')!==entry.sha256) throw new NodeContentUnavailable('A persisted migration relation failed verification.')
    }
  }

  /** Verify persisted snapshot bytes without contacting the source.
   * @param snapshot - prepared snapshot ID, job and source revision.
   */
  verify(snapshot:Snapshot):Promise<void>{
    return this.store.read(this.b,async local=>{
      const row=(await local.query<{manifest:Manifest}>(`SELECT manifest FROM node_content.migration_snapshots WHERE id=$1 AND job_id=$2
        AND organization_id=$3 AND project_id=$4 AND runtime_id=$5 AND writer_epoch=$6 AND source_revision=$7 AND verified`,
      [snapshot.id,snapshot.jobId,this.b.organizationId,this.b.projectId,this.b.runtimeId,this.b.writerEpoch,snapshot.sourceRevision])).rows[0]
      if (!row) throw new NodeContentUnavailable('The selected snapshot does not belong to this space and source revision.')
      await this.verifyAt(local,snapshot.id,row.manifest)
    })
  }

  /** Populate the still-inert node tables, and check their typed readback against the original snapshot.
   * @param snapshot - verified local copy. An already published allocation cannot be overwritten.
   */
  async materialize(snapshot:Snapshot):Promise<void>{
    const b=this.b
    return transaction(this.control,async control=>{
      const locked=await control.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,712315)) locked`,[snapshot.jobId])
      if (locked.rows[0].locked!==true) throw new NodeContentUnavailable('Another migration operation owns the staging volume.')
      const current=await control.query(`SELECT FROM harness.project_content_copy_jobs WHERE id=$1 AND organization_id=$2 AND project_id=$3
        AND runtime_id=$4 AND node_id=$5 AND volume_id=$6 AND NOT published`,[snapshot.jobId,...jobCoordinates(b)])
      if (current.rowCount!==1) throw new NodeContentUnavailable('Only this job’s unpublished destination may be materialized.')
      await this.store.write(b,async local=>{
        // A failed governance commit may have left the old snapshot sealed. The migration lock excludes publication.
        await local.query(`UPDATE node_content.spaces SET publication_state='staging' WHERE organization_id=$1 AND runtime_id=$2
          AND publication_state='sealed'`,[b.organizationId,b.runtimeId])
        await local.query("SET LOCAL TIME ZONE 'UTC'")
        await local.query("SET LOCAL DateStyle='ISO, YMD'")
        const recorded=(await local.query<{manifest:Manifest;materialized:boolean}>(`SELECT m.manifest,m.materialized FROM node_content.migration_snapshots m
          JOIN node_content.spaces s ON s.organization_id=m.organization_id AND s.project_id=m.project_id AND s.runtime_id=m.runtime_id
          WHERE m.id=$1 AND m.job_id=$2 AND m.source_revision=$3 AND m.organization_id=$4 AND m.runtime_id=$5
            AND m.writer_epoch=$6 AND m.verified AND s.publication_state='staging' FOR UPDATE OF m`,
        [snapshot.id,snapshot.jobId,snapshot.sourceRevision,b.organizationId,b.runtimeId,b.writerEpoch])).rows[0]
        if (!recorded) throw new NodeContentUnavailable('The destination does not own the selected staged snapshot.')
        await this.verifyAt(local,snapshot.id,recorded.manifest)
        if (recorded.materialized) return
        const old=await local.query(`SELECT id FROM node_content.migration_snapshots WHERE organization_id=$1 AND runtime_id=$2 AND materialized`,[b.organizationId,b.runtimeId])
        for (const relation of (Object.keys(relations) as Relation[]).reverse()) {
          const table='node_content.'+escapeIdentifier(relation)
          if (old.rowCount) await local.query(`DELETE FROM ${table} WHERE organization_id=$1 AND ${ownerColumn(relation)}=$2`,scopedValues(b,relation))
          else if ((await local.query(`SELECT 1 FROM ${table} WHERE organization_id=$1 AND ${ownerColumn(relation)}=$2 LIMIT 1`,scopedValues(b,relation))).rowCount) {
            throw new NodeContentUnavailable('A staged copy cannot replace independently populated node data.')
          }
        }
        if (old.rowCount) await local.query('UPDATE node_content.migration_snapshots SET materialized=false WHERE id=$1',[old.rows[0].id])
        for (const relation of Object.keys(relations) as Relation[]) {
          const entry=recorded.manifest[relation], table='node_content.'+escapeIdentifier(relation)
          const columns=new Set((await local.query<{attname:string}>(`SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass
            AND attnum>0 AND NOT attisdropped AND attgenerated=''`,[table])).rows.map(row=>row.attname))
          const missing=entry.columns.filter(column=>!columns.has(column))
          if (missing.length) throw new NodeContentUnavailable('The destination cannot preserve '+relation+'.'+missing.join(',')+'.')
          const answer=relation==='conversation_interaction_responses'
          const names=answer?[...entry.columns,'has_answers']:entry.columns
          await local.query(`DECLARE materialize_batches NO SCROLL CURSOR FOR SELECT body FROM node_content.migration_batches
            WHERE snapshot_id=$1 AND relation=$2 ORDER BY batch`,[snapshot.id,relation])
          while (true) {
            const batch=(await local.query<{body:string}>('FETCH FORWARD 1 FROM materialize_batches')).rows[0]
            if (!batch) break
            const rows=JSON.parse(batch.body) as Array<Array<string|null>>
            const values:Array<string|boolean|null>=[]
            const tuples=rows.map(row=>{
              if (row.length!==entry.columns.length || (entry.columns.includes('runtime_id') && row[entry.columns.indexOf('runtime_id')]!==b.runtimeId)
                || (entry.columns.includes('project_id') && row[entry.columns.indexOf('project_id')]!==null && row[entry.columns.indexOf('project_id')]!==b.projectId)
                || row[entry.columns.indexOf('organization_id')]!==b.organizationId) throw new NodeContentUnavailable('Migration row belongs to a different Runtime.')
              const encoded:Array<string|boolean|null>=[...row]
              if (answer) {
                const value:unknown=JSON.parse(row[entry.columns.indexOf('outcome')]!)
                encoded.push(typeof value==='object' && value!==null && 'answers' in value && Array.isArray(value.answers))
              }
              return '('+encoded.map(value=>'$'+String(values.push(value))).join(',')+')'
            })
            await local.query(`INSERT INTO ${table}(${qualifiedOrder(names)}) VALUES ${tuples.join(',')}`,values)
          }
          await local.query('CLOSE materialize_batches')
          await local.query(`DECLARE verify_typed NO SCROLL CURSOR FOR SELECT ARRAY[${entry.columns.map(c=>escapeIdentifier(c)+'::text').join(',')}] v
            FROM ${table} WHERE organization_id=$1 AND ${ownerColumn(relation)}=$2 ORDER BY ${qualifiedOrder(relations[relation])}`,scopedValues(b,relation))
          let count=0
          const hash=createHash('sha256')
          while (true) {
            const rows=(await local.query<{v:(string|null)[]}>('FETCH FORWARD 16 FROM verify_typed')).rows
            if (!rows.length) break
            count+=rows.length
            hash.update(createHash('sha256').update(JSON.stringify(rows.map(r=>r.v))).digest())
          }
          await local.query('CLOSE verify_typed')
          if (count!==entry.rows || hash.digest('hex')!==entry.sha256) throw new NodeContentUnavailable('Typed migration readback differs for '+relation+'.')
        }
        await local.query('UPDATE node_content.migration_snapshots SET materialized=true WHERE id=$1',[snapshot.id])
        for (const [domain,tables] of Object.entries(coreManifestDomains) as [NodeContentDomain,Relation[]][]) {
          if (domain==='archive' && (recorded.manifest.content_files.rows || recorded.manifest.conversation_archive_file_cleanup.rows)) continue
          const evidence=tables.map(table=>({table,...recorded.manifest[table]}))
          await recordNodeContentDomainReceipt(local,{domain,snapshotId:snapshot.id,sourceRevision:snapshot.sourceRevision,
            digest:createHash('sha256').update(JSON.stringify(evidence)).digest(),records:evidence.reduce((all,t)=>all+t.rows,0)})
        }
      })
    })
  }

  /** Acquire the final source fence without stopping an active task or waiting for a busy writer.
   * @param control - short final publication transaction. The Runtime cannot restart until the transaction finishes.
   * @param snapshot - verified candidate with unchanged source revision.
   * @returns completion only when the exact stopped Runtime and unchanged source are locked.
   */
  async lockSource(control:PoolClient,snapshot:Snapshot,lease:RuntimeStopLease):Promise<void>{
    const b=this.b
    if (!lease.wasStopped || !lease.operationId || lease.runtimeId!==b.runtimeId) throw new NodeContentUnavailable('A confirmed process-owned quiescence receipt is required.')
    const lock=await control.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,712315)) locked',[snapshot.jobId])
    if (lock.rows[0].locked!==true) throw new NodeContentUnavailable('Another migration operation owns the staging volume.')
    const held=await control.query(`SELECT 1 FROM harness.project_content_copy_jobs j JOIN harness.instances i
      ON i.organization_id=j.organization_id AND i.project_id=j.project_id AND i.runtime_id=j.runtime_id AND i.assigned_node_id=j.node_id
      JOIN harness.runtime_destructive_operations op ON op.organization_id=i.organization_id AND op.runtime_id=i.runtime_id AND op.node_id=i.assigned_node_id
      WHERE j.organization_id=$1 AND j.project_id=$2 AND j.runtime_id=$3 AND j.node_id=$4 AND j.volume_id=$5
        AND j.id=$6 AND j.source_revision=$7 AND NOT j.published
        AND i.desired_state='stopped' AND i.observed_state='stopping' AND i.runtime_token_hash IS NULL
        AND NOT EXISTS(SELECT FROM harness.project_journal_state journal WHERE journal.organization_id=j.organization_id AND journal.project_id=j.project_id AND journal.generating_since IS NOT NULL)
        AND NOT EXISTS(SELECT FROM harness.project_journal_requests r JOIN harness.node_resource_requests a
          ON (a.organization_id,a.node_id,a.operation_id)=(r.organization_id,r.node_id,r.operation_id)
          WHERE r.organization_id=j.organization_id AND r.project_id=j.project_id AND NOT r.completed)
        AND i.generation=$8 AND op.operation_id=$9 AND op.generation=i.generation AND op.quiescent_at IS NOT NULL
      FOR UPDATE OF j,i,op NOWAIT`,[...jobCoordinates(b),snapshot.jobId,snapshot.sourceRevision,lease.generation,lease.operationId])
    if (held.rowCount!==1) throw new NodeContentUnavailable('The Runtime is busy or the source has changed. Prepare a fresh snapshot.')
  }

  /** Publish verified local data while the caller still holds the process-owned stop lease.
   * The source-retirement marker remains pending until its independent retention checks finish.
   * @param snapshot - materialized destination matching all captured source writes.
   * @param lease - fresh proof that an already stopped source is fenced, including its current process generation.
   * @param publication - installed content owners checking their own migration coverage.
   * @param authorize - current administrator authority retained until the placement commits.
   */
  async publish(snapshot:Snapshot,lease:RuntimeStopLease,publication:NodeContentPublication,authorize?: (control:PoolClient)=>Promise<void>):Promise<void>{
    const b=this.b
    const missing=publication.missing()
    if (missing.length) throw new NodeContentUnavailable('Project content services are not ready: '+missing.join(', ')+'.')
    await transaction(this.control,async control=>{
      await authorize?.(control)
      const previous=await control.query(`SELECT FROM harness.project_content_copy_jobs j JOIN harness.project_content_placement p
        ON (p.organization_id,p.project_id,p.node_id,p.runtime_id,p.volume_id)=(j.organization_id,j.project_id,j.node_id,j.runtime_id,j.volume_id)
        WHERE j.id=$1 AND j.organization_id=$2 AND j.project_id=$3 AND j.runtime_id=$4 AND j.node_id=$5 AND j.volume_id=$6
        AND j.published AND j.source_revision=$7 AND p.writer_epoch=$8`,[snapshot.jobId,...jobCoordinates(b),snapshot.sourceRevision,b.writerEpoch])
      if (previous.rowCount===1) return
      await this.lockSource(control,snapshot,lease)
      const names=await projectNamePolicy(control,b.organizationId)
      if (names?.state!=='active') throw new NodeContentUnavailable('Complete organization-wide project name coverage before publishing this project.')
      const origin=(await control.query<{name:string;path:string;version:string}>(`SELECT p.name::text,m.canonical_path path,p.logical_name_id version
        FROM harness.projects p JOIN harness.project_mounts m ON (m.organization_id,m.project_id)=(p.organization_id,p.id)
        WHERE p.organization_id=$1 AND p.id=$2 AND m.node_id=$3 AND p.status='active' AND m.status='active' FOR UPDATE OF p,m`,[b.organizationId,b.projectId,b.nodeId])).rows[0]
      if(!origin)throw new NodeContentUnavailable('The source project metadata is unavailable.')
      await this.store.write(b,async local=>{
        const meta=(await local.query<{name:string;root_path:string}>(`SELECT node_content.project_name_at(organization_id,project_id,runtime_id,$4) name,root_path
          FROM node_content.spaces WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3`,[b.organizationId,b.projectId,b.runtimeId,origin.version])).rows[0]
        if(!meta||meta.name!==origin.name||meta.root_path!==origin.path) throw new NodeContentUnavailable('The source project name or directory changed. Stage current metadata before publication.')
        const verified=await local.query(`SELECT FROM node_content.migration_snapshots m WHERE m.id=$1 AND m.job_id=$2 AND m.organization_id=$3
          AND m.project_id=$4 AND m.runtime_id=$5 AND m.writer_epoch=$6 AND m.source_revision=$7 AND m.materialized AND m.verified`,
        [snapshot.id,snapshot.jobId,b.organizationId,b.projectId,b.runtimeId,b.writerEpoch,snapshot.sourceRevision])
        if (verified.rowCount!==1) throw new NodeContentUnavailable('The destination has not verified the typed copy for this source revision.')
        await publication.assertReady({control,local,binding:b,migration:{jobId:snapshot.jobId,snapshotId:snapshot.id,sourceRevision:snapshot.sourceRevision}})
        const sealed=await local.query(`UPDATE node_content.spaces SET publication_state='sealed' WHERE organization_id=$1 AND runtime_id=$2 AND publication_state IN ('staging','sealed')`,[b.organizationId,b.runtimeId])
        if (sealed.rowCount!==1) throw new NodeContentUnavailable('The local destination has another publication.')
      })
      await control.query(`INSERT INTO harness.project_content_placement(organization_id,project_id,runtime_id,node_id,volume_id,writer_epoch,source_retirement)
        VALUES($1,$2,$3,$4,$5,$6,'retiring')`,[...jobCoordinates(b),b.writerEpoch])
      await control.query(`INSERT INTO harness.node_journal_deliveries(organization_id,project_id,node_id,runtime_id,request_id,operation_id,completed)
        SELECT organization_id,project_id,node_id,$4,request_id,operation_id,completed FROM harness.project_journal_requests
        WHERE organization_id=$1 AND project_id=$2 AND node_id=$3 AND delivered_at IS NULL ON CONFLICT(request_id) DO NOTHING`,
      [b.organizationId,b.projectId,b.nodeId,b.runtimeId])
      await control.query('UPDATE harness.project_content_copy_jobs SET published=true,publication_xid=pg_current_xact_id() WHERE id=$1',[snapshot.jobId])
      await control.query("UPDATE harness.projects SET name='hgw-project-'||id::text WHERE organization_id=$1 AND id=$2",[b.organizationId,b.projectId])
      await control.query("UPDATE harness.project_mounts SET local_path='urn:hgw:project:'||project_id::text,canonical_path='urn:hgw:project:'||project_id::text WHERE organization_id=$1 AND project_id=$2 AND node_id=$3",[b.organizationId,b.projectId,b.nodeId])
    })
    await this.finishPublished(snapshot,authorize)
  }

  /** Finalize a committed placement after a lost operator response. Running work is untouched.
   * @param snapshot - the exact previously published job and source revision.
   * @param authorize - current operator authority retained while the local marker is finalized.
   */
  async finishPublished(snapshot:Snapshot,authorize?: (control:PoolClient)=>Promise<void>):Promise<void> {
    const b=this.b
    await transaction(this.control,async control=>{
      await authorize?.(control)
      const committed=await control.query(`SELECT FROM harness.project_content_copy_jobs j JOIN harness.project_content_placement p
        ON (p.organization_id,p.project_id,p.node_id,p.runtime_id,p.volume_id)=(j.organization_id,j.project_id,j.node_id,j.runtime_id,j.volume_id)
        WHERE j.id=$1 AND j.organization_id=$2 AND j.project_id=$3 AND j.runtime_id=$4 AND j.node_id=$5 AND j.volume_id=$6
          AND j.published AND j.source_revision=$7 AND p.writer_epoch=$8 FOR SHARE OF p,j`,[snapshot.jobId,...jobCoordinates(b),snapshot.sourceRevision,b.writerEpoch])
      if(committed.rowCount!==1) throw new NodeContentUnavailable('The selected migration is not the committed placement.')
      await this.store.write(b,async local=>{
        const result=await local.query(`UPDATE node_content.spaces s SET publication_state='published' WHERE s.organization_id=$1 AND s.runtime_id=$2
          AND s.publication_state IN ('sealed','published') AND EXISTS(SELECT FROM node_content.migration_snapshots m WHERE m.id=$3 AND m.job_id=$4 AND m.source_revision=$5
            AND (m.organization_id,m.runtime_id,m.project_id,m.writer_epoch)=(s.organization_id,s.runtime_id,s.project_id,s.writer_epoch) AND m.verified AND m.materialized)`,
        [b.organizationId,b.runtimeId,snapshot.id,snapshot.jobId,snapshot.sourceRevision])
        if (result.rowCount!==1) throw new NodeContentUnavailable('The active destination is not the sealed migration.')
      })
    })
  }
}
