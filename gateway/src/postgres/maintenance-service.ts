/**
 * Shared-PostgreSQL maintenance windows: writer convergence across Gateway
 * nodes, a monotonic write epoch that fences pre-restore writers, node drain
 * ordering, and the deployment operation ledger.
 *
 * The serving Gateway calls {@link PostgresMaintenanceService.heartbeat} on a
 * timer and routes every mutating HTTP request through {@link writeGate}; the
 * standalone `pg:deploy` applier drives {@link beginRestore}/{@link
 * completeRestore} while administrators drive {@link enterMaintenance},
 * {@link exitMaintenance}, and {@link setNodeStatus} from the admin API.
 */
import type { Queryable } from './database.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

export type ClusterMode = 'serving' | 'maintenance' | 'restoring'
export type DeploymentOperationKind = 'enter-maintenance' | 'exit-maintenance' | 'apply' | 'backup' | 'restore' | 'node-status'
export type DeploymentOperationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted'
export type DeploymentNodeStatus = 'active' | 'draining' | 'offline'

/** One compute node's maintenance convergence state as the applier sees it. */
export interface ClusterNodeView {
  nodeId: string
  name: string
  status: DeploymentNodeStatus
  /** PostgreSQL timestamp rendered by the driver. */
  lastHeartbeatAt: string | null
  heartbeatAgeMs: number | null
  maintenanceAppliedEpoch: string
  /**
   * Mutating requests and fenced background work the node reports as
   * in-flight. `-1` means the node's build predates inflight reporting — it
   * cannot prove it is not writing, so it never counts as quiesced.
   */
  inflightWrites: number
  /**
   * Fresh heartbeat, acknowledged the current maintenance epoch, and zero
   * in-flight writers.
   */
  quiesced: boolean
}

/** Cluster mode, epochs, and per-node writer convergence for one organization. */
export interface ClusterState {
  mode: ClusterMode
  maintenanceEpoch: string
  writeEpoch: string
  reason: string | null
  enteredAt: string | null
  updatedAt: string
  nodes: ClusterNodeView[]
  /**
   * Every node still allowed to write (active or draining) has a fresh
   * heartbeat and acknowledged the current maintenance epoch. Offline nodes
   * are declared stopped by an operator and never write.
   */
  writersQuiesced: boolean
}

/** HTTP write gate verdict; `stale-epoch` means the process predates a restore. */
export type WriteGateVerdict = 'open' | 'maintenance' | 'stale-epoch'

/** One ledger row describing a controlled deployment operation. */
export interface DeploymentOperationView {
  id: string
  kind: DeploymentOperationKind
  status: DeploymentOperationStatus
  nodeName: string | null
  detail: unknown
  createdBy: number | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

/** A maintenance or node lifecycle request was invalid for the current state. */
export class MaintenanceError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}

interface ControlRow {
  mode: ClusterMode
  maintenance_epoch: string
  write_epoch: string
  reason: string | null
  entered_at: string | null
  updated_at: string
}

function controlRow(row: { [key: string]: unknown } | undefined): ControlRow | undefined {
  if (row === undefined) return undefined
  return {
    mode: row.mode as ClusterMode,
    maintenance_epoch: String(row.maintenance_epoch),
    write_epoch: String(row.write_epoch),
    reason: row.reason as string | null,
    entered_at: row.entered_at as string | null,
    updated_at: String(row.updated_at),
  }
}

async function readControl(queryable: Queryable, organizationId: string): Promise<ControlRow> {
  const result = await queryable.query<Record<string, unknown>>(
    'SELECT mode,maintenance_epoch,write_epoch,reason,entered_at,updated_at FROM harness.cluster_control WHERE organization_id=$1',
    [organizationId],
  )
  return controlRow(result.rows[0]) ?? {
    mode: 'serving', maintenance_epoch: '0', write_epoch: '1',
    reason: null, entered_at: null, updated_at: '',
  }
}

