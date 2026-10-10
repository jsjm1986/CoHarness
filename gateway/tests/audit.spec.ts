import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuditService } from '../src/audit.ts'
import { openDb } from '../src/db.ts'

describe('AuditService', () => {
  it('writes and filters entries', () => {
    const audit = new AuditService(openDb(join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite')))
    audit.write({ userId: 1, action: 'login', ip: '1.1.1.1' })
    audit.write({ userId: 1, action: 'api', methodPath: 'POST /api/session.prompt', status: 200 })
    audit.write({ userId: 2, action: 'api', methodPath: 'POST /api/session.create', status: 200 })
    expect(audit.query({ userId: 1 })).toHaveLength(2)
    expect(audit.query({ action: 'login' })[0]?.ip).toBe('1.1.1.1')
    expect(audit.query({ limit: 1 })).toHaveLength(1)
  })

  it('filters by fromMs, toMs, offset, and action prefix', () => {
    const audit = new AuditService(openDb(join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite')))
    audit.write({ userId: 1, action: 'admin.projects.create' })
    audit.write({ userId: 1, action: 'admin.projects.delete' })
    audit.write({ userId: 1, action: 'admin.users' })
    const mid = Date.now()
    audit.write({ userId: 2, action: 'admin.members.set' })
    expect(audit.query({ action: 'admin.projects%' })).toHaveLength(2)
    expect(audit.query({ actionPrefix: 'admin.members' }).map(r => r.action)).toEqual(['admin.members.set'])
    expect(audit.query({ fromMs: mid, userId: 2 })).toHaveLength(1)
    expect(audit.query({ toMs: mid, actionPrefix: 'admin.projects' })).toHaveLength(2)
    expect(audit.query({ limit: 1, offset: 1 }).length).toBe(1)
    expect(audit.query({ limit: 2, offset: 0 })[0]?.action).toBe('admin.members.set')
  })

  it('filters by family, outcome, actor name, and literal action text', () => {
    const audit = new AuditService(openDb(join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite')))
    audit.write({ userId: 1, action: 'login.failed', status: 401 })
    audit.write({ userId: 1, action: 'login', ip: '1.1.1.1' })
    audit.write({ userId: 1, action: 'api', methodPath: 'POST /api/x', status: 503 })
    audit.write({ userId: 1, action: 'admin.users.set' })
    audit.write({ userId: 1, action: 'steward.query' })
    expect(audit.query({ family: 'auth' }).map(r => r.action)).toEqual(['login', 'login.failed'])
    expect(audit.query({ family: 'admin' })).toHaveLength(1)
    expect(audit.query({ family: 'steward' })).toHaveLength(1)
    expect(audit.query({ family: 'api' })).toHaveLength(1)
    expect(audit.query({ family: 'model' })).toHaveLength(0)
    expect(audit.query({ outcome: 'failure' }).map(r => r.action)).toEqual(['api', 'login.failed'])
    expect(audit.query({ outcome: 'success', family: 'admin' })).toHaveLength(1)
    expect(audit.query({ queryText: 'login' })).toHaveLength(2)
    // `_` and `%` in user input match literally, never as wildcards.
    audit.write({ userId: 1, action: 'weird_name' })
    audit.write({ userId: 1, action: 'weirdXname' })
    expect(audit.query({ queryText: 'weird_name' }).map(r => r.action)).toEqual(['weird_name'])
  })

  it('joins actor names, clamps the limit, and counts across pages', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite'))
    db.prepare(`INSERT INTO users(username, password_hash, display_name, role, home_path, created_at, updated_at)
      VALUES('root-admin', 'x', 'Root Admin', 'admin', '/tmp/root-admin', 1, 1)`).run()
    const audit = new AuditService(db)
    audit.write({ userId: 1, action: 'admin.users' })
    audit.write({ userId: 99999, action: 'admin.orphan' })
    for (let i = 0; i < 3; i += 1) audit.write({ userId: 1, action: `admin.op.${i}` })
    expect(audit.count({})).toBe(5)
    expect(audit.count({ family: 'admin' })).toBe(5)
    expect(audit.query({ limit: 100000 }).length).toBe(5)
    expect(audit.query({ offset: -5 }).length).toBe(5)
    expect(audit.query({ actor: 'Root Admin' }).length).toBe(4)
    const named = audit.query({ actionPrefix: 'admin.users' })[0]
    expect(named?.username).toBe('root-admin')
    expect(named?.displayName).toBe('Root Admin')
    const orphan = audit.query({ actionPrefix: 'admin.orphan' })[0]
    expect(orphan?.username).toBeNull()
  })
})
