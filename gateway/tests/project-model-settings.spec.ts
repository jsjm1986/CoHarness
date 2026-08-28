import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { ProjectService } from '../src/projects.ts'
import type { GatewayCollaborationService, GatewayModelGovernanceService } from '../src/services.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-project-models-'))
  const db = openDb(join(root, 'gateway.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects') })
  const users = new UserService(db, cfg)
  const projects = new ProjectService(db, cfg)
  const admin = await users.create({ username: 'admin', password: 'pw-12345678', role: 'admin' })
  await users.changeOwnPassword(admin.id, 'pw-12345678')
  const member = await users.create({ username: 'member', password: 'pw-12345678' })
  await users.changeOwnPassword(member.id, 'pw-12345678')
  const project = projects.createManaged({ name: 'Models', ownerUserId: admin.id })
  // Use the allocated project row; the path is already a directory.
  const authority = async (projectId: number, userId: number) => {
    const row = await projects.getById(projectId)
    const user = await users.getById(userId)
    if (row === null || user === null) return null
    if (user.role === 'admin') return { projectId, name: row.name, path: row.path, mode: 'rw' as const, administrator: true }
    const entry = row.members.find(candidate => candidate.userId === userId)
    return entry === undefined ? null : { projectId, name: row.name, path: row.path, mode: entry.mode, administrator: false }
  }
  const collaboration: GatewayCollaborationService = {
    projectForUser: authority,
    projectsForUser: async userId => {
      const value = await authority(project.id, userId)
      return value === null ? [] : [value]
    },
    access: () => { throw new Error('unused') }, listConversations: () => [], readableSessionIds: () => [],
    setVisibility: () => { throw new Error('unused') }, claimInteraction: () => false,
  }
  projects.setMember(project.id, member.id, 'rw')
  const view = () => ({
    projectId: project.id, revision: 1, writable: true, hasDocument: false as const,
    namespaces: [{ ns: 'llm-pi-ai' as const, schema: {}, value: { providers: {} }, base: { providers: {} }, user: { providers: {} }, applies: 'live' as const, secrets: [], revision: 1 }],
    providers: [], models: { groups: [], failures: [] },
  })
  const governance = {
    policyForProject: vi.fn(async () => ({ version: 1, defaultAllowed: false, models: [], providers: [] })),
    issueIntakeToken: vi.fn(async () => 'token'),
    subjectForIntakeToken: vi.fn(async () => ({ kind: 'project' as const, id: project.id })),
    describeProjectModelSettings: vi.fn(async () => view()),
    mutateProjectModelSettings: vi.fn(async () => view()),
    describeProjectCredentials: vi.fn(async (_id: number, refs: string[]) => Object.fromEntries(refs.map(ref => [ref, { configured: false, source: 'project' as const, writable: true as const }]))),
    setProjectCredential: vi.fn(async () => {}), unsetProjectCredential: vi.fn(async () => {}),
    discoverProjectModels: vi.fn(async () => []),
  } as unknown as GatewayModelGovernanceService
  const deps: GatewayDeps = {
    cfg, auth: new AuthService(db, cfg), users, projects, collaboration,
    audit: new AuditService(db), instances: new InstanceManager(db, cfg), governance,
  }
  const server = createGatewayServer(deps)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  cfg.publicOrigins.push(base)
  close = () => new Promise(resolve => server.close(() => resolve()))
  const login = async (username: string) => {
    const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: 'pw-12345678' }) })
    return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  }
  return { base, project, login, governance }
}

describe('project model settings API', () => {
  it('allows a project manager to read and mutate the shared provider settings', async () => {
    const { base, project, login, governance } = await setup()
    const cookie = await login('admin')
    const read = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings`, { headers: { cookie } })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ projectId: project.id, writable: true })
    const write = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings`, {
      method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'set', path: ['providers', 'relay'], value: { api: 'anthropic-messages', baseURL: 'https://relay.example/v1', models: [{ id: 'chat', name: 'Chat' }] } }], expectedRevision: 1 }),
    })
    expect(write.status).toBe(200)
    expect(governance.mutateProjectModelSettings).toHaveBeenCalledOnce()
  })

  it('returns a read-only view and refuses writes for a regular member', async () => {
    const { base, project, login, governance } = await setup()
    const cookie = await login('member')
    const read = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings`, { headers: { cookie } })
    expect(read.status).toBe(200)
    expect((await read.json())).toMatchObject({ writable: false, namespaces: [{ writable: false, writableReason: 'project' }] })
    const write = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings`, {
      method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ ops: [] }),
    })
    expect(write.status).toBe(403)
    expect(governance.mutateProjectModelSettings).not.toHaveBeenCalled()

    const credentials = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings/credentials?refs=DSH_PROJECT_${String(project.id)}_RELAY_API_KEY`, {
      headers: { cookie },
    })
    expect(credentials.status).toBe(200)
    expect(await credentials.json()).toMatchObject({
      credentials: {
        [`DSH_PROJECT_${String(project.id)}_RELAY_API_KEY`]: { writable: false },
      },
    })
  })

  it('rejects empty and prototype-polluting project setting paths before mutation', async () => {
    const { base, project, login, governance } = await setup()
    const cookie = await login('admin')
    const headers = { cookie, origin: base, 'content-type': 'application/json' }
    const empty = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings`, {
      method: 'PUT', headers, body: JSON.stringify({ ops: [] }),
    })
    expect(empty.status).toBe(400)
    const polluted = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings`, {
      method: 'PUT', headers,
      body: JSON.stringify({ ops: [{ op: 'set', path: ['providers', '__proto__', 'polluted'], value: true }] }),
    })
    expect(polluted.status).toBe(400)
    expect(governance.mutateProjectModelSettings).not.toHaveBeenCalled()
  })

  it('returns an explicit 413 for an oversized project settings request', async () => {
    const { base, project, login, governance } = await setup()
    const cookie = await login('admin')
    const padding = 'x'.repeat(1024 * 1024)
    const response = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings`, {
      method: 'PUT',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'set', path: ['providers', 'relay'], value: { padding } }] }),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'request-too-large' })
    expect(governance.mutateProjectModelSettings).not.toHaveBeenCalled()
  })
})
