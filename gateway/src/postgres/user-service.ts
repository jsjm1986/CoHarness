import type { RuntimeNodeId } from '../runtime-catalog.ts'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { UserRow } from '../auth.ts'
import type { GatewayConfig } from '../config.ts'
import { hashPassword } from '../password.ts'
import type { GatewayUserListRow } from '../services.ts'
import { prepareUserData } from '../user-data.ts'
import { transaction } from './database.ts'
import { allocateInstancePorts } from './port-allocation.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'
import { lockAdministrator } from './administrator-authority.ts'
import { USERNAME_RE } from '../user-name.ts'
import { RuntimeManagementError } from '../runtime-management.ts'

interface PostgresUserRow {
  internal_id: string
  public_id: string
  username: string
  display_name: string
  role: 'admin' | 'member'
  user_status: 'active' | 'disabled'
  deleted_at: Date | null
  membership_status: 'active' | 'disabled'
  home_path: string
  home_node_id?: RuntimeNodeId | null
  must_change_password: boolean
  auto_review_eligible: boolean
  port: number | null
  instance_state: string
  runtime_count: number
}

function isPostgresError(error: unknown): error is Error & { code: string; constraint?: string } {
  return error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
}

function toUser(row: Omit<PostgresUserRow, 'port' | 'instance_state' | 'runtime_count'>): UserRow {
  return {
    id: publicNumber(row.public_id, 'user'),
    username: row.username,
    displayName: row.display_name,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.user_status === 'active' && row.membership_status === 'active' ? 'active' : 'disabled',
    homePath: row.home_path,
    ...(row.home_node_id == null ? {} : { homeNodeId: row.home_node_id }),
    mustChangePassword: row.must_change_password,
    autoReviewEligible: row.auto_review_eligible,
  }
}

