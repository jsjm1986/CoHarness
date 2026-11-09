import type { RuntimeId } from '../src/runtime-catalog.ts'
/** Push delivery claims and recipients retain database ownership under concurrency. @module */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { JpushRestSender, PostgresPushService, type PushProvider } from '../src/push-notifications.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { resolve } from 'node:path'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL push ownership', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, process.env.DSH_AUDIT_ACCOUNT_MIGRATIONS ?? resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture(provider: PushProvider = 'fcm') {
    const organizationId = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Push ownership') RETURNING id", [`push-owner-${randomUUID()}`])).rows[0]!.id
    try {
      const accounts = []
      for (const username of ['creator', 'other']) {
        const user = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
          VALUES($1,$2::text,$2::text,'/unused') RETURNING id,public_id`, [organizationId, username])).rows[0]!
        await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, user.id])
        accounts.push({ id: user.id, publicId: Number(user.public_id) })
      }
      const creator = accounts[0]!, other = accounts[1]!, sessionId = `push-session-${randomUUID()}`
      const personalNode = (await pool.query<{ id: string }>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'personal') RETURNING id", [organizationId])).rows[0]!.id
      const runtimes = new Map<string, RuntimeId>()
      for (const [index, account] of accounts.entries()) {
        const runtimeId = (await pool.query<{ runtime_id: RuntimeId }>('INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port) VALUES($1,$2,$3,$4) RETURNING runtime_id', [organizationId, account.id, personalNode, 42001 + index])).rows[0]!.runtime_id
        runtimes.set(account.id, runtimeId)
      }
      await pool.query(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,session_format_version,
        created_at,updated_at,visibility,root_session_id) VALUES($1,$2,$3,0,now(),now(),'personal',$1)`, [sessionId, organizationId, creator.id])
      const cfg = loadConfig({}), context = { pool, organizationId }, token = `fixture-device-${randomUUID()}`
      const sender = { send: vi.fn(async (_input: { token: string; runtimeId: RuntimeId; sessionId: string; eventSeq: number }, _signal?: AbortSignal) => {}) }
      const service = new PostgresPushService(context, cfg, fetch, sender)
      const device = await service.registerDevice(creator.publicId, { token, platform: 'android', provider })
      return { context, cfg, sender, service, creator, other, runtimeId: runtimes.get(creator.id)!, otherRuntimeId: runtimes.get(other.id)!, sessionId, personalNode, device, token, provider, close: () => removeFixtureOrganization(pool, organizationId) }
    } catch (error) {
      try { await removeFixtureOrganization(pool, organizationId) } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Push fixture setup and cleanup failed') }
      throw error
    }
  }

  async function projectSession(f: Awaited<ReturnType<typeof fixture>>, projectId: string): Promise<void> {
    await pool.query('DELETE FROM harness.conversation_sessions WHERE id=$1', [f.sessionId])
    await pool.query(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,project_id,session_format_version,
      created_at,updated_at,visibility,root_session_id) VALUES($1,$2,$3,$4,0,now(),now(),'project',$1)`, [f.sessionId, f.context.organizationId, f.creator.id, projectId])
    f.runtimeId = (await pool.query<{ runtime_id: RuntimeId }>('SELECT runtime_id FROM harness.conversation_sessions WHERE organization_id=$1 AND id=$2', [f.context.organizationId, f.sessionId])).rows[0]!.runtime_id
  }

  it.each(['fcm', 'jpush'] as const)('retries a completed event after its unconfigured %s provider becomes available', async (provider) => {
    const f = await fixture(provider), report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await new PostgresPushService(f.context, f.cfg).notifyCompleted(f.runtimeId, f.sessionId, 32)
      expect((await pool.query('SELECT status,attempts FROM harness.push_deliveries WHERE organization_id=$1', [f.context.organizationId])).rows)
        .toEqual([{ status: 'failed', attempts: 1 }])
      expect((await pool.query('SELECT id FROM harness.push_devices WHERE id=$1', [f.device.id])).rowCount).toBe(1)
      await f.service.notifyCompleted(f.runtimeId, f.sessionId, 32)
      expect(f.sender.send).toHaveBeenCalledOnce()
      expect((await pool.query('SELECT status,attempts FROM harness.push_deliveries WHERE organization_id=$1', [f.context.organizationId])).rows)
        .toEqual([{ status: 'sent', attempts: 2 }])
    } finally { report.mockRestore(); await f.close() }
  })

  it.each(['revoked', 'missing-grant', 'retired-runtime'] as const)('requires the personal Session source computer despite a second allowed computer: %s', async change => {
    const f = await fixture()
    try {
      const second = (await pool.query<{ id: string }>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'second') RETURNING id", [f.context.organizationId])).rows[0]!.id
      await pool.query("INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,'/unused-second')", [f.context.organizationId, second, f.creator.id])
      await pool.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout)
        VALUES($1,$2,$3,42001,'isolated')`, [f.context.organizationId, f.creator.id, second])
      await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [f.context.organizationId, second, f.creator.id])
      if (change === 'revoked') await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE node_id=$1 AND user_id=$2', [f.personalNode, f.creator.id])
      if (change === 'missing-grant') await pool.query('DELETE FROM harness.computer_use_permissions WHERE node_id=$1 AND user_id=$2', [f.personalNode, f.creator.id])
      if (change === 'retired-runtime') await pool.query('DELETE FROM harness.instances WHERE assigned_node_id=$1 AND user_id=$2', [f.personalNode, f.creator.id])
      await f.service.notifyCompleted(f.runtimeId, f.sessionId, 29)
      expect(f.sender.send).not.toHaveBeenCalled()
      expect((await pool.query('SELECT * FROM harness.push_deliveries WHERE organization_id=$1', [f.context.organizationId])).rows).toEqual([])
    } finally { await f.close() }
  })

  it('retains a personal source computer grant through a device-row wait', async () => {
    const f = await fixture(), readName = `personal-push-${randomUUID()}`, revokeName = `personal-revoke-${randomUUID()}`
    const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: readName }), revoker = createPostgresPool(databaseUrl!, { max: 1, application_name: revokeName })
    const service = new PostgresPushService({ ...f.context, pool: reader }, f.cfg, fetch, f.sender)
    const blocker = await pool.connect()
    let pending: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, revokeSettled = false
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM harness.push_devices WHERE id=$1 FOR UPDATE', [f.device.id])
      pending = service.notifyCompleted(f.runtimeId, f.sessionId, 30).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [readName])).rows[0]!.waiting).toBe(true)
      revoked = revoker.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE node_id=$1 AND user_id=$2', [f.personalNode, f.creator.id])
        .then(value => { revokeSettled = true; return value }, (error: unknown) => { revokeSettled = true; return error })
      await expect.poll(async () => revokeSettled || (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity r JOIN pg_stat_activity p ON p.application_name=$1
        WHERE r.application_name=$2 AND p.pid=ANY(pg_blocking_pids(r.pid))) blocked`, [readName, revokeName])).rows[0]!.blocked).toBe(true)
      expect(revokeSettled).toBe(false)
      await blocker.query('COMMIT')
      expect(await pending).not.toBeInstanceOf(Error); expect(await revoked).not.toBeInstanceOf(Error)
      await service.notifyCompleted(f.runtimeId, f.sessionId, 31)
      expect(f.sender.send).toHaveBeenCalledOnce()
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await Promise.all([pending, revoked]); await reader.end(); await revoker.end(); await f.close()
    }
  })

  it('does not send a completed event twice while its first delivery is pending', async () => {
    const f = await fixture()
    let entered!: () => void, release!: () => void
    const observed = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done })
    let calls = 0
    f.sender.send.mockImplementation(async () => { calls += 1; if (calls === 1) { entered(); await gate } })
    let first: Promise<void> | undefined, second: Promise<void> | undefined
    try {
      first = f.service.notifyCompleted(f.runtimeId, f.sessionId, 17)
      await observed
      second = f.service.notifyCompleted(f.runtimeId, f.sessionId, 17)
      await second
      expect(calls).toBe(1)
      release(); await first
      expect((await pool.query('SELECT status,attempts FROM harness.push_deliveries WHERE organization_id=$1', [f.context.organizationId])).rows).toEqual([{ status: 'sent', attempts: 1 }])
    } finally { release(); await Promise.all([first, second]); await f.close() }
  })

  it('drops a captured device after another account takes ownership before delivery admission', async () => {
    const f = await fixture()
    let entered!: () => void, release!: () => void
    const observed = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done })
    let captured = false, pending: Promise<void> | undefined
    const lane = new Proxy(pool, {
      get(target, key) {
        if (key === 'query') return async (text: string, values?: readonly unknown[]) => {
          const result = await target.query(text, values === undefined ? undefined : [...values])
          if (!captured && text.includes('FROM harness.push_devices') && !text.includes('DELETE')) { captured = true; entered(); await gate }
          return result
        }
        const value: unknown = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    try {
      const service = new PostgresPushService({ ...f.context, pool: lane }, f.cfg, fetch, f.sender)
      pending = service.notifyCompleted(f.runtimeId, f.sessionId, 18)
      await observed
      expect(await f.service.registerDevice(f.other.publicId, { token: f.token, platform: 'android' })).toEqual(f.device)
      release(); await pending
      expect(f.sender.send).not.toHaveBeenCalled()
      expect((await pool.query('SELECT user_id FROM harness.push_devices WHERE id=$1', [f.device.id])).rows[0]?.user_id).toBe(f.other.id)
    } finally { release(); await pending; await f.close() }
  })

  it.each(['disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization'] as const)('does not notify a creator with %s', async change => {
    const f = await fixture()
    try {
      if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.creator.id])
      if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [f.creator.id])
      if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [f.creator.id])
      if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [f.creator.id])
      if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
      await f.service.notifyCompleted(f.runtimeId, f.sessionId, 19)
      expect(f.sender.send).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

  it('retries a failed delivery and retains the successful attempt after a late expired worker fails', async () => {
    const f = await fixture(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let entered!: () => void, release!: () => void
    const observed = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done })
    let calls = 0, first: Promise<void> | undefined
    f.sender.send.mockImplementation(async () => { calls += 1; if (calls === 1) { entered(); await gate; throw new Error('late-worker-failure') } })
    try {
      first = f.service.notifyCompleted(f.runtimeId, f.sessionId, 20); await observed
      await pool.query("UPDATE harness.push_deliveries SET updated_at=clock_timestamp()-($2+1)*interval '1 millisecond' WHERE organization_id=$1", [f.context.organizationId, f.cfg.pushDeliveryLeaseMs])
      await f.service.notifyCompleted(f.runtimeId, f.sessionId, 20)
      release(); await first
      expect(calls).toBe(2)
      expect((await pool.query('SELECT status,attempts,last_error FROM harness.push_deliveries WHERE organization_id=$1', [f.context.organizationId])).rows)
        .toEqual([{ status: 'sent', attempts: 2, last_error: null }])
      expect(log).toHaveBeenCalledOnce()
    } finally { release(); await first; log.mockRestore(); await f.close() }
  })

  it('releases its transaction before sending and can retry an explicitly failed delivery', async () => {
    const f = await fixture(), limited = createPostgresPool(databaseUrl!, { max: 1 }), log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let calls = 0
    const sender = { send: async () => { await limited.query('SELECT 1'); calls += 1; if (calls === 1) throw new Error('temporary-provider-failure') } }
    try {
      const service = new PostgresPushService({ ...f.context, pool: limited }, f.cfg, fetch, sender)
      await service.notifyCompleted(f.runtimeId, f.sessionId, 21)
      expect((await pool.query('SELECT status FROM harness.push_deliveries WHERE organization_id=$1', [f.context.organizationId])).rows[0]?.status).toBe('failed')
      await service.notifyCompleted(f.runtimeId, f.sessionId, 21)
      expect((await pool.query('SELECT status,attempts FROM harness.push_deliveries WHERE organization_id=$1', [f.context.organizationId])).rows).toEqual([{ status: 'sent', attempts: 2 }])
      expect(calls).toBe(2); expect(log).toHaveBeenCalledOnce()
    } finally { log.mockRestore(); await limited.end(); await f.close() }
  })

  it('bounds a sender that never settles and aborts its transport without removing the device', async () => {
    const f = await fixture(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let signal: AbortSignal | undefined
    const sender = { send: async (_input: unknown, current?: AbortSignal) => { signal = current; await new Promise<void>(() => {}) } }
    const cfg = loadConfig({ HGW_PUSH_DELIVERY_TIMEOUT_MS: '50', HGW_PUSH_DELIVERY_LEASE_MS: '1000' })
    try {
      await new PostgresPushService(f.context, cfg, fetch, sender).notifyCompleted(f.runtimeId, f.sessionId, 22)
      expect(signal?.aborted).toBe(true)
      expect((await pool.query('SELECT status,last_error FROM harness.push_deliveries WHERE organization_id=$1', [f.context.organizationId])).rows)
        .toEqual([{ status: 'failed', last_error: 'Push delivery timed out' }])
      expect((await pool.query('SELECT id FROM harness.push_devices WHERE id=$1', [f.device.id])).rowCount).toBe(1)
      expect(log).toHaveBeenCalledOnce()
    } finally { log.mockRestore(); await f.close() }
  })

  it('does not delete another account\'s new registration after an old invalid-token response', async () => {
    const f = await fixture('jpush'), log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let entered!: () => void, release!: () => void, pending: Promise<void> | undefined
    const observed = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done })
    const request = vi.fn(async () => { entered(); await gate; return new Response('invalid registration id', { status: 400 }) })
    try {
      const service = new PostgresPushService(f.context, f.cfg, fetch, new JpushRestSender('fixture-app', 'fixture-secret', request))
      pending = service.notifyCompleted(f.runtimeId, f.sessionId, 23); await observed
      await f.service.registerDevice(f.other.publicId, { token: f.token, platform: 'android', provider: 'jpush' })
      release(); await pending
      expect((await pool.query('SELECT user_id FROM harness.push_devices WHERE id=$1', [f.device.id])).rows[0]?.user_id).toBe(f.other.id)
      expect(log).toHaveBeenCalledOnce()
    } finally { release(); await pending; log.mockRestore(); await f.close() }
  })

  it.each(['register', 'remove'] as const)('rechecks current account eligibility for queued %s operations', async operation => {
    const f = await fixture(), limited = createPostgresPool(databaseUrl!, { max: 1 })
    const held = await limited.connect(), service = new PostgresPushService({ ...f.context, pool: limited }, f.cfg, fetch, f.sender)
    let pending: Promise<unknown> | undefined, released = false
    try {
      expect(await f.service.removeDevice(f.other.publicId, f.device.id)).toBe(false)
      pending = (operation === 'register' ? service.registerDevice(f.creator.publicId, { token: 'another-fixture-device', platform: 'android' })
        : service.removeDevice(f.creator.publicId, f.device.id)).catch((error: unknown) => error)
      await expect.poll(() => limited.waitingCount).toBe(1)
      await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.creator.id])
      held.release(); released = true
      expect(await pending).toMatchObject({ code: 'forbidden' })
      expect((await pool.query('SELECT id FROM harness.push_devices WHERE organization_id=$1', [f.context.organizationId])).rows).toEqual([{ id: f.device.id }])
    } finally { if (!released) held.release(); await pending; await limited.end(); await f.close() }
  })

  it.each(['current', 'removed-member', 'computer-revoked', 'archived-project', 'administrator', 'steward-with-grant', 'steward-without-grant'] as const)('checks current shared-project read eligibility: %s', async change => {
    const f = await fixture()
    try {
      const node = (await pool.query<{ id: string }>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local') RETURNING id", [f.context.organizationId])).rows[0]!.id
      const steward = change.startsWith('steward-')
      const project = (await pool.query<{ id: string }>("INSERT INTO harness.projects(organization_id,name,kind,steward_node_id) VALUES($1,'Shared notification',$2,$3) RETURNING id",
        [f.context.organizationId, steward ? 'steward' : 'standard', steward ? node : null])).rows[0]!.id
      await pool.query('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,42000)', [f.context.organizationId, project, node])
      await pool.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'ro')", [f.context.organizationId, project, f.creator.id])
      await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [f.context.organizationId, node, f.creator.id])
      await projectSession(f, project)
      if (change === 'removed-member') await pool.query('DELETE FROM harness.project_members WHERE project_id=$1 AND user_id=$2', [project, f.creator.id])
      if (change === 'computer-revoked') await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE node_id=$1 AND user_id=$2', [node, f.creator.id])
      if (change === 'archived-project') await pool.query("UPDATE harness.projects SET status='archived' WHERE id=$1", [project])
      if (change === 'administrator' || steward) {
        await pool.query("UPDATE harness.memberships SET role='admin' WHERE user_id=$1", [f.creator.id])
        await pool.query('DELETE FROM harness.project_members WHERE project_id=$1 AND user_id=$2', [project, f.creator.id])
      }
      if (change === 'steward-with-grant') await pool.query('INSERT INTO harness.steward_access_policies(organization_id,node_id,user_id,enabled,revision) VALUES($1,$2,$3,true,1)', [f.context.organizationId, node, f.creator.id])
      await f.service.notifyCompleted(f.runtimeId, f.sessionId, 24)
      expect(f.sender.send).toHaveBeenCalledTimes(change === 'current' || change === 'administrator' || change === 'steward-with-grant' ? 1 : 0)
    } finally { await f.close() }
  })

  it.each(['member', 'admin'] as const)('does not notify a child creator with role %s who cannot read another account\'s personal root', async role => {
    const f = await fixture()
    try {
      await pool.query('DELETE FROM harness.conversation_sessions WHERE id=$1', [f.sessionId])
      await pool.query(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,session_format_version,
        created_at,updated_at,visibility,root_session_id) VALUES($1,$2,$3,0,now(),now(),'personal',$1)`, [f.sessionId, f.context.organizationId, f.other.id])
      await pool.query('UPDATE harness.memberships SET role=$2 WHERE user_id=$1', [f.creator.id, role])
      const child = `push-child-${randomUUID()}`
      await pool.query(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,session_format_version,
        created_at,updated_at,visibility,root_session_id,parent_session_id) VALUES($1,$2,$3,0,now(),now(),'personal',$4,$4)`,
      [child, f.context.organizationId, f.other.id, f.sessionId])
      // Legacy child attribution must not grant access to its retained personal root.
      await pool.query('UPDATE harness.conversation_sessions SET creator_user_id=$2 WHERE id=$1', [child, f.creator.id])
      await f.service.notifyCompleted(f.otherRuntimeId, child, 25)
      expect(f.sender.send).not.toHaveBeenCalled()
    } finally { await f.close() }
  })


  it('retains computer qualification through a device-row wait and drops later notifications after withdrawal', async () => {
    const f = await fixture(), readName = `push-read-${randomUUID()}`, revokeName = `push-revoke-${randomUUID()}`
    const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: readName }), revoker = createPostgresPool(databaseUrl!, { max: 1, application_name: revokeName })
    const blocker = await pool.connect(), service = new PostgresPushService({ ...f.context, pool: reader }, f.cfg, fetch, f.sender)
    let pending: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, revokeSettled = false
    try {
      const node = (await pool.query<{ id: string }>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local') RETURNING id", [f.context.organizationId])).rows[0]!.id
      const project = (await pool.query<{ id: string }>("INSERT INTO harness.projects(organization_id,name) VALUES($1,'Shared wait') RETURNING id", [f.context.organizationId])).rows[0]!.id
      await pool.query('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,42000)', [f.context.organizationId, project, node])
      await pool.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'ro')", [f.context.organizationId, project, f.creator.id])
      await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [f.context.organizationId, node, f.creator.id])
      await projectSession(f, project)
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM harness.push_devices WHERE id=$1 FOR UPDATE', [f.device.id])
      pending = service.notifyCompleted(f.runtimeId, f.sessionId, 26).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [readName])).rows[0]!.waiting).toBe(true)
      revoked = revoker.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE node_id=$1 AND user_id=$2', [node, f.creator.id])
        .then(value => { revokeSettled = true; return value }, (error: unknown) => { revokeSettled = true; return error })
      await expect.poll(async () => revokeSettled || (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity r JOIN pg_stat_activity p ON p.application_name=$1
        WHERE r.application_name=$2 AND p.pid=ANY(pg_blocking_pids(r.pid))) blocked`, [readName, revokeName])).rows[0]!.blocked).toBe(true)
      expect(revokeSettled).toBe(false)
      await blocker.query('COMMIT')
      expect(await pending).not.toBeInstanceOf(Error); expect(await revoked).not.toBeInstanceOf(Error)
      await service.notifyCompleted(f.runtimeId, f.sessionId, 27)
      expect(f.sender.send).toHaveBeenCalledOnce()
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await Promise.all([pending, revoked]); await reader.end(); await revoker.end(); await f.close()
    }
  })

  it('keeps equal completion and device keys independent across two computers belonging to the same account', async () => {
    const f = await fixture()
    try {
      const node = (await pool.query<{ id: string }>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'second-notifier') RETURNING id", [f.context.organizationId])).rows[0]!.id
      await pool.query("INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,'/unused-second')", [f.context.organizationId, node, f.creator.id])
      await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [f.context.organizationId, node, f.creator.id])
      const sibling = (await pool.query<{ runtime_id: RuntimeId }>("INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,42001,'isolated') RETURNING runtime_id", [f.context.organizationId, f.creator.id, node])).rows[0]!.runtime_id
      await pool.query(`INSERT INTO harness.conversation_sessions(id,organization_id,runtime_id,creator_user_id,session_format_version,created_at,updated_at,visibility,root_session_id)
        VALUES($1,$2,$3,$4,0,now(),now(),'personal',$1)`, [f.sessionId, f.context.organizationId, sibling, f.creator.id])
      await Promise.all([f.service.notifyCompleted(f.runtimeId, f.sessionId, 33), f.service.notifyCompleted(sibling, f.sessionId, 33)])
      expect(f.sender.send.mock.calls.map(([input]) => input.runtimeId).sort()).toEqual([f.runtimeId, sibling].sort())
      const rows = (await pool.query<{ runtime_id: RuntimeId; status: string }>('SELECT runtime_id,status FROM harness.push_deliveries WHERE organization_id=$1 AND session_id=$2 ORDER BY runtime_id', [f.context.organizationId, f.sessionId])).rows
      expect(rows).toEqual([f.runtimeId, sibling].sort().map(runtime_id => ({ runtime_id, status: 'sent' })))
      await Promise.all([f.service.notifyCompleted(f.runtimeId, f.sessionId, 33), f.service.notifyCompleted(sibling, f.sessionId, 33)])
      expect(f.sender.send).toHaveBeenCalledTimes(2)
      await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [f.context.organizationId, f.personalNode, f.creator.id])
      await f.service.notifyCompleted(f.runtimeId, f.sessionId, 34)
      await f.service.notifyCompleted(sibling, f.sessionId, 34)
      expect(f.sender.send).toHaveBeenCalledTimes(3)
      expect(f.sender.send.mock.calls.at(-1)?.[0].runtimeId).toBe(sibling)
    } finally { await f.close() }
  })

})
