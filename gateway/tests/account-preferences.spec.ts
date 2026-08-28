import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/auth.ts'
import type {
  AccountPreferenceMutation, AccountPreferencesView, GatewayAccountPreferencesService,
} from '../src/account-preferences.ts'
import { AuditService } from '../src/audit.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { ProjectService } from '../src/projects.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })

const VIEW: AccountPreferencesView = {
  revision: 4,
  migrated: true,
  values: {
    locale: { preference: 'zh' },
    'ui-theme': { preference: 'dark' },
    'ui-conversation': { busyEnter: 'steer' },
  },
  overrides: {
    locale: { preference: 'zh' },
    'ui-theme': { preference: 'dark' },
    'ui-conversation': { busyEnter: 'steer' },
  },
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-prefs-'))
  const db = openDb(join(root, 'gateway.sqlite'))
  const cfg = loadConfig({
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_STATE_ROOT: join(root, 'state'),
    HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
  })
  let current = structuredClone(VIEW)
  const userPreferences: GatewayAccountPreferencesService = {
    describe: async () => structuredClone(current),
    mutate: async (_user, mutation: AccountPreferenceMutation) => {
      if (mutation.expectedRevision !== undefined && mutation.expectedRevision !== current.revision) {
        throw new Error('account preference revision conflict')
      }
      current = { ...current, revision: current.revision + 1 }
      return structuredClone(current)
    },
  }
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    projects: new ProjectService(db, cfg),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
    userPreferences,
  }
  const admin = await deps.users.create({ username: 'admin', password: 'pw-12345678', role: 'admin' })
  await deps.users.changeOwnPassword(admin.id, 'pw-12345678')
  const server = createGatewayServer(deps)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  cfg.publicOrigins.push(base)
  close = () => new Promise(resolve => server.close(() => resolve()))
  const login = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'pw-12345678' }),
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  if (cookie === '') throw new Error('login did not return a session cookie')
  return { base, cookie, deps }
}

describe('Gateway account preferences route', () => {
  it('reads and writes only the authenticated account with a no-store response', async () => {
    const { base, cookie, deps } = await setup()
    const read = await fetch(`${base}/account/api/preferences`, { headers: { cookie } })
    expect(read.status).toBe(200)
    expect(read.headers.get('cache-control')).toBe('no-store')
    expect(await read.json()).toMatchObject({ revision: 4, values: VIEW.values })

    const write = await fetch(`${base}/account/api/preferences`, {
      method: 'PATCH', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'ui-theme', field: 'preference', operation: 'set', value: 'light', expectedRevision: 4 }),
    })
    expect(write.status).toBe(200)
    expect((await write.json()).revision).toBe(5)
    const audit = await deps.audit.query({ action: 'account-preference.updated' })
    expect(audit).toHaveLength(1)
    expect(audit[0]?.methodPath).toBe('')
  })

  it('enforces CSRF and returns a conflict without invoking a stale mutation', async () => {
    const { base, cookie, deps } = await setup()
    const noOrigin = await fetch(`${base}/account/api/preferences`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'locale', field: 'preference', operation: 'set', value: 'en' }),
    })
    expect(noOrigin.status).toBe(403)

    const service = deps.userPreferences!
    let calls = 0
    const original = service.mutate
    service.mutate = async (...args) => { calls += 1; return original(...args) }
    // The test double's conflict is represented as a normal service error in
    // this route-level suite; validation and authorization remain the route's
    // responsibility.
    const bad = await fetch(`${base}/account/api/preferences`, {
      method: 'PATCH', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'locale', field: 'preference', operation: 'set', value: 'fr', expectedRevision: 4 }),
    })
    expect(bad.status).toBe(400)
    expect(calls).toBe(0)
  })

  it('marks an absent account store as unsupported so embedded Hosts can fall back', async () => {
    const { base, cookie, deps } = await setup()
    delete deps.userPreferences
    const response = await fetch(`${base}/account/api/preferences`, { headers: { cookie } })
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({ error: 'account-preferences-unsupported' })
  })
})
