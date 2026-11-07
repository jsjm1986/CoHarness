import { RuntimeStartBlockedError, RuntimeGenerationConflictError, type InstanceRepository, type RuntimeInstanceSnapshot, type RuntimeTarget, type RuntimeStartIntent, type RuntimeStopReason,
  type RuntimeStopLease, type RuntimeStopOperationId, type RuntimeStopPurpose } from '../instances.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { PersonalRuntimePolicy } from '../instances.ts'
import { RuntimeCatalogError, type RuntimeId } from '../runtime-catalog.ts'
import type { PersonalRuntimeStorageLayout } from '../runtime-layout.ts'
import type { GatewayResourceOwner } from '../node-resource-budget.ts'
import type { PoolClient } from 'pg'
import { createHash } from 'node:crypto'
import { isDatabaseContentionError, transaction } from './database.ts'
import { allocateInstancePorts } from './port-allocation.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'
import type { RuntimeCredentialSubject } from '../runtime-api.ts'
import { CollaborationDeniedError } from '../collaboration.ts'
import { lockProjectManagement } from './project-management-authority.ts'
import type { Queryable } from './database.ts'
import { lockAdministrator } from './administrator-authority.ts'
import type { ProjectOrigin } from '../projects.ts'

function runtimeAddress(target: RuntimeTarget, parameter: number): string {
  const owner = target.kind === 'user' ? 'user_id' : 'project_id'
  return `(($${parameter}::uuid IS NOT NULL AND i.runtime_id=$${parameter}) OR ($${parameter}::uuid IS NULL AND NOT EXISTS(
    SELECT 1 FROM harness.instances other WHERE other.organization_id=i.organization_id
      AND other.assigned_node_id=i.assigned_node_id AND other.${owner}=i.${owner} AND other.runtime_id<>i.runtime_id)))`
}

function ownerJoin(target: RuntimeTarget, runtimeParameter = 4): { join: string; predicate: string; noun: string } {
  return target.kind === 'user'
    ? {
        join: 'JOIN harness.users owner ON owner.id=i.user_id AND owner.organization_id=i.organization_id',
        predicate: `owner.public_id=$3 AND ${runtimeAddress(target, runtimeParameter)}`,
        noun: 'user',
      }
    : {
        join: 'JOIN harness.projects owner ON owner.id=i.project_id AND owner.organization_id=i.organization_id',
        predicate: `owner.public_id=$3 AND ${runtimeAddress(target, runtimeParameter)}`,
        noun: 'project',
      }
}

function activeOwnerPredicate(target: RuntimeTarget): string {
  return target.kind === 'user'
    ? `owner.status='active' AND owner.deleted_at IS NULL
      AND harness.computer_use_allowed(owner.organization_id,owner.id,i.assigned_node_id) AND EXISTS(
        SELECT 1 FROM harness.memberships membership
        WHERE membership.organization_id=owner.organization_id AND membership.user_id=owner.id
          AND membership.status='active'
      )`
    : `owner.status='active'`
}

