import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { AuthService } from '../src/auth.ts'
import { testConfig } from './test-config.ts'
import { openDb } from '../src/db.ts'
import { hashPassword } from '../src/password.ts'

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  onTestFinished(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const now = Date.now()
  db.prepare(`INSERT INTO users(username, password_hash, home_path, role, must_change_password, created_at, updated_at)
              VALUES('alice', ?, '/tmp/alice', 'user', 0, ?, ?)`)
    .run(await hashPassword('secret-1'), now, now)
  return { db, auth: new AuthService(db, testConfig(root)) }
}

describe('AuthService', () => {
  it.each(['idle', 'absolute'])('refuses a token exactly at its %s deadline without renewing it', async (kind) => {
    const { auth, db } = await setup()
    const login = await auth.login('alice', 'secret-1', '127.0.0.1', 'fixture')
    if (typeof login === 'string') throw new Error(login)
    const now = Date.now()
    const time = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      db.prepare('UPDATE auth_sessions SET expires_at=?,absolute_expires_at=?')
        .run(kind === 'idle' ? now : now + 10_000, kind === 'absolute' ? now : now + 10_000)
      const before = db.prepare('SELECT expires_at,absolute_expires_at,last_seen_at FROM auth_sessions').get()
      expect(auth.validate(login.token)).toBeNull()
      expect(db.prepare('SELECT expires_at,absolute_expires_at,last_seen_at FROM auth_sessions').get()).toEqual(before)
    } finally { time.mockRestore() }
  })

  it('logs in, validates with sliding expiry, revokes', async () => {
    const { auth } = await setup()
    const result = await auth.login('alice', 'secret-1', '1.2.3.4', 'ua')
    if (result === 'invalid' || result === 'locked') throw new Error(result)
    expect(result.user.username).toBe('alice')
    expect(auth.validate(result.token)?.username).toBe('alice')
    auth.revoke(result.token)
    expect(auth.validate(result.token)).toBeNull()
  })

  it('locks a username after 5 failures only for the failing source', async () => {
    const { auth } = await setup()
    for (let i = 0; i < 5; i++) {
      expect(await auth.login('alice', 'nope', '9.9.9.9', 'ua')).toBe('invalid')
    }
    expect(await auth.login('alice', 'secret-1', '9.9.9.9', 'ua')).toBe('locked')
    expect(await auth.login('alice', 'secret-1', '8.8.8.8', 'ua')).toMatchObject({ user: { username: 'alice' } })
    expect(await auth.login('alice', 'secret-1', '9.9.9.9', 'ua')).toBe('locked')
  })

  it('locks one source after 20 failures across usernames, sharing an IPv6 /64', async () => {
    const { auth } = await setup()
    for (let i = 0; i < 20; i++) {
      expect(await auth.login(`user-${String(i)}`, 'nope-nope', `2001:db8:1:2::${(i + 1).toString(16)}`, 'ua')).toBe('invalid')
    }
    expect(await auth.login('alice', 'secret-1', '2001:db8:1:2:ffff::1', 'ua')).toBe('locked')
    expect(await auth.login('alice', 'secret-1', '2001:db8:1:3::1', 'ua')).toMatchObject({ user: { username: 'alice' } })
  })

  it('never applies the source-wide lock to an undistinguishable loopback source', async () => {
    const { auth } = await setup()
    for (let i = 0; i < 20; i++) {
      expect(await auth.login(`user-${String(i)}`, 'nope-nope', '127.0.0.1', 'ua')).toBe('invalid')
    }
    expect(await auth.login('alice', 'secret-1', '127.0.0.1', 'ua')).toMatchObject({ user: { username: 'alice' } })
  })

  it('rejects disabled users and unknown tokens', async () => {
    const { db, auth } = await setup()
    db.prepare(`UPDATE users SET status='disabled'`).run()
    expect(await auth.login('alice', 'secret-1', '1.1.1.1', 'ua')).toBe('invalid')
    expect(auth.validate('bogus')).toBeNull()
  })
})
