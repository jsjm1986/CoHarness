import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { testConfig } from './test-config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { ProjectService } from '../src/projects.ts'
import { CollaborationDeniedError } from '../src/collaboration.ts'
import { NonPublicNetworkTargetError } from '../src/public-network-fetch.ts'
import type { GatewayCollaborationService, GatewayModelGovernanceService } from '../src/services.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-project-models-'))
  const db = openDb(join(root, 'gateway.sqlite'))
  const cfg = testConfig(root, { HGW_USERS_ROOT: join(root, 'users'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects') })
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
    if (user.role === 'admin') return { projectId, name: row.name, path: row.path, mode: 'rw' as const, administrator: true, canManage: true, uiThemePolicy: 'follow-user' as const }
    const entry = row.members.find(candidate => candidate.userId === userId)
    return entry === undefined ? null : { projectId, name: row.name, path: row.path, mode: entry.mode, administrator: false, canManage: row.owner?.id === userId, uiThemePolicy: 'follow-user' as const }
  }
  const collaboration: GatewayCollaborationService = {
    projectForUser: authority,
    projectsForUser: async userId => {
      const value = await authority(project.id, userId)
      return value === null ? [] : [value]
    },
    access: () => { throw new Error('unused') }, listConversations: () => [], readableSessionIds: () => [],
    setVisibility: () => { throw new Error('unused') }, claimInteraction: () => false, listActivity: async () => ({ items: [] }),
  }
  projects.setMember(project.id, member.id, 'rw')
  const view = () => ({
    projectId: project.id, revision: 1, writable: true, hasDocument: false as const,
    namespaces: [{ ns: 'llm-pi-ai' as const, schema: {}, value: { providers: {} }, base: { providers: {} }, user: { providers: {} }, applies: 'live' as const, secrets: [], revision: 1 }],
    providers: [], models: { groups: [], failures: [] },
  })
  const governance = Object.assign({} as GatewayModelGovernanceService, {
    policyForProject: vi.fn(async () => ({ version: 1, defaultAllowed: false as const, models: [], providers: [] })),
    issueIntakeToken: vi.fn(async () => 'token'),
    subjectForIntakeToken: vi.fn(async () => ({ kind: 'project' as const, id: project.id })),
    describeProjectModelSettings: vi.fn(async () => view()),
    mutateProjectModelSettings: vi.fn(async () => view()),
    describeProjectCredentials: vi.fn(async (_id: number, refs: string[]) => Object.fromEntries(refs.map(ref => [ref, { configured: false, source: 'project' as const, writable: true as const }]))),
    setProjectCredential: vi.fn(async () => {}), unsetProjectCredential: vi.fn(async () => {}),
    discoverProjectModels: vi.fn(async () => []),
  })
  governance.authorizeProjectModelRead = vi.fn(async (projectId: number, userId: number) => {
    const current = await authority(projectId, userId)
    if (current === null) throw new CollaborationDeniedError('forbidden')
    return current.canManage
  })
  const deps: GatewayDeps = {
    cfg, auth: new AuthService(db, cfg), users, projects, collaboration,
    audit: new AuditService(db), instances: new InstanceManager(db, cfg), governance,
  }
  const server = createGatewayServer(deps)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  cfg.publicOrigins.push(base)
  close = () => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(() => resolve()))
  }
  const login = async (username: string) => {
    const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: 'pw-12345678' }) })
    return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  }
  return { base, project, projects, login, governance, admin, member }
}