/** PostgreSQL-backed user administration; effective status includes organization, membership and account eligibility. */
export class PostgresUserService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly cfg: GatewayConfig,
  ) {}

  private selectUsers(where = '', assignment = true): string {
    return `SELECT u.id internal_id,u.public_id::text,u.username::text,u.display_name,
      CASE WHEN organization.status='active' THEN u.status ELSE 'disabled' END user_status,
      u.deleted_at,COALESCE(a.home_path,u.home_path) home_path,a.node_id home_node_id,u.auto_review_eligible,m.role,m.status membership_status,c.must_change_password,
      ${assignment ? 'i.port,i.instance_state,i.runtime_count' : 'NULL::integer port,NULL::text instance_state,0 runtime_count'}
      FROM harness.users u
      JOIN harness.organizations organization ON organization.id=u.organization_id
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      JOIN harness.password_credentials c ON c.user_id=u.id
      LEFT JOIN harness.node_user_accounts a ON a.organization_id=u.organization_id AND a.user_id=u.id AND a.node_id=${assignment ? '$2' : '$3'}
      ${assignment ? `LEFT JOIN LATERAL (SELECT count(*)::integer runtime_count,
        CASE WHEN count(*)=1 THEN min(instance.port) ELSE NULL END port,
        CASE WHEN count(*)=0 THEN 'unassigned' WHEN count(*)=1 THEN min(instance.observed_state) ELSE 'multiple' END instance_state
        FROM harness.instances instance WHERE instance.organization_id=u.organization_id AND instance.user_id=u.id
          AND instance.assigned_node_id=$2) i ON true` : ''}
      WHERE u.organization_id=$1 AND u.deleted_at IS NULL ${where}`
  }

  async count(): Promise<number> {
    const result = await this.context.pool.query<{ n: string }>(
      'SELECT COUNT(*)::text n FROM harness.users WHERE organization_id=$1 AND deleted_at IS NULL',
      [this.context.organizationId],
    )
    return Number(result.rows[0]?.n ?? 0)
  }

  async create(input: {
    username: string
    password: string
    role?: 'admin' | 'user'
    displayName?: string
  }, actorUserId?: number): Promise<UserRow> {
    if (!USERNAME_RE.test(input.username)) throw new Error(`invalid username: ${input.username}`)
    const homePath = join(this.cfg.usersRoot, input.username, 'home')
    const passwordHash = await hashPassword(input.password)
    let publicId: number
    try {
      publicId = await transaction(this.context.pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-port:${this.context.nodeId}`])
        if (actorUserId !== undefined) await lockAdministrator(client, this.context, actorUserId)
        const user = await client.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
          organization_id,username,display_name,home_path
        ) VALUES($1,$2,$3,$4) RETURNING id,public_id::text`, [this.context.organizationId, input.username,
          input.displayName ?? input.username, homePath])
        const row = user.rows[0]
        if (row === undefined) throw new Error('user insert returned no row')
        await client.query(`INSERT INTO harness.password_credentials(user_id,password_hash)
          VALUES($1,$2)`, [row.id, passwordHash])
        await client.query(`INSERT INTO harness.memberships(organization_id,user_id,role)
          VALUES($1,$2,$3)`, [this.context.organizationId, row.id, input.role === 'admin' ? 'admin' : 'member'])
        const [port] = await allocateInstancePorts(
          client,
          this.context.nodeId,
          this.cfg.instancePortBase,
          1,
          this.context.nodeName,
        )
        await client.query(`INSERT INTO harness.instances(
          organization_id,user_id,assigned_node_id,port
        ) VALUES($1,$2,$3,$4)`, [this.context.organizationId, row.id, this.context.nodeId, port])
        prepareUserData(this.cfg, input.username)
        return publicNumber(row.public_id, 'user')
      })
    } catch (error) {
      if (isPostgresError(error) && error.code === '23505') {
        throw new Error(`duplicate username: ${input.username}`)
      }
      throw error
    }
    const created = await this.getById(publicId)
    if (created === null) throw new Error('user row missing after insert')
    return created
  }

  async list(): Promise<GatewayUserListRow[]> {
    const result = await this.context.pool.query<PostgresUserRow>(
      `${this.selectUsers()} ORDER BY u.public_id`, [this.context.organizationId, this.context.nodeId],
    )
    return result.rows.map(row => ({ ...toUser(row), port: row.port, instanceState: row.instance_state, runtimeCount: row.runtime_count }))
  }

  async getById(id: number): Promise<UserRow | null> {
    const result = await this.context.pool.query<Omit<PostgresUserRow, 'port' | 'instance_state' | 'runtime_count'>>(
      `${this.selectUsers('AND u.public_id=$2', false)} LIMIT 1`,
      [this.context.organizationId, id, this.context.nodeId],
    )
    return result.rows[0] === undefined ? null : toUser(result.rows[0])
  }

  /**
   * Confirm an organization-owned account tombstone.
   * @param id - organization-scoped public account identifier.
   * @returns true only for an existing deleted account; unknown ids return false.
   */
  async isDeleted(id: number): Promise<boolean> {
    const result = await this.context.pool.query<{ deleted: boolean }>(`SELECT EXISTS(SELECT 1 FROM harness.users
      WHERE organization_id=$1 AND public_id=$2 AND deleted_at IS NOT NULL) deleted`, [this.context.organizationId, id])
    return result.rows[0]!.deleted
  }

  /** Read one organization account and its local assignment count; a port is present only for one local Runtime. */
  async getListedById(id: number): Promise<GatewayUserListRow | null> {
    const result = await this.context.pool.query<PostgresUserRow>(
      `${this.selectUsers('AND u.public_id=$3')} LIMIT 1`,
      [this.context.organizationId, this.context.nodeId, id],
    )
    const row = result.rows[0]
    return row === undefined ? null : { ...toUser(row), port: row.port, instanceState: row.instance_state, runtimeCount: row.runtime_count }
  }

  async getByUsername(username: string): Promise<UserRow | null> {
    const result = await this.context.pool.query<Omit<PostgresUserRow, 'port' | 'instance_state' | 'runtime_count'>>(
      `${this.selectUsers('AND u.username=$2', false)} LIMIT 1`,
      [this.context.organizationId, username, this.context.nodeId],
    )
    return result.rows[0] === undefined ? null : toUser(result.rows[0])
  }

  /** Atomically update administrator-editable fields for one user. */
  async patch(
    id: number,
    next: { role?: 'admin' | 'user'; status?: 'active' | 'disabled'; displayName?: string; autoReviewEligible?: boolean },
    actorUserId?: number,
  ): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
      if (actorUserId !== undefined) await lockAdministrator(client, this.context, actorUserId)
      const target = await client.query<{
        id: string
        role: 'admin' | 'member'
        user_status: 'active' | 'disabled'
        membership_status: 'active' | 'disabled'
        auto_review_eligible: boolean
      }>(`SELECT u.id,m.role,u.status user_status,m.status membership_status,u.auto_review_eligible
        FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.deleted_at IS NULL FOR UPDATE OF u,m`,
      [this.context.organizationId, id])
      const row = target.rows[0]
      if (row === undefined) return
      const losesAdmin = row.role === 'admin' && row.user_status === 'active' && row.membership_status === 'active'
        && (next.role === 'user' || next.status === 'disabled')
      if (losesAdmin) {
        const others = await client.query<{ n: string }>(`SELECT COUNT(*)::text n
          FROM harness.users u JOIN harness.memberships m
            ON m.organization_id=u.organization_id AND m.user_id=u.id
          WHERE u.organization_id=$1 AND u.id<>$2 AND u.deleted_at IS NULL AND u.status='active'
            AND m.status='active' AND m.role='admin'`, [this.context.organizationId, row.id])
        if (Number(others.rows[0]?.n ?? 0) === 0) throw new Error('cannot-remove-last-admin')
      }
      const role = next.role === undefined ? row.role : next.role === 'admin' ? 'admin' : 'member'
      const status = next.status ?? row.user_status
      const autoReviewEligible = next.autoReviewEligible ?? row.auto_review_eligible
      if (next.displayName === undefined) {
        await client.query(`UPDATE harness.users SET status=$3,auto_review_eligible=$4,updated_at=now()
          WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, row.id, status, autoReviewEligible])
      } else {
        await client.query(`UPDATE harness.users SET status=$3,display_name=$4,auto_review_eligible=$5,updated_at=now()
          WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, row.id, status, next.displayName, autoReviewEligible])
      }
      if (next.role !== undefined) {
        await client.query(`UPDATE harness.memberships SET role=$3
          WHERE organization_id=$1 AND user_id=$2`, [this.context.organizationId, row.id, role])
      }
      if (next.status !== undefined) {
        await client.query(`UPDATE harness.memberships SET status=$3
          WHERE organization_id=$1 AND user_id=$2`, [this.context.organizationId, row.id, status])
        if (status === 'disabled') {
          await client.query(`UPDATE harness.auth_sessions SET revoked_at=now(),revoked_reason='user-disabled'
            WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [this.context.organizationId, row.id])
        }
      }
    })
  }

  private async mutateAdmin(
    id: number,
    next: { role?: 'admin' | 'user'; status?: 'active' | 'disabled' },
    actorUserId?: number,
  ): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
      if (actorUserId !== undefined) await lockAdministrator(client, this.context, actorUserId)
      const target = await client.query<{
        id: string
        role: 'admin' | 'member'
        user_status: 'active' | 'disabled'
        membership_status: 'active' | 'disabled'
      }>(`SELECT u.id,m.role,u.status user_status,m.status membership_status
        FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.deleted_at IS NULL FOR UPDATE OF u,m`,
      [this.context.organizationId, id])
      const row = target.rows[0]
      if (row === undefined) return
      const losesAdmin = row.role === 'admin' && row.user_status === 'active' && row.membership_status === 'active'
        && (next.role === 'user' || next.status === 'disabled')
      if (losesAdmin) {
        const others = await client.query<{ n: string }>(`SELECT COUNT(*)::text n
          FROM harness.users u JOIN harness.memberships m
            ON m.organization_id=u.organization_id AND m.user_id=u.id
          WHERE u.organization_id=$1 AND u.id<>$2 AND u.deleted_at IS NULL AND u.status='active'
            AND m.status='active' AND m.role='admin'`, [this.context.organizationId, row.id])
        if (Number(others.rows[0]?.n ?? 0) === 0) throw new Error('cannot-remove-last-admin')
      }
      if (next.role !== undefined) {
        await client.query(`UPDATE harness.memberships SET role=$3
          WHERE organization_id=$1 AND user_id=$2`,
        [this.context.organizationId, row.id, next.role === 'admin' ? 'admin' : 'member'])
      }
      if (next.status !== undefined) {
        await client.query('UPDATE harness.users SET status=$3,updated_at=now() WHERE organization_id=$1 AND id=$2',
          [this.context.organizationId, row.id, next.status])
        await client.query('UPDATE harness.memberships SET status=$3 WHERE organization_id=$1 AND user_id=$2',
          [this.context.organizationId, row.id, next.status])
        if (next.status === 'disabled') {
          await client.query(`UPDATE harness.auth_sessions SET revoked_at=now(),revoked_reason='user-disabled'
            WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [this.context.organizationId, row.id])
        }
      }
    })
  }

  async setStatus(id: number, status: 'active' | 'disabled', actorUserId?: number): Promise<void> {
    await this.mutateAdmin(id, { status }, actorUserId)
  }

  async setRole(id: number, role: 'admin' | 'user', actorUserId?: number): Promise<void> {
    await this.mutateAdmin(id, { role }, actorUserId)
  }

  async setDisplayName(id: number, name: string, actorUserId?: number): Promise<void> {
    await this.patch(id, { displayName: name }, actorUserId)
  }

  /** Mark a user deleted while retaining history that still references the account. */
  async remove(id: number, actorUserId?: number): Promise<boolean> {
    return transaction(this.context.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
      if (actorUserId !== undefined) await lockAdministrator(client, this.context, actorUserId)
      const target = await client.query<{
        id: string
        role: 'admin' | 'member'
        user_status: 'active' | 'disabled'
        membership_status: 'active' | 'disabled'
      }>(`SELECT u.id,m.role,u.status user_status,m.status membership_status
        FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.deleted_at IS NULL
        FOR UPDATE OF u,m`, [this.context.organizationId, id])
      const row = target.rows[0]
      if (row === undefined) return false
      const losesAdmin = row.role === 'admin' && row.user_status === 'active' && row.membership_status === 'active'
      if (losesAdmin) {
        const others = await client.query<{ n: string }>(`SELECT COUNT(*)::text n
          FROM harness.users u JOIN harness.memberships m
            ON m.organization_id=u.organization_id AND m.user_id=u.id
          WHERE u.organization_id=$1 AND u.id<>$2 AND u.deleted_at IS NULL
            AND u.status='active' AND m.status='active' AND m.role='admin'`,
        [this.context.organizationId, row.id])
        if (Number(others.rows[0]?.n ?? 0) === 0) throw new Error('cannot-remove-last-admin')
      }
      const runtimes = await client.query<{ observed_state: string; quiescent: boolean }>(`SELECT i.observed_state,
        EXISTS(SELECT 1 FROM harness.runtime_destructive_operations operation WHERE operation.organization_id=i.organization_id
          AND operation.runtime_id=i.runtime_id AND operation.node_id=i.assigned_node_id AND operation.generation=i.generation
          AND operation.quiescent_at IS NOT NULL) quiescent
        FROM harness.instances i WHERE i.organization_id=$1 AND i.user_id=$2 ORDER BY i.runtime_id FOR UPDATE OF i`,
      [this.context.organizationId, row.id])
      if (runtimes.rows.some(runtime => runtime.observed_state !== 'stopped' && !runtime.quiescent)) {
        throw new RuntimeManagementError(409, 'runtime-management/runtimes-not-stopped')
      }
      await client.query(`UPDATE harness.users SET status='disabled',deleted_at=now(),updated_at=now()
        WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, row.id])
      await client.query(`UPDATE harness.memberships SET status='disabled'
        WHERE organization_id=$1 AND user_id=$2`, [this.context.organizationId, row.id])
      await client.query(`UPDATE harness.auth_sessions SET revoked_at=now(),revoked_reason='user-deleted'
        WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [this.context.organizationId, row.id])
      // Instance rows are operational assignments, not historical records.
      // Removing the row releases its node-local port for a later account;
      // the user's durable audit, usage, and conversation rows remain intact.
      await client.query(`DELETE FROM harness.instances WHERE organization_id=$1 AND user_id=$2`,
        [this.context.organizationId, row.id])
      await client.query(`DELETE FROM harness.login_attempts
        WHERE organization_id=$1 AND username=(SELECT username FROM harness.users WHERE id=$2)`,
      [this.context.organizationId, row.id])
      await client.query('DELETE FROM harness.project_members WHERE organization_id=$1 AND user_id=$2',
        [this.context.organizationId, row.id])
      await client.query('DELETE FROM harness.project_invitations WHERE invitee_user_id=$1 OR inviter_user_id=$1',
        [row.id])
      await client.query('DELETE FROM harness.model_user_access WHERE organization_id=$1 AND user_id=$2',
        [this.context.organizationId, row.id])
      await client.query('DELETE FROM harness.model_intake_tokens WHERE user_id=$1', [row.id])
      await client.query('DELETE FROM harness.model_runtime_intake_tokens WHERE organization_id=$1 AND user_id=$2', [this.context.organizationId, row.id])
      await client.query('DELETE FROM harness.user_quotas WHERE user_id=$1', [row.id])
      return true
    })
  }

  async resetPassword(id: number, newPassword: string, actorUserId?: number): Promise<void> {
    const passwordHash = await hashPassword(newPassword)
    await transaction(this.context.pool, async (client) => {
      if (actorUserId !== undefined) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
        await lockAdministrator(client, this.context, actorUserId)
      }
      const user = await client.query<{ id: string }>(
        'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2 AND deleted_at IS NULL',
        [this.context.organizationId, id],
      )
      const userId = user.rows[0]?.id
      if (userId === undefined) return
      await client.query(`UPDATE harness.password_credentials SET password_hash=$2,
        password_version=password_version+1,must_change_password=true,changed_at=now() WHERE user_id=$1`,
      [userId, passwordHash])
      await client.query(`UPDATE harness.auth_sessions SET revoked_at=now(),revoked_reason='password-reset'
        WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [this.context.organizationId, userId])
    })
  }

  async changeOwnPassword(id: number, newPassword: string, keepToken?: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword)
    await transaction(this.context.pool, async (client) => {
      const user = await client.query<{ id: string }>(
        'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2 AND deleted_at IS NULL',
        [this.context.organizationId, id],
      )
      const userId = user.rows[0]?.id
      if (userId === undefined) return
      await client.query(`UPDATE harness.password_credentials SET password_hash=$2,
        password_version=password_version+1,must_change_password=false,changed_at=now() WHERE user_id=$1`,
      [userId, passwordHash])
      // A stolen parallel session survives a password change unless the other
      // tokens are revoked — the caller keeps only the session it proved it owns.
      if (keepToken === undefined) {
        await client.query(`UPDATE harness.auth_sessions SET revoked_at=now(),revoked_reason='password-change'
          WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [this.context.organizationId, userId])
      } else {
        await client.query(`UPDATE harness.auth_sessions SET revoked_at=now(),revoked_reason='password-change'
          WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL AND token_hash!=$3`,
        [this.context.organizationId, userId, createHash('sha256').update(keepToken).digest()])
      }
    })
  }
}
