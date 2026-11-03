/** Administrator-owned personal Runtime allocation, shared quotas and durable mutation receipts. */
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import type { RuntimeId, RuntimeNodeId } from './runtime-catalog.ts'
import { publicNumber, type PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { transaction } from './postgres/database.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { allocateInstancePorts } from './postgres/port-allocation.ts'
import { USERNAME_RE } from './user-name.ts'
import { prepareUserData } from './user-data.ts'
import type { RuntimeStopLease } from './instances.ts'

/** Caller-generated idempotency key retained after the allocated assignment retires. */
export type RuntimeAllocationRequestId = Branded<'RuntimeAllocationRequestId'>

/** Account-wide allocation limits count both stopped and running assignments on all computers. */
export interface RuntimeAllocationPolicy {
  revision: string
  maxTotal: number
  maxPerNode: number
  source: 'organization' | 'user'
}

/** Successful allocation receipt; retirement never reuses its identity or request id. */
export interface RuntimeAllocationReceipt {
  requestId: RuntimeAllocationRequestId
  runtimeId: RuntimeId
  nodeId: RuntimeNodeId
  userId: number
  status: 'preparing' | 'allocated' | 'retired'
}

/** Expected management refusal; no refused request starts a Runtime. */
export class RuntimeManagementError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, readonly code: 'runtime-management/invalid-request'
    | 'runtime-management/forbidden' | 'runtime-management/not-found' | 'runtime-management/revision-conflict'
    | 'runtime-management/quota-exceeded' | 'runtime-management/request-conflict' | 'runtime-management/provisioning-pending'
    | 'runtime-management/runtimes-not-stopped'
    | 'runtime-management/unavailable', options?: ErrorOptions) {
    super(code, options); this.name = 'RuntimeManagementError'
  }
}

const revision = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u)
const limits = z.object({ maxTotal: z.number().int().positive().max(2147483647),
  maxPerNode: z.number().int().positive().max(2147483647) }).strict().refine(value => value.maxPerNode <= value.maxTotal)
const policyWrite = z.object({ revision, limits: limits.nullable() }).strict()
const allocation = z.object({ requestId: z.uuid().transform(value => value as RuntimeAllocationRequestId) }).strict()
interface PolicyRow { revision: string; max_total: number; max_per_node: number; user_id: string | null; override_enabled: boolean }

/** Shared PostgreSQL policy and node-owned filesystem allocation over the existing personal-space services. */
export class PostgresRuntimeManagement {
  /** @param context - organization and computer whose local files this process owns. @param cfg - this deployment's existing user paths and port allocator settings. */
  constructor(private readonly context: PostgresRuntimeContext, private readonly cfg: GatewayConfig) {}

  private async actor(client: PoolClient, actor: UserRow): Promise<void> {
    await lockAdministrator(client, this.context, actor.id)
  }

  private async owner(client: PoolClient, userId: number, lock = false): Promise<{ id: string; username: string; active: boolean }> {
    const result = await client.query<{ id: string; username: string; active: boolean }>(`SELECT u.id,u.username::text,
      u.status='active' AND m.status='active' active FROM harness.users u
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      WHERE u.organization_id=$1 AND u.public_id=$2 AND u.deleted_at IS NULL${lock ? ' FOR UPDATE OF u,m' : ''}`,
    [this.context.organizationId, userId])
    const row = result.rows[0]
    if (row === undefined) throw new RuntimeManagementError(404, 'runtime-management/not-found')
    return row
  }

  private async policyRow(client: PoolClient, userId: string | null, lock = false): Promise<PolicyRow | undefined> {
    return (await client.query<PolicyRow>(`SELECT revision::text,max_total,max_per_node,user_id,override_enabled FROM harness.runtime_allocation_policies
      WHERE organization_id=$1 AND user_id IS NOT DISTINCT FROM $2::uuid${lock ? ' FOR UPDATE' : ' FOR SHARE'}`,
    [this.context.organizationId, userId])).rows[0]
  }

  private async resolvedPolicy(client: PoolClient, userId: string | null): Promise<RuntimeAllocationPolicy> {
    const own = await this.policyRow(client, userId)
    const row = own?.override_enabled === true ? own : await this.policyRow(client, null)
    if (row === undefined) throw new RuntimeManagementError(503, 'runtime-management/unavailable')
    return { revision: own?.revision ?? '0', maxTotal: row.max_total, maxPerNode: row.max_per_node,
      source: row.user_id === null ? 'organization' : 'user' }
  }

