/** Attested node-owned PostgreSQL volumes and fenced project transactions. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { isDatabaseContentionError, isTransientDatabaseError, transaction, type Queryable } from './postgres/database.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { NodeContentPublication } from './node-content-publication.ts'
import { peerProjectTables, projectScopedTables } from './node-content-project-tables.ts'
import { checkedNodeContentVersions, nodeContentMigrations } from './node-content-manifest.ts'
import { NodeContentUnavailable } from './node-content-error.ts'
import { assertLocalMount } from './node-local-mount.ts'
export { NodeContentUnavailable, assertLocalMount }

/** Governance coordinates. Names, paths and Session metadata stay in the volume. */
export interface NodeContentBinding {
  organizationId: string
  projectId: string
  nodeId: string
  runtimeId: RuntimeId
  volumeId: string
  writerEpoch: string
}

/** Configuration of a dedicated physical PostgreSQL content database. */
export interface NodeContentOptions {
  pool: Pool
  organizationId: string
  nodeId: string
  volumeId: string
  /** Host-visible PGDATA, including its operator-provisioned harness-node-content-proofs directory. */
  dataDirectory: string
  proofTimeoutMs: number
}

interface VolumeIdentity { clusterId: string; databaseOid: string }
interface BindingRow {
  organization_id: string; project_id: string; node_id: string; runtime_id: RuntimeId
  volume_id: string; writer_epoch: string
}

function bindingOf(row: BindingRow): NodeContentBinding {
  return { organizationId: row.organization_id, projectId: row.project_id, nodeId: row.node_id,
    runtimeId: row.runtime_id, volumeId: row.volume_id, writerEpoch: row.writer_epoch }
}

/** Look up the exact historical placement. Only a missing binding selects legacy storage.
 * @param query - organization control database.
 * @param organizationId - authenticated organization.
 * @param runtimeId - exact allocation.
 * @returns its published binding, or undefined for the shared layout.
 */
export async function getProjectContentBinding(query: Queryable, organizationId: string, runtimeId: RuntimeId): Promise<NodeContentBinding | undefined> {
  const result = await query.query<BindingRow>(`SELECT organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch::text
    FROM harness.project_content_placement WHERE organization_id=$1 AND runtime_id=$2`, [organizationId, runtimeId])
  return result.rows[0] === undefined ? undefined : bindingOf(result.rows[0])
}

/** One live database challenge is witnessed through a file created on the configured local volume. */
export async function proveNodeContentVolume(options: NodeContentOptions, client: PoolClient, bootstrap = false): Promise<VolumeIdentity> {
  if (!isAbsolute(options.dataDirectory) || !Number.isSafeInteger(options.proofTimeoutMs) || options.proofTimeoutMs < 1) {
    throw new NodeContentUnavailable('Invalid node content volume proof configuration.')
  }
  const root = await realpath(options.dataDirectory)
  const proofRoot = join(root, 'harness-node-content-proofs')
  const directory = await lstat(proofRoot)
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(proofRoot) !== proofRoot
    || process.platform !== 'win32' && (directory.mode & 0o002) !== 0) throw new NodeContentUnavailable('Unsafe challenge directory.')
  await assertLocalMount(root, options.proofTimeoutMs)
  const nonce = randomBytes(32), id = randomUUID(), path = join(proofRoot, id)
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o640)
  try {
    await file.writeFile(nonce)
    const result = await client.query<{ cluster_id: string; database_oid: number; proof: Buffer | null; relation_path: string }>(
      bootstrap ? `SELECT (pg_control_system()).system_identifier::text cluster_id,d.oid database_oid,
        sha256(pg_read_binary_file('harness-node-content-proofs/'||$1::uuid::text,0,32,true)) proof,
        pg_relation_filepath('pg_catalog.pg_class'::regclass) relation_path FROM pg_database d
        WHERE d.datname=current_database() AND NOT pg_is_in_recovery()` : 'SELECT * FROM node_content.volume_proof($1)', [id])
    const row = result.rows[0], digest = createHash('sha256').update(nonce).digest()
    if (row === undefined || row.proof === null || row.proof.length !== digest.length || !timingSafeEqual(row.proof, digest)
      || !new RegExp('^base/' + String(row.database_oid) + '/[0-9]+$','u').test(row.relation_path)) {
      throw new NodeContentUnavailable('The connected database did not prove the challenged content volume.')
    }
    const relation = join(root, row.relation_path)
    const [data, control, rootStat,wal] = await Promise.all([lstat(relation), readFile(join(root,'global','pg_control')), lstat(root),lstat(join(root,'pg_wal'))])
    if (await realpath(relation) !== relation || !data.isFile() || data.dev !== rootStat.dev || directory.dev !== rootStat.dev
      || !wal.isDirectory() || wal.isSymbolicLink() || wal.dev !== rootStat.dev || await realpath(join(root,'pg_wal')) !== join(root,'pg_wal')
      || control.length < 8 || ![control.readBigUInt64LE(),control.readBigUInt64BE()].some(value => value.toString() === row.cluster_id)) {
      throw new NodeContentUnavailable('PostgreSQL relation files or cluster identity differ from the local volume.')
    }
    return { clusterId: row.cluster_id, databaseOid: String(row.database_oid) }
  } finally {
    try { await file.close() } finally { await rm(path, { force: true }) }
  }
}

