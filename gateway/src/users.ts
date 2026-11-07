import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { toUserRow, type UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import { hashPassword } from './password.ts'
import type { GatewayUserListRow } from './services.ts'
import { prepareUserData } from './user-data.ts'
import { requireSqliteAdministrator } from './administrator-authority.ts'
import { clearSqliteUserQuotaAliases } from './sqlite-user-quota.ts'
import { USERNAME_RE } from './user-name.ts'

export class UserService {
  constructor(private readonly db: Database.Database, private readonly cfg: GatewayConfig) {}

  /** Find the first free port at or above the configured base. */
  private allocatePort(): number {
    const base = this.cfg.instancePortBase
    const row = this.db.prepare(`
      SELECT MIN(candidate) AS port
      FROM (
        SELECT CAST(? AS INTEGER) AS candidate
        UNION ALL
        SELECT port + 1 FROM instances WHERE port >= ?
      ) candidates
      WHERE candidate BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM instances occupied WHERE occupied.port=candidate)
    `).get(base, base, base, 65535) as { port: number | null }
    if (row.port === null) throw new Error('no instance ports remain')
    return row.port
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL`).get() as { n: number }).n
  }

  async create(input: { username: string; password: string; role?: 'admin' | 'user'; displayName?: string }, actorUserId?: number): Promise<UserRow> {
    if (!USERNAME_RE.test(input.username)) throw new Error(`invalid username: ${input.username}`)
    const homePath = join(this.cfg.usersRoot, input.username, 'home')
    const now = Date.now()
    const hash = await hashPassword(input.password)
    const insert = this.db.transaction(() => {
      if (actorUserId !== undefined) requireSqliteAdministrator(this.db, actorUserId)
      const info = this.db.prepare(
        `INSERT INTO users(username, password_hash, display_name, role, home_path, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.username, hash, input.displayName ?? input.username, input.role ?? 'user', homePath, now, now)
      const userId = Number(info.lastInsertRowid)
      const port = this.allocatePort()
      this.db.prepare(`INSERT INTO instances(user_id, port, state) VALUES(?, ?, 'stopped')`)
        .run(userId, port)
      prepareUserData(this.cfg, input.username)
      return userId
    })
    const id = insert.immediate()
    const row = this.getById(id)
    if (row === null) throw new Error('user row missing after insert')
    return row
  }

  list(): GatewayUserListRow[] {
    const rows = this.db.prepare(
      `SELECT u.*, i.port AS port, i.state AS instance_state
       FROM users u JOIN instances i ON i.user_id = u.id
       WHERE u.deleted_at IS NULL ORDER BY u.id`,
    ).all() as never[]
    return rows.map((r) => {
      const raw = r as { port: number; instance_state: string }
      return { ...toUserRow(r), port: raw.port, instanceState: raw.instance_state }
    })
  }

  /** Read one user with its personal instance port and state, or null when absent or deleted. */
  getListedById(id: number): GatewayUserListRow | null {
    const row = this.db.prepare(
      `SELECT u.*, i.port AS port, i.state AS instance_state
       FROM users u JOIN instances i ON i.user_id = u.id
       WHERE u.id = ? AND u.deleted_at IS NULL`,
    ).get(id)
    if (row === undefined) return null
    const raw = row as { port: number; instance_state: string }
    return { ...toUserRow(row as never), port: raw.port, instanceState: raw.instance_state }
  }

  getById(id: number): UserRow | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`).get(id)
    return row === undefined ? null : toUserRow(row as never)
  }

  /**
   * Confirm a retained account tombstone.
   * @param id - local account identifier.
   * @returns true only for an existing deleted account; unknown ids return false.
   */
  isDeleted(id: number): boolean {
    const row = this.db.prepare('SELECT deleted_at FROM users WHERE id=?').get(id) as { deleted_at: number | null } | undefined
    return row !== undefined && row.deleted_at !== null
  }

  getByUsername(username: string): UserRow | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE username = ? AND deleted_at IS NULL`).get(username)
    return row === undefined ? null : toUserRow(row as never)
  }

  /** Atomically update administrator-editable fields for one user. */
  patch(id: number, next: { role?: 'admin' | 'user'; status?: 'active' | 'disabled'; displayName?: string; autoReviewEligible?: boolean }, actorUserId?: number): void {
    this.db.transaction(() => {
      if (actorUserId !== undefined) requireSqliteAdministrator(this.db, actorUserId)
      const current = this.db.prepare(`SELECT role, status, auto_review_eligible FROM users WHERE id = ? AND deleted_at IS NULL`)
        .get(id) as { role: 'admin' | 'user'; status: 'active' | 'disabled'; auto_review_eligible: number } | undefined
      if (current === undefined) return
      this.assertNotLastAdmin(id, { role: next.role, status: next.status })
      const role = next.role ?? current.role
      const status = next.status ?? current.status
      const displayName = next.displayName
      const autoReviewEligible = next.autoReviewEligible === undefined ? current.auto_review_eligible : Number(next.autoReviewEligible)
      if (displayName === undefined) {
        this.db.prepare(`UPDATE users SET role = ?, status = ?, auto_review_eligible = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
          .run(role, status, autoReviewEligible, Date.now(), id)
      } else {
        this.db.prepare(`UPDATE users SET role = ?, status = ?, display_name = ?, auto_review_eligible = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
          .run(role, status, displayName, autoReviewEligible, Date.now(), id)
      }
      if (status === 'disabled') this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(id)
    }).immediate()
  }

  setStatus(id: number, status: 'active' | 'disabled', actorUserId?: number): void {
    this.patch(id, { status }, actorUserId)
  }

  setRole(id: number, role: 'admin' | 'user', actorUserId?: number): void {
    this.patch(id, { role }, actorUserId)
  }

  setDisplayName(id: number, name: string, actorUserId?: number): void {
    this.patch(id, { displayName: name }, actorUserId)
  }

  /** Mark a user deleted while retaining history that still references the account. */
  remove(id: number, actorUserId?: number): boolean {
    const remove = this.db.transaction(() => {
      if (actorUserId !== undefined) requireSqliteAdministrator(this.db, actorUserId)
      const row = this.db.prepare(
        `SELECT role, status FROM users WHERE id = ? AND deleted_at IS NULL`,
      ).get(id) as { role: 'admin' | 'user'; status: 'active' | 'disabled' } | undefined
      if (row === undefined) return false
      this.assertNotLastAdmin(id, { status: 'disabled' })
      const now = Date.now()
      this.db.prepare(
        `UPDATE users SET status = 'disabled', deleted_at = ?, updated_at = ? WHERE id = ?`,
      ).run(now, now, id)
      // Instance rows are operational assignments, not historical records.
      // Removing the row releases its node-local port for a later account;
      // the user's durable audit, usage, and conversation rows remain intact.
      this.db.prepare(`DELETE FROM instances WHERE user_id = ?`).run(id)
      this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(id)
      this.db.prepare(`DELETE FROM login_attempts WHERE username = (SELECT username FROM users WHERE id = ?)`).run(id)
      this.db.prepare(`DELETE FROM project_members WHERE user_id = ?`).run(id)
      this.db.prepare(`DELETE FROM project_invitations WHERE invitee_user_id = ? OR inviter_user_id = ?`).run(id, id)
      this.db.prepare(`DELETE FROM model_user_access WHERE user_id = ?`).run(id)
      this.db.prepare(`DELETE FROM model_intake_tokens WHERE user_id = ?`).run(id)
      this.db.prepare(`DELETE FROM model_quotas WHERE subject_type = 'user' AND subject_id = ?`).run(String(id))
      clearSqliteUserQuotaAliases(this.db, id)
      return true
    })
    return remove.immediate()
  }

  private assertNotLastAdmin(id: number, next: { role?: 'admin' | 'user'; status?: 'active' | 'disabled' }): void {
    const row = this.getById(id)
    if (row === null || row.role !== 'admin' || row.status !== 'active') return
    const wouldLose = (next.role === 'user') || (next.status === 'disabled')
    if (!wouldLose) return
    const n = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL AND id != ?`,
    ).get(id) as { n: number }).n
    if (n === 0) throw new Error('cannot-remove-last-admin')
  }

  async resetPassword(id: number, newPassword: string, actorUserId?: number): Promise<void> {
    const hash = await hashPassword(newPassword)
    this.db.transaction(() => {
      if (actorUserId !== undefined) requireSqliteAdministrator(this.db, actorUserId)
      this.db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
        .run(hash, Date.now(), id)
      this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(id)
    }).immediate()
  }

  async changeOwnPassword(id: number, newPassword: string, keepToken?: string): Promise<void> {
    this.db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(await hashPassword(newPassword), Date.now(), id)
    // Revoke every other session so a stolen token cannot survive a password change.
    if (keepToken === undefined) {
      this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(id)
    } else {
      this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?`)
        .run(id, createHash('sha256').update(keepToken).digest('hex'))
    }
  }
}
