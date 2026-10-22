/** Stream authentication reads login eligibility without renewing user activity. */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { AuthService } from '../src/auth.ts'
import { openDb } from '../src/db.ts'
import { testConfig } from './test-config.ts'

const NOW = Date.UTC(2026, 9, 23, 0, 0, 0)
const TOKEN = 'stream-session-fixture'

function fixture() {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
  onTestFinished(() => { clock.mockRestore() })
  const root = mkdtempSync(join(tmpdir(), 'hgw-stream-auth-'))
  let database: ReturnType<typeof openDb> | undefined
  onTestFinished(() => {
    try { database?.close() }
    finally { rmSync(root, { recursive: true, force: true }) }
  })
  const db = database = openDb(join(root, 'gateway.sqlite'))
  const cfg = testConfig(root, { HGW_SESSION_TTL_MS: '60000', HGW_SESSION_ABS_TTL_MS: '120000' })
  db.prepare(`INSERT INTO users(id,username,password_hash,display_name,role,home_path,must_change_password,created_at,updated_at)
    VALUES(1,'stream-user','unused-password-hash','Stream User','user',?,0,?,?)`).run(root, NOW, NOW)
  db.prepare(`INSERT INTO auth_sessions(user_id,token_hash,created_at,expires_at,absolute_expires_at,last_seen_at)
    VALUES(1,?,?,?,?,?)`).run(
    createHash('sha256').update(TOKEN).digest('hex'), NOW - 30_000, NOW + 30_000, NOW + 90_000, NOW - 30_000,
  )
  const snapshot = () => db.prepare('SELECT last_seen_at,expires_at,absolute_expires_at FROM auth_sessions').all()
  return { db, cfg, auth: new AuthService(db, cfg), snapshot }
}

describe('SQLite stream login qualification', () => {
  it('reads an active login under SQLite query-only mode without touching either deadline or last-seen activity', () => {
    const f = fixture()
    const before = f.snapshot()
    f.db.pragma('query_only = ON')
    const qualified = f.auth.qualifyForStream(TOKEN)
    expect(qualified).toMatchObject({
      user: { id: 1, username: 'stream-user', role: 'user', mustChangePassword: false },
      expiresAt: NOW + 30_000,
    })
    expect(f.auth.qualifyForStream(TOKEN)).toEqual(qualified)
    expect(f.snapshot()).toEqual(before)
  })

  it('returns the absolute deadline when it is earlier than idle expiry', () => {
    const f = fixture()
    f.db.prepare('UPDATE auth_sessions SET absolute_expires_at=?').run(NOW + 10_000)
    const before = f.snapshot()
    f.db.pragma('query_only = ON')
    expect(f.auth.qualifyForStream(TOKEN)?.expiresAt).toBe(NOW + 10_000)
    expect(f.snapshot()).toEqual(before)
  })

  it('reads current role and review eligibility instead of retaining the first qualification', () => {
    const f = fixture()
    expect(f.auth.qualifyForStream(TOKEN)?.user.role).toBe('user')
    f.db.prepare("UPDATE users SET role='admin',auto_review_eligible=1,display_name='Updated User'").run()
    const before = f.snapshot()
    f.db.pragma('query_only = ON')
    expect(f.auth.qualifyForStream(TOKEN)?.user).toMatchObject({ role: 'admin', autoReviewEligible: true, displayName: 'Updated User' })
    expect(f.snapshot()).toEqual(before)
  })

  const refusals = [
    { state: 'disabled user', sql: "UPDATE users SET status='disabled'" },
    { state: 'deleted user', sql: `UPDATE users SET deleted_at=${NOW}` },
    { state: 'password change required', sql: 'UPDATE users SET must_change_password=1' },
    { state: 'revoked session', sql: 'DELETE FROM auth_sessions' },
    { state: 'idle expiry', sql: `UPDATE auth_sessions SET expires_at=${NOW - 1}` },
    { state: 'idle deadline reached', sql: `UPDATE auth_sessions SET expires_at=${NOW}` },
    { state: 'absolute expiry', sql: `UPDATE auth_sessions SET absolute_expires_at=${NOW - 1}` },
    { state: 'absolute deadline reached', sql: `UPDATE auth_sessions SET absolute_expires_at=${NOW}` },
  ] as const

  it.each(refusals)('rejects $state without updating session metadata', ({ sql }) => {
    const f = fixture()
    expect(f.auth.qualifyForStream(TOKEN)).not.toBeNull()
    f.db.prepare(sql).run()
    const before = f.snapshot()
    f.db.pragma('query_only = ON')
    expect(f.auth.qualifyForStream(TOKEN)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it('rejects an unknown token without modifying a valid session', () => {
    const f = fixture()
    const before = f.snapshot()
    f.db.pragma('query_only = ON')
    expect(f.auth.qualifyForStream('unknown-stream-token')).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it('keeps ordinary validation sliding idle activity and capping it at absolute expiry', () => {
    const f = fixture()
    const before = f.snapshot()
    expect(f.auth.validate(TOKEN)?.username).toBe('stream-user')
    expect(f.snapshot()).toEqual([{ last_seen_at: NOW, expires_at: NOW + f.cfg.sessionTtlMs, absolute_expires_at: NOW + 90_000 }])
    expect(f.snapshot()).not.toEqual(before)
    f.db.prepare('UPDATE auth_sessions SET absolute_expires_at=?').run(NOW + 10_000)
    expect(f.auth.validate(TOKEN)?.username).toBe('stream-user')
    expect(f.snapshot()).toEqual([{ last_seen_at: NOW, expires_at: NOW + 10_000, absolute_expires_at: NOW + 10_000 }])
  })

  it('keeps password-change identity available to ordinary validation while refusing stream qualification', () => {
    const f = fixture()
    f.db.prepare('UPDATE users SET must_change_password=1').run()
    expect(f.auth.qualifyForStream(TOKEN)).toBeNull()
    expect(f.auth.validate(TOKEN)).toMatchObject({ username: 'stream-user', mustChangePassword: true })
  })

  it('preserves ordinary validation at its inclusive deadline while stream qualification refuses that deadline', () => {
    const f = fixture()
    f.db.prepare('UPDATE auth_sessions SET expires_at=?,absolute_expires_at=?').run(NOW, NOW)
    expect(f.auth.qualifyForStream(TOKEN)).toBeNull()
    expect(f.auth.validate(TOKEN)?.username).toBe('stream-user')
  })
})
