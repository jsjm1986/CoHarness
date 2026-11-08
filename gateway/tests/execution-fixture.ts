/** Real PostgreSQL actors and private HTTP API shared by execution integration tests. @module */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'pg'
import type { UserRow } from '../src/auth.ts'
import { PostgresAccessMonitor, scopeAccessMonitor } from '../src/access-invalidation.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { PostgresConversationStore } from '../src/postgres/conversation-repository.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresSshTargetService } from '../src/postgres/ssh-target-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { createRuntimeApiHandler } from '../src/runtime-api.ts'
import { DesktopCoordinator } from '../src/desktop-coordinator.ts'
import { PostgresDesktopCoordinatorRepository } from '../src/postgres/desktop-coordinator-repository.ts'
import type { ExecutionIdentityState } from '../src/execution-identity.ts'
import { NodeResourceBudget, type NodeResourceBudgetConfig } from '../src/node-resource-budget.ts'
import { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'
import { createDocumentCatalogHandlers } from '../src/document-catalog.ts'
import { enableFixtureTopology } from './fixtures/topology-fixture.mjs'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
type Actor = UserRow & { uuid: string }
interface Runtime { kind: 'user' | 'project'; id: number; uuid: string; generation: number; token: string; runtimeId: import('../src/runtime-catalog.ts').RuntimeId }
/** An HTTP-accepted input whose actors remain independent of their current permissions. */
export interface Receipt { inputId: string; actors: Array<{ userId: number }>; primaryActorUserId: number }

/**
 * Start an organization-owned Gateway fixture on an ephemeral loopback port.
 * @param pool - a migrated disposable PostgreSQL database, owned by the caller
 * @param options - liveness timing, resource admission and a same-database catalog observation lane
 * @returns real accounts, runtime credentials, HTTP helpers, and their awaited disposer
 */
export async function createExecutionFixture(pool: Pool, options: {
  executionWatchHeartbeatMs?: number
  executionWatchAuthorizationTimeoutMs?: number
  /** Enable multi-computer topology and establish a control lease before starting managed fixture Runtimes. */
  nodeConnection?: { id: string; epoch: number }
  resourceBudget?: NodeResourceBudgetConfig
  /** Same disposable database, with a named connection lane for catalog lock observations. */
  documentCatalogPool?: Pool
} = {}) {
  const cleanup: Array<() => Promise<unknown> | void> = []
  const slug = randomUUID()
  const organizationId = (await pool.query<{ id: string }>(
    "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Execution tests') RETURNING id", [slug],
  )).rows[0]!.id
  const nodeName = randomUUID()
  await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, nodeName])
  const context = await resolvePostgresRuntimeContext(pool, slug, nodeName)
  if (options.nodeConnection !== undefined) {
    await enableFixtureTopology(context)
    await pool.query(`INSERT INTO harness.node_agents
      (organization_id,node_id,credential_hash,connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')`,
    [organizationId, context.nodeId, createHash('sha256').update(randomUUID()).digest(), options.nodeConnection.id, options.nodeConnection.epoch])
  }
  const actor = async (name: string, role: 'admin' | 'user', auto = false): Promise<Actor> => {
    const row = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path,auto_review_eligible)
      VALUES($1,$2::text,$2::text,$3,$4) RETURNING id,public_id`, [organizationId, name, `/tmp/${slug}/${name}`, auto])).rows[0]!
    await pool.query('INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
      [organizationId, row.id, role === 'admin' ? 'admin' : 'member'])
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',
      [organizationId, context.nodeId, row.id])
    await pool.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture',false)", [row.id])
    return { uuid: row.id, id: Number(row.public_id), username: name, displayName: name,
      homePath: `/tmp/${slug}/${name}`, role, status: 'active', mustChangePassword: false, autoReviewEligible: auto }
  }
  const admin = await actor('alice', 'admin', true)
  const member = await actor('bob', 'user')
  const peer = await actor('carol', 'admin', true)
  const projectRows = []
  for (const name of ['first', 'other']) {
    const row = (await pool.query<{ id: string; public_id: string }>(
      'INSERT INTO harness.projects(organization_id,name,created_by) VALUES($1,$2,$3) RETURNING id,public_id',
      [organizationId, name, admin.uuid],
    )).rows[0]!
    await pool.query(`INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path)
      VALUES($1,$2,$3,$4,$4)`, [organizationId, row.id, context.nodeId, `/tmp/${slug}/${name}`])
    for (const person of [admin, member, peer]) await pool.query(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
      VALUES($1,$2,$3,'rw')`, [organizationId, row.id, person.uuid])
    projectRows.push(row)
  }
  const instances = new PostgresInstanceRepository(context, 48_000)
  await instances.initialize()
  const start = async (kind: Runtime['kind'], id: number, uuid: string): Promise<Runtime> => {
    const token = randomUUID()
    const generation = await instances.beginStart({ kind, id }, Date.now(), createHash('sha256').update(token).digest())
    await instances.markReady({ kind, id }, generation)
    const target = await instances.resolveTarget({ kind, id })
    return { kind, id, uuid, token, generation, runtimeId: target.runtimeId! }
  }
  const project = await start('project', Number(projectRows[0]!.public_id), projectRows[0]!.id)
  const other = await start('project', Number(projectRows[1]!.public_id), projectRows[1]!.id)
  const personal = await start('user', admin.id, admin.uuid)
  const peerPersonal = await start('user', peer.id, peer.uuid)
  const key = generateKeyPairSync('ed25519')
  const principals = new GatewayPrincipalSigner(key.privateKey, slug, 60_000)
  const conversationStore = new PostgresConversationStore(pool)
  const conversations = conversationStore.forRuntime({ organizationId, runtimeId: project.runtimeId })
  const accessMonitor = new PostgresAccessMonitor(context, 60_000)
  await accessMonitor.synchronize()
  const desktops = new DesktopCoordinator(new PostgresDesktopCoordinatorRepository(context), instances)
  await desktops.initialize()
  const resourceBudget = options.resourceBudget === undefined ? undefined
    : new NodeResourceBudget(pool, organizationId, context.nodeId, options.resourceBudget)
  await resourceBudget?.configure()
  const documents = createDocumentCatalogHandlers(new PostgresDocumentCatalogService({ ...context, pool: options.documentCatalogPool ?? pool }))
  const handler = createRuntimeApiHandler({ context, instances, conversations: conversationStore, principals,
    accessMonitor: scopeAccessMonitor(accessMonitor, context.nodeId as RuntimeNodeId), desktops,
    documentCatalogOverview: documents.overview, documentCatalogHistory: documents.history,
    documentCatalogAuthorize: documents.authorize, documentCatalogSync: documents.sync, documentCatalogPurge: documents.purge,
    resourceBudget,
    executionWatchHeartbeatMs: options.executionWatchHeartbeatMs ?? 60_000,
    executionWatchAuthorizationTimeoutMs: options.executionWatchAuthorizationTimeoutMs,
    sshTargets: new PostgresSshTargetService(context),
    collaboration: new PostgresCollaborationService(context), governance: { resolveOrganizationCredential: async () => null } })
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      if (!await handler(req, res, new URL(req.url ?? '/', 'http://runtime').pathname, Buffer.concat(chunks).toString('utf8'))) {
        res.writeHead(404); res.end()
      }
    })().catch((error: unknown) => { res.writeHead(500); res.end(String(error)) })
  })
  await new Promise<void>(ready => { server.listen(0, '127.0.0.1', ready) })
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((closed, reject) => { server.close(error => { if (error) reject(error); else closed() }) })
    await accessMonitor.close()
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = (runtime: Runtime, person?: Actor): Record<string, string> => ({
    authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json',
    ...person === undefined ? {} : { [PRINCIPAL_HEADER]: principals.issue({
      user: person, runtime: { kind: runtime.kind, id: runtime.id, generation: runtime.generation, runtimeId: runtime.runtimeId },
      scope: runtime.kind === 'user' ? { kind: 'personal' } : { kind: 'project', projectId: runtime.id, projectName: 'Project', mode: 'rw' },
    }) },
  })
  const call = async <T = Record<string, unknown>>(action: string, body: unknown, person?: Actor, runtime = project): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${base}${action.startsWith('/') ? action : `/internal/runtime/execution/${action}`}`, {
      method: 'POST', headers: headers(runtime, person), body: JSON.stringify(body),
    })
    const text = await response.text()
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: response.status, body: parsed as T }
  }
  const session = async (runtime = project, parentSessionId?: string, isSeeded = false): Promise<string> => {
    const id = randomUUID()
    if (runtime.kind === 'project') await conversationStore.forRuntime({ organizationId, runtimeId: runtime.runtimeId }).create({ id, organizationId, runtimeId: runtime.runtimeId, projectId: runtime.uuid,
      creatorUserId: admin.uuid, sessionFormatVersion: 3, createdAt: Date.now(), visibility: 'project',
      ...(parentSessionId === undefined ? {} : { parentSessionId }), ...(isSeeded ? { seedLength: 0 } : {}) })
    assert.equal((await call('register-session', { sessionId: id, parentSessionId, isSeeded }, undefined, runtime)).status, 200)
    return id
  }
  const admit = async (sessionId: string, person = admin, runtime = project, messageId: string = randomUUID()): Promise<Receipt & { messageId: string; contentHash: string }> => {
    const contentHash = hash(messageId)
    const result = await call<Receipt>('input', { sessionId, messageId, contentHash, kind: 'message' }, person, runtime)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    return { ...result.body, messageId, contentHash }
  }
  const enter = (sessionId: string, input: Receipt & { messageId: string; contentHash: string }, runtime = project, unverifiedHistory?: boolean) =>
    call<ExecutionIdentityState>('enter', { sessionId, inputId: input.inputId, messageId: input.messageId, contentHash: input.contentHash, unverifiedHistory }, undefined, runtime)
  const dispose = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const action of cleanup.reverse()) {
      try { await action() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'execution fixture cleanup failed')
  }
  return { base, context, project, other, personal, peerPersonal, admin, member, peer, principals, headers, dispose,
    publicKey: key.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    conversations, accessMonitor, desktops, instances, resourceBudget, call, session, admit, enter, organizationId }
}
