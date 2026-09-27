/** Profile management carries only explicit administrator operations to a leased generation. */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { GatewayPluginManagement } from '../src/plugin-management.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import type { UserRow } from '../src/auth.ts'
import type { GatewayDeps } from '../src/server.ts'
import { RuntimeLeaseUnavailableError } from '../src/instances.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const admin = { id: 1, role: 'admin', status: 'active', username: 'admin', displayName: 'Admin' } as UserRow
const target = { kind: 'project' as const, id: 7 }
async function fixture() {
  const signer = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, 'org', 30_000)
  let live = true, generation = 4, status = 200, size = 0
  const requests: unknown[] = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const claims = signer.verify(req.headers[PRINCIPAL_HEADER] as string)
      expect(claims).toMatchObject({ purpose: 'plugin-admin', user: { id: 1 }, runtime: { ...target, generation: 4 } })
      expect(body).toMatchObject({ type: 'client-request' })
      if (!req.url?.startsWith('/api/settings.')) expect(body.payload).toEqual({ args: {} })
      requests.push({ path: req.url, body })
      const stream = req.url?.includes('/_stream/') === true
      res.writeHead(status, { 'content-type': stream ? 'application/x-ndjson' : 'application/json' })
      res.end(size > 0 ? 'x'.repeat(size) : JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: [] } }))
    })().catch(error => { res.writeHead(500); res.end(String(error)) })
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const operationRef = vi.fn(async (_target: typeof target, _delta: 1 | -1, _generation?: number) => {})
  const users = { getById: vi.fn(async () => admin) }
  const deps = { users, projects: { getById: async () => ({ name: 'Project' }) },
    instances: { isLive: async () => live, generationOf: async () => generation, operationRef, portOf: async () => (server.address() as AddressInfo).port },
    cfg: { upstreamTimeoutMs: 5000, upstreamResponseLimitBytes: 1024 },
  } as unknown as GatewayDeps
  const manager = new GatewayPluginManagement(deps, signer, 'node-1')
  const request = { target, nodeId: 'node-1', generation: 4, rpcId: randomUUID(), endpoint: 'pluginManager/listBundles', args: {} }
  const invoke = async (input: unknown = request) => {
    const output: Uint8Array[] = []
    for await (const chunk of manager.invoke(admin, input, new AbortController().signal)) output.push(chunk)
    return Buffer.concat(output).toString()
  }
  return { manager, invoke, request, requests, users, operationRef,
    live: (value: boolean) => { live = value }, generation: (value: number) => { generation = value },
    status: (value: number) => { status = value }, size: (value: number) => { size = value } }
}

it('binds current-node state and forwards only a correlated, leased profile method', async () => {
  const f = await fixture()
  expect(await f.manager.target(admin, target)).toEqual({ nodeId: 'node-1', target, generation: 4 })
  expect(JSON.parse(await f.invoke())).toMatchObject({ rpcId: f.request.rpcId, result: { ok: true, value: [] } })
  expect(f.operationRef.mock.calls).toEqual([[target, 1, 4], [target, -1, 4]])
  expect(f.requests).toHaveLength(1)
  await f.invoke({ ...f.request, endpoint: 'pluginManager/installBundleStream' })
  expect(f.requests[1]).toMatchObject({ path: '/api/_stream/pluginManager/installBundleStream' })
})

it('does not start an idle runtime or accept another node or generation', async () => {
  const f = await fixture()
  f.live(false)
  expect(await f.manager.target(admin, target)).toMatchObject({ generation: null })
  await expect(f.invoke()).rejects.toMatchObject({ status: 409 })
  f.live(true); f.generation(5)
  await expect(f.invoke()).rejects.toMatchObject({ status: 409 })
  await expect(f.invoke({ ...f.request, nodeId: 'foreign' })).rejects.toMatchObject({ status: 409 })
  expect(f.requests).toEqual([])
  expect(f.operationRef).not.toHaveBeenCalled()
})

it('rejects stale roles, undeclared endpoints, payload destinations and invalid identities', async () => {
  const f = await fixture()
  f.users.getById.mockResolvedValueOnce({ ...admin, role: 'user' })
  await expect(f.invoke()).rejects.toMatchObject({ status: 403 })
  for (const input of [
    { ...f.request, endpoint: 'terminal/write' }, { ...f.request, url: 'http://outside' },
    { ...f.request, endpoint: 'pluginManager/installBundle' }, { ...f.request, rpcId: 'not-a-uuid' },
  ]) await expect(f.invoke(input)).rejects.toMatchObject({ status: 400 })
  await expect(f.manager.target(admin, { kind: 'user', id: -1 })).rejects.toMatchObject({ status: 400 })
  expect(f.requests).toEqual([])
})

it('bounds response bytes, releases on refusal and never retries an interrupted operation', async () => {
  const f = await fixture()
  f.size(1025)
  await expect(f.invoke()).rejects.toMatchObject({ status: 502, message: 'profile response exceeds its byte budget' })
  f.size(0); f.status(500)
  await expect(f.invoke()).rejects.toMatchObject({ status: 502 })
  expect(f.requests).toHaveLength(2)
  expect(f.operationRef.mock.calls).toEqual([[target, 1, 4], [target, -1, 4], [target, 1, 4], [target, -1, 4]])
})

it('rejects lease acquisition races without releasing a lease it never acquired', async () => {
  const f = await fixture()
  f.operationRef.mockRejectedValueOnce(new RuntimeLeaseUnavailableError(target))
  await expect(f.invoke()).rejects.toMatchObject({ status: 409 })
  f.operationRef.mockRejectedValueOnce(new Error('private storage details'))
  await expect(f.invoke()).rejects.toMatchObject({ status: 503 })
  expect(f.operationRef.mock.calls).toEqual([[target, 1, 4], [target, 1, 4]])
  expect(f.requests).toEqual([])
})

it('forwards configuration payloads directly while keeping the same administrator and generation lease', async () => {
  const f = await fixture()
  const args = { ns: 'shell', expectedRevision: 3, ops: [{ op: 'set', path: ['timeoutMs'], value: 5000 }] }
  await f.invoke({ ...f.request, endpoint: 'settings.describe' })
  await f.invoke({ ...f.request, endpoint: 'settings.mutate', args })
  expect(f.requests).toEqual([
    expect.objectContaining({ path: '/api/settings.describe', body: expect.objectContaining({ payload: {} }) }),
    expect.objectContaining({ path: '/api/settings.mutate', body: expect.objectContaining({ payload: args }) }),
  ])
  expect(f.operationRef.mock.calls).toEqual([[target, 1, 4], [target, -1, 4], [target, 1, 4], [target, -1, 4]])
  await expect(f.invoke({ ...f.request, endpoint: 'settings.replace' })).rejects.toMatchObject({ status: 400 })
  for (const expectedRevision of [undefined, -1, 1.5, '3']) {
    await expect(f.invoke({ ...f.request, endpoint: 'settings.mutate', args: { expectedRevision } })).rejects.toMatchObject({ status: 400 })
  }
})
