/** Existing Admin authorization and instance controls with exact Runtime and computer addressing. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { UserRow } from './auth.ts'
import type { RuntimeSubject, RuntimeTarget } from './instances.ts'
import type { GatewayDeps } from './server.ts'
import { RuntimeManagementError } from './runtime-management.ts'

const controls = /^\/admin\/api\/runtimes\/([^/]+)\/(start|stop|restart|retire)$/u
const personal = /^\/admin\/api\/users\/([1-9][0-9]*)\/runtimes$/u
const policy = /^\/admin\/api\/(?:users\/([1-9][0-9]*)\/)?runtime-allocation-policy$/u
const receipt = /^\/admin\/api\/runtime-allocations\/([^/]+)$/u
const detail = /^\/admin\/api\/runtimes\/([^/]+)$/u
const generation = z.object({ generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()

/**
 * Identify center-owned metadata requests before selecting a remote Gateway.
 * @param pathname - decoded HTTP path without query fields.
 * @param method - HTTP request method.
 * @returns whether handling requires only the shared control plane.
 */
export function isCentralRuntimeManagementRequest(pathname: string, method: string): boolean {
  return policy.test(pathname) || receipt.test(pathname) || detail.test(pathname) || method === 'GET' && personal.test(pathname)
}

function body(value: string): unknown {
  try { return JSON.parse(value) as unknown }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new RuntimeManagementError(400, 'runtime-management/invalid-request') }
}

function userId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new RuntimeManagementError(400, 'runtime-management/invalid-request')
  return id
}

/**
 * Handle Admin allocation, policy and process operations through existing services.
 * @param deps - shared metadata and node-owned instance/file providers.
 * @param req - authenticated, origin-checked Admin request.
 * @param res - uncached JSON response.
 * @param actor - administrator candidate; services retain current authority through each mutation.
 * @param pathname - path without query fields.
 * @param input - bounded request body already read by the Gateway.
 * @returns true after handling a management route; unrelated Admin APIs retain their existing handlers.
 */