function storageFailure(error:unknown):never {
  const code = error instanceof Error && 'code' in error ? String(error.code) : ''
  if (isDatabaseContentionError(error) || isTransientDatabaseError(error) || ['ENOTDIR','ENOENT','EACCES','3F000','42P01','42501','28P01'].includes(code)) {
    throw new NodeContentUnavailable()
  }
  throw error
}

/** Dedicated content pool. Borrowed transactions verify placement and cannot select another database on failure. */
export class NodeContentStore {
  private readonly provenClients = new WeakSet<PoolClient>()
  private constructor(private readonly options: NodeContentOptions, private readonly identity: VolumeIdentity) {}

  /** Open an explicitly initialized volume. @param options - target node configuration. @returns the verified store. */
  static async open(options: NodeContentOptions): Promise<NodeContentStore> {
    return transaction(options.pool, async tx => {
      const identity = await proveNodeContentVolume(options, tx)
      const files=await nodeContentMigrations()
      if (await checkedNodeContentVersions(tx,files)!==files.length) throw new NodeContentUnavailable('The node content database requires an explicit schema upgrade.')
      const store = new NodeContentStore(options, identity)
      await store.checkVolume(tx)
      store.provenClients.add(tx)
      return store
    },AbortSignal.timeout(options.proofTimeoutMs)).catch(storageFailure)
  }

  private identityParameters(): [string,string,string,string,string] {
    return [this.options.organizationId,this.options.nodeId,this.options.volumeId,this.identity.clusterId,this.identity.databaseOid]
  }

  private async checkVolume(tx: PoolClient): Promise<void> {
    const result = await tx.query(`SELECT 1 FROM node_content.volume v JOIN pg_database d ON d.oid=v.database_oid AND d.datname=current_database()
      WHERE v.singleton AND v.organization_id=$1 AND v.node_id=$2 AND v.volume_id=$3 AND v.cluster_id=$4 AND v.database_oid=$5
      AND to_regnamespace('harness') IS NULL AND NOT pg_is_in_recovery()
      AND d.dattablespace=(SELECT oid FROM pg_tablespace WHERE spcname='pg_default')
      AND NOT EXISTS(WITH owned AS (SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='node_content'),
        physical AS (SELECT oid FROM owned UNION SELECT reltoastrelid FROM owned UNION SELECT indexrelid FROM pg_index WHERE indrelid IN (SELECT reltoastrelid FROM owned))
        SELECT FROM physical JOIN pg_class c ON c.oid=physical.oid WHERE c.relkind IN ('r','m','i','t') AND c.reltablespace NOT IN (0,d.dattablespace))
`, this.identityParameters())
    if (result.rowCount !== 1) throw new NodeContentUnavailable('Unexpected content database, node or volume identity.')
  }

  private async verify(tx: PoolClient): Promise<void> {
    if (!this.provenClients.has(tx)) {
      const proof = await proveNodeContentVolume(this.options, tx)
      if (proof.clusterId !== this.identity.clusterId || proof.databaseOid !== this.identity.databaseOid) throw new NodeContentUnavailable()
      this.provenClients.add(tx)
    }
    await this.checkVolume(tx)
  }

  /** Publish non-content coordinates only after local verification. @param control - current organization transaction. */
  async registerVolume(control: Queryable): Promise<void> {
    await transaction(this.options.pool, tx => this.verify(tx))
    const [org,node,volume,cluster,oid] = this.identityParameters()
    const result = await control.query(`INSERT INTO harness.node_content_volumes(organization_id,node_id,volume_id,cluster_id,database_oid)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(volume_id) DO UPDATE SET cluster_id=excluded.cluster_id
      WHERE node_content_volumes.organization_id=excluded.organization_id AND node_content_volumes.node_id=excluded.node_id
      AND node_content_volumes.cluster_id=excluded.cluster_id AND node_content_volumes.database_oid=excluded.database_oid RETURNING 1`, [org,node,volume,cluster,oid])
    if (result.rowCount !== 1) throw new NodeContentUnavailable('A different computer owns the content volume.')
  }

