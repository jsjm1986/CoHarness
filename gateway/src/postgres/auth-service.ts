import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type { GatewayConfig } from '../config.ts'
import type { UserRow } from '../auth.ts'
import { verifyPassword } from '../password.ts'
import { transaction } from './database.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

const LOCK_WINDOW_MS = 10 * 60 * 1000
const LOCK_THRESHOLD = 5

interface PostgresAuthUser {
  public_id: string
  username: string
  display_name: string
  role: 'admin' | 'member'
  status: 'active' | 'disabled'
  membership_status: 'active' | 'disabled'
  home_path: string
  must_change_password: boolean
  password_hash: string
  deleted_at: Date | null
}

/** Login identity including the internal database key required by sessions. */
interface PostgresAuthIdentity extends PostgresAuthUser {
  id: string
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

function sourceIp(ip: string): string | null {
  const normalized = ip.replace(/^::ffff:/, '')
  return isIP(normalized) === 0 ? null : normalized
}

/** Use one advisory-lock bucket for case-insensitive PostgreSQL usernames. */
function loginKey(username: string): string {
  return username.toLowerCase()
}

function userRow(row: PostgresAuthUser): UserRow {
  return {
    id: publicNumber(row.public_id, 'user'),
    username: row.username,
    displayName: row.display_name,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status === 'active' && row.membership_status === 'active' ? 'active' : 'disabled',
    homePath: row.home_path,
    mustChangePassword: row.must_change_password,
  }
}

/** PostgreSQL-backed authentication and sliding sessions for one organization. */
export class PostgresAuthService {
  private readonly loginTails = new Map<string, Promise<unknown>>()

  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly cfg: GatewayConfig,
  ) {}

  private serializeLogin<T>(username: string, operation: () => Promise<T>): Promise<T> {
    const key = `${this.context.organizationId}\u0000${loginKey(username)}`
    const previous = this.loginTails.get(key) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    const tail = current.then(() => undefined, () => undefined)
    this.loginTails.set(key, tail)
    void tail.then(() => {
      if (this.loginTails.get(key) === tail) this.loginTails.delete(key)
    })
    return current
  }

