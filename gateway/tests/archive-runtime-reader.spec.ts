/** Personal archive transport carries administrator authority and generation-owned operation leases. @module */
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArchiveRuntimeReader } from '../src/archive-runtime-reader.ts'
import type { UserRow } from '../src/auth.ts'
import type { ProjectDetail } from '../src/projects.ts'
import type { InstanceManager, RuntimeEndpoint } from '../src/instances.ts'
import { RuntimeLeaseUnavailableError } from '../src/instances.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER, type GatewayPrincipalClaims } from '../src/principal.ts'

const runtimeId = '11000000-0000-4000-8000-000000000099' as RuntimeId
const runtime = { kind: 'user' as const, id: 22, runtimeId }
const validPage = { descendants: [{ sessionId: 'root', parentSessionId: null, title: 'Archive' }],
  events: [{ sessionId: 'root', seq: 1, type: 'user/message', time: 1000, data: { content: 'archived' } }], hasMore: false }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } }
  if (errors.length > 0) throw new AggregateError(errors, 'Archive reader fixture cleanup failed')
})
const account = (id: number, role: UserRow['role']): UserRow => ({ id, role, username: `user-${id}`, displayName: `User ${id}`,
  homePath: `/tmp/user-${id}`, status: 'active', mustChangePassword: false, autoReviewEligible: false })

async function fixture(options: { body?: unknown; raw?: string; status?: number; responseLimit?: number; truncated?: boolean } = {}) {
  const keys = generateKeyPairSync('ed25519'), principals = new GatewayPrincipalSigner(keys.privateKey, 'archive', 60_000)
  const received: Array<{ claims: GatewayPrincipalClaims; path: string }> = []
  const server = createServer((req, res) => {
    try {
      const value = req.headers[PRINCIPAL_HEADER]
      if (typeof value !== 'string') throw new Error('Missing Runtime principal')
      received.push({ claims: principals.verify(value), path: req.url! })
      res.writeHead(options.status ?? 200, { 'content-type': 'application/json',
        ...(options.truncated === true ? { 'content-length': '999', connection: 'close' } : {}) })
      res.end(options.raw ?? JSON.stringify('body' in options ? options.body : validPage))
    } catch (error) { res.destroy(error instanceof Error ? error : new Error(String(error))) }
  })
  cleanups.push(async () => {
    if (!server.listening) return
    server.closeAllConnections()
    await new Promise<void>((done, fail) => { server.close(error => { if (error) fail(error); else done() }) })
  })
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => { server.off('error', fail); done() })
  })
  const port = (server.address() as AddressInfo).port
  const owner = account(runtime.id, 'user'), administrator = account(33, 'admin')
  const accounts = new Map([[owner.id, owner], [administrator.id, administrator]])
  const project: ProjectDetail = { id: 44, name: 'Project', path: '/tmp/archive-project', memberCount: 1, origin: 'admin', members: [] }
  const getById = vi.fn(async (id: number): Promise<UserRow | null> => accounts.get(id) ?? null)
  const projectById = vi.fn(async (id: number): Promise<ProjectDetail | null> => id === project.id ? project : null)
  const ensureRunning = vi.fn(async (..._args: Parameters<InstanceManager['ensureRunning']>): Promise<RuntimeEndpoint> => ({ port, generation: 7, runtimeId }))
  const operationRef = vi.fn(async (..._args: Parameters<InstanceManager['operationRef']>): Promise<void> => {})
  const authorizeAdministrator = vi.fn(async (_id: number): Promise<void> => {})
  const read = createArchiveRuntimeReader({ cfg: { readinessTimeoutMs: 5000, upstreamResponseLimitBytes: options.responseLimit ?? 4096 },
    users: { getById }, projects: { getById: projectById }, instances: { ensureRunning, operationRef }, principals, authorizeAdministrator })
  return { read, accounts, owner, administrator, project, received, ensureRunning, operationRef, authorizeAdministrator, port }
}

