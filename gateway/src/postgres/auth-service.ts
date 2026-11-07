import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type { GatewayConfig } from '../config.ts'
import type { UserRow } from '../auth.ts'
import { verifyPassword } from '../password.ts'
import { transaction } from './database.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

const LOCK_WINDOW_MS = 10 * 60 * 1000
const LOCK_THRESHOLD = 5
/** Valid argon2id encoding at the production parameters; verifies (and costs) like a real hash, always rejects. */
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$jXVYi2qhgjpSj3RGmuYeVg$boG4Z6yJ9CoKKvdNf2rURS5weuV0ctWo01r8ITOdopM'

interface PostgresAuthUser {
  public_id: string
  username: string
  display_name: string
  role: 'admin' | 'member'
  status: 'active' | 'disabled'
  membership_status: 'active' | 'disabled'
  home_path: string
  must_change_password: boolean
  auto_review_eligible: boolean
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

function userRow(row: PostgresAuthUser): UserRow {
  return {
    id: publicNumber(row.public_id, 'user'),
    username: row.username,
    displayName: row.display_name,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status === 'active' && row.membership_status === 'active' ? 'active' : 'disabled',
    homePath: row.home_path,
    mustChangePassword: row.must_change_password,
    autoReviewEligible: row.auto_review_eligible,
  }
}

/** PostgreSQL-backed authentication and sliding sessions for one organization. */
export class PostgresAuthService {
  private readonly loginTails = new Map<string, Promise<unknown>>()

  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly cfg: GatewayConfig,
  ) {}

