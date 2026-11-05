/** Explicit organization administrator operations for one project on its recorded owner. */
import type { PoolClient } from 'pg'
import { CollaborationDeniedError } from './collaboration.ts'
import type { InstanceManager } from './instances.ts'
import { NodeContentMigration } from './node-content-migration.ts'
import type { NodeMigrationChoices, NodeMigrationBlocker, NodeMigrationPreflight, NodeMigrationPublish, NodeMigrationTarget } from './node-content-migration-protocol.ts'
import type { NodeContentPublication } from './node-content-publication.ts'
import { NodeContentUnavailable, type NodeContentBinding, type NodeContentStore } from './node-content-store.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { transaction } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { RuntimeId } from './runtime-catalog.ts'

interface Project {
  id: string
  runtime_id: RuntimeId
  generation: number
  ready_to_fence: boolean
  available: boolean
  progress_busy: boolean
  names_active: boolean
  source_retirement: NodeMigrationPreflight['sourceRetirement']
  binding: NodeContentBinding | null
  job_id: string | null
  source_revision: string | null
  volume_id: string | null
  name: string | null
  root_path: string | null
}
type Snapshot = NodeMigrationPublish['snapshot']
type LocalSnapshot = Snapshot & { unprovedFiles: boolean }

/** A reviewed preflight can become stale while the source continues serving. */
export class NodeMigrationConflict extends Error {
  readonly status = 409
  readonly code = 'node-content/migration-conflict'
  constructor(message: string) { super(message); this.name = 'NodeMigrationConflict' }
}

/** Server-owned administrator identity, volume verifier, process supervisor and installed content domains. */
export class NodeContentMigrationAdmin {
  constructor(private readonly context: PostgresRuntimeContext, private readonly ready: () => Promise<NodeContentStore>,
    private readonly instances: Pick<InstanceManager, 'withStopped'>, private readonly publication: NodeContentPublication) {}

  private async selected(control: PoolClient, actor: number, id: number, expected?: NodeMigrationTarget): Promise<Project> {
    await lockAdministrator(control, this.context, actor)
    const { organizationId, nodeId } = this.context
    if (expected && expected.nodeId !== nodeId) throw new CollaborationDeniedError('forbidden')
    const row = (await control.query<Project>(`SELECT p.id,i.runtime_id,i.generation::float8 generation,
      i.desired_state='stopped' AND i.observed_state='stopped' AND i.runtime_token_hash IS NULL ready_to_fence,
      harness.node_execution_available(p.organization_id,i.assigned_node_id) available,
      EXISTS(SELECT FROM harness.project_journal_state js WHERE js.organization_id=p.organization_id AND js.project_id=p.id AND js.generating_since IS NOT NULL)
      OR EXISTS(SELECT FROM harness.project_journal_requests jr JOIN harness.node_resource_requests a
        ON (jr.organization_id,jr.node_id,jr.operation_id)=(a.organization_id,a.node_id,a.operation_id)
        WHERE jr.organization_id=p.organization_id AND jr.project_id=p.id AND NOT jr.completed) progress_busy,
      EXISTS(SELECT FROM harness.project_name_policies n WHERE n.organization_id=p.organization_id AND n.state='active'
        AND n.normalization=harness.project_name_normalization()) names_active,
      b.source_retirement,harness.project_content_key(p.organization_id,p.id) binding,j.id job_id,j.source_revision::text,j.volume_id,
      CASE WHEN b.project_id IS NULL THEN p.name::text END name,CASE WHEN b.project_id IS NULL THEN m.canonical_path END root_path
      FROM harness.projects p JOIN harness.project_mounts m ON (m.organization_id,m.project_id)=(p.organization_id,p.id) AND m.status='active'
      JOIN harness.instances i ON (i.organization_id,i.project_id,i.assigned_node_id)=(m.organization_id,m.project_id,m.node_id)
      JOIN harness.runtime_environments r ON (r.organization_id,r.id,r.owner_id,r.node_id)=(i.organization_id,i.runtime_id,i.project_id,i.assigned_node_id)
        AND r.owner_kind='project' AND r.retired_at IS NULL
      LEFT JOIN harness.project_content_placement b ON (b.organization_id,b.project_id,b.node_id,b.runtime_id)=(p.organization_id,p.id,m.node_id,i.runtime_id)
      LEFT JOIN harness.project_content_copy_jobs j ON (j.organization_id,j.project_id,j.node_id,j.runtime_id)=(p.organization_id,p.id,m.node_id,i.runtime_id)
      WHERE p.organization_id=$1 AND p.public_id=$2 AND m.node_id=$3 AND p.status='active' AND p.kind='standard'
        AND ($4::uuid IS NULL OR i.runtime_id=$4) FOR SHARE OF p,m,r`, [organizationId, id, nodeId, expected?.runtimeId ?? null])).rows[0]
    if (!row) throw new CollaborationDeniedError('forbidden')
    return row
  }