  /** Prepare the local representation and publish its binding inside new project creation.
   * @param control - creating control transaction, carrying an uncommitted new project.
   * @param project - freshly allocated space with node-owned display name and path.
   * @returns the immutable publication coordinates.
   */
  async bindNewProject(control: PoolClient, project: { projectId: string; runtimeId: RuntimeId; name: string; rootPath: string },
    publication = new NodeContentPublication()): Promise<NodeContentBinding> {
    const missing=publication.missing()
    if (missing.length) throw new NodeContentUnavailable('Project content services are not ready: '+missing.join(', ')+'.')
    const { organizationId, nodeId } = this.options
    const fresh = await control.query(`SELECT 1 FROM harness.projects p JOIN harness.instances i ON i.project_id=p.id AND i.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.id=$2 AND i.runtime_id=$3 AND i.assigned_node_id=$4 AND p.kind='standard'
      AND i.observed_state='stopped' AND p.content_creation_xid=pg_current_xact_id()
      AND NOT EXISTS(SELECT FROM harness.conversation_sessions s WHERE s.organization_id=p.organization_id AND s.project_id=p.id)
      FOR UPDATE OF p,i`, [organizationId,project.projectId,project.runtimeId,nodeId])
    if (fresh.rowCount !== 1) throw new NodeContentUnavailable('Only a newly created stopped project can publish a fresh content volume.')
    const binding=await this.stageProject(control,project)
    await this.write(binding,async local=>{
      await publication.assertReady({control,local,binding})
      await local.query("UPDATE node_content.spaces SET publication_state='published' WHERE organization_id=$1 AND project_id=$2",[binding.organizationId,binding.projectId])
    })
    await control.query(`INSERT INTO harness.project_content_placement(organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch)
      VALUES($1,$2,$3,$4,$5,$6)`,this.parameters(binding))
    return binding
  }

  /** Prepare one inert destination for a new or existing space. This operation does not change the live storage target.
   * @param control - control transaction that owns the project identity.
   * @param project - original allocated ids and node-owned business metadata.
   * @returns the prepared coordinates for migration and verification.
   */
  async stageProject(control: PoolClient,project:{ projectId:string; runtimeId:RuntimeId; name:string; rootPath:string }): Promise<NodeContentBinding> {
    const [org,node,volume]=this.identityParameters()
    const verified=await control.query<{name_version:string;name:string;root:string;fresh:boolean}>(`SELECT p.logical_name_id name_version,p.name::text,m.canonical_path root,
      p.content_creation_xid=pg_current_xact_id() fresh FROM harness.projects p JOIN harness.project_mounts m ON (m.organization_id,m.project_id)=(p.organization_id,p.id)
      JOIN harness.runtime_environments r
      ON r.organization_id=p.organization_id AND r.owner_kind='project' AND r.owner_id=p.id
      WHERE p.organization_id=$1 AND p.id=$2 AND r.id=$3 AND r.node_id=$4 AND m.node_id=$4 AND m.status='active' AND r.retired_at IS NULL AND p.kind='standard' AND p.status='active'
      AND NOT EXISTS(SELECT FROM harness.project_content_placement b WHERE b.organization_id=p.organization_id AND b.project_id=p.id)
      FOR SHARE OF p,r`,[org,project.projectId,project.runtimeId,node])
    if (verified.rowCount!==1) throw new NodeContentUnavailable('The project does not have an unbound allocation on this node.')
    const facts=verified.rows[0]!
    if(!facts.fresh&&(facts.name!==project.name||facts.root!==project.rootPath)) throw new NodeContentUnavailable('The source project name or workspace changed before staging.')
    await this.registerVolume(control)
    const b:NodeContentBinding={organizationId:org,projectId:project.projectId,nodeId:node,volumeId:volume,runtimeId:project.runtimeId,writerEpoch:'1'}
    await transaction(this.options.pool,async tx=>{
      await this.verify(tx)
      const pinned=await tx.query(`INSERT INTO node_content.spaces(organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch,name,root_path)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,project_id) DO UPDATE SET name=excluded.name,root_path=excluded.root_path
        WHERE (spaces.node_id,spaces.runtime_id,spaces.volume_id,spaces.writer_epoch)=(excluded.node_id,excluded.runtime_id,excluded.volume_id,excluded.writer_epoch)
          AND (spaces.publication_state='staging' OR (spaces.name,spaces.root_path)=(excluded.name,excluded.root_path)) RETURNING 1`,
      [...this.parameters(b),project.name,project.rootPath])
      if (pinned.rowCount!==1) throw new NodeContentUnavailable('The selected space is already occupied by a different identity or generation.')
      const recorded=await tx.query(`INSERT INTO node_content.project_name_versions(organization_id,project_id,runtime_id,version_id,name)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,project_id,version_id) DO UPDATE SET version_id=excluded.version_id
        WHERE project_name_versions.runtime_id=excluded.runtime_id AND project_name_versions.name=excluded.name`,
      [org,project.projectId,project.runtimeId,verified.rows[0]!.name_version,project.name])
      if (recorded.rowCount!==1) throw new NodeContentUnavailable('The selected name version is occupied by a different project name.')
    })
    return b
  }

