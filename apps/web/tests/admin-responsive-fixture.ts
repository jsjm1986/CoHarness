/** Isolated authenticated Gateway with deterministic organization and computer read models for browser layout coverage. */
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { loadConfig } from '../../../gateway/src/config.ts'
import { openDb } from '../../../gateway/src/db.ts'
import { AuthService } from '../../../gateway/src/auth.ts'
import { UserService } from '../../../gateway/src/users.ts'
import { ProjectService } from '../../../gateway/src/projects.ts'
import { AuditService } from '../../../gateway/src/audit.ts'
import { InstanceManager } from '../../../gateway/src/instances.ts'
import { ModelGovernanceService } from '../../../gateway/src/model-governance.ts'
import { organizationModelSettingsSchema } from '../../../gateway/src/organization-model-settings.ts'
import { createGatewayServer, type GatewayDeps } from '../../../gateway/src/server.ts'
import { createProxyHandlers } from '../../../gateway/src/proxy.ts'
import { createAdminApiHandler } from '../../../gateway/src/admin-api.ts'
import { NodeConfigurationStore } from '../../../gateway/src/node-config-store.ts'
import { isolatedNodeConfigurationAuthority } from '../../../gateway/tests/node-config-fixture.ts'
import { installAdminComputerFixture } from './admin-computer-fixture.ts'
import type { RuntimeCatalogEntry, RuntimeNodeId, RuntimeId } from '../../../gateway/src/runtime-catalog.ts'
import type { DeploymentContext } from '../../../gateway/src/deployment-protocol.ts'
import { NodeServiceError } from '../../../gateway/src/node-service-stream.ts'

const NODE = '10000000-0000-4000-8000-000000000001' as RuntimeNodeId
const REMOTE = '10000000-0000-4000-8000-000000000002' as RuntimeNodeId
const RUNTIME = '33000000-0000-4000-8000-000000000033' as RuntimeId
const ARCHIVE = '22000000-0000-4000-8000-000000000022'
const DOCUMENT = '11111111-1111-4111-8111-111111111111'
const LONG = '移动验收 · LongOrganizationProjectAndComputerIdentifierWithNoBreaks01234567890123456789'
const NOW = Date.UTC(2026, 10, 16, 1)
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  totalTokens: 0, estimatedCostMicros: 0, companyCostMicros: 0, calls: 0, missingUsageCalls: 0 }

/**
 * Start private users/projects with deterministic service reads and production authentication/static routing.
 * @param host - browser-visible authority for an isolated device origin.
 * @returns the private server, read-state controls and owned-resource cleanup.
 */