  private readSelection(actor: number, id: number, expected?: NodeMigrationTarget): Promise<Project> {
    return transaction(this.context.pool, tx => this.selected(tx, actor, id, expected))
  }

  private binding(project: Project): NodeContentBinding | undefined {
    if (project.binding) return project.binding
    if (!project.job_id || !project.volume_id) return undefined
    return { organizationId: this.context.organizationId, projectId: project.id, nodeId: this.context.nodeId,
      runtimeId: project.runtime_id, volumeId: project.volume_id, writerEpoch: '1' }
  }

  private async snapshot(store: NodeContentStore, project: Project): Promise<LocalSnapshot | null> {
    const binding = this.binding(project)
    if (!binding || !project.job_id) {
      await store.readVolume(db => db.query('SELECT 1'))
      return null
    }
    return store.read(binding, async db => (await db.query<LocalSnapshot>(`SELECT m.id,m.job_id "jobId",m.source_revision::text "sourceRevision",
      (COALESCE((m.manifest->'content_files'->>'rows')::bigint,0)>0 OR COALESCE((m.manifest->'conversation_archive_file_cleanup'->>'rows')::bigint,0)>0)
        AND NOT EXISTS(SELECT FROM node_content.migration_domain_receipts e WHERE e.snapshot_id=m.id AND e.domain='archive' AND e.source_revision=m.source_revision) "unprovedFiles"
      FROM node_content.migration_snapshots m WHERE m.job_id=$1 AND m.organization_id=$2 AND m.project_id=$3 AND m.runtime_id=$4
        AND m.writer_epoch=$5 AND m.materialized AND m.verified`, [project.job_id, binding.organizationId, binding.projectId, binding.runtimeId, binding.writerEpoch])).rows[0] ?? null)
  }

  /** Browse local allocations without reading content databases or starting a Runtime.
   * @param actor - current administrator. @param after - public ID of the previous page's final project.
   * @returns up to 25 project choices and the next cursor, if any.
   */
  async choices(actor: number, after = 0): Promise<NodeMigrationChoices> {
    if (!Number.isSafeInteger(after) || after < 0) throw new NodeMigrationConflict('Invalid project directory cursor.')
    return transaction(this.context.pool, async control => {
      await lockAdministrator(control, this.context, actor)
      const rows = (await control.query<{ id: number; name: string | null }>(`SELECT p.public_id::float8 id,
        CASE WHEN b.project_id IS NULL THEN p.name::text END name FROM harness.projects p
        JOIN harness.runtime_environments r ON r.organization_id=p.organization_id AND r.owner_kind='project' AND r.owner_id=p.id AND r.retired_at IS NULL
        JOIN harness.project_mounts m ON (m.organization_id,m.project_id,m.node_id)=(p.organization_id,p.id,r.node_id) AND m.status='active'
        LEFT JOIN harness.project_content_placement b ON (b.organization_id,b.project_id)=(p.organization_id,p.id)
        WHERE p.organization_id=$1 AND r.node_id=$2 AND p.status='active' AND p.kind='standard' AND p.public_id>$3
        ORDER BY p.public_id LIMIT 26`, [this.context.organizationId, this.context.nodeId, after])).rows
      const items = rows.slice(0,25)
      return { items, next: rows.length > items.length ? items.at(-1)!.id : null }
    })
  }