export async function runtimeManagementApi(deps: Pick<GatewayDeps, 'runtimeManagement' | 'runtimeCatalog' | 'nodeServiceIdentity'
  | 'instances' | 'users' | 'projects' | 'audit'>, req: IncomingMessage, res: ServerResponse, actor: UserRow, pathname: string, input: string): Promise<boolean> {
  const selectedPolicy = policy.exec(pathname), selectedReceipt = receipt.exec(pathname), selectedOwner = personal.exec(pathname)
  const selectedControl = controls.exec(pathname), selectedDetail = detail.exec(pathname)
  if (selectedPolicy === null && selectedReceipt === null && selectedOwner === null && selectedControl === null && selectedDetail === null) return false
  const service = deps.runtimeManagement, method = req.method ?? 'GET'
  res.setHeader('cache-control', 'no-store')
  if (actor.role !== 'admin') throw new RuntimeManagementError(403, 'runtime-management/forbidden')
  if (service === undefined) throw new RuntimeManagementError(503, 'runtime-management/unavailable')
  const send = (status: number, value: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value))
  }
  if (selectedPolicy !== null) {
    if (method === 'GET') send(200, await service.policy(actor, userId(selectedPolicy[1])))
    else if (method === 'PUT') send(200, await service.setPolicy(actor, body(input), userId(selectedPolicy[1])))
    else { res.setHeader('allow', 'GET, PUT'); send(405, { error: 'method-not-allowed' }) }
    return true
  }
  if (selectedReceipt !== null) {
    if (method === 'GET') send(200, await service.allocationReceipt(actor, selectedReceipt[1]!))
    else { res.setHeader('allow', 'GET'); send(405, { error: 'method-not-allowed' }) }
    return true
  }
  if (selectedOwner !== null) {
    const owner = userId(selectedOwner[1])!
    if (method === 'GET') {
      if (deps.runtimeCatalog?.pageForAdministratorOwner === undefined) throw new RuntimeManagementError(503, 'runtime-management/unavailable')
      if (await deps.users.getById(owner) === null) throw new RuntimeManagementError(404, 'runtime-management/not-found')
      const query = new URL(req.url ?? pathname, 'http://gateway').searchParams
      send(200, await deps.runtimeCatalog.pageForAdministratorOwner(actor, { kind: 'personal', id: owner }, {
        ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}), ...(query.has('limit') ? { limit: query.get('limit')! } : {}),
      }))
    } else if (method === 'POST') {
      const result = await service.allocate(actor, owner, body(input))
      res.setHeader('location', `/admin/api/runtimes/${result.runtimeId}`)
      send(201, result)
    } else { res.setHeader('allow', 'GET, POST'); send(405, { error: 'method-not-allowed' }) }
    return true
  }
  if (deps.runtimeCatalog?.resolveForAdministrator === undefined) throw new RuntimeManagementError(503, 'runtime-management/unavailable')
  const environment = await deps.runtimeCatalog.resolveForAdministrator(actor, (selectedControl ?? selectedDetail)![1]!)
  if (selectedDetail !== null) {
    if (method === 'GET') send(200, environment)
    else { res.setHeader('allow', 'GET'); send(405, { error: 'method-not-allowed' }) }
    return true
  }
  if (method !== 'POST') { res.setHeader('allow', 'POST'); send(405, { error: 'method-not-allowed' }); return true }
  if (environment.node.id !== deps.nodeServiceIdentity?.nodeId) throw new RuntimeManagementError(503, 'runtime-management/unavailable')
  const target: RuntimeTarget = { kind: environment.owner.kind === 'personal' ? 'user' : 'project', id: environment.owner.id, runtimeId: environment.id }
  const action = selectedControl![2]!
  const record = (generation: number) => deps.audit.write({ userId: actor.id, action: `admin.instances.${action}`,
    detail: JSON.stringify({ target, runtimeId: environment.id, nodeId: environment.node.id, generation }),
    methodPath: `${method} ${pathname}`, status: 200, ip: req.socket.remoteAddress ?? '' })
  if (action !== 'start') {
    const parsed = generation.safeParse(body(input))
    if (!parsed.success || action === 'retire' && target.kind !== 'user') throw new RuntimeManagementError(400, 'runtime-management/invalid-request')
    await deps.instances.withStopped(target, async lease => {
      if (action === 'retire') {
        if (lease === undefined) throw new RuntimeManagementError(503, 'runtime-management/unavailable')
        await service.retire(actor, target.id, lease)
      }
    }, actor.id, parsed.data.generation, action === 'retire' ? 'destructive' : 'control')
    if (action === 'retire') { send(200, { runtimeId: target.runtimeId, nodeId: environment.node.id, retired: true, dataRetained: true }); return true }
    if (action === 'stop') {
      await record(parsed.data.generation)
      send(200, { runtimeId: target.runtimeId, nodeId: environment.node.id, generation: parsed.data.generation, observedState: 'stopped' }); return true
    }
  } else if (!z.object({}).strict().safeParse(body(input)).success) throw new RuntimeManagementError(400, 'runtime-management/invalid-request')
  let subject: RuntimeSubject
  if (target.kind === 'user') {
    const owner = await deps.users.getById(target.id)
    if (owner === null) throw new RuntimeManagementError(404, 'runtime-management/not-found')
    subject = { ...owner, runtimeId: target.runtimeId }
  } else {
    const owner = await deps.projects.getById(target.id)
    if (owner === null) throw new RuntimeManagementError(404, 'runtime-management/not-found')
    subject = { kind: 'project', id: owner.id, name: owner.name, path: owner.path, runtimeId: target.runtimeId, steward: owner.kind === 'steward' }
  }
  const running = await deps.instances.ensureRunning(subject, 'explicit', actor.id)
  await record(running.generation)
  send(200, { runtimeId: target.runtimeId, nodeId: environment.node.id, generation: running.generation, observedState: 'ready' })
  return true
}
