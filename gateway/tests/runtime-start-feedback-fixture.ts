/** Gateway services and controlled process observations for the startup browser transcript. */
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthService } from '../src/auth.ts'
import { AuditService } from '../src/audit.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { ProjectService } from '../src/projects.ts'
import { createProxyHandlers } from '../src/proxy.ts'
import { RuntimeCapacityError } from '../src/runtime-capacity.ts'
import { RuntimeCatalogError, type RuntimeCatalogEntry, type RuntimeId, type RuntimeNodeId } from '../src/runtime-catalog.ts'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from '../src/runtime-router.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'
import { testConfig } from './test-config.ts'

/** Browser fixture metadata uses serialized IDs; Gateway authority retains its branded IDs. */
export interface RuntimeStartFeedbackFixture {
  origin: string
  personalRuntimeId: string
  selectedRuntimeId: string
  ownerId: number
  projectId: number
  startCalls(): ReadonlyArray<{ id: number; runtimeId: string | undefined; intent: string | undefined }>
  close(): Promise<void>
}

/**
 * Assemble real Gateway authentication, routing, project lookup and gate pages with refused physical startup.
 * @param kind - personal or shared target opened by the browser.
 * @returns isolated metadata and a disposer that joins every owned service.
 */
export async function runtimeStartFeedbackFixture(kind: 'personal' | 'project'): Promise<RuntimeStartFeedbackFixture> {
  const root = await mkdtemp(join(tmpdir(), 'runtime-start-feedback-'))
  const cleanup: Array<() => unknown> = [() => rm(root, { recursive: true, force: true })]
  const close = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const release of cleanup.splice(0).reverse()) {
      try { await release() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Runtime startup Gateway fixture cleanup failed')
  }
  try {
    const db = openDb(join(root, 'gateway.sqlite'))
    cleanup.push(() => db.close())
    const cfg = testConfig(root)
    const deps: GatewayDeps = { cfg, auth: new AuthService(db, cfg), users: new UserService(db, cfg),
      projects: new ProjectService(db, cfg), audit: new AuditService(db), instances: new InstanceManager(db, cfg) }
    cleanup.push(() => deps.instances.stopAll())
    const admin = await deps.users.create({ username: 'admin', password: 'fixture-password', role: 'admin' })
    await deps.users.changeOwnPassword(admin.id, 'fixture-password')
    const project = await deps.projects.create({ name: 'Shared', createdBy: admin.id })
    deps.collaboration = {
      projectForUser: async (id, actorId) => {
        const row = await deps.projects.getById(id)
        const actor = await deps.users.getById(actorId)
        return row === null || actor?.role !== 'admin' ? null : { projectId: row.id, name: row.name, path: row.path,
          mode: 'rw', administrator: true, canManage: true, uiThemePolicy: 'follow-user' }
      },
      projectsForUser: async () => [], listConversations: () => [], readableSessionIds: () => [],
      claimInteraction: () => false, listActivity: async () => ({ items: [] }),
      access: () => { throw new Error('Startup fixture does not read conversations') },
      setVisibility: () => { throw new Error('Startup fixture does not change conversation visibility') },
    }
    const personal: RuntimeCatalogEntry = { id: '00000000-0000-4000-8000-000000000091' as RuntimeId,
      owner: { kind: 'personal', id: admin.id, name: 'admin' },
      node: { id: '00000000-0000-4000-8000-000000000081' as RuntimeNodeId,
        name: 'Local', status: 'active', lastHeartbeatAt: null },
      routing: 'local', observedState: 'stopped', generation: 1 }
    const shared: RuntimeCatalogEntry = { ...personal, id: '00000000-0000-4000-8000-000000000092' as RuntimeId,
      owner: { kind: 'project', id: project.id, name: project.name } }
    const entries = [personal, shared]
    deps.runtimeCatalog = {
      resolveForAccount: async (_actor, id) => {
        const entry = entries.find(candidate => candidate.id === id)
        if (entry === undefined) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
        return entry
      },
      pageForAccount: async () => ({ items: entries, nextCursor: null }),
      pageForAdministrator: async () => ({ items: entries, nextCursor: null }),
    }
    deps.runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter({ collaboration: deps.collaboration }), {
      localNodeId: personal.node.id, catalog: { resolveForAccount: deps.runtimeCatalog.resolveForAccount, resolveForLanding: async () => personal,
        resolveForOwner: async (_actor, owner) => {
          const entry = entries.find(candidate => candidate.owner.kind === owner.kind && candidate.owner.id === owner.id)
          if (entry === undefined) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
          return entry
        } },
    })
    deps.instances.liveEndpoint = async () => null
    deps.instances.stopReasonOf = async () => 'manual'
    const calls: Array<{ id: number; runtimeId: string | undefined; intent: string | undefined }> = []
    deps.instances.ensureRunning = async (subject, intent) => {
      calls.push({ id: subject.id, runtimeId: subject.runtimeId === undefined ? undefined : String(subject.runtimeId), intent })
      throw new RuntimeCapacityError('timeout')
    }
    const proxy = createProxyHandlers(deps)
    cleanup.push(() => { proxy.close() })
    const server = createGatewayServer(deps, proxy)
    cleanup.push(() => new Promise<void>((done, reject) => {
      server.closeAllConnections()
      server.close((error) => { if (error) reject(error); else done() })
    }))
    await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    cfg.publicOrigins.push(origin)
    return { origin, personalRuntimeId: String(personal.id), selectedRuntimeId: String(kind === 'personal' ? personal.id : shared.id),
      ownerId: kind === 'personal' ? admin.id : project.id, projectId: project.id, startCalls: () => calls, close }
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Runtime startup fixture construction and cleanup failed') }
    throw error
  }
}