  /** Remove an abandoned fresh allocation only after a definitive control-plane rollback.
   * @param control - owning control pool. The same allocation lock waits for any uncertain commit.
   * @param projectId - immutable ID generated by the failed creation.
   * @param runtimeId - allocation from that creation.
   * @returns true only when the project was never published and had no Runtime work.
   */
  async discardDetachedCreation(control:Pool,projectId:string,runtimeId:RuntimeId):Promise<boolean> {
    const {organizationId:org,nodeId:node}=this.options
    return transaction(control,async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['gateway-port:'+node])
      const used=await tx.query(`SELECT FROM harness.projects WHERE organization_id=$1 AND id=$2 UNION ALL
        SELECT FROM harness.runtime_environments WHERE organization_id=$1 AND (id=$3 OR (owner_kind='project' AND owner_id=$2))
        UNION ALL SELECT FROM harness.project_content_copy_jobs WHERE organization_id=$1 AND project_id=$2 LIMIT 1`,[org,projectId,runtimeId])
      if (used.rowCount) return false
      return this.writeVolume(async local=>{
        const candidate=await local.query(`SELECT FROM node_content.spaces s WHERE s.organization_id=$1 AND s.project_id=$2 AND s.runtime_id=$3
          AND s.node_id=$4 AND s.volume_id=$5 AND s.writer_epoch=1 AND s.runtime_generation=0
          AND NOT EXISTS(SELECT FROM node_content.migration_snapshots m WHERE m.organization_id=s.organization_id AND m.runtime_id=s.runtime_id)
          AND NOT EXISTS(SELECT FROM node_content.conversation_sessions c WHERE c.organization_id=s.organization_id AND c.runtime_id=s.runtime_id)
          AND NOT EXISTS(SELECT FROM node_content.execution_sessions e WHERE e.organization_id=s.organization_id AND e.runtime_id=s.runtime_id) FOR UPDATE OF s`,
        [org,projectId,runtimeId,node,this.options.volumeId])
        if (!candidate.rowCount) return false
        // bindNewProject's assertReady populates children beyond spaces —
        // document_roots and project_file_anchors at minimum — and their
        // non-cascading foreign keys turn a spaces-only delete into a thrown
        // 23503, leaving the orphan permanent. Delete every project-scoped
        // table in reverse dependency order before the parent row; journal
        // tables key by project rather than runtime.
        for (const table of peerProjectTables.slice(1).reverse()) {
          const projectKey = projectScopedTables.has(table)
          await local.query(`DELETE FROM node_content."${table}" WHERE organization_id=$1 AND ${projectKey?'project_id':'runtime_id'}=$2`,[org,projectKey?projectId:runtimeId])
        }
        await local.query('DELETE FROM node_content.spaces WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3',[org,projectId,runtimeId])
        return true
      })
    })
  }

  private parameters(b: NodeContentBinding): [string,string,string,RuntimeId,string,string] {
    if (b.organizationId !== this.options.organizationId || b.nodeId !== this.options.nodeId || b.volumeId !== this.options.volumeId) throw new NodeContentUnavailable()
    return [b.organizationId,b.projectId,b.nodeId,b.runtimeId,b.volumeId,b.writerEpoch]
  }

  /** Read a node-owned domain that is scoped by account, computer or a batch of authorized projects.
   * @param work - reader that enforces its domain's organization, node and access predicates.
   * @param signal - optional caller cancellation.
   * @returns a repeatable snapshot from this verified volume.
   */
  readVolume<T>(work:(tx:PoolClient)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    return transaction(this.options.pool,async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await this.verify(tx)
      return work(tx)
    },signal).catch(storageFailure)
  }

  /** Commit a verified node-level domain; project content uses write() to advance its project revision.
   * @param work - mutation that checks its domain's subject and write epoch.
   * @param signal - optional caller cancellation.
   * @returns the result after the local commit.
   */
  writeVolume<T>(work:(tx:PoolClient)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    return transaction(this.options.pool,async tx=>{
      await this.verify(tx)
      return work(tx)
    },signal).catch(storageFailure)
  }

  /** Read one verified space from a repeatable snapshot. @param binding - control-issued coordinates. @param work - bounded local consumer. @returns its result. */
  read<T>(binding: NodeContentBinding, work: (tx: PoolClient) => Promise<T>, signal?: AbortSignal, generation?: number): Promise<T> {
    return transaction(this.options.pool, async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await this.verify(tx)
      const result = await tx.query(`SELECT 1 FROM node_content.spaces WHERE organization_id=$1 AND project_id=$2 AND node_id=$3
        AND runtime_id=$4 AND volume_id=$5 AND writer_epoch=$6 AND publication_state<>'retired' AND NOT EXISTS(SELECT FROM node_content.recovery_candidates rc
          WHERE rc.organization_id=spaces.organization_id AND rc.runtime_id=spaces.runtime_id AND rc.phase<>'active')
        AND ($7::bigint IS NULL OR runtime_generation<=$7)`, [...this.parameters(binding),generation ?? null])
      if (result.rowCount !== 1) throw new NodeContentUnavailable('The local content space does not match its active placement.')
      return work(tx)
    }, signal).catch(storageFailure)
  }

  /** Retain the matching local visibility decision only for the final live organization check.
   * @param binding - exact governing placement. @param revision - ACL revision of the original content snapshot.
   * @param finish - fresh, bounded account/project authorization before issuing data.
   * @param generation - credential's Runtime generation when applicable. @returns the confirmed operation result.
   */
  async confirmCollaborationRead<T>(binding:NodeContentBinding,revision:string,finish:()=>Promise<T>,generation?:number):Promise<T> {
    return transaction(this.options.pool,async tx=>{
      await this.verify(tx)
      const current=await tx.query(`SELECT FROM node_content.spaces s JOIN node_content.conversation_acl_versions v
        ON (v.organization_id,v.runtime_id,v.project_id)=(s.organization_id,s.runtime_id,s.project_id)
        WHERE s.organization_id=$1 AND s.project_id=$2 AND s.node_id=$3 AND s.runtime_id=$4 AND s.volume_id=$5 AND s.writer_epoch=$6
          AND v.revision=$7 AND ($8::bigint IS NULL OR s.runtime_generation<=$8) AND s.publication_state<>'retired'
          AND NOT EXISTS(SELECT FROM node_content.recovery_candidates r WHERE r.organization_id=s.organization_id AND r.runtime_id=s.runtime_id AND r.phase<>'active')
        FOR SHARE OF v NOWAIT`,[...this.parameters(binding),revision,generation??null])
      if(current.rowCount!==1) throw new NodeContentUnavailable('The conversation permissions changed while reading. Retry with current access.')
      return finish()
    }).catch(storageFailure)
  }

  /** Serialize and fence one local commit. @param binding - control-issued coordinates. @param work - local mutation. @param generation - current authenticated Runtime generation if applicable. @returns its result after commit. */
  write<T>(binding: NodeContentBinding, work: (tx: PoolClient) => Promise<T>, generation?: number): Promise<T> {
    return transaction(this.options.pool, async tx => {
      await this.verify(tx)
      const updated = await tx.query(`UPDATE node_content.spaces SET revision=revision+1,
        runtime_generation=GREATEST(runtime_generation,COALESCE($7::bigint,runtime_generation))
        WHERE organization_id=$1 AND project_id=$2 AND node_id=$3 AND runtime_id=$4 AND volume_id=$5 AND writer_epoch=$6
        AND publication_state<>'retired' AND NOT EXISTS(SELECT FROM node_content.recovery_candidates rc
          WHERE rc.organization_id=spaces.organization_id AND rc.runtime_id=spaces.runtime_id AND rc.phase<>'active')
        AND ($7::bigint IS NULL OR runtime_generation<=$7) RETURNING 1`, [...this.parameters(binding),generation ?? null])
      if (updated.rowCount !== 1) throw new NodeContentUnavailable('The active content writer or Runtime generation has changed.')
      return work(tx)
    }).catch(storageFailure)
  }
}