export async function startAdminResponsiveFixture(host = '127.0.0.1') {
  const state = { mode: 'loaded' as 'loaded' | 'empty' | 'error', failurePath: '', recovery: 'loaded' as 'loaded' | 'idle' | 'error',
    scope: 'local' as 'local' | 'organization' }
  const root = await mkdtemp(join(tmpdir(), 'admin-responsive-'))
  const adminRoot = join(root, 'admin')
  await cp(process.env.DSH_ADMIN_ASSET_ROOT ?? resolve('gateway/public/admin'), adminRoot, { recursive: true })
  const db = openDb(join(root, 'gateway.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECTS_ROOT: join(root, 'projects'),
    HGW_STATE_ROOT: join(root, 'state') })
  await mkdir(cfg.projectsRoot, { recursive: true })
  const governance = new ModelGovernanceService(db)
  const deps: GatewayDeps = { cfg, instances: new InstanceManager(db, cfg), auth: new AuthService(db, cfg),
    users: new UserService(db, cfg), projects: new ProjectService(db, cfg), audit: new AuditService(db), governance }
  installAdminComputerFixture(deps)
  const policy = (): DeploymentContext => ({ mode: state.scope === 'local' ? 'single' : 'multi', revision: '1',
    entry: { nodeId: NODE, name: LONG }, primary: state.scope === 'local' ? null : { nodeId: NODE, name: LONG, origin: 'https://fixture.invalid' },
    scope: state.scope, role: state.scope === 'local' ? 'standalone' : 'primary', refreshAfterMs: 30000, legacyMigrationRequired: false })
  Object.assign(deps.topology!, { read: async () => policy(), adminRead: async () => policy(),
    assertNode: async (nodeId: string) => {
      if (nodeId !== NODE && state.scope === 'local') throw new NodeServiceError(503, 'node-service/unavailable')
    } })
  Object.assign(deps.nodeAccess!, { list: async () => ({ items: [{ nodeId: REMOTE, name: LONG, revision: '1',
    status: 'disconnected', platform: 'linux', architecture: 'arm64', lastSeenAt: null, leaseExpiresAt: null, executionReady: false }], nextCursor: null }) })
  const nodeConfiguration = new NodeConfigurationStore({ organizationId: 'responsive-fixture', nodeId: NODE }, cfg, {}, isolatedNodeConfigurationAuthority)
  await nodeConfiguration.initialize()
  deps.nodeConfiguration = nodeConfiguration
  const admin = await deps.users.create({ username: 'admin', password: 'fixture-password', role: 'admin' })
  await deps.users.changeOwnPassword(admin.id, 'fixture-password')
  const project = await deps.projects.create({ name: LONG, createdBy: admin.id })
  const deployment = { mode: 'serving', maintenanceEpoch: '1', writeEpoch: '1', reason: null,
    enteredAt: null, updatedAt: '2026-11-16', nodes: [], writersQuiesced: false, operations: [], migrations: null }
  const summary = { ...zero, month: '2026-11', tokenLimit: 12345, companyCostMicrosLimit: 8500000, alerts: [] }
  const userRow = { id: admin.id, username: 'admin', displayName: LONG, role: 'admin', status: 'active',
    homePath: join(root, LONG), mustChangePassword: false, autoReviewEligible: true, port: null, instanceState: 'stopped' }
  const runtime: RuntimeCatalogEntry = { id: RUNTIME, owner: { kind: 'personal', id: admin.id, name: LONG },
    node: { id: NODE, name: LONG, status: 'active', lastHeartbeatAt: null }, routing: 'local', observedState: 'stopped', generation: 0 }
  deps.runtimeCatalog = { pageForAccount: async () => ({ items: [runtime], nextCursor: null }),
    pageForAdministrator: async () => ({ items: [runtime], nextCursor: null }), resolveForAccount: async () => runtime }
  deps.computerAccess = { authorize: async () => {},
    page: async () => ({ items: [{ nodeId: NODE, name: LONG, status: 'active', enabled: true, revision: '1' }], nextCursor: null }),
    set: async () => { throw new Error('The responsive fixture does not mutate computer permissions') } }
  const document = { catalogId: DOCUMENT, scope: { kind: 'personal', label: '个人' }, docId: 'fixture-doc', directoryId: 'fixture-directory',
    name: `${LONG}.txt`, bytes: 7, mediaType: 'text/plain', modifiedAt: NOW, owner: { id: admin.id, displayName: LONG },
    ownerSource: 'upload', state: 'active', legacy: false, lineageRootId: null }
  const archive = { archiveId: ARCHIVE, rootSessionId: 'archive-fixture', title: LONG, contentPreview: LONG,
    creator: { id: admin.id, displayName: LONG }, project: null, runtime: { kind: 'user', id: admin.id, runtimeId: RUNTIME },
    workspace: null, state: 'archived', archivedAt: NOW, restoredAt: null, trashedAt: null, purgeAfter: null,
    syncState: 'synced', childCount: 0, messageCount: 1, updatedAt: NOW }
  const desktop = { resourceKey: `${NODE}/desktop`, node: LONG, desktop: LONG, fencingSeq: 1, queueSeq: 0,
    state: 'available', stateNote: null, updatedAt: NOW }
  const model = { provider: 'fixture', model: 'fixture-model', displayName: LONG, enabled: true, adminAllowed: true, userAllowed: true,
    inputMicrosPerMillion: 1234567, outputMicrosPerMillion: 2345678, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 }
  governance.upsertModel(model)
  const fields = { providers: {} }
  Object.assign(governance, {
    describeOrganizationModelSettings: () => ({ writable: false, hasDocument: false,
      namespaces: [{ ns: 'llm-pi-ai', schema: organizationModelSettingsSchema(), value: fields, base: fields, user: fields,
        applies: 'live', secrets: [], revision: 0 }] }),
    describeOrganizationCredentials: () => ({}),
  })
  const endpoint = { id: 'webhook-fixture', publicId: 1, name: LONG, provider: 'github', source: 'organization/repository',
    events: ['issues'], actions: ['opened'], repositories: ['organization/repository'], titleTemplate: LONG,
    promptTemplate: LONG, workspacePath: '/work', agentPreset: 'default', permissionPreset: 'default',
    modelProvider: null, modelId: null, modelMaxTokens: null, executionUserId: admin.id, runtimeKind: 'user',
    runtimePublicId: admin.id, runtimeId: RUNTIME, nodeId: NODE, intakeLimit: 10, intakeWindowMs: 60000,
    replayWindowMs: 60000, maxBodyBytes: 65536, enabled: false, revision: '1', projectVisibility: 'project' }
  const recovery = { operationId: DOCUMENT, state: 'review', revision: '1', sourceNodeId: NODE, targetNodeId: NODE,
    unrestoredDomains: ['authorization:computer-project-model-and-plugin-grants'],
    accounts: [{ userId: ARCHIVE, publicId: admin.id, username: LONG, role: 'admin', sourceStatus: 'active', deleted: false, bootstrap: false, decision: null }],
    nodes: [{ nodeId: NODE, name: LONG, sourceStatus: 'active', decision: null, quarantined: true }], runtimes: [], unreconfiguredItems: [],
    continuation: { accounts: null, nodes: null, runtimes: null, configuration: null } }
  const localRecovery = { ...recovery, localOnly: true, state: 'released', localNodeId: NODE,
    runtimes: [{ id: ARCHIVE, runtimeId: RUNTIME, nodeId: NODE, ownerKind: 'user', ownerPublicId: admin.id, observedState: 'stopped',
      generation: '1', sourceGeneration: '1', executionReviewRequired: true, dataBinding: 'unbound', bindingErrorCode: null }],
    continuation: { runtimes: null } }
  deps.governanceRecovery = { admission: async () => ({ operationId: DOCUMENT, bootstrapUserId: admin.id, state: 'released' }),
    verifyAdministration: async () => {} }
  const data: Record<string, unknown> = {
    '/users': [userRow], [`/users/${admin.id}`]: userRow,
    [`/users/${admin.id}/computers`]: { items: [{ nodeId: NODE, name: LONG, status: 'active', enabled: true, revision: '1' }], nextCursor: null },
    '/deployment': deployment, '/backups': { backups: [] },
    '/peer-backups/recoveries/local-execution': { items: [] },
    '/desktop-environment': { state: 'not-detected', reason: 'no-display' },
    '/documents': { documents: [document] }, [`/documents/${DOCUMENT}`]: { document, history: [], copies: [] },
    '/documents/metrics': { total: 1, active: 1, deleted: 0, personal: 1, project: 0, bytes: 7, operations24h: 0, failures24h: 0 },
    '/archives/records': [archive], [`/archives/records/${ARCHIVE}`]: { record: archive, descendants: [], hasMore: false,
      events: [{ sessionId: 'archive-fixture', seq: 0, type: 'user/message', time: NOW, data: { content: [{ type: 'text', text: LONG }] } }] },
    [`/archives/records/${ARCHIVE}/status`]: archive,
    '/usage': summary, '/usage/overview': { month: '2026-11', timeZone: 'Asia/Shanghai', personal: zero, projects: zero, unattributedProjects: zero,
      users: [{ userId: admin.id, username: LONG, personal: summary, projectContribution: zero }] },
    '/usage/health': { month: '2026-11', timeZone: 'Asia/Shanghai', missingUsageCalls: 0, unattributedProjectCalls: 0,
      unattributedProjectTokens: 0, unpricedCalls: 0, historicalUnknownCalls: 0, maxIntakeLagMs: 0 },
    '/usage/contributors': { month: '2026-11', timeZone: 'Asia/Shanghai', projectId: project.id, rows: [], unattributed: zero },
    '/project-model-access': { projectDefaultAllowed: false, effective: { version: 1, defaultAllowed: false, models: [] }, overrides: [] },
    '/progress/digest-model': { model: null, candidates: [] },
    '/tunnel': { supported: true, binary: null, mode: 'off', desired: 'stopped', state: 'stopped', publicUrl: null,
      hostname: null, domain: null, apiTokenConfigured: false, lastError: null, revision: 0, startedAt: null, updatedAt: '2026-11-16T00:00:00.000Z' },
    '/ssh-targets': { targets: [{ publicId: 1, name: LONG, host: 'example.invalid', node: '/usr/bin/node', helper: '/opt/helper.mjs',
      helperHash: '0'.repeat(64), workspace: '/work', bootstrapPath: null, bootstrapHash: null, passwordRef: 'FIXTURE_PASSWORD',
      requestTimeoutMs: null, maxFrameBytes: null, maxPending: null, leaseMs: null, enabled: false, revision: '1', sharedProjects: [] }] },
    '/steward': { enabled: true, space: { id: project.id, name: LONG, path: `/work/${LONG}`, runtime: 'stopped' },
      members: [{ userId: admin.id, username: 'admin', displayName: LONG, role: 'member', userStatus: 'active', membershipStatus: 'active', grantable: true,
        qualified: false, effective: false, revision: '1' }] },
    '/webhook-endpoints': { endpoints: [endpoint] }, '/webhook-deliveries': { items: [], nextCursor: null },
    '/desktops': { resources: [desktop] }, '/desktops/detail': { resource: desktop, grants: [], queue: [] },
    '/remote-desktop/endpoints': { endpoints: [{ nodeId: NODE, desktop: LONG, host: 'example.invalid', port: 5900 }] },
    '/remote-desktop/grants': { grants: [{ id: 'grant-fixture', target: { nodeId: NODE, desktop: LONG }, principal: 'admin', level: 'view',
      scope: { kind: 'machine' }, recording: false, grantedBy: 'admin', createdAt: NOW }] },
    '/remote-desktop/audit': { events: [{ kind: 'grant', principal: LONG, target: { nodeId: NODE, desktop: LONG }, at: NOW }] },
    '/audit': [{ id: 1, ts: NOW, userId: admin.id, username: 'admin', displayName: LONG, action: 'admin.project.create',
      methodPath: 'POST /admin/api/projects', status: 200, ip: '127.0.0.1', outcome: 'success', metadata: { project: LONG } }],
    '/plugins/overview': [{ target: { kind: 'user', id: admin.id, label: LONG }, entries: 1, disabled: 0, live: false, updatedAt: '2026-11-16T00:00:00.000Z' }],
    '/plugins/inventory': [
      { target: { kind: 'user', id: admin.id, runtimeId: RUNTIME, label: LONG, steward: false },
        live: false, generation: null, reportedAt: '2026-11-16T00:00:00.000Z',
        inventory: { bundles: [{ name: 'fixture-bundle', version: '1.0.0', enabled: true, installed: true, optional: false, removable: true,
          meta: { title: LONG, description: LONG }, source: 'registry',
          rows: [{ rowId: 'fixture-row', moduleName: 'fixture-module', meta: { title: LONG }, entryId: 'fixture-entry' }], overrides: [] }],
        plugins: [{ entryId: 'fixture-entry', moduleName: 'fixture-module', meta: { title: LONG, description: LONG }, enabled: true, fiberPhase: 'running' }] },
        desired: null },
      { target: { kind: 'project', id: project.id, runtimeId: RUNTIME, label: LONG, steward: true },
        live: false, generation: null, reportedAt: null, inventory: null,
        desired: { bundles: ['fixture-bundle'], entries: [{ id: 'fixture-entry', name: 'fixture-module', disabled: false }] } },
    ],
    '/plugins/target': { nodeId: NODE, target: { kind: 'user', id: admin.id, runtimeId: RUNTIME }, generation: null },
    '/plugins/state': { revision: '1', appliedRevision: '1', generation: null, state: { entries: [], bundles: [] }, observed: null },
    '/terminals': { nodeId: NODE, target: { kind: 'user', id: admin.id, runtimeId: RUNTIME }, generation: 1,
      terminals: [{ ownerId: 'owner-fixture', sessionId: LONG, id: LONG, creatorUserId: admin.id, state: 'running' }] },
    [`/users/${admin.id}/runtimes`]: { items: [runtime], nextCursor: null }, '/runtimes': { items: [runtime], nextCursor: null },
  }
  const emptyData: Record<string, unknown> = {
    '/users': [], '/projects': [], '/models': [], '/documents': { documents: [] }, '/archives/records': [],
    '/plugins/overview': [], '/plugins/inventory': [], '/ssh-targets': { targets: [] }, '/steward': { enabled: false, space: null, members: [] },
    '/webhook-endpoints': { endpoints: [] }, '/desktops': { resources: [] }, '/remote-desktop/endpoints': { endpoints: [] },
    '/remote-desktop/grants': { grants: [] }, '/remote-desktop/audit': { events: [] }, '/audit': [],
    '/terminals': { ...(data['/terminals'] as object), terminals: [] },
    '/usage/overview': { month: '2026-11', timeZone: 'Asia/Shanghai', personal: zero, projects: zero, unattributedProjects: zero, users: [] },
  }
  const handler = createAdminApiHandler(deps)
  const proxy = createProxyHandlers(deps)
  const server = createGatewayServer(deps, {
    ...proxy, adminRoot,
    peerBackups: { admin: async (req, res) => {
      if (req.method !== 'GET' || req.url !== '/admin/api/peer-backups/recoveries/local-execution') return false
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"items":[]}'); return true
    }, internal: async () => false },
    governanceRecovery: { admin: async (req, res) => {
      res.writeHead(state.recovery === 'error' ? 403 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(state.recovery === 'error' ? { error: 'forbidden' }
        : req.url?.startsWith('/admin/api/governance-recovery/local')
          ? state.recovery === 'idle' ? { ...localRecovery, runtimes: [] } : localRecovery
          : state.recovery === 'idle' ? null : recovery))
      return true
    } },
    admin: async (req, res, user, path, body) => {
      const suffix = path.replace(/^\/admin\/api/, '')
      if (req.method === 'GET' && state.mode === 'error' && suffix === state.failurePath) {
        res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unavailable' })); return true
      }
      let value = req.method === 'GET' ? (state.mode === 'empty' && suffix in emptyData ? emptyData[suffix] : data[suffix]) : undefined
      if (req.method === 'GET' && /\/(?:desktops|terminals|ssh|plugins|memory|steward)\/permissions$/.test(suffix)) {
        const query = new URL(req.url!, 'http://fixture').searchParams
        value = { kind: query.get('kind') ?? 'user', id: Number(query.get('id') ?? admin.id), enabled: true, revision: '1' }
      }
      if (value !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json', ...(suffix === '/audit' ? { 'x-total-count': state.mode === 'empty' ? '0' : '1' } : {}) })
        res.end(JSON.stringify(value)); return true
      }
      return handler(req, res, user, path, body)
    },
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const base = `http://${host}:${(server.address() as AddressInfo).port}`
  cfg.publicOrigins.push(base)
  return { base, state, adminId: admin.id, projectId: project.id, nodeId: NODE, remoteNodeId: REMOTE,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((done, reject) => server.close((error) => { if (error) reject(error); else done() }))
      proxy.close(); db.close(); await rm(root, { recursive: true, force: true })
    } }
}
