import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { ModelGovernanceService } from '../src/model-governance.ts'
import { ProjectService } from '../src/projects.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'

const EXPECTED = join(import.meta.dirname, 'snapshots/admin-usage/overview.expected.md')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'

it('serves the real Gateway usage overview with separate billing and activity fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hgw-admin-usage-snapshot-'))
  const db = openDb(join(root, 'gateway.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state') })
  const governance = new ModelGovernanceService(db)
  const deps: GatewayDeps = {
    cfg, auth: new AuthService(db, cfg), users: new UserService(db, cfg), projects: new ProjectService(db, cfg),
    audit: new AuditService(db), instances: new InstanceManager(db, cfg), governance,
  }
  const admin = await deps.users.create({ username: 'admin', password: 'pw-12345678', role: 'admin' })
  await deps.users.changeOwnPassword(admin.id, 'pw-12345678')
  governance.upsertModel({
    provider: 'snapshot', model: 'model', displayName: 'Snapshot Model', enabled: true,
    adminAllowed: true, userAllowed: true, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
    cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0,
  })
  governance.ingest({ kind: 'user', id: admin.id }, {
    eventId: 'snapshot-usage', occurredAt: Date.parse('2026-08-12T12:00:00Z'),
    provider: 'snapshot', model: 'model', purpose: 'assistant', credentialSource: 'user-env',
    credentialClass: 'company', status: 'succeeded', usage: { inputTokens: 12, outputTokens: 3 },
  })
  const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    cfg.publicOrigins.push(base)
    const login = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'pw-12345678' }),
    })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const response = await fetch(`${base}/admin/api/usage/overview?month=2026-08`, { headers: { cookie } })
    const overview = await response.json() as {
      month: string; timeZone: string; personal: { calls: number; totalTokens: number }
      projects: { calls: number; totalTokens: number }; unattributedProjects: { calls: number; totalTokens: number }
      users: Array<{ username: string; personal: { totalTokens: number }; projectContribution: { totalTokens: number } }>
    }
    const transcript = [
      '# Administrator usage overview', '', `status=${String(response.status)}`, `month=${overview.month}`,
      `timeZone=${overview.timeZone}`, `personalCalls=${String(overview.personal.calls)}`,
      `personalTokens=${String(overview.personal.totalTokens)}`, `projectCalls=${String(overview.projects.calls)}`,
      `projectTokens=${String(overview.projects.totalTokens)}`,
      `unattributedProjectTokens=${String(overview.unattributedProjects.totalTokens)}`,
      ...overview.users.map(user => `user=${user.username} personal=${String(user.personal.totalTokens)} contribution=${String(user.projectContribution.totalTokens)}`), '',
    ].join('\n')
    if (refreshing) {
      await import('node:fs/promises').then(({ mkdir, writeFile }) => mkdir(join(import.meta.dirname, 'snapshots/admin-usage'), { recursive: true }).then(() => writeFile(EXPECTED, transcript)))
    }
    await expect(transcript).toMatchFileSnapshot(EXPECTED)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