/** PostgreSQL instance rows scoped to one organization and compute node. */
export class PostgresInstanceRepository implements InstanceRepository {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly instancePortBase: number,
  ) {}

  async resolveTarget(target: RuntimeTarget): Promise<RuntimeTarget> {
    const owner = target.kind === 'user' ? 'users' : 'projects', column = target.kind === 'user' ? 'user_id' : 'project_id'
    const result = await this.context.pool.query<{ runtime_id: RuntimeId }>(`SELECT i.runtime_id FROM harness.instances i
      JOIN harness.${owner} owner ON owner.organization_id=i.organization_id AND owner.id=i.${column}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND owner.public_id=$3
        AND ($4::uuid IS NULL OR i.runtime_id=$4) ORDER BY i.runtime_id LIMIT 2`,
    [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null])
    if (result.rows.length > 1) throw new RuntimeCatalogError(409, 'runtime-catalog/ambiguous-target')
    if (result.rows.length === 0) throw new RuntimeStartBlockedError('unavailable', 'Runtime assignment is missing.')
    return { ...target, runtimeId: result.rows[0]!.runtime_id }
  }

  async snapshotOf(target: RuntimeTarget): Promise<RuntimeInstanceSnapshot> {
    const owner = target.kind === 'user' ? 'users' : 'projects', column = target.kind === 'user' ? 'user_id' : 'project_id'
    const result = await this.context.pool.query<{ runtime_id: RuntimeId; observed_state: string; port: number; generation: string }>(
      `SELECT i.runtime_id,i.observed_state,i.port,i.generation::text FROM harness.instances i
      JOIN harness.${owner} owner ON owner.organization_id=i.organization_id AND owner.id=i.${column}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND owner.public_id=$3
        AND ($4::uuid IS NULL OR i.runtime_id=$4) ORDER BY i.runtime_id LIMIT 2`,
      [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null],
    )
    if (result.rows.length > 1) throw new RuntimeCatalogError(409, 'runtime-catalog/ambiguous-target')
    const row = result.rows[0]
    if (row === undefined) throw new RuntimeStartBlockedError('unavailable', 'Runtime assignment is missing.')
    return { target: { ...target, runtimeId: row.runtime_id }, state: row.observed_state, port: row.port, generation: Number(row.generation) }
  }

  async targetsForOwner(target: RuntimeTarget): Promise<RuntimeTarget[]> {
    const column = target.kind === 'user' ? 'user_id' : 'project_id', table = target.kind === 'user' ? 'users' : 'projects'
    const result = await this.context.pool.query<{ runtime_id: RuntimeId }>(`SELECT i.runtime_id FROM harness.instances i
      JOIN harness.${table} owner ON owner.organization_id=i.organization_id AND owner.id=i.${column}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND owner.public_id=$3 ORDER BY i.runtime_id`,
    [this.context.organizationId, this.context.nodeId, target.id])
    return result.rows.map(row => ({ kind: target.kind, id: target.id, runtimeId: row.runtime_id }))
  }

  async initialize(): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-port:${this.context.nodeId}`])
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
      // Account share locks survive port allocation and serialize with deletion.
      const missingUsers = await client.query<{ user_id: string }>(`SELECT u.id user_id
        FROM harness.users u
        WHERE u.organization_id=$1 AND u.status='active' AND u.deleted_at IS NULL AND u.personal_runtime_allocation='automatic'
          AND (NOT EXISTS(SELECT 1 FROM harness.node_user_accounts account WHERE account.organization_id=u.organization_id AND account.user_id=u.id)
            OR EXISTS(SELECT 1 FROM harness.node_user_accounts account WHERE account.organization_id=u.organization_id AND account.user_id=u.id AND account.node_id=$2))
          AND harness.computer_use_allowed(u.organization_id,u.id,$2)
          AND EXISTS (
            SELECT 1 FROM harness.memberships membership
            WHERE membership.organization_id=u.organization_id
              AND membership.user_id=u.id AND membership.status='active'
          )
          AND NOT EXISTS(
            SELECT 1 FROM harness.instances i
            WHERE i.organization_id=u.organization_id AND i.user_id=u.id
          ) ORDER BY u.public_id FOR SHARE OF u`, [this.context.organizationId, this.context.nodeId])
      const missingProjects = await client.query<{ project_id: string }>(`SELECT p.id project_id
        FROM harness.projects p
        JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
          AND pm.node_id=$2 AND pm.status='active'
        WHERE p.organization_id=$1 AND p.status='active' AND NOT EXISTS(
          SELECT 1 FROM harness.instances i
          WHERE i.organization_id=p.organization_id AND i.project_id=p.id
        ) ORDER BY p.public_id`, [this.context.organizationId, this.context.nodeId])
      const missingCount = missingUsers.rows.length + missingProjects.rows.length
      const ports = await allocateInstancePorts(
        client,
        this.context.nodeId,
        this.instancePortBase,
        missingCount,
        this.context.nodeName,
      )
      if (missingUsers.rows.length > 0) {
        await client.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port)
          SELECT $1,item.user_id,$2,item.port
          FROM unnest($3::uuid[],$4::integer[]) AS item(user_id,port)`, [
          this.context.organizationId,
          this.context.nodeId,
          missingUsers.rows.map(row => row.user_id),
          ports.slice(0, missingUsers.rows.length),
        ])
      }
      if (missingProjects.rows.length > 0) {
        await client.query(`INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port)
          SELECT $1,item.project_id,$2,item.port
          FROM unnest($3::uuid[],$4::integer[]) AS item(project_id,port)`, [
          this.context.organizationId,
          this.context.nodeId,
          missingProjects.rows.map(row => row.project_id),
          ports.slice(missingUsers.rows.length),
        ])
      }
    })
  }

  async activeTargets(): Promise<RuntimeTarget[]> {
    const result = await this.context.pool.query<{ kind: 'user' | 'project'; id: string; runtime_id: RuntimeId }>(`SELECT i.runtime_id,
      CASE WHEN i.user_id IS NOT NULL THEN 'user' ELSE 'project' END kind,
      COALESCE(u.public_id,p.public_id)::text id FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
      LEFT JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND i.observed_state IN ('ready','starting','stopping')`,
    [this.context.organizationId, this.context.nodeId])
    return result.rows.map(row => ({ kind: row.kind, id: publicNumber(row.id, 'Runtime target'), runtimeId: row.runtime_id }))
  }

  async portOf(target: RuntimeTarget): Promise<number> {
    const owner = ownerJoin(target)
    const result = await this.context.pool.query<{ port: number }>(`SELECT i.port FROM harness.instances i
      ${owner.join}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${owner.predicate}`,
    [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null])
    const port = result.rows[0]?.port
    if (port === undefined) throw new Error(`no instance row for ${owner.noun} ${String(target.id)}`)
    return port
  }

  async stateOf(target: RuntimeTarget): Promise<string> {
    const owner = ownerJoin(target)
    const result = await this.context.pool.query<{ observed_state: string }>(`SELECT i.observed_state
      FROM harness.instances i ${owner.join}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${owner.predicate}`,
    [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null])
    return result.rows[0]?.observed_state ?? 'stopped'
  }

  async generationOf(target: RuntimeTarget): Promise<number> {
    const owner = ownerJoin(target)
    const result = await this.context.pool.query<{ generation: string }>(`SELECT i.generation::text
      FROM harness.instances i ${owner.join}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${owner.predicate}`,
    [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null])
    const generation = result.rows[0]?.generation
    if (generation === undefined) throw new Error(`no instance row for ${owner.noun} ${String(target.id)}`)
    return Number(generation)
  }

  async credentialHashOf(target: RuntimeTarget, generation: number): Promise<string | null> {
    const owner = ownerJoin(target, 5)
    const result = await this.context.pool.query<{ credential_hash: string | null }>(`SELECT encode(i.runtime_token_hash,'hex') credential_hash
      FROM harness.instances i ${owner.join}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${owner.predicate} AND i.generation=$4`,
    [this.context.organizationId, this.context.nodeId, target.id, generation, target.runtimeId ?? null])
    const row = result.rows[0]
    if (row === undefined) throw new Error(`stale instance generation for ${target.kind} ${String(target.id)}`)
    return row.credential_hash
  }

  async stopReasonOf(target: RuntimeTarget): Promise<RuntimeStopReason | null> {
    const owner = ownerJoin(target)
    const result = await this.context.pool.query<{ stop_reason: RuntimeStopReason | null }>(`SELECT i.stop_reason
      FROM harness.instances i ${owner.join}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${owner.predicate}`,
    [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null])
    const row = result.rows[0]
    if (row === undefined) throw new Error(`no instance row for ${owner.noun} ${String(target.id)}`)
    return row.stop_reason
  }

  async touch(target: RuntimeTarget, at: number): Promise<void> {
    await this.activity(client => client.query(`UPDATE harness.instances i SET
      last_activity_at=to_timestamp($4/1000.0),updated_at=now()
      FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
      WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
        AND owner.organization_id=i.organization_id AND i.organization_id=$1
        AND i.assigned_node_id=$2 AND owner.public_id=$3 AND ${runtimeAddress(target, 5)}`,
    [this.context.organizationId, this.context.nodeId, target.id, at, target.runtimeId ?? null]))
  }

  async admitLease(target: RuntimeTarget, at: number, generation?: number): Promise<boolean> {
    const owner = ownerJoin(target)
    const result = await this.activity(async client => {
      await client.query(`SELECT i.id FROM harness.instances i ${owner.join}
        WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${owner.predicate} FOR UPDATE OF i`,
      [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null])
      return client.query(`UPDATE harness.instances i SET
      last_activity_at=to_timestamp($5/1000.0),updated_at=now()
      FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
      WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
        AND owner.organization_id=i.organization_id AND i.organization_id=$1
        AND i.assigned_node_id=$2 AND ${owner.predicate} AND ${activeOwnerPredicate(target)}
        AND i.observed_state='ready' AND i.provisioning_state='ready'
        AND ($6::bigint IS NULL OR i.generation=$6)
        AND harness.node_execution_available(i.organization_id,i.assigned_node_id)
        AND harness.runtime_node_execution_allowed(
          i.organization_id,i.assigned_node_id,i.node_connection_id,i.node_connection_epoch)`,
      [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null, at, generation ?? null])
    })
    return result.rowCount === 1
  }

  private async activity<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await transaction(this.context.pool, operation, undefined, { lockWait: 'statement' })
    } catch (error) {
      if (!isDatabaseContentionError(error)) throw error
      throw new RuntimeStartBlockedError('unavailable', 'Runtime activity is busy. Retry after the current operation settles.', { cause: error })
    }
  }

  async markExpiredConnectionStopping(target: RuntimeTarget, generation: number, administratorUserId?: number): Promise<boolean> {
    const owner = ownerJoin(target, 5)
    const claim = async (database: Queryable): Promise<boolean> => {
      const result = await database.query(`UPDATE harness.instances i
        SET desired_state='stopped',observed_state='stopping',
          stop_reason=CASE WHEN i.stop_reason='manual' THEN 'manual' ELSE 'access-change' END,updated_at=now()
        FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
        WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
          AND owner.organization_id=i.organization_id AND i.organization_id=$1 AND i.assigned_node_id=$2
          AND ${owner.predicate} AND i.generation=$4 AND i.observed_state IN ('starting','ready','stopping')
          AND NOT EXISTS(SELECT 1 FROM harness.runtime_destructive_operations operation
            WHERE operation.organization_id=i.organization_id AND operation.runtime_id=i.runtime_id)
          AND i.node_connection_id IS NOT NULL AND NOT harness.runtime_node_execution_allowed(
            i.organization_id,i.assigned_node_id,i.node_connection_id,i.node_connection_epoch)`,
      [this.context.organizationId, this.context.nodeId, target.id, generation, target.runtimeId ?? null])
      return result.rowCount === 1
    }
    return administratorUserId === undefined ? claim(this.context.pool) : this.withAdministrator(administratorUserId, claim)
  }

  async beginStart(target: RuntimeTarget, at: number, runtimeTokenHash: Buffer, intent: RuntimeStartIntent = 'passive', administratorUserId?: number): Promise<number> {
    const activeOwner = activeOwnerPredicate(target)
    const claim = (database: Queryable) => database.query<{ generation: string }>(`UPDATE harness.instances i
      SET desired_state='running',observed_state='starting',stop_reason=NULL,allocation_state='not-started',
      generation=generation+1,started_at=to_timestamp($4/1000.0),last_activity_at=to_timestamp($4/1000.0),
      runtime_token_hash=$5,runtime_token_issued_at=now(),updated_at=now()
      FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
      WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
        AND owner.organization_id=i.organization_id AND i.organization_id=$1
        AND i.assigned_node_id=$2 AND owner.public_id=$3 AND ${activeOwner} AND ${runtimeAddress(target, 7)}
        AND harness.node_execution_available(i.organization_id,i.assigned_node_id)
        AND i.observed_state='stopped' AND i.provisioning_state='ready'
        AND NOT EXISTS(SELECT 1 FROM harness.runtime_destructive_operations operation
          WHERE operation.organization_id=i.organization_id AND operation.runtime_id=i.runtime_id)
        AND ($6='explicit' OR (i.stop_reason IS DISTINCT FROM 'manual' AND ($6<>'webhook' OR i.stop_reason='idle')))
      RETURNING i.generation::text`,
    [this.context.organizationId, this.context.nodeId, target.id, at, runtimeTokenHash, intent, target.runtimeId ?? null])
    const result = await (administratorUserId === undefined ? claim(this.context.pool)
      : this.withAdministrator(administratorUserId, claim)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === '55000'
        && 'constraint' in error && (error.constraint === 'runtime_destructive_operation'
          || error.constraint === 'runtime_node_execution')) throw new RuntimeStartBlockedError('unavailable')
      throw error
    })
    const generation = result.rows[0]?.generation
    if (generation === undefined) {
      const eligible = await this.startEligibility(target), reason = eligible?.stopReason
      const blockedIntent = intent !== 'explicit' && (reason === 'manual' || intent === 'webhook' && reason !== 'idle')
      throw new RuntimeStartBlockedError(eligible !== null && blockedIntent ? eligible.stopReason : 'unavailable')
    }
    return Number(generation)
  }

  async startEligibility(target: RuntimeTarget): Promise<{ stopReason: RuntimeStopReason | null } | null> {
    const owner = ownerJoin(target)
    const result = await this.context.pool.query<{ stop_reason: RuntimeStopReason | null }>(`SELECT i.stop_reason
      FROM harness.instances i ${owner.join}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${owner.predicate} AND ${activeOwnerPredicate(target)}
        AND i.provisioning_state='ready'
        AND harness.node_execution_available(i.organization_id,i.assigned_node_id)
        AND (i.observed_state='stopped' OR harness.runtime_node_execution_allowed(
          i.organization_id,i.assigned_node_id,i.node_connection_id,i.node_connection_epoch))`,
    [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null])
    const row = result.rows[0]
    return row === undefined ? null : { stopReason: row.stop_reason }
  }

  async markReady(target: RuntimeTarget, generation: number): Promise<void> {
    const result = await this.context.pool.query(`UPDATE harness.instances i SET observed_state='ready',
      observed_generation=generation,last_heartbeat_at=now(),updated_at=now()
      FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
      WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
        AND owner.organization_id=i.organization_id AND i.organization_id=$1
        AND i.assigned_node_id=$2 AND owner.public_id=$3 AND i.generation=$4
        AND i.desired_state='running' AND i.observed_state='starting' AND i.stop_reason IS NULL AND ${runtimeAddress(target, 5)}`,
    [this.context.organizationId, this.context.nodeId, target.id, generation, target.runtimeId ?? null])
    if (result.rowCount !== 1) throw new Error(`stale instance generation for ${target.kind} ${String(target.id)}`)
  }

  async idleTargets(cutoff: number): Promise<RuntimeTarget[]> {
    const result = await this.context.pool.query<{ kind: 'user' | 'project'; public_id: string; runtime_id: RuntimeId }>(`SELECT i.runtime_id,
      CASE WHEN i.user_id IS NOT NULL THEN 'user' ELSE 'project' END kind,
      COALESCE(u.public_id,p.public_id)::text public_id
      FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
      LEFT JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND i.observed_state='ready'
        AND i.last_activity_at < to_timestamp($3/1000.0)
        AND (p.kind IS NULL OR p.kind<>'steward')
      ORDER BY kind,public_id`, [this.context.organizationId, this.context.nodeId, cutoff])
    return result.rows.map(row => ({ kind: row.kind, id: publicNumber(row.public_id, row.kind), runtimeId: row.runtime_id }))
  }

  async idleTarget(target: RuntimeTarget, cutoff: number): Promise<boolean> {
    const owner = ownerJoin(target, 5)
    const result = await this.context.pool.query(`SELECT 1 AS present FROM harness.instances i
      ${owner.join}
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${owner.predicate}
        AND i.observed_state='ready' AND i.last_activity_at < to_timestamp($4/1000.0)
        ${target.kind === 'project' ? `AND owner.kind<>'steward'` : ''}
      LIMIT 1`, [this.context.organizationId, this.context.nodeId, target.id, cutoff, target.runtimeId ?? null])
    return result.rows.length > 0
  }

  private async writeStopping(database: Queryable, target: RuntimeTarget, generation: number, reason: RuntimeStopReason, idleCutoff?: number): Promise<boolean> {
    const idlePredicate = idleCutoff === undefined ? '' : `AND i.observed_state='ready'
      AND i.last_activity_at < to_timestamp($7/1000.0)
      ${target.kind === 'project' ? "AND owner.kind<>'steward'" : ''}
      AND EXISTS (SELECT 1 FROM harness.node_resource_runtimes runtime WHERE runtime.organization_id=i.organization_id
        AND runtime.node_id=i.assigned_node_id AND runtime.runtime_kind='${target.kind}' AND runtime.runtime_public_id=$3
        AND runtime.generation=i.generation AND runtime.runtime_id=i.runtime_id)
      AND NOT EXISTS (SELECT 1 FROM harness.node_resource_requests request WHERE request.organization_id=i.organization_id
        AND request.node_id=i.assigned_node_id AND request.runtime_kind='${target.kind}' AND request.runtime_public_id=$3
        AND request.generation=i.generation)`
    const result = await database.query(`UPDATE harness.instances i SET desired_state='stopped',observed_state='stopping',
      stop_reason=CASE WHEN i.stop_reason='manual' THEN 'manual' ELSE $5 END,updated_at=now() FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
      WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
        AND owner.organization_id=i.organization_id AND i.organization_id=$1
        AND i.assigned_node_id=$2 AND owner.public_id=$3 AND i.generation=$4 AND ${runtimeAddress(target, 6)} ${idlePredicate}`,
    [this.context.organizationId, this.context.nodeId, target.id, generation, reason, target.runtimeId ?? null,
      ...idleCutoff === undefined ? [] : [idleCutoff]])
    return result.rowCount === 1
  }

  /** Atomically retain queued, running and uncertain work before claiming automatic process termination. */
  async markIdleStopping(target: RuntimeTarget, generation: number, cutoff: number): Promise<boolean> {
    return transaction(this.context.pool, async client => {
      const locked = await client.query(`SELECT 1 FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2 FOR UPDATE`,
        [this.context.organizationId, this.context.nodeId])
      if (locked.rowCount !== 1) return false
      return this.writeStopping(client, target, generation, 'idle', cutoff)
    })
  }

  async markStopping(target: RuntimeTarget, generation: number, reason: RuntimeStopReason = 'manual', actorUserId?: number): Promise<boolean> {
    if (actorUserId === undefined) return this.writeStopping(this.context.pool, target, generation, reason)
    return transaction(this.context.pool, async client => {
      await this.destructiveActor(client, target, actorUserId)
      return this.writeStopping(client, target, generation, reason)
    })
  }

  private withAdministrator<T>(administratorUserId: number, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return transaction(this.context.pool, async client => {
      await lockAdministrator(client, this.context, administratorUserId)
      return operation(client)
    })
  }

  async authorizeAdministrator(administratorUserId: number): Promise<void> {
    await this.withAdministrator(administratorUserId, async () => {})
  }

  markControlStopping(target: RuntimeTarget, generation: number, reason: RuntimeStopReason, administratorUserId: number): Promise<boolean> {
    return this.withAdministrator(administratorUserId, client => this.writeStopping(client, target, generation, reason))
  }

  async acquireStopLease(target: RuntimeTarget, operationId: RuntimeStopOperationId, owner: GatewayResourceOwner, actorUserId?: number, expectedGeneration?: number,
    purpose: RuntimeStopPurpose = 'destructive'): Promise<RuntimeStopLease> {
    if (owner.organizationId !== this.context.organizationId) throw new Error('Gateway process owner belongs to another organization')
    return transaction(this.context.pool, async client => {
      if (actorUserId !== undefined) {
        switch (purpose) {
          case 'control': await lockAdministrator(client, this.context, actorUserId); break
          case 'destructive': await this.destructiveActor(client, target, actorUserId); break
          default: return assertNever(purpose)
        }
      }
      const process = await client.query(`SELECT 1 FROM harness.node_resource_gateways
        WHERE organization_id=$1 AND node_id=$2 AND owner_id=$3 AND generation=$4 FOR SHARE`,
      [this.context.organizationId, this.context.nodeId, owner.ownerId, owner.generation])
      if (process.rowCount !== 1) throw new Error('Gateway process owner is unavailable on this node')
      const join = ownerJoin(target)
      const assignment = await client.query<{ runtime_id: RuntimeId; generation: string; observed_state: string }>(`SELECT i.runtime_id,i.generation::text,i.observed_state
        FROM harness.instances i ${join.join}
        WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND ${join.predicate} FOR UPDATE OF i`,
      [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null])
      const row = assignment.rows[0]
      if (row === undefined) throw new RuntimeStartBlockedError('unavailable')
      const generation = Number(row.generation)
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Runtime generation exceeds the supported range')
      if (expectedGeneration !== undefined && generation !== expectedGeneration) throw new RuntimeGenerationConflictError()
      const registered = await client.query(`INSERT INTO harness.runtime_destructive_operations
        (organization_id,runtime_id,node_id,generation,operation_id,gateway_owner_id,gateway_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,runtime_id) DO NOTHING RETURNING runtime_id`,
      [this.context.organizationId, row.runtime_id, this.context.nodeId, generation, operationId, owner.ownerId, owner.generation])
      if (registered.rowCount !== 1) throw new RuntimeStartBlockedError('unavailable', 'A destructive Runtime operation is already pending.')
      await client.query(`UPDATE harness.instances SET desired_state='stopped',observed_state='stopping',stop_reason='manual',updated_at=now()
        WHERE organization_id=$1 AND runtime_id=$2 AND assigned_node_id=$3 AND generation=$4`,
      [this.context.organizationId, row.runtime_id, this.context.nodeId, generation])
      return { runtimeId: row.runtime_id, operationId, generation, wasStopped: row.observed_state === 'stopped' }
    })
  }

  async confirmStopLease(operationId: RuntimeStopOperationId, owner: GatewayResourceOwner): Promise<void> {
    if (owner.organizationId !== this.context.organizationId) throw new Error('Gateway process owner belongs to another organization')
    const result = await this.context.pool.query(`UPDATE harness.runtime_destructive_operations operation SET quiescent_at=clock_timestamp()
      FROM harness.instances instance WHERE operation.organization_id=$1 AND operation.node_id=$2 AND operation.operation_id=$3
        AND operation.gateway_owner_id=$4 AND operation.gateway_generation=$5
        AND instance.organization_id=operation.organization_id AND instance.runtime_id=operation.runtime_id
        AND instance.assigned_node_id=operation.node_id AND instance.generation=operation.generation
        AND instance.desired_state='stopped' AND instance.observed_state='stopping'`,
    [this.context.organizationId, this.context.nodeId, operationId, owner.ownerId, owner.generation])
    if (result.rowCount !== 1) throw new RuntimeStartBlockedError('unavailable', 'Runtime quiescence no longer belongs to this destructive operation.')
  }

  async releaseStopLease(operationId: RuntimeStopOperationId, owner: GatewayResourceOwner): Promise<void> {
    if (owner.organizationId !== this.context.organizationId) throw new Error('Gateway process owner belongs to another organization')
    await this.context.pool.query(`DELETE FROM harness.runtime_destructive_operations
      WHERE organization_id=$1 AND node_id=$2 AND operation_id=$3 AND gateway_owner_id=$4 AND gateway_generation=$5`,
    [this.context.organizationId, this.context.nodeId, operationId, owner.ownerId, owner.generation])
  }

  private async destructiveActor(client: PoolClient, target: RuntimeTarget, actorUserId: number): Promise<void> {
    if (target.kind === 'user') return lockAdministrator(client, this.context, actorUserId)
    const project = await lockProjectManagement(client, this.context, target.id, actorUserId, 'administrator')
    const kind = await client.query<{ kind: 'standard' | 'steward' }>('SELECT kind FROM harness.projects WHERE organization_id=$1 AND id=$2',
      [this.context.organizationId, project])
    if (kind.rows[0]?.kind === 'steward') throw new CollaborationDeniedError('steward-reserved')
  }

  async markStopped(target: RuntimeTarget, generation: number, reason?: RuntimeStopReason): Promise<boolean> {
    const result = await this.context.pool.query(`UPDATE harness.instances i SET desired_state='stopped',observed_state='stopped',
      stop_reason=CASE WHEN i.stop_reason='manual' THEN 'manual' ELSE COALESCE($5,i.stop_reason) END,last_heartbeat_at=now(),runtime_token_hash=NULL,runtime_token_issued_at=NULL,updated_at=now()
      FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
      WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'}
        AND owner.organization_id=i.organization_id AND i.organization_id=$1
        AND i.assigned_node_id=$2 AND owner.public_id=$3 AND i.generation=$4 AND ${runtimeAddress(target, 6)}`,
    [this.context.organizationId, this.context.nodeId, target.id, generation, reason ?? null, target.runtimeId ?? null])
    return result.rowCount === 1
  }

  async owner(target: RuntimeTarget): Promise<{
    kind: 'user' | 'project'
    id: number
    username: string
    homePath: string
    storageLayout?: PersonalRuntimeStorageLayout
    provisioning?: 'preparing' | 'ready'
    name?: string
    /** Reserved kind for project targets; absent for user targets. */
    projectKind?: 'standard' | 'steward'
    /** Stored creation source for the launch-time directory policy. */
    projectOrigin?: ProjectOrigin
  } | null> {
    if (target.kind === 'user') {
      const result = await this.context.pool.query<{
        public_id: string
        username: string
        home_path: string
        storage_layout: PersonalRuntimeStorageLayout
        provisioning_state: 'preparing' | 'ready'
      }>(`SELECT u.public_id::text,u.username::text,a.home_path,i.storage_layout,i.provisioning_state
        FROM harness.users u JOIN harness.instances i
          ON i.user_id=u.id AND i.organization_id=u.organization_id
        JOIN harness.node_user_accounts a ON a.organization_id=i.organization_id AND a.node_id=i.assigned_node_id AND a.user_id=i.user_id
        WHERE u.organization_id=$1 AND i.assigned_node_id=$2 AND u.public_id=$3 AND ${runtimeAddress(target, 4)}`,
      [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null])
      const row = result.rows[0]
      return row === undefined ? null : {
        kind: 'user',
        id: publicNumber(row.public_id, 'user'),
        username: row.username,
        homePath: row.home_path,
        storageLayout: row.storage_layout,
        provisioning: row.provisioning_state,
      }
    }
    const result = await this.context.pool.query<{
      public_id: string
      name: string
      local_path: string
      kind: 'standard' | 'steward'
      origin: ProjectOrigin
    }>(`SELECT p.public_id::text,p.name::text,m.local_path,p.kind,p.origin
      FROM harness.projects p
      JOIN harness.instances i ON i.project_id=p.id AND i.organization_id=p.organization_id
      JOIN harness.project_mounts m ON m.project_id=p.id AND m.organization_id=p.organization_id
        AND m.node_id=i.assigned_node_id AND m.status='active'
      WHERE p.organization_id=$1 AND i.assigned_node_id=$2 AND p.public_id=$3 AND ${runtimeAddress(target, 4)}`,
    [this.context.organizationId, this.context.nodeId, target.id, target.runtimeId ?? null])
    const row = result.rows[0]
    return row === undefined ? null : {
      kind: 'project',
      projectKind: row.kind,
      projectOrigin: row.origin,
      id: publicNumber(row.public_id, 'project'),
      username: `project-${row.public_id}`,
      name: row.name,
      homePath: row.local_path,
    }
  }

  async personalPolicy(id: number, administratorUserId?: number, runtimeId?: RuntimeId): Promise<PersonalRuntimePolicy | null> {
    const read = (database: Queryable) => database.query<{ public_id: string; username: string; home_path: string; role: 'admin' | 'member'; runtime_id: RuntimeId; storage_layout: PersonalRuntimeStorageLayout }>(`SELECT
      u.public_id::text,u.username::text,a.home_path,m.role,i.runtime_id,i.storage_layout
      FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      JOIN harness.organizations o ON o.id=u.organization_id
      JOIN harness.instances i ON i.organization_id=u.organization_id AND i.user_id=u.id
      JOIN harness.node_user_accounts a ON a.organization_id=i.organization_id AND a.node_id=i.assigned_node_id AND a.user_id=i.user_id
      WHERE u.organization_id=$1 AND i.assigned_node_id=$2 AND u.public_id=$3
        AND ${runtimeAddress({ kind: 'user', id, runtimeId }, 4)}
        AND harness.computer_use_allowed(u.organization_id,u.id,i.assigned_node_id)
        AND i.provisioning_state='ready'
        AND u.status='active' AND u.deleted_at IS NULL AND m.status='active' AND o.status='active'
        ${administratorUserId === undefined ? '' : 'FOR SHARE OF u,m'}`,
    [this.context.organizationId, this.context.nodeId, id, runtimeId ?? null])
    const result = await (administratorUserId === undefined ? read(this.context.pool) : this.withAdministrator(administratorUserId, read))
    const row = result.rows[0]
    return row === undefined ? null : { id: publicNumber(row.public_id, 'user'), username: row.username,
      homePath: row.home_path, role: row.role === 'admin' ? 'admin' : 'user', status: 'active', runtimeId: row.runtime_id, storageLayout: row.storage_layout }
  }

  /** Resolve a live runtime credential to its current generation and owner ids. */
  async authenticateRuntimeToken(token: string): Promise<RuntimeCredentialSubject | null> {
    return this.authenticateToken(token, false)
  }

  /**
   * Authenticate completion reports after revocation or while the owned Runtime stops.
   * @param token - private bearer for the current node and generation.
   * @returns identity for resource cleanup only; never permits new work.
   */
  async authenticateRuntimeCleanupToken(token: string): Promise<RuntimeCredentialSubject | null> {
    return this.authenticateToken(token, true)
  }

  private async authenticateToken(token: string, cleanup: boolean): Promise<{
    organizationId: string
    target: RuntimeTarget
    generation: number
    userInternalId?: string
    projectInternalId?: string
  } | null> {
    const hash = createHash('sha256').update(token).digest()
    const result = await this.context.pool.query<{
      organization_id: string
      runtime_id: RuntimeId
      generation: string
      user_internal_id: string | null
      user_public_id: string | null
      project_internal_id: string | null
      project_public_id: string | null
    }>(`SELECT i.organization_id,i.runtime_id,i.generation::text,
      u.id user_internal_id,u.public_id::text user_public_id,
      p.id project_internal_id,p.public_id::text project_public_id
      FROM harness.instances i
      JOIN harness.organizations o ON o.id=i.organization_id
      LEFT JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
      LEFT JOIN harness.memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id
      LEFT JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND i.runtime_token_hash=$3
        AND (($4 AND i.observed_state IN ('starting','ready','stopping'))
          OR (NOT $4 AND o.status='active' AND i.provisioning_state='ready' AND i.desired_state='running' AND i.observed_state IN ('starting','ready')
            AND harness.runtime_node_execution_allowed(i.organization_id,i.assigned_node_id,i.node_connection_id,i.node_connection_epoch)
            AND ((u.id IS NOT NULL AND u.status='active' AND u.deleted_at IS NULL AND m.status='active'
                AND harness.computer_use_allowed(u.organization_id,u.id,i.assigned_node_id))
              OR (p.id IS NOT NULL AND p.status='active'))))`,
    [this.context.organizationId, this.context.nodeId, hash, cleanup])
    const row = result.rows[0]
    if (row === undefined) return null
    if (row.user_internal_id !== null && row.user_public_id !== null) {
      return {
        organizationId: row.organization_id,
        target: { kind: 'user', id: publicNumber(row.user_public_id, 'user'), runtimeId: row.runtime_id },
        generation: Number(row.generation),
        userInternalId: row.user_internal_id,
      }
    }
    if (row.project_internal_id !== null && row.project_public_id !== null) {
      return {
        organizationId: row.organization_id,
        target: { kind: 'project', id: publicNumber(row.project_public_id, 'project'), runtimeId: row.runtime_id },
        generation: Number(row.generation),
        projectInternalId: row.project_internal_id,
      }
    }
    throw new Error('runtime credential resolved an ownerless instance')
  }
}