describe('project model settings API', () => {
  it('refuses a model service without current project read qualification', async () => {
    const { base, project, login, governance } = await setup()
    const cookie = await login('admin')
    governance.authorizeProjectModelRead = undefined
    const response = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings`, { headers: { cookie } })
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({ error: 'project-model-settings-unsupported' })
    expect(governance.describeProjectModelSettings).not.toHaveBeenCalled()
  })

  it('qualifies every model read after preparing its result using the authenticated actor', async () => {
    const { base, project, login, governance, admin } = await setup()
    const cookie = await login('admin')
    const qualify = vi.mocked(governance.authorizeProjectModelRead!)
    qualify.mockResolvedValue(false)
    const read = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings`, { headers: { cookie } })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ writable: false, namespaces: [{ writable: false }] })
    const ref = `DSH_PROJECT_${String(project.id)}_RELAY_API_KEY`
    const credentials = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings/credentials?refs=${ref}`, { headers: { cookie } })
    expect(credentials.status).toBe(200)
    expect(await credentials.json()).toMatchObject({ credentials: { [ref]: { writable: false } } })
    const discover = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings/discover`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ actorUserId: 999 }),
    })
    expect(discover.status).toBe(403)
    expect(await discover.json()).toEqual({ error: 'forbidden' })
    expect(qualify).toHaveBeenCalledTimes(3)
    for (const call of qualify.mock.calls) expect(call).toEqual([project.id, admin.id])
  })

  it('restricts non-administrator discovery to public endpoints and withholds upstream diagnostics', async () => {
    const { base, projects, login, governance, member } = await setup()
    const owned = projects.createManaged({ name: 'Member models', ownerUserId: member.id })
    const discover = vi.mocked(governance.discoverProjectModels!)
    const post = async (username: string, projectId: number) => {
      const cookie = await login(username)
      const response = await fetch(`${base}/account/api/projects/${String(projectId)}/model-settings/discover`, {
        method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ baseURL: 'http://169.254.169.254', api: 'openai-completions' }),
      })
      return { status: response.status, body: await response.json() as { error: string } }
    }
    discover.mockRejectedValueOnce(new Error('could not reach http://169.254.169.254/models', { cause: new NonPublicNetworkTargetError('169.254.169.254') }))
    expect(await post('member', owned.id)).toEqual({ status: 400, body: { error: 'model-discovery-target-not-public' } })
    expect(discover).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: owned.id, allowPrivateNetwork: false }))
    const upstream = 'http://10.0.0.5/v1/models answered 403: internal-service-secret'
    discover.mockRejectedValueOnce(new Error(upstream))
    expect(await post('member', owned.id)).toEqual({ status: 400, body: { error: 'model-discovery-failed' } })
    discover.mockRejectedValueOnce(new Error(upstream))
    expect(await post('admin', owned.id)).toEqual({ status: 400, body: { error: upstream } })
    expect(discover).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: owned.id, allowPrivateNetwork: true }))
  })

  it('withholds prepared model and credential data when current reading authority is withdrawn', async () => {
    const { base, project, login, governance } = await setup()
    const cookie = await login('admin')
    vi.mocked(governance.authorizeProjectModelRead!).mockRejectedValue(new CollaborationDeniedError('forbidden'))
    for (const suffix of ['', '/credentials?refs=DSH_PROJECT_1_RELAY_API_KEY', '/discover']) {
      const response = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings${suffix}`, {
        method: suffix === '/discover' ? 'POST' : 'GET',
        headers: { cookie, origin: base, 'content-type': 'application/json' },
        ...(suffix === '/discover' ? { body: '{}' } : {}),
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'forbidden' })
    }
    expect(governance.describeProjectModelSettings).toHaveBeenCalledOnce()
    expect(governance.describeProjectCredentials).toHaveBeenCalledOnce()
    expect(governance.discoverProjectModels).toHaveBeenCalledOnce()
  })

  it('preserves a committed mutation response without applying read publication rules', async () => {
    const { base, project, login, governance } = await setup()
    const cookie = await login('admin')
    vi.mocked(governance.authorizeProjectModelRead!).mockRejectedValue(new CollaborationDeniedError('forbidden'))
    const response = await fetch(`${base}/account/api/projects/${String(project.id)}/model-settings`, {
      method: 'PATCH', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'set', path: ['providers', 'relay', 'displayName'], value: 'Committed' }] }),
    })
    expect(response.status).toBe(200)
    expect(governance.mutateProjectModelSettings).toHaveBeenCalledOnce()
    expect(governance.authorizeProjectModelRead).not.toHaveBeenCalled()
  })

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
