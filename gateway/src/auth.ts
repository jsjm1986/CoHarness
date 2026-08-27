import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { GatewayConfig } from './config.ts'
import { verifyPassword } from './password.ts'

export interface UserRow {
  id: number
  username: string
  displayName: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  homePath: string
  mustChangePassword: boolean
}

const LOCK_WINDOW_MS = 10 * 60 * 1000
const LOCK_THRESHOLD = 5

interface DbUser {
  id: number
  username: string
  password_hash: string
  display_name: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  home_path: string
  must_change_password: number
  deleted_at: number | null
}

export function toUserRow(row: DbUser): UserRow {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    homePath: row.home_path,
    mustChangePassword: row.must_change_password === 1,
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Use one lock bucket for equivalent login spellings across case-insensitive stores. */
function loginKey(username: string): string {
  return username.toLowerCase()
}

export class AuthService {
  private readonly loginTails = new Map<string, Promise<unknown>>()

  constructor(private readonly db: Database.Database, private readonly cfg: GatewayConfig) {}

  private serializeLogin<T>(username: string, operation: () => Promise<T>): Promise<T> {
    const key = loginKey(username)
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
      const row = this.db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as DbUser | undefined
      const passwordOk = row !== undefined && row.status === 'active' && row.deleted_at === null
        && await verifyPassword(row.password_hash, password)
      return this.db.transaction(() => {
        const now = Date.now()
        this.db.prepare(`DELETE FROM login_attempts WHERE ts <= ?`).run(now - LOCK_WINDOW_MS)
        const failures = this.db.prepare(
          `SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND ts > ?`,
        ).get(username, now - LOCK_WINDOW_MS) as { n: number }
        if (failures.n >= LOCK_THRESHOLD) return 'locked' as const

        // Password hashing is asynchronous, so the row checked before the
        // await may have been disabled or replaced in the meantime. Re-read
        // the authoritative row before creating a session.
        const current = this.db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as DbUser | undefined
        const accepted = passwordOk && row !== undefined && current !== undefined
          && current.id === row.id && current.password_hash === row.password_hash
          && current.status === 'active' && current.deleted_at === null
        if (!accepted || current === undefined) {
          this.db.prepare(`INSERT INTO login_attempts(username, ip, ts) VALUES(?, ?, ?)`).run(username, ip, now)
          return 'invalid' as const
        }

        this.db.prepare(`DELETE FROM login_attempts WHERE username = ?`).run(username)
        const token = randomBytes(32).toString('base64url')
        this.db.prepare(
          `INSERT INTO auth_sessions(user_id, token_hash, created_at, expires_at, absolute_expires_at, last_seen_at, ip, user_agent)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(current.id, tokenHash(token), now, now + this.cfg.sessionTtlMs, now + this.cfg.sessionAbsoluteTtlMs, now, ip, userAgent)
        return { token, user: toUserRow(current) }
      })()
    })
  }

  validate(token: string): UserRow | null {
    return this.db.transaction(() => {
      const now = Date.now()
      const session = this.db.prepare(`SELECT * FROM auth_sessions WHERE token_hash = ?`).get(tokenHash(token)) as
        { id: number; user_id: number; expires_at: number; absolute_expires_at: number } | undefined
      if (session === undefined || session.expires_at < now || session.absolute_expires_at < now) return null
      this.db.prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`)
        .run(now, Math.min(now + this.cfg.sessionTtlMs, session.absolute_expires_at), session.id)
      const user = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(session.user_id) as DbUser | undefined
      if (user === undefined || user.status !== 'active' || user.deleted_at !== null) return null
      return toUserRow(user)
    })()
  }

  revoke(token: string): void {
    this.db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(tokenHash(token))
  }
}