  /**
   * Read current organization limits or one account's explicit override and inherited limits.
   * @param actor - authenticated administrator candidate.
   * @param userId - selected account; omission reads the organization default.
   * @returns revision zero for an absent account override, with its current inherited limits.
   */
  async policy(actor: UserRow, userId?: number): Promise<RuntimeAllocationPolicy> {
    return transaction(this.context.pool, async client => {
      await this.actor(client, actor)
      return this.resolvedPolicy(client, userId === undefined ? null : (await this.owner(client, userId)).id)
    })
  }

  /**
   * Change allocation limits under the selected policy revision; lowering a limit retires no data or processes.
   * @param actor - administrator retained through commit.
   * @param value - complete limits and observed revision; null clears only an account override.
   * @param userId - account override, or omission for organization policy.
   * @returns committed explicit or inherited policy.
   */
  async setPolicy(actor: UserRow, value: unknown, userId?: number): Promise<RuntimeAllocationPolicy> {
    const parsed = policyWrite.safeParse(value)
    if (!parsed.success || userId === undefined && parsed.data.limits === null) throw new RuntimeManagementError(400, 'runtime-management/invalid-request')
    return transaction(this.context.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
      await this.actor(client, actor)
      const ownerId = userId === undefined ? null : (await this.owner(client, userId)).id
      const previous = await this.policyRow(client, ownerId, true)
      if ((previous?.revision ?? '0') !== parsed.data.revision) throw new RuntimeManagementError(409, 'runtime-management/revision-conflict')
      const selected = parsed.data.limits
      if (selected === null && previous !== undefined) await client.query(`UPDATE harness.runtime_allocation_policies
        SET override_enabled=false,revision=revision+1 WHERE organization_id=$1 AND user_id=$2`, [this.context.organizationId, ownerId])
      else if (selected !== null && previous === undefined) await client.query(`INSERT INTO harness.runtime_allocation_policies(organization_id,user_id,max_total,max_per_node)
        VALUES($1,$2,$3,$4)`, [this.context.organizationId, ownerId, selected.maxTotal, selected.maxPerNode])
      else if (selected !== null) await client.query(`UPDATE harness.runtime_allocation_policies SET max_total=$3,max_per_node=$4,override_enabled=true,revision=revision+1
        WHERE organization_id=$1 AND user_id IS NOT DISTINCT FROM $2::uuid`, [this.context.organizationId, ownerId, selected.maxTotal, selected.maxPerNode])
      const result = await this.resolvedPolicy(client, ownerId)
      await this.audit(client, actor.id, 'admin.runtimes.policy', { userId: userId ?? null, ...result })
      return result
    })
  }

  private async receipt(client: PoolClient, requestId: RuntimeAllocationRequestId): Promise<(RuntimeAllocationReceipt & { ownerId: string }) | undefined> {
    const result = await client.query<{ runtime_id: RuntimeId; node_id: RuntimeNodeId; user_id: string; public_id: string; retired: boolean; provisioning_state: 'preparing' | 'ready' | null }>(`SELECT
      receipt.runtime_id,receipt.node_id,receipt.user_id,account.public_id::text,environment.retired_at IS NOT NULL retired,instance.provisioning_state
      FROM harness.runtime_allocation_receipts receipt JOIN harness.users account ON account.organization_id=receipt.organization_id AND account.id=receipt.user_id
      JOIN harness.runtime_environments environment ON environment.organization_id=receipt.organization_id AND environment.id=receipt.runtime_id
      LEFT JOIN harness.instances instance ON instance.organization_id=receipt.organization_id AND instance.runtime_id=receipt.runtime_id
      WHERE receipt.organization_id=$1 AND receipt.request_id=$2`, [this.context.organizationId, requestId])
    const row = result.rows[0]
    return row === undefined ? undefined : { requestId, runtimeId: row.runtime_id, nodeId: row.node_id, ownerId: row.user_id,
      userId: publicNumber(row.public_id, 'user'), status: row.retired ? 'retired' : row.provisioning_state === 'ready' ? 'allocated' : 'preparing' }
  }

  /**
   * Allocate one stopped Runtime on this computer under current account, computer and shared quota authority.
   * @param actor - current administrator; allocation grants no additional computer permission.
   * @param userId - existing organization account.
   * @param value - fresh request UUID, reusable only to recover this exact allocation outcome.
   * @returns durable receipt after the node-owned directory and assignment commit, without starting a process.
   */
  async allocate(actor: UserRow, userId: number, value: unknown): Promise<RuntimeAllocationReceipt> {
    const parsed = allocation.safeParse(value)
    if (!parsed.success) throw new RuntimeManagementError(400, 'runtime-management/invalid-request')
    const decision = await transaction(this.context.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-port:${this.context.nodeId}`])
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
      await this.actor(client, actor)
      const previous = await this.receipt(client, parsed.data.requestId)
      if (previous !== undefined) {
        if (previous.userId !== userId || previous.nodeId !== this.context.nodeId) throw new RuntimeManagementError(409, 'runtime-management/request-conflict')
        if (previous.status !== 'preparing') return { kind: 'complete' as const, receipt: this.publicReceipt(previous) }
      }
      const owner = await this.owner(client, userId, true)
      if (!owner.active || !USERNAME_RE.test(owner.username)) throw new RuntimeManagementError(403, 'runtime-management/forbidden')
      await this.computerPermission(client, owner.id)
      let runtimeId = previous?.runtimeId
      if (runtimeId === undefined) {
        const policy = await this.resolvedPolicy(client, owner.id)
        const count = (await client.query<{ total: number; local: number }>(`SELECT count(*)::integer total,
          count(*) FILTER(WHERE assigned_node_id=$3)::integer local FROM harness.instances WHERE organization_id=$1 AND user_id=$2`,
        [this.context.organizationId, owner.id, this.context.nodeId])).rows[0]!
        if (count.total >= policy.maxTotal || count.local >= policy.maxPerNode) throw new RuntimeManagementError(409, 'runtime-management/quota-exceeded')
        await client.query(`INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,$4)
          ON CONFLICT DO NOTHING`, [this.context.organizationId, this.context.nodeId, owner.id, join(this.cfg.usersRoot, owner.username, 'home')])
        const [port] = await allocateInstancePorts(client, this.context.nodeId, this.cfg.instancePortBase, 1, this.context.nodeName)
        const row = (await client.query<{ runtime_id: RuntimeId }>(`INSERT INTO harness.instances
          (organization_id,user_id,assigned_node_id,port,storage_layout,provisioning_state)
          VALUES($1,$2,$3,$4,'isolated','preparing') RETURNING runtime_id`,
        [this.context.organizationId, owner.id, this.context.nodeId, port])).rows[0]!
        runtimeId = row.runtime_id
        await client.query("UPDATE harness.users SET personal_runtime_allocation='managed' WHERE organization_id=$1 AND id=$2", [this.context.organizationId, owner.id])
        await client.query(`INSERT INTO harness.runtime_allocation_receipts(organization_id,request_id,runtime_id,node_id,user_id,actor_user_id)
          VALUES($1,$2,$3,$4,$5,(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$6))`,
        [this.context.organizationId, parsed.data.requestId, runtimeId, this.context.nodeId, owner.id, actor.id])
        await this.audit(client, actor.id, 'admin.runtimes.allocate', { requestId: parsed.data.requestId, runtimeId,
          nodeId: this.context.nodeId, userId, status: 'preparing' })
      }
      const account = (await client.query<{ home_path: string }>(`SELECT home_path FROM harness.node_user_accounts
        WHERE organization_id=$1 AND node_id=$2 AND user_id=$3`, [this.context.organizationId, this.context.nodeId, owner.id])).rows[0]
      if (account === undefined) throw new RuntimeManagementError(503, 'runtime-management/unavailable')
      const receipt: RuntimeAllocationReceipt = { requestId: parsed.data.requestId, runtimeId,
        nodeId: this.context.nodeId as RuntimeNodeId, userId, status: 'preparing' }
      return { kind: 'prepare' as const, receipt, username: owner.username, homePath: account.home_path }
    })
    if (decision.kind === 'complete') return decision.receipt
    try { prepareUserData(this.cfg, decision.username, { runtimeId: decision.receipt.runtimeId, storageLayout: 'isolated' }, decision.homePath) }
    catch (error) { throw new RuntimeManagementError(503, 'runtime-management/provisioning-pending', { cause: error }) }
    return transaction(this.context.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
      await this.actor(client, actor)
      const current = await this.receipt(client, parsed.data.requestId)
      if (current === undefined) throw new RuntimeManagementError(503, 'runtime-management/unavailable')
      if (current.status !== 'preparing') return this.publicReceipt(current)
      const owner = await this.owner(client, userId, true)
      if (!owner.active) throw new RuntimeManagementError(403, 'runtime-management/forbidden')
      await this.computerPermission(client, owner.id)
      const ready = await client.query(`UPDATE harness.instances SET provisioning_state='ready',updated_at=now()
        WHERE organization_id=$1 AND assigned_node_id=$2 AND runtime_id=$3 AND user_id=$4
          AND provisioning_state='preparing' AND observed_state='stopped' AND desired_state='stopped'`,
      [this.context.organizationId, this.context.nodeId, current.runtimeId, owner.id])
      if (ready.rowCount !== 1) throw new RuntimeManagementError(409, 'runtime-management/unavailable')
      const result: RuntimeAllocationReceipt = { ...this.publicReceipt(current), status: 'allocated' }
      await this.audit(client, actor.id, 'admin.runtimes.provision', result)
      return result
    })
  }

  private publicReceipt(value: RuntimeAllocationReceipt): RuntimeAllocationReceipt {
    return { requestId: value.requestId, runtimeId: value.runtimeId, nodeId: value.nodeId, userId: value.userId, status: value.status }
  }

  /**
   * Inspect an uncertain allocation using center metadata, including after assignment retirement.
   * @param actor - current administrator candidate.
   * @param requestId - original allocation request UUID.
   * @returns the original identity and provisioning state; this read never contacts a computer or prepares files.
   */
  async allocationReceipt(actor: UserRow, requestId: string): Promise<RuntimeAllocationReceipt> {
    const parsed = allocation.shape.requestId.safeParse(requestId)
    if (!parsed.success) throw new RuntimeManagementError(400, 'runtime-management/invalid-request')
    return transaction(this.context.pool, async client => {
      await this.actor(client, actor)
      const found = await this.receipt(client, parsed.data)
      if (found === undefined) throw new RuntimeManagementError(404, 'runtime-management/not-found')
      const visible = await client.query<{ allowed: boolean }>('SELECT harness.entry_node_visible($1,$2,$3) allowed',
        [this.context.organizationId, this.context.nodeId, found.nodeId])
      if (visible.rows[0]?.allowed !== true) throw new RuntimeManagementError(404, 'runtime-management/not-found')
      return this.publicReceipt(found)
    })
  }

  /**
   * Retire a personal assignment inside its owning manager's confirmed-stop callback; data and history remain retained.
   * @param actor - current administrator retained through the retirement transaction.
   * @param userId - exact personal account addressed by the administrator directory.
   * @param lease - process-owned destructive operation whose termination and resource accounting have completed.
   * @returns completion after the exact assignment retires and automatic bootstrap repair is disabled for this account.
   */
  async retire(actor: UserRow, userId: number, lease: RuntimeStopLease): Promise<void> {
    if (lease.operationId === undefined) throw new RuntimeManagementError(503, 'runtime-management/unavailable')
    await transaction(this.context.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
      await this.actor(client, actor)
      const owner = await this.owner(client, userId, true)
      const current = await client.query(`SELECT 1 FROM harness.instances i JOIN harness.runtime_destructive_operations operation
        ON operation.organization_id=i.organization_id AND operation.runtime_id=i.runtime_id AND operation.node_id=i.assigned_node_id
          AND operation.generation=i.generation AND operation.operation_id=$5 AND operation.quiescent_at IS NOT NULL
        WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND i.runtime_id=$3 AND i.generation=$4 AND i.user_id=$6
          AND i.observed_state='stopping' AND i.desired_state='stopped' FOR UPDATE OF i,operation`,
      [this.context.organizationId, this.context.nodeId, lease.runtimeId, lease.generation, lease.operationId, owner.id])
      if (current.rowCount !== 1) throw new RuntimeManagementError(409, 'runtime-management/runtimes-not-stopped')
      await client.query("UPDATE harness.users SET personal_runtime_allocation='managed' WHERE organization_id=$1 AND id=$2", [this.context.organizationId, owner.id])
      await client.query('DELETE FROM harness.instances WHERE organization_id=$1 AND runtime_id=$2 AND generation=$3',
        [this.context.organizationId, lease.runtimeId, lease.generation])
      await this.audit(client, actor.id, 'admin.runtimes.retire', { userId, runtimeId: lease.runtimeId,
        nodeId: this.context.nodeId, generation: lease.generation, dataRetained: true })
    })
  }

  private async computerPermission(client: PoolClient, userId: string): Promise<void> {
    const result = await client.query(`SELECT 1 FROM harness.computer_use_permissions permission JOIN harness.compute_nodes node
      ON node.organization_id=permission.organization_id AND node.id=permission.node_id
      WHERE permission.organization_id=$1 AND permission.node_id=$2 AND permission.user_id=$3 AND permission.enabled FOR SHARE OF permission,node`,
    [this.context.organizationId, this.context.nodeId, userId])
    if (result.rowCount !== 1) throw new RuntimeManagementError(403, 'runtime-management/forbidden')
  }

  private async audit(client: PoolClient, actor: number, action: string, detail: object): Promise<void> {
    await client.query(`INSERT INTO harness.audit_events(organization_id,actor_user_id,action,resource_type,outcome,detail)
      VALUES($1,(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2),$3,'runtime','success',$4::jsonb)`,
    [this.context.organizationId, actor, action, JSON.stringify(detail)])
  }
}