  private serializeLogin<T>(canonicalUsername: string, operation: () => Promise<T>): Promise<T> {
    const key = `${this.context.organizationId}\u0000${canonicalUsername}`
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
    // citext uses the database locale; JavaScript case folding can assign the
    // same PostgreSQL identity to different queues and transaction locks.
    const canonical = await this.context.pool.query<{ username: string }>(
      'SELECT lower($1::text) username', [username],
    )
    const canonicalUsername = canonical.rows[0]!.username
    return this.serializeLogin(canonicalUsername, async () => {
      const address = sourceIp(ip)
      const result = await this.context.pool.query<PostgresAuthUser>(`SELECT u.public_id::text,u.username::text,
        u.display_name,u.status,u.deleted_at,u.home_path,m.role,m.status membership_status,
        c.must_change_password,c.password_hash,u.auto_review_eligible
        FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        JOIN harness.password_credentials c ON c.user_id=u.id
        WHERE u.organization_id=$1 AND u.username=$2
          AND (SELECT status FROM harness.organizations WHERE id=$1)='active'`, [this.context.organizationId, username])
      const row = result.rows[0]
      const eligible = row !== undefined && row.status === 'active' && row.membership_status === 'active'
        && row.deleted_at === null
      // Ineligible attempts verify a fixed valid dummy hash so response time
      // does not reveal whether the username or membership exists.
      const verified = await verifyPassword(row?.password_hash ?? DUMMY_PASSWORD_HASH, password)
      const accepted = eligible && verified
      const token = accepted ? randomBytes(32).toString('base64url') : undefined
      return await transaction(this.context.pool, async (client) => {
        // Serialize the check-and-record transition across Gateway processes,
        // not just within this Node instance.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-login:${this.context.organizationId}:${canonicalUsername}`])
        await client.query(`DELETE FROM harness.login_attempts
          WHERE organization_id=$1 AND occurred_at <= clock_timestamp()-($2::double precision * interval '1 millisecond')`,
        [this.context.organizationId, LOCK_WINDOW_MS])
        const failures = await client.query<{ n: string }>(`SELECT COUNT(*)::text n
          FROM harness.login_attempts
          WHERE organization_id=$1 AND username=$2
            AND occurred_at > clock_timestamp()-($3::double precision * interval '1 millisecond') AND succeeded=false`,
        [this.context.organizationId, username, LOCK_WINDOW_MS])
        if (Number(failures.rows[0]?.n ?? 0) >= LOCK_THRESHOLD) return 'locked' as const
        if (!accepted || row === undefined || token === undefined) {
          await client.query(`INSERT INTO harness.login_attempts(
            organization_id,username,source_ip,occurred_at,succeeded
          ) VALUES($1,$2,$3,clock_timestamp(),false)`,
          [this.context.organizationId, username, address])
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
            m.role,m.status membership_status,c.must_change_password,c.password_hash,u.auto_review_eligible
           FROM harness.users u
           JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
           JOIN harness.password_credentials c ON c.user_id=u.id
           WHERE u.organization_id=$1 AND u.public_id=$2
             AND (SELECT status FROM harness.organizations WHERE id=$1)='active'
           FOR SHARE OF u,m,c`,
          [this.context.organizationId, row.public_id],
        )
        const current = user.rows[0]
        if (current === undefined || current.status !== 'active' || current.membership_status !== 'active'
          || current.deleted_at !== null || current.password_hash !== row.password_hash) {
          await client.query(`INSERT INTO harness.login_attempts(
            organization_id,username,source_ip,occurred_at,succeeded
          ) VALUES($1,$2,$3,clock_timestamp(),false)`,
          [this.context.organizationId, username, address])
          return 'invalid' as const
        }
        await client.query(`WITH issued AS MATERIALIZED (SELECT clock_timestamp() at)
          INSERT INTO harness.auth_sessions(
          organization_id,user_id,token_hash,created_at,expires_at,absolute_expires_at,last_seen_at,source_ip,user_agent
          ) SELECT $1,$2,$3,at,at+($4::double precision * interval '1 millisecond'),
            at+($5::double precision * interval '1 millisecond'),at,$6,$7 FROM issued`,
        [this.context.organizationId, current.id, tokenHash(token), this.cfg.sessionTtlMs, this.cfg.sessionAbsoluteTtlMs, address, userAgent])
        return { token, user: userRow(current) }
      })
    })
  }

  async validate(token: string): Promise<UserRow | null> { return this.validateSession(token,false) }

  /** Recheck the browser account and this computer grant from the same post-renewal authorization snapshot.
   * @param token - current browser session. @returns the active account or null after expiry, revocation, or loss of computer use.
   */
  validateOnComputer(token:string):Promise<UserRow|null> { return this.validateSession(token,true) }

  private async validateSession(token:string,requireComputer:boolean):Promise<UserRow|null> {
    const renewed = await this.context.pool.query<{ id: string }>(`WITH locked AS MATERIALIZED (
        SELECT id,expires_at,absolute_expires_at FROM harness.auth_sessions
        WHERE organization_id=$1 AND token_hash=$2 AND revoked_at IS NULL
          AND expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp()
        FOR UPDATE
      ) UPDATE harness.auth_sessions s
        SET last_seen_at=clock_timestamp(),
          expires_at=LEAST(clock_timestamp()+($3::double precision * interval '1 millisecond'),s.absolute_expires_at)
        FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        JOIN harness.password_credentials c ON c.user_id=u.id
        CROSS JOIN locked
        WHERE s.organization_id=$1 AND s.id=locked.id AND s.user_id=u.id AND u.organization_id=s.organization_id
          AND s.revoked_at IS NULL AND locked.expires_at > clock_timestamp() AND locked.absolute_expires_at > clock_timestamp()
          AND u.status='active' AND u.deleted_at IS NULL AND m.status='active'
          AND (SELECT status FROM harness.organizations WHERE id=$1)='active'
        RETURNING s.id`, [this.context.organizationId, tokenHash(token), this.cfg.sessionTtlMs])
    const session = renewed.rows[0]
    if (session === undefined) return null
    // Authority comes from a fresh snapshot after renewal releases the session lock.
    const result = await this.context.pool.query<PostgresAuthUser>(`SELECT
        u.public_id::text,u.username::text,u.display_name,u.status,u.deleted_at,u.home_path,
        m.role,m.status membership_status,c.must_change_password,u.auto_review_eligible
      FROM harness.auth_sessions s
      JOIN harness.users u ON u.id=s.user_id AND u.organization_id=s.organization_id
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      JOIN harness.password_credentials c ON c.user_id=u.id
      WHERE s.organization_id=$1 AND s.id=$2 AND s.revoked_at IS NULL
        AND s.expires_at > clock_timestamp() AND s.absolute_expires_at > clock_timestamp()
        AND u.status='active' AND u.deleted_at IS NULL AND m.status='active'
        AND (SELECT status FROM harness.organizations WHERE id=$1)='active'
        AND (NOT $3::boolean OR harness.computer_use_allowed($1,u.id,$4) AND harness.entry_node_visible($1,$4,$4))`,
    [this.context.organizationId, session.id,requireComputer,this.context.nodeId])
    const row = result.rows[0]
    return row === undefined ? null : userRow(row)
  }

  async revoke(token: string): Promise<void> {
    // Session renewal takes FOR UPDATE on this row on every validated request;
    // a logout racing that renewal must outlast the brief lock instead of
    // surfacing lock_not_available (55P03) as a 500.
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.context.pool.query(`UPDATE harness.auth_sessions
          SET revoked_at=now(),revoked_reason='logout'
          WHERE organization_id=$1 AND token_hash=$2 AND revoked_at IS NULL`,
        [this.context.organizationId, tokenHash(token)])
        return
      } catch (error) {
        if (error === null || typeof error !== 'object' || !('code' in error)
          || String(error.code) !== '55P03' || attempt === 3) throw error
        lastError = error
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
    throw lastError
  }
}