async function ensureControl(queryable: Queryable, organizationId: string): Promise<void> {
  await queryable.query(
    'INSERT INTO harness.cluster_control(organization_id) VALUES($1) ON CONFLICT (organization_id) DO NOTHING',
    [organizationId],
  )
}

function operationView(row: Record<string, unknown>): DeploymentOperationView {
  return {
    id: String(row.id),
    kind: row.kind as DeploymentOperationKind,
    status: row.status as DeploymentOperationStatus,
    nodeName: row.node_name as string | null,
    detail: row.detail,
    createdBy: row.created_by === null ? null : publicNumber(row.created_by as string | number, 'operation actor'),
    createdAt: String(row.created_at),
    startedAt: row.started_at as string | null,
    finishedAt: row.finished_at as string | null,
    error: row.error as string | null,
  }
}

export class PostgresMaintenanceService {
  /**
   * @param context - database and organization owned by this Gateway
   * @param staleHeartbeatMs - heartbeat age at which a node stops counting as a live writer
   */
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly staleHeartbeatMs: number,
  ) {
    if (!Number.isSafeInteger(staleHeartbeatMs) || staleHeartbeatMs < 1) {
      throw new RangeError('staleHeartbeatMs must be a positive safe integer')
    }
  }

  /** Resolve the HTTP-facing public user number to the internal actor uuid. */
  private async actorUuid(actor: number | null): Promise<string | null> {
    if (actor === null) return null
    const result = await this.context.pool.query<{ id: string }>(
      'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',
      [this.context.organizationId, String(actor)],
    )
    return result.rows[0]?.id ?? null
  }

  /**
   * Open the HTTP write gate only while serving and while the process's
   * baseline write epoch still matches the database. A process that started
   * before a restore reads a higher epoch and fences itself out rather than
   * writing stale state over the restored snapshot.
   * @param baselineWriteEpoch - write epoch observed by this process at startup
   */
  async writeGate(baselineWriteEpoch: bigint): Promise<{ verdict: WriteGateVerdict; mode: ClusterMode; maintenanceEpoch: bigint; writeEpoch: bigint }> {
    const control = await readControl(this.context.pool, this.context.organizationId)
    const writeEpoch = BigInt(control.write_epoch)
    const maintenanceEpoch = BigInt(control.maintenance_epoch)
    if (writeEpoch !== baselineWriteEpoch) {
      return { verdict: 'stale-epoch', mode: control.mode, maintenanceEpoch, writeEpoch }
    }
    return {
      verdict: control.mode === 'serving' ? 'open' : 'maintenance',
      mode: control.mode, maintenanceEpoch, writeEpoch,
    }
  }

  /** Read the current control row without opening the gate; used by the heartbeat loop. */
  async currentWriteEpoch(): Promise<bigint> {
    const control = await readControl(this.context.pool, this.context.organizationId)
    return BigInt(control.write_epoch)
  }

  /**
   * Acknowledge the maintenance epoch this node's write gate has already
   * observed, publish the node's in-flight writer count, and refresh
   * `last_heartbeat_at`. Acknowledging only the observed epoch keeps a
   * restarted or cached node from claiming a quiesce its gate has not
   * enforced.
   * @param observedMaintenanceEpoch - epoch last returned by {@link writeGate}
   * @param inflightWrites - mutating requests and fenced background tasks
   *   currently executing on this node
   */
  async heartbeat(observedMaintenanceEpoch: bigint, inflightWrites: number): Promise<void> {
    const updated = await this.context.pool.query(
      `UPDATE harness.compute_nodes
       SET last_heartbeat_at=now(),
           status = CASE WHEN status = 'offline' THEN 'active' ELSE status END,
           maintenance_applied_epoch=GREATEST(maintenance_applied_epoch,$3),
           inflight_writes=$4
       WHERE organization_id=$1 AND id=$2`,
      [this.context.organizationId, this.context.nodeId, observedMaintenanceEpoch.toString(), inflightWrites],
    )
    if (updated.rowCount !== 1) throw new Error('maintenance heartbeat compute node disappeared')
  }

  /** Cluster mode plus per-node convergence for the admin API and the applier. */
  async state(): Promise<ClusterState> {
    const control = await readControl(this.context.pool, this.context.organizationId)
    const nodes = await this.context.pool.query<{
      id: string
      name: string
      status: DeploymentNodeStatus
      last_heartbeat_at: string | null
      heartbeat_age_ms: number | null
      maintenance_applied_epoch: string
      inflight_writes: string
    }>(
      `SELECT id,name::text,status,last_heartbeat_at,
              (EXTRACT(EPOCH FROM (now()-last_heartbeat_at))*1000)::bigint heartbeat_age_ms,
              maintenance_applied_epoch,inflight_writes
       FROM harness.compute_nodes WHERE organization_id=$1 ORDER BY name`,
      [this.context.organizationId],
    )
    const epoch = BigInt(control.maintenance_epoch)
    let quiesced = true
    const views = nodes.rows.map((row): ClusterNodeView => {
      const fresh = row.heartbeat_age_ms !== null && row.heartbeat_age_ms <= this.staleHeartbeatMs
      const applied = BigInt(row.maintenance_applied_epoch) >= epoch
      const inflight = Number(row.inflight_writes)
      // A node that never heartbeated cannot be writing; its gate observes the
      // maintenance epoch on first use. A stale-heartbeat node might still be
      // running partitioned and stays a writer until the operator stops it.
      // A reported inflight count of -1 predates inflight reporting, so that
      // node can never prove it is drained short of going offline.
      const cold = row.last_heartbeat_at === null
      const nodeQuiesced = row.status === 'offline' || cold || (fresh && applied && inflight === 0)
      if (row.status !== 'offline' && !nodeQuiesced) quiesced = false
      return {
        nodeId: row.id,
        name: row.name,
        status: row.status,
        lastHeartbeatAt: row.last_heartbeat_at,
        heartbeatAgeMs: row.heartbeat_age_ms === null ? null : Number(row.heartbeat_age_ms),
        maintenanceAppliedEpoch: row.maintenance_applied_epoch,
        inflightWrites: inflight,
        quiesced: nodeQuiesced,
      }
    })
    return {
      mode: control.mode,
      maintenanceEpoch: control.maintenance_epoch,
      writeEpoch: control.write_epoch,
      reason: control.reason,
      enteredAt: control.entered_at,
      updatedAt: control.updated_at,
      nodes: views,
      writersQuiesced: quiesced,
    }
  }

  /**
   * Enter maintenance: bump the epoch every writer must acknowledge before a
   * restore or apply window opens. Idempotent while maintenance or restoring
   * is already active so a second administrator cannot reset the clock.
   * @param actor - public user number of the administrator, or null for the applier
   * @param reason - operator-supplied window note recorded on the control row
   */
  async enterMaintenance(actor: number | null, reason?: string): Promise<ClusterState> {
    const actorUserId = await this.actorUuid(actor)
    const prior = await readControl(this.context.pool, this.context.organizationId)
    await this.context.pool.query(
      `INSERT INTO harness.cluster_control(organization_id,mode,maintenance_epoch,reason,actor_user_id,entered_at,updated_at)
       VALUES($1,'maintenance',1,$2,$3,now(),now())
       ON CONFLICT (organization_id) DO UPDATE SET
         mode = CASE WHEN harness.cluster_control.mode = 'serving' THEN 'maintenance' ELSE harness.cluster_control.mode END,
         maintenance_epoch = CASE WHEN harness.cluster_control.mode = 'serving'
                                  THEN harness.cluster_control.maintenance_epoch + 1
                                  ELSE harness.cluster_control.maintenance_epoch END,
         reason = CASE WHEN harness.cluster_control.mode = 'serving' THEN $2 ELSE harness.cluster_control.reason END,
         actor_user_id = CASE WHEN harness.cluster_control.mode = 'serving' THEN $3 ELSE harness.cluster_control.actor_user_id END,
         entered_at = CASE WHEN harness.cluster_control.mode = 'serving' THEN now() ELSE harness.cluster_control.entered_at END,
         updated_at = now()`,
      [this.context.organizationId, reason ?? null, actorUserId],
    )
    if (prior.mode === 'serving') {
      await this.insertOperation('enter-maintenance', 'completed', actorUserId, { reason: reason ?? null })
    }
    return this.state()
  }

  /** Leave maintenance back to serving; refused while a restore is open. */
  async exitMaintenance(actor: number | null): Promise<ClusterState> {
    const actorUserId = await this.actorUuid(actor)
    const updated = await this.context.pool.query(
      `UPDATE harness.cluster_control SET mode='serving', reason=NULL, actor_user_id=NULL, entered_at=NULL, updated_at=now()
       WHERE organization_id=$1 AND mode='maintenance'`,
      [this.context.organizationId],
    )
    if (updated.rowCount !== 1) {
      const control = await readControl(this.context.pool, this.context.organizationId)
      if (control.mode === 'restoring') throw new MaintenanceError(409, 'restore-in-progress')
      if (control.mode !== 'maintenance') throw new MaintenanceError(409, 'not-in-maintenance')
      throw new MaintenanceError(409, 'maintenance-exit-conflict')
    }
    await this.insertOperation('exit-maintenance', 'completed', actorUserId, {})
    return this.state()
  }

  /**
   * Open a restore window inside maintenance; every live writer must already
   * be quiesced so the restore cannot race a still-writing node.
   * @param backupId - registry row the restore will apply, or null for an operator-supplied dump
   */
  async beginRestore(actor: number | null, backupId?: string): Promise<ClusterState> {
    const state = await this.state()
    if (state.mode !== 'maintenance') throw new MaintenanceError(409, 'restore-requires-maintenance')
    if (!state.writersQuiesced) throw new MaintenanceError(409, 'writers-not-quiesced')
    const actorUserId = await this.actorUuid(actor)
    const updated = await this.context.pool.query(
      `UPDATE harness.cluster_control SET mode='restoring', updated_at=now()
       WHERE organization_id=$1 AND mode='maintenance'`,
      [this.context.organizationId],
    )
    if (updated.rowCount !== 1) throw new MaintenanceError(409, 'restore-begin-conflict')
    await this.insertOperation('restore', 'running', actorUserId, { backupId: backupId ?? null })
    return this.state()
  }

  /**
   * Finish a restore: bump the write epoch so every process started before the
   * restore fences itself out, mark the backup restored, and stay in
   * maintenance for operator verification before {@link exitMaintenance}.
   * @param detail - applier-recorded outcome such as dump checksum and restored files
   */
  async completeRestore(actor: number | null, backupId: string | undefined, detail: Record<string, unknown>): Promise<ClusterState> {
    const actorUserId = await this.actorUuid(actor)
    const updated = await this.context.pool.query(
      `UPDATE harness.cluster_control SET mode='maintenance',
         write_epoch=GREATEST(write_epoch+1,(EXTRACT(EPOCH FROM now())*1000)::bigint), updated_at=now()
       WHERE organization_id=$1 AND mode='restoring'`,
      [this.context.organizationId],
    )
    if (updated.rowCount !== 1) throw new MaintenanceError(409, 'restore-complete-conflict')
    if (backupId !== undefined) {
      await this.context.pool.query(
        `UPDATE harness.backup_records SET status='restored', restored_at=now()
         WHERE organization_id=$1 AND id=$2`,
        [this.context.organizationId, backupId],
      )
    }
    // The dump rewound the ledger to dump-time: a restore request that was
    // pending back then resurfaces as pending now. Abort any such resurrected
    // claim so a later applier cannot pick it up and re-restore.
    await this.context.pool.query(
      `UPDATE harness.deployment_operations
       SET status='aborted', finished_at=now(), error='superseded-by-restore'
       WHERE organization_id=$1 AND kind='restore' AND status='pending'`,
      [this.context.organizationId],
    )
    await this.insertOperation('restore', 'completed', actorUserId, { backupId: backupId ?? null, ...detail })
    return this.state()
  }

  /**
   * Re-assert the restoring window after `restoreDump`: the applier excludes
   * `cluster_control` from pg_restore, so the row normally survives intact —
   * this call covers restores run with a custom command line or against an
   * unpackaged dump where the exclusion was dropped. Reasserting keeps
   * `completeRestore` able to transition; the write epoch bump there stays
   * monotonic via `GREATEST` against whatever the dump rewound it to.
   */
  async resumeRestoring(): Promise<void> {
    await this.context.pool.query(
      `INSERT INTO harness.cluster_control(organization_id,mode,updated_at)
       VALUES($1,'restoring',now())
       ON CONFLICT (organization_id) DO UPDATE SET mode='restoring', updated_at=now()`,
      [this.context.organizationId],
    )
  }

  /** Record a failed restore attempt and return to maintenance so it can retry or exit. */
  async failRestore(actor: number | null, error: string): Promise<ClusterState> {
    const actorUserId = await this.actorUuid(actor)
    const updated = await this.context.pool.query(
      `UPDATE harness.cluster_control SET mode='maintenance', updated_at=now()
       WHERE organization_id=$1 AND mode='restoring'`,
      [this.context.organizationId],
    )
    if (updated.rowCount !== 1) throw new MaintenanceError(409, 'restore-fail-conflict')
    await this.insertOperation('restore', 'failed', actorUserId, { error })
    return this.state()
  }

  /**
   * Drain or reactivate one compute node for rolling restarts. `draining`
   * keeps the node writable until its heartbeat goes stale or it acknowledges
   * the epoch; `offline` declares it stopped and excludes it from quiesce
   * accounting.
   */
  async setNodeStatus(actor: number | null, nodeId: string, status: DeploymentNodeStatus): Promise<ClusterNodeView> {
    if (status !== 'active' && status !== 'draining' && status !== 'offline') {
      throw new MaintenanceError(400, 'invalid-node-status')
    }
    const actorUserId = await this.actorUuid(actor)
    const updated = await this.context.pool.query<{ name: string }>(
      `UPDATE harness.compute_nodes SET status=$3 WHERE organization_id=$1 AND id=$2 RETURNING name`,
      [this.context.organizationId, nodeId, status],
    )
    const row = updated.rows[0]
    if (row === undefined) throw new MaintenanceError(404, 'node-not-found')
    await this.insertOperation('node-status', 'completed', actorUserId, { nodeId, name: row.name, status })
    const state = await this.state()
    const view = state.nodes.find(node => node.nodeId === nodeId)
    if (view === undefined) throw new MaintenanceError(404, 'node-not-found')
    return view
  }

  /** Append one ledger row for an HTTP-facing actor; detail stays free of secrets. */
  async logOperation(
    kind: DeploymentOperationKind,
    status: DeploymentOperationStatus,
    actor: number | null,
    detail: Record<string, unknown>,
    nodeName?: string,
  ): Promise<string> {
    return this.insertOperation(kind, status, await this.actorUuid(actor), detail, nodeName)
  }

  /** Append one ledger row under an already-resolved internal actor uuid. */
  private async insertOperation(
    kind: DeploymentOperationKind,
    status: DeploymentOperationStatus,
    actorUserId: string | null,
    detail: Record<string, unknown>,
    nodeName?: string,
  ): Promise<string> {
    const started = status === 'running'
    const finished = status === 'completed' || status === 'failed' || status === 'aborted'
    const inserted = await this.context.pool.query<{ id: string }>(
      `INSERT INTO harness.deployment_operations(organization_id,kind,status,node_name,detail,created_by,started_at,finished_at,error)
       VALUES($1,$2,$3,$6,$4,$5,CASE WHEN $7 THEN now() ELSE NULL END,CASE WHEN $8 THEN now() ELSE NULL END,$9)
       RETURNING id`,
      [this.context.organizationId, kind, status, JSON.stringify(detail), actorUserId, nodeName ?? null,
        started, finished, typeof detail.error === 'string' ? detail.error : null],
    )
    return inserted.rows[0]!.id
  }

  /**
   * Claim the oldest pending restore request for the applier, marking it
   * running. Returns undefined when no administrator requested a restore.
   */
  async claimRestoreRequest(): Promise<DeploymentOperationView | undefined> {
    const claimed = await this.context.pool.query<{ id: string }>(
      `UPDATE harness.deployment_operations SET status='running', started_at=now(), node_name=$2
       WHERE id = (
         SELECT id FROM harness.deployment_operations
         WHERE organization_id=$1 AND kind='restore' AND status='pending'
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING id`,
      [this.context.organizationId, this.context.nodeName],
    )
    const row = claimed.rows[0]
    if (row === undefined) return undefined
    const selected = await this.context.pool.query<Record<string, unknown>>(
      `SELECT o.id,o.kind,o.status,o.node_name,o.detail,
              (SELECT u.public_id FROM harness.users u WHERE u.id=o.created_by) created_by,
              o.created_at,o.started_at,o.finished_at,o.error
       FROM harness.deployment_operations o WHERE o.organization_id=$1 AND o.id=$2`,
      [this.context.organizationId, row.id],
    )
    return operationView(selected.rows[0]!)
  }

  /** Close out a claimed pending operation after the applier finishes or fails it. */
  async finishOperation(id: string, status: 'completed' | 'failed' | 'aborted', detail: Record<string, unknown>): Promise<void> {
    await this.context.pool.query(
      `UPDATE harness.deployment_operations SET status=$3, detail=detail||$4, finished_at=now(),
         error=CASE WHEN $3='failed' THEN $5 ELSE error END
       WHERE organization_id=$1 AND id=$2`,
      [this.context.organizationId, id, status, JSON.stringify(detail),
        typeof detail.error === 'string' ? detail.error : null],
    )
  }

  /** Request a restore through the admin API; the applier claims pending rows. */
  async requestRestore(actor: number | null, backupId: string): Promise<DeploymentOperationView> {
    const actorUserId = await this.actorUuid(actor)
    let id: string
    try {
      const inserted = await this.context.pool.query<{ id: string }>(
        `INSERT INTO harness.deployment_operations(organization_id,kind,status,detail,created_by)
         VALUES($1,'restore','pending',$3,$2) RETURNING id`,
        [this.context.organizationId, actorUserId, JSON.stringify({ backupId })],
      )
      id = inserted.rows[0]!.id
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === '23505') {
        throw new MaintenanceError(409, 'restore-already-pending')
      }
      throw error
    }
    const row = await this.context.pool.query<Record<string, unknown>>(
      `SELECT o.id,o.kind,o.status,o.node_name,o.detail,
              (SELECT u.public_id FROM harness.users u WHERE u.id=o.created_by) created_by,
              o.created_at,o.started_at,o.finished_at,o.error
       FROM harness.deployment_operations o WHERE o.organization_id=$1 AND o.id=$2`,
      [this.context.organizationId, id],
    )
    return operationView(row.rows[0]!)
  }

  /** Recent ledger rows for the admin deployment page. */
  async listOperations(limit = 50): Promise<DeploymentOperationView[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('operation limit out of range')
    const result = await this.context.pool.query<Record<string, unknown> & { created_by: string | null }>(
      `SELECT o.id,o.kind,o.status,o.node_name,o.detail,
              (SELECT u.public_id FROM harness.users u WHERE u.id=o.created_by) created_by,
              o.created_at,o.started_at,o.finished_at,o.error
       FROM harness.deployment_operations o
       WHERE o.organization_id=$1 ORDER BY o.created_at DESC LIMIT $2`,
      [this.context.organizationId, limit],
    )
    return result.rows.map(operationView)
  }
}

export { ensureControl }