describe('archive Runtime reader', () => {
  it('binds the administrator, passive start and both lease transitions to the returned generation', async () => {
    const f = await fixture()
    expect(await f.read(runtime, 'root', 3, 200, f.administrator.id)).toEqual(validPage)
    expect(f.ensureRunning).toHaveBeenCalledWith({ ...f.owner, runtimeId }, 'passive', f.administrator.id)
    expect(f.authorizeAdministrator).toHaveBeenCalledWith(f.administrator.id)
    expect(f.received).toMatchObject([{ claims: { purpose: 'archive-read', user: { id: f.administrator.id },
      runtime: { id: runtime.id, generation: 7, runtimeId }, scope: { kind: 'personal' } },
    path: '/api/internal/archive/read?sessionId=root&fromSeq=3&limit=200' }])
    expect(f.operationRef.mock.calls).toEqual([[runtime, 1, 7], [runtime, -1, 7]])
  })

  it('retains the project scope and read-only mode for an internal project reader', async () => {
    const f = await fixture(), target = { kind: 'project' as const, id: f.project.id, runtimeId }
    expect(await f.read(target, 'root', 0, 100, f.administrator.id)).toEqual(validPage)
    expect(f.ensureRunning).toHaveBeenCalledWith({ kind: 'project', id: f.project.id, name: f.project.name, path: f.project.path, runtimeId }, 'passive', f.administrator.id)
    expect(f.received[0]?.claims.scope).toEqual({ kind: 'project', projectId: f.project.id, projectName: f.project.name, mode: 'ro' })
  })

  it('preserves returned titles, child lineage and pagination', async () => {
    const page = { ...validPage, title: 'Archive', descendants: [{ sessionId: 'child', parentSessionId: 'root', title: 'Child' }], hasMore: true }
    const f = await fixture({ body: page })
    expect(await f.read(runtime, 'root', 0, 200, f.administrator.id)).toEqual(page)
  })

  it('retains generation ownership for a legacy endpoint without an explicit Runtime identity', async () => {
    const f = await fixture()
    f.ensureRunning.mockResolvedValueOnce({ port: f.port, generation: 7 })
    expect(await f.read({ kind: 'user', id: runtime.id }, 'root', 0, 200, f.administrator.id)).toEqual(validPage)
    expect(f.received[0]?.claims.runtime.runtimeId).toBeUndefined()
    const target = { kind: 'user', id: runtime.id, runtimeId: undefined }
    expect(f.operationRef.mock.calls).toEqual([[target, 1, 7], [target, -1, 7]])
  })

  it.each(['user', 'project'] as const)('does not start a missing %s owner', async kind => {
    const f = await fixture()
    expect(await f.read({ kind, id: 999, runtimeId }, 'root', 0, 200, f.administrator.id)).toBeUndefined()
    expect(f.ensureRunning).not.toHaveBeenCalled()
    expect(f.operationRef).not.toHaveBeenCalled()
    expect(f.received).toEqual([])
  })

  it('rejects a disappeared administrator before startup', async () => {
    const f = await fixture(); f.accounts.delete(f.administrator.id)
    await expect(f.read(runtime, 'root', 0, 200, f.administrator.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect(f.ensureRunning).not.toHaveBeenCalled()
    expect(f.received).toEqual([])
  })

  it('keeps omitted actors reserved for the trusted internal reader', async () => {
    const f = await fixture()
    expect(await f.read(runtime, 'root', 0, 200)).toEqual(validPage)
    expect(f.ensureRunning).toHaveBeenCalledWith({ ...f.owner, runtimeId }, 'passive', undefined)
    expect(f.authorizeAdministrator).not.toHaveBeenCalled()
    expect(f.received[0]?.claims.user).toMatchObject({ id: 1, username: 'gateway-archive-reader' })
  })

  it('does not borrow a newer generation when operation admission refuses the ready result', async () => {
    const f = await fixture(), refused = new RuntimeLeaseUnavailableError(runtime)
    f.operationRef.mockRejectedValueOnce(refused)
    await expect(f.read(runtime, 'root', 0, 200, f.administrator.id)).rejects.toMatchObject({ cause: refused })
    expect(f.operationRef.mock.calls).toEqual([[runtime, 1, 7]])
    expect(f.received).toEqual([])
  })

  it('preserves an unexpected operation-admission failure without releasing an unacquired lease', async () => {
    const f = await fixture(), failure = new Error('Lease backend unavailable')
    f.operationRef.mockRejectedValueOnce(failure)
    await expect(f.read(runtime, 'root', 0, 200, f.administrator.id)).rejects.toBe(failure)
    expect(f.operationRef.mock.calls).toEqual([[runtime, 1, 7]])
    expect(f.received).toEqual([])
  })

  it('rechecks qualification after lease admission and drains that exact lease on refusal', async () => {
    const f = await fixture(), failure = new Error('Administrator withdrawn')
    f.authorizeAdministrator.mockRejectedValueOnce(failure)
    await expect(f.read(runtime, 'root', 0, 200, f.administrator.id)).rejects.toBe(failure)
    expect(f.operationRef.mock.calls).toEqual([[runtime, 1, 7], [runtime, -1, 7]])
    expect(f.received).toEqual([])
  })

  it('releases the lease when the owning Runtime has no transcript', async () => {
    const f = await fixture({ status: 404 })
    expect(await f.read(runtime, 'root', 0, 200, f.administrator.id)).toBeUndefined()
    expect(f.operationRef.mock.calls).toEqual([[runtime, 1, 7], [runtime, -1, 7]])
  })

  it.each([
    { raw: 'not-json', status: 200, message: 'invalid JSON' },
    { raw: 'not-json', status: 503, message: 'HTTP 503' },
    { raw: 'partial', truncated: true, status: 200, message: 'HTTP 200' },
    { body: { error: 'unavailable' }, status: 503, message: 'HTTP 503' },
    { body: validPage, responseLimit: 16, message: 'response is too large' },
    { body: null, message: 'invalid JSON' },
    { body: [], message: 'invalid JSON' },
    { body: { ...validPage, title: 3 }, message: 'invalid archive page' },
    { body: { ...validPage, descendants: null }, message: 'invalid archive page' },
    { body: { ...validPage, events: null }, message: 'invalid archive page' },
    { body: { ...validPage, hasMore: null }, message: 'invalid archive page' },
    { body: { ...validPage, descendants: [null] }, message: 'invalid descendant' },
    { body: { ...validPage, descendants: [[]] }, message: 'invalid descendant' },
    { body: { ...validPage, descendants: [{ sessionId: '', parentSessionId: null, title: 'Archive' }] }, message: 'invalid descendant' },
    { body: { ...validPage, descendants: [{ sessionId: 'root', parentSessionId: 3, title: 'Archive' }] }, message: 'invalid descendant' },
    { body: { ...validPage, descendants: [{ sessionId: 'root', parentSessionId: null, title: 3 }] }, message: 'invalid descendant' },
    { body: { ...validPage, events: [null] }, message: 'invalid event' },
    { body: { ...validPage, events: [[]] }, message: 'invalid event' },
    ...Object.entries({ sessionId: '', type: '', seq: -1, time: -1 }).map(([key, value]) => ({
      body: { ...validPage, events: [{ ...validPage.events[0], [key]: value }] }, message: 'invalid event',
    })),
  ])('refuses a failed or invalid Runtime response and releases its lease: %j', async options => {
    const f = await fixture(options)
    await expect(f.read(runtime, 'root', 0, 200, f.administrator.id)).rejects.toThrow(options.message)
    expect(f.operationRef.mock.calls).toEqual([[runtime, 1, 7], [runtime, -1, 7]])
  })

  it('reports lease drainage failure after a successful read', async () => {
    const f = await fixture(), failure = new Error('Lease heartbeat unavailable')
    f.operationRef.mockResolvedValueOnce().mockRejectedValueOnce(failure)
    await expect(f.read(runtime, 'root', 0, 200, f.administrator.id)).rejects.toMatchObject({ errors: [failure] })
  })

  it('preserves the read and cleanup failures together', async () => {
    const f = await fixture({ status: 503 }), failure = new Error('Lease heartbeat unavailable')
    f.operationRef.mockResolvedValueOnce().mockRejectedValueOnce(failure)
    const result = await f.read(runtime, 'root', 0, 200, f.administrator.id).then(() => undefined, (error: unknown) => error)
    expect(result).toBeInstanceOf(AggregateError)
    if (!(result instanceof AggregateError)) throw result
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toHaveProperty('message', 'runtime archive reader returned HTTP 503')
    expect(result.errors[1]).toBe(failure)
  })
})
