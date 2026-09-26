/** Administrative terminal calls preserve runtime identity and expose metadata only. */
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeLeaseUnavailableError } from '../src/instances.ts'
import { GatewayTerminalManagement } from '../src/terminal-management.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import type { UserRow } from '../src/auth.ts'
import type { GatewayDeps } from '../src/server.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const admin = { id: 1, role: 'admin', status: 'active', username: 'admin', displayName: 'Administrator' } as UserRow
const target = { kind: 'project' as const, id: 7 }
const item = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: 'private-session', id: 'terminal-1', creatorUserId: 2, state: 'running' }

async function fixture() {
  const signer = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, 'organization', 30_000)
  let live = true, generation = 4, output: unknown = [item], status = 200, allowed = true
  const requests: Array<{ path: string; args: unknown }> = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      expect(body.type).toBe('client-request')
      const claims = signer.verify(req.headers[PRINCIPAL_HEADER] as string)
      expect(claims).toMatchObject({ user: { id: 1 }, purpose: 'terminal-admin', runtime: { ...target, generation: 4 }, scope: { mode: 'ro' } })
      requests.push({ path: req.url!, args: body.payload.args })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ rpcId: body.rpcId, result: allowed ? { ok: true, value: req.url?.endsWith('adminList') ? output : undefined } : { ok: false, error: { code: 'terminal/forbidden', message: 'private runtime diagnostic' } } }))
    })().catch(error => { res.writeHead(500); res.end(String(error)) })
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const operationRef = vi.fn(async (_target: typeof target, _delta: 1 | -1, _generation?: number) => {})
  const users = { getById: vi.fn(async () => admin) }
  const deps = {
    users, projects: { getById: async () => ({ name: 'Project' }) },
    instances: { isLive: async () => live, generationOf: async () => generation, operationRef,
      portOf: async () => (server.address() as AddressInfo).port },
    cfg: { readinessTimeoutMs: 1000, upstreamResponseLimitBytes: 1_000_000 },
  } as unknown as GatewayDeps
  return { manager: new GatewayTerminalManagement(deps, signer, 'node-1'), users, operationRef, requests,
    live: (value: boolean) => { live = value }, generation: (value: number) => { generation = value },
    output: (value: unknown) => { output = value }, status: (value: number) => { status = value }, allowed: (value: boolean) => { allowed = value } }
}

it('holds the exact generation across inventory and explicit cleanup without forwarding terminal text', async () => {
  const f = await fixture()
  const inventory = await f.manager.list(admin, target)
  expect(inventory).toEqual({ nodeId: 'node-1', target, generation: 4, terminals: [item] })
  await f.manager.close(admin, target, { nodeId: inventory.nodeId, generation: inventory.generation, ownerId: item.ownerId, id: item.id })
  expect(f.requests).toEqual([{ path: '/api/terminal/adminList', args: {} }, { path: '/api/terminal/adminClose', args: { ownerId: item.ownerId, id: item.id } }])
  expect(f.operationRef.mock.calls).toEqual([[target, 1, 4], [target, -1, 4], [target, 1, 4], [target, -1, 4]])
})

it('does not start stopped runtimes and rejects old-node and old-generation actions', async () => {
  const f = await fixture()
  f.live(false)
  expect(await f.manager.list(admin, target)).toEqual({ nodeId: 'node-1', target, generation: null, terminals: [] })
  const close = { nodeId: 'node-1', generation: 4, ownerId: item.ownerId, id: item.id }
  await expect(f.manager.close(admin, target, close)).rejects.toMatchObject({ status: 409 })
  f.live(true); f.generation(5)
  await expect(f.manager.close(admin, target, close)).rejects.toMatchObject({ status: 409 })
  await expect(f.manager.close(admin, target, { ...close, nodeId: 'other' })).rejects.toMatchObject({ status: 409 })
  await expect(f.manager.close(admin, target, { ...close, input: 'command' })).rejects.toMatchObject({ status: 400 })
  expect(f.requests).toEqual([])
})

it('rejects stale administrator roles, malformed inventory and unexpected private fields', async () => {
  const f = await fixture()
  f.users.getById.mockResolvedValueOnce({ ...admin, role: 'user' })
  await expect(f.manager.list(admin, target)).rejects.toMatchObject({ status: 403 })
  expect(f.requests).toEqual([])
  for (const output of [null, [{ ...item, screen: 'private output' }], [{ ...item, ownerId: 'invalid' }]]) {
    f.output(output)
    await expect(f.manager.list(admin, target)).rejects.toMatchObject({ status: 502 })
  }
  f.allowed(false)
  await expect(f.manager.list(admin, target)).rejects.toMatchObject({ status: 403, message: 'terminal management refused' })
  f.status(503)
  await expect(f.manager.list(admin, target)).rejects.toMatchObject({ status: 502 })
  expect(f.operationRef.mock.calls.filter(call => call[1] === 1)).toHaveLength(5)
  expect(f.operationRef.mock.calls.filter(call => call[1] === -1)).toHaveLength(5)
})

it('rejects a lease race before sending the request and does not release an unacquired lease', async () => {
  const f = await fixture()
  f.operationRef.mockRejectedValueOnce(new RuntimeLeaseUnavailableError(target))
  await expect(f.manager.list(admin, target)).rejects.toMatchObject({ status: 409 })
  f.operationRef.mockRejectedValueOnce(new Error('database unavailable'))
  await expect(f.manager.list(admin, target)).rejects.toMatchObject({ status: 503, message: 'terminal runtime lease unavailable' })
  expect(f.requests).toEqual([])
  expect(f.operationRef.mock.calls).toEqual([[target, 1, 4], [target, 1, 4]])
})

it('reports incomplete lease cleanup without exposing storage diagnostics', async () => {
  const f = await fixture()
  f.operationRef.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private storage detail'))
  await expect(f.manager.list(admin, target)).rejects.toMatchObject({ status: 503, message: 'terminal runtime lease cleanup failed' })
  expect(f.requests).toHaveLength(1)
  expect(f.operationRef.mock.calls).toEqual([[target, 1, 4], [target, -1, 4]])
})