  async login(username: string, password: string, ip: string, userAgent: string):
  Promise<{ token: string; user: UserRow } | 'invalid' | 'locked'> {
    return this.serializeLogin(username, async () => {
      const now = Date.now()
      const address = sourceIp(ip)
      const result = await this.context.pool.query<PostgresAuthUser>(`SELECT u.public_id::text,u.username::text,
        u.display_name,u.status,u.deleted_at,u.home_path,m.role,m.status membership_status,
        c.must_change_password,c.password_hash
        FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        JOIN harness.password_credentials c ON c.user_id=u.id
        WHERE u.organization_id=$1 AND u.username=$2`, [this.context.organizationId, username])
      const row = result.rows[0]
      const accepted = row !== undefined && row.status === 'active' && row.membership_status === 'active'
        && row.deleted_at === null
        && await verifyPassword(row.password_hash, password)
      const token = accepted ? randomBytes(32).toString('base64url') : undefined
      return await transaction(this.context.pool, async (client) => {
        // Serialize the check-and-record transition across Gateway processes,
        // not just within this Node instance.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-login:${this.context.organizationId}:${username}`])
        await client.query(`DELETE FROM harness.login_attempts
          WHERE organization_id=$1 AND occurred_at <= to_timestamp($2/1000.0)`,
        [this.context.organizationId, now - LOCK_WINDOW_MS])
        const failures = await client.query<{ n: string }>(`SELECT COUNT(*)::text n
          FROM harness.login_attempts
          WHERE organization_id=$1 AND username=$2 AND occurred_at > to_timestamp($3/1000.0) AND succeeded=false`,
        [this.context.organizationId, username, now - LOCK_WINDOW_MS])
        if (Number(failures.rows[0]?.n ?? 0) >= LOCK_THRESHOLD) return 'locked' as const
        if (!accepted || row === undefined || token === undefined) {
          await client.query(`INSERT INTO harness.login_attempts(
            organization_id,username,source_ip,occurred_at,succeeded
          ) VALUES($1,$2,$3,to_timestamp($4/1000.0),false)`,
          [this.context.organizationId, username, address, now])
          return 'invalid' as const
        }
        await client.query(`DELETE FROM harness.login_attempts
          WHERE organization_id=$1 AND username=$2 AND succeeded=false`,
        [this.context.organizationId, username])
        // Re-read the complete identity under the transaction lock. Password
        // verification happened before the lock; a concurrent role, display
        // name, membership, or credential change must not be reflected by the
        // token returned from this login attempt.
        const user = await client.query<PostgresAuthIdentity>(
          `SELECT u.id::text AS id,u.public_id::text,u.username::text,u.display_name,u.status,u.deleted_at,u.home_path,
            m.role,m.status membership_status,c.must_change_password,c.password_hash
           FROM harness.users u
           JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
           JOIN harness.password_credentials c ON c.user_id=u.id
           WHERE u.organization_id=$1 AND u.public_id=$2
           FOR SHARE OF u,m,c`,
          [this.context.organizationId, row.public_id],
        )
        const current = user.rows[0]
        if (current === undefined || current.status !== 'active' || current.membership_status !== 'active'
          || current.deleted_at !== null || current.password_hash !== row.password_hash) {
          await client.query(`INSERT INTO harness.login_attempts(
            organization_id,username,source_ip,occurred_at,succeeded
          ) VALUES($1,$2,$3,to_timestamp($4/1000.0),false)`,
          [this.context.organizationId, username, address, now])
          return 'invalid' as const
        }
        await client.query(`INSERT INTO harness.auth_sessions(
          organization_id,user_id,token_hash,created_at,expires_at,absolute_expires_at,last_seen_at,source_ip,user_agent
        ) VALUES($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),to_timestamp($6/1000.0),
          to_timestamp($4/1000.0),$7,$8)`, [this.context.organizationId, current.id, tokenHash(token), now,
          now + this.cfg.sessionTtlMs, now + this.cfg.sessionAbsoluteTtlMs, address, userAgent])
        return { token, user: userRow(current) }
      })
    })
  }

  async validate(token: string): Promise<UserRow | null> {
    return transaction(this.context.pool, async (client) => {
      const result = await client.query<PostgresAuthUser & {
        session_id: string
        absolute_expires_at: Date
      }>(`SELECT s.id session_id,s.absolute_expires_at,u.public_id::text,u.username::text,
        u.display_name,u.status,u.deleted_at,u.home_path,m.role,m.status membership_status,
        c.must_change_password,c.password_hash
        FROM harness.auth_sessions s
        JOIN harness.users u ON u.id=s.user_id AND u.organization_id=s.organization_id
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        JOIN harness.password_credentials c ON c.user_id=u.id
        WHERE s.organization_id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL
          AND s.expires_at >= now() AND s.absolute_expires_at >= now()
        FOR UPDATE OF s`, [this.context.organizationId, tokenHash(token)])
      const row = result.rows[0]
      if (row === undefined || row.status !== 'active' || row.membership_status !== 'active' || row.deleted_at !== null) return null
      const now = Date.now()
      const expiresAt = Math.min(now + this.cfg.sessionTtlMs, row.absolute_expires_at.getTime())
      await client.query(`UPDATE harness.auth_sessions
        SET last_seen_at=to_timestamp($2/1000.0),expires_at=to_timestamp($3/1000.0)
        WHERE id=$1`, [row.session_id, now, expiresAt])
      return userRow(row)
    })
  }

  async revoke(token: string): Promise<void> {
    await this.context.pool.query(`UPDATE harness.auth_sessions
      SET revoked_at=now(),revoked_reason='logout'
      WHERE organization_id=$1 AND token_hash=$2 AND revoked_at IS NULL`,
    [this.context.organizationId, tokenHash(token)])
  }
}