  /** Check one selected project without starting a Runtime or changing its storage.
   * @param actor - authenticated administrator. @param id - public project ID on this computer.
   * @returns only opaque identifiers, current conditions and verified snapshot coordinates.
   */
  async preflight(actor: number, id: number): Promise<NodeMigrationPreflight> {
    const project = await this.readSelection(actor, id)
    const blockers: NodeMigrationBlocker[] = []
    let snapshot: LocalSnapshot | null = null
    try { snapshot = await this.snapshot(await this.ready(), project) }
    catch (error) {
      if (!(error instanceof NodeContentUnavailable)) throw error
      blockers.push('volume-unavailable')
    }
    const missingAdapters = this.publication.missing()
    if (!project.source_retirement) {
      if (missingAdapters.length) blockers.push('adapters-missing')
      if (!project.available) blockers.push('node-unavailable')
      if (!project.names_active) blockers.push('names-incomplete')
      if (!project.ready_to_fence) blockers.push('runtime-busy')
      if (project.progress_busy) blockers.push('progress-busy')
      if (!snapshot) blockers.push('prepare-required')
      else if (snapshot.sourceRevision !== project.source_revision) blockers.push('source-changed')
      if (snapshot?.unprovedFiles) blockers.push('archive-files-unverified')
    }
    return { projectId: id, nodeId: this.context.nodeId, runtimeId: project.runtime_id, generation: project.generation,
      storage: project.source_retirement ? 'node' : 'shared', sourceRetirement: project.source_retirement,
      sourceRevision: project.source_revision, snapshot: snapshot && { id: snapshot.id, jobId: snapshot.jobId, sourceRevision: snapshot.sourceRevision },
      blockers, missingAdapters, canPrepare: !project.source_retirement && !blockers.includes('volume-unavailable') && project.available,
      canPublish: !project.source_retirement && blockers.length === 0 }
  }

  /** Prepare and verify an inert destination while the original project can keep serving.
   * @param actor - authenticated administrator. @param id - selected project. @param target - reviewed owner and Runtime.
   * @param signal - optional operator cancellation. @returns refreshed preparation state.
   */
  async prepare(actor: number, id: number, target: NodeMigrationTarget, signal?: AbortSignal): Promise<NodeMigrationPreflight> {
    await this.readSelection(actor, id, target)
    const store = await this.ready()
    const migration = await transaction(this.context.pool, async tx => {
      const project = await this.selected(tx, actor, id, target)
      if (!project.available || project.source_retirement || project.name === null || project.root_path === null) {
        throw new NodeMigrationConflict('The source is unavailable or has already switched storage. Refresh its current state.')
      }
      const binding = await store.stageProject(tx, { projectId: project.id, runtimeId: project.runtime_id, name: project.name, rootPath: project.root_path })
      const migration = new NodeContentMigration(this.context.pool, store, binding)
      await migration.register(tx)
      return migration
    }, signal)
    const snapshot = await migration.copy(signal)
    signal?.throwIfAborted()
    await this.readSelection(actor, id, target)
    await migration.materialize(snapshot)
    return this.preflight(actor, id)
  }

  /** Publish only the reviewed snapshot under the authentic process supervisor's positive stopped-generation proof.
   * @param actor - authenticated administrator. @param id - selected project. @param intent - reviewed generation and snapshot.
   * @returns current placement and source-retirement state.
   */
  async publish(actor: number, id: number, intent: NodeMigrationPublish): Promise<NodeMigrationPreflight> {
    const project = await this.readSelection(actor, id, intent)
    const store = await this.ready(), current = await this.snapshot(store, project), binding = this.binding(project)
    if (!current || !binding || current.id !== intent.snapshot.id || current.jobId !== intent.snapshot.jobId ||
      current.sourceRevision !== intent.snapshot.sourceRevision || project.source_revision !== current.sourceRevision) {
      throw new NodeMigrationConflict('Prepare the current source revision before publishing this project.')
    }
    const migration = new NodeContentMigration(this.context.pool, store, binding)
    if (project.source_retirement) {
      await migration.finishPublished(intent.snapshot, tx => lockAdministrator(tx, this.context, actor))
      return this.preflight(actor, id)
    }
    if (!project.available || !project.ready_to_fence || project.progress_busy || project.generation !== intent.generation) {
      throw new NodeMigrationConflict('The project must already be stopped on its available owner with no active progress work. Refresh its generation.')
    }
    if (current.unprovedFiles) throw new NodeMigrationConflict('The archived file inventory still requires verification.')
    if (!project.names_active || this.publication.missing().length) throw new NodeMigrationConflict('Complete the project name index and installed content services before publication.')
    await this.instances.withStopped({ kind: 'project', id, runtimeId: binding.runtimeId }, async lease => {
      if (!lease?.wasStopped || !lease.operationId) throw new NodeContentUnavailable('The process owner has not confirmed this stopped Runtime.')
      await migration.publish(intent.snapshot, lease, this.publication, tx => lockAdministrator(tx, this.context, actor))
    }, actor, intent.generation, 'content-publication')
    return this.preflight(actor, id)
  }
}
