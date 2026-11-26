/** Real resource HTTP streams retain exact authority without entering execution admission. */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import type { AccessInvalidationSubject, GatewayAccessMonitor } from '../src/access-invalidation.ts'
import type { UserRow } from '../src/auth.ts'
import type { InstanceManager, RuntimeInstanceSnapshot } from '../src/instances.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import type { RuntimeAssetAdmission, RuntimeAssetRequest } from '../src/runtime-asset-admission.ts'
import { RuntimeAssets, type RuntimeAssetsOptions } from '../src/runtime-assets.ts'
import * as httpCompression from '../src/http-compression.ts'
import { RELEASE_COMBO_DIGEST_HEADER } from '../src/node-service-stream.ts'
import type { RuntimeId, RuntimeNodeId } from '../src/runtime-catalog.ts'
import { barrier } from './barrier.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const dispose of cleanups.splice(0).reverse()) { try { await dispose() } catch (error) { failures.push(error) } }
  if (failures.length > 0) throw new AggregateError(failures, 'Runtime resource HTTP cleanup failed')
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve())
  }))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

async function fixture(options: { streaming?: boolean; remote?: boolean; releaseCombo?: RuntimeAssetsOptions['releaseCombo']; entryNodeId?: RuntimeNodeId } = {}) {
  const runtimeId = randomUUID() as RuntimeId, nodeId = randomUUID() as RuntimeNodeId
  const actor: UserRow = { id: 7, username: 'fixture', displayName: 'Fixture', role: 'user', status: 'active',
    homePath: '/fixture', mustChangePassword: false, autoReviewEligible: false }
  const signer = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, 'fixture', 30_000)
  const entered = barrier(), streamRelease = barrier(), referenceReleased = barrier()
  const observed: Array<{ path: string; headers: Record<string, unknown> }> = []
  let runtimeGeneration = 7
  const runtime = createServer((req, res) => {
    const assertion = req.headers[PRINCIPAL_HEADER]
    try {
      if (typeof assertion !== 'string') throw new Error('principal required')
      const claims = signer.verify(assertion)
      if (claims.runtime.generation !== runtimeGeneration || claims.runtime.runtimeId !== runtimeId
        || claims.purpose !== 'runtime-asset' || claims.asset === undefined || claims.asset.method !== req.method || claims.asset.path !== req.url) throw new Error('foreign resource request')
    } catch { res.writeHead(401, { 'cache-control': 'no-store' }).end(); return }
    observed.push({ path: req.url!, headers: { ...req.headers } })
    res.setHeader('content-type', 'text/javascript')
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.setHeader('etag', '"fixture-revision"')
    res.setHeader('set-cookie', 'runtime-must-not-set-cookie=1')
    res.setHeader('x-dsh-runtime-id', 'runtime-must-not-set-identity')
    res.setHeader('connection', 'keep-alive, x-private-hop')
    res.setHeader('x-private-hop', 'runtime-only')
    if (req.headers['if-none-match'] === '"fixture-revision"') { res.writeHead(304).end(); return }
    if (options.streaming) {
      res.write('authorized-prefix'); entered.resolve()
      void streamRelease.promise.then(() => { if (!res.destroyed) res.end('authorized-suffix') })
    } else res.end('export const fixture = true')
  })
  const runtimeOrigin = await listen(runtime)
  const admission: RuntimeAssetAdmission = {
    user: actor, scope: { kind: 'personal' }, accessRevision: '4', expiresAt: Date.now() + 60_000,
    placement: { local: !options.remote, resetScope: false, target: 'personal', environment: {
      id: runtimeId, owner: { kind: 'personal', id: actor.id, name: 'Fixture' },
      node: { id: nodeId, name: 'Fixture computer', status: 'active', lastHeartbeatAt: null }, routing: 'local', observedState: 'ready', generation: 7,
    } },
    snapshot: { target: { kind: 'user', id: actor.id, runtimeId }, state: 'ready', generation: 7,
      port: Number(new URL(runtimeOrigin).port), launchStamp: 'fixture-stamp', startedAt: Date.now() },
  }
  const subscribers = new Set<(subject: AccessInvalidationSubject) => void | Promise<void>>()
  const monitor: GatewayAccessMonitor = { available: true, synchronize: vi.fn(async () => {}), synchronizeTo: vi.fn(async revision => revision === 4n),
    subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener) } } }
  let retained = true, references = 0
  const retain: Pick<InstanceManager, 'retainAsset'> = {
    async retainAsset<T extends { snapshot: RuntimeInstanceSnapshot }>(_runtimeId: RuntimeId, qualify: () => Promise<T>) {
      if (!retained || options.remote) return null
      const current = await qualify()
      references += 1
      let released = false
      return { admission: current, release() {
        if (released) return
        released = true; references -= 1; referenceReleased.resolve()
      } }
    },
  }
  const admit = vi.fn(async (_request: RuntimeAssetRequest) => admission)
  const forward = vi.fn<NonNullable<RuntimeAssetsOptions['forward']>>(async (_req, res) => { res.end('remote-resource'); return true })
  const cfg = { publicOrigins: [] as string[], upstreamTimeoutMs: 10_000 }
  const assets = new RuntimeAssets({ cfg, localNodeId: options.remote ? randomUUID() as RuntimeNodeId : nodeId,
    admission: { admit }, instances: retain, monitor, signer, releaseCombo: options.releaseCombo, ...(options.remote ? { forward } : {}) })
  cleanups.push(() => assets.close())
  const dispatches: Promise<unknown>[] = []
  const server = createServer((req, res) => {
    const work = assets.handle(req, res, actor, options.entryNodeId).then(handled => {
      if (!handled) res.writeHead(404).end('ordinary-route')
    }, () => { if (!res.headersSent) res.writeHead(500).end(); else res.destroy() })
    dispatches.push(work)
  })
  const origin = await listen(server)
  cleanups.push(async () => { streamRelease.resolve(); await assets.close(); await Promise.all(dispatches) })
  cfg.publicOrigins.push(origin)
  const resource = '/plugins/combo.js??fixture/client.js&rev=012345abcdef'
  const path = resource + '&dshRuntime=' + runtimeId
  const headers = { cookie: 'hgw_session=fixture-session', authorization: 'Bearer must-not-reach-runtime', [PRINCIPAL_HEADER]: 'forged' }
  return { origin, resource, path, headers, actor, admission, admit, monitor, assets, observed, forward, entered, streamRelease, referenceReleased,
    references: () => references, subscribers: () => subscribers.size, untrack: () => { retained = false },
    replaceGeneration: () => { runtimeGeneration += 1 },
    invalidate: async (subject: AccessInvalidationSubject) => { await Promise.all([...subscribers].map(listener => listener(subject))) } }
}

it('forwards exact GET/HEAD resources and conditional reads without exposing browser or response credentials', async () => {
  const f = await fixture()
  const response = await fetch(f.origin + f.path, { headers: f.headers })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('export const fixture = true')
  expect(response.headers.get('etag')).toBe('"fixture-revision"')
  expect(response.headers.get('set-cookie')).toBeNull(); expect(response.headers.get('x-dsh-runtime-id')).toBeNull()
  expect(response.headers.get('x-private-hop')).toBeNull()
  await f.referenceReleased.promise
  expect(f.references()).toBe(0)
  expect(f.admit).toHaveBeenCalledOnce()
  expect(f.observed[0]?.path).toBe(f.resource)
  expect(f.observed[0]?.headers.cookie).toBeUndefined(); expect(f.observed[0]?.headers.authorization).toBeUndefined()
  expect(f.observed[0]?.headers[PRINCIPAL_HEADER]).not.toBe('forged')
  const head = await fetch(f.origin + f.path, { method: 'HEAD', headers: f.headers })
  expect(head.status).toBe(200); expect(await head.text()).toBe('')
  const conditional = await fetch(f.origin + f.path, { headers: { ...f.headers, 'if-none-match': '"fixture-revision"' } })
  expect(conditional.status).toBe(304); await conditional.arrayBuffer()
  expect(f.monitor.synchronize).not.toHaveBeenCalled()
})

it('pins only a same-origin referring Runtime and leaves dynamic operations on their existing route', async () => {
  const f = await fixture()
  const response = await fetch(f.origin + f.resource, { headers: { ...f.headers, referer: f.origin + '/?dshRuntime=' + f.admission.placement.environment.id } })
  expect(response.status).toBe(200); await response.arrayBuffer()
  for (const path of ['/plugins/events', '/api/session.list', '/plugins/combo.js??fixture/client.js&rev=not-a-revision']) {
    const ordinary = await fetch(f.origin + path, { headers: f.headers })
    expect(ordinary.status).toBe(404); await ordinary.arrayBuffer()
  }
  expect(f.admit).toHaveBeenCalledOnce()
})

it('refuses duplicate target selectors and changed browser identity without Runtime dispatch', async () => {
  const f = await fixture()
  for (const suffix of ['&dshRuntime=' + f.admission.placement.environment.id, '&dshNode=not-a-node', '&dshTarget=unknown']) {
    const reply = await fetch(f.origin + f.path + suffix, { headers: f.headers })
    expect(reply.status).toBe(400); await reply.arrayBuffer()
  }
  const changed = await fetch(f.origin + f.path + '&dshPrincipal=8', { headers: f.headers })
  expect(changed.status).toBe(409); expect(await changed.json()).toEqual({ error: 'account-changed' })
  expect(f.observed).toHaveLength(0)
})

it('refuses unavailable monitors, changed revisions and untracked generations without execution recovery', async () => {
  const f = await fixture()
  const synchronize = f.monitor.synchronizeTo!
  f.monitor.synchronizeTo = undefined
  const unavailable = await fetch(f.origin + f.path, { headers: f.headers })
  expect(unavailable.status).toBe(503); await unavailable.arrayBuffer()
  expect(f.admit).not.toHaveBeenCalled()
  f.monitor.synchronizeTo = async () => false
  const stale = await fetch(f.origin + f.path, { headers: f.headers })
  expect(stale.status).toBe(503); await stale.arrayBuffer()
  f.monitor.synchronizeTo = synchronize
  f.untrack()
  const untracked = await fetch(f.origin + f.path, { headers: f.headers })
  expect(untracked.status).toBe(503); await untracked.arrayBuffer()
  expect(f.observed).toHaveLength(0); expect(f.references()).toBe(0)
})

it('does not publish bytes from another generation listening on the same port', async () => {
  const f = await fixture()
  f.replaceGeneration()
  const response = await fetch(f.origin + f.path, { headers: f.headers })
  expect(response.status).toBe(401); await response.arrayBuffer()
  await f.referenceReleased.promise
  expect(f.observed).toHaveLength(0); expect(f.references()).toBe(0)
})

it.each(['revocation', 'disconnect', 'shutdown'] as const)('closes a resource stream and releases its reference after %s', async cause => {
  const f = await fixture({ streaming: true })
  const response = await fetch(f.origin + f.path, { headers: f.headers })
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('authorized-prefix')
  await f.entered.promise
  expect(f.references()).toBe(1)
  const pending = reader.read()
  const settled = pending.then<unknown, unknown>(value => value, error => error)
  try {
    if (cause === 'revocation') await f.invalidate({ userId: f.actor.id })
    else if (cause === 'disconnect') await reader.cancel()
    else await f.assets.close()
    await settled; await f.referenceReleased.promise
    expect(f.references()).toBe(0)
    f.streamRelease.resolve()
    if (cause === 'shutdown') expect(f.subscribers()).toBe(0)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
})

it('joins an admission read already in flight when shutdown closes the response', async () => {
  const f = await fixture(), entered = barrier(), release = barrier()
  f.admit.mockImplementation(async () => { entered.resolve(); await release.promise; return f.admission })
  const pending = fetch(f.origin + f.path, { headers: f.headers })
  const outcome = pending.then<unknown, unknown>(value => value, error => error)
  await entered.promise
  let closed = false
  const closing = f.assets.close().then(() => { closed = true })
  try {
    await outcome
    expect(closed).toBe(false)
    release.resolve(); await closing
    expect(f.references()).toBe(0); expect(f.observed).toHaveLength(0)
  } finally { release.resolve(); await closing }
})

it('reuses the exact fresh placement for remote delivery without invoking a local Runtime', async () => {
  const f = await fixture({ remote: true })
  const response = await fetch(f.origin + f.path, { headers: f.headers })
  expect(response.status).toBe(200); expect(await response.text()).toBe('remote-resource')
  expect(f.admit).toHaveBeenCalledOnce(); expect(f.forward).toHaveBeenCalledOnce()
  expect(f.forward.mock.calls[0]?.[3]).toBe(f.admission.placement)
  expect(f.observed).toHaveLength(0)
})

it('qualifies the same account, authority and Runtime generation again after an owning-node byte match', async () => {
  const body = Buffer.from('window.releasePlugin = true;\n'.repeat(100))
  const sha256 = createHash('sha256').update(body).digest('hex')
  const releaseCombo = vi.fn(async (_path: string) => ({ body, sha256 }))
  const f = await fixture({ remote: true, releaseCombo })
  f.forward.mockImplementation(async (_req, res, _actor, _placement, _generation, delivery) => {
    if (delivery?.release === undefined) { res.end('node resource'); return true }
    expect(delivery.release.sha256).toBe(sha256)
    await delivery.release.serve(new AbortController().signal)
    return true
  })
  const matched = await fetch(f.origin + f.path, { headers: { ...f.headers, 'accept-encoding': 'br' } })
  expect(matched.status).toBe(200)
  expect(Buffer.from(await matched.arrayBuffer())).toEqual(body)
  expect(matched.headers.get('content-encoding')).toBe('br')
  expect(matched.headers.get('cache-control')).toBe('private, no-store')
  expect(matched.headers.get(RELEASE_COMBO_DIGEST_HEADER)).toBeNull()
  expect(releaseCombo).toHaveBeenCalledExactlyOnceWith(f.resource)
  expect(f.admit).toHaveBeenCalledTimes(2)

  const conditional = await fetch(f.origin + f.path, { headers: { ...f.headers, 'if-none-match': '\"old\"' } })
  expect(await conditional.text()).toBe('node resource')
  expect(releaseCombo).toHaveBeenCalledTimes(1)

  f.admit.mockResolvedValueOnce(f.admission).mockResolvedValueOnce({ ...f.admission, accessRevision: '5' })
  const revoked = await fetch(f.origin + f.path, { headers: f.headers })
  expect(revoked.status).toBe(409)
  expect(await revoked.json()).toEqual({ error: 'runtime-asset/authority-changed' })
  f.admit.mockResolvedValueOnce(f.admission).mockResolvedValueOnce({ ...f.admission, snapshot: { ...f.admission.snapshot, generation: 8 } })
  const replaced = await fetch(f.origin + f.path, { headers: f.headers })
  expect(replaced.status).toBe(409)
  await replaced.arrayBuffer()
})

it('limits release digest challenges to an already authenticated managed forward', async () => {
  const digest = 'a'.repeat(64)
  const forwarded = await fixture({ entryNodeId: randomUUID() as RuntimeNodeId })
  const headers = { ...forwarded.headers, [RELEASE_COMBO_DIGEST_HEADER]: digest }
  const direct = await fetch(forwarded.origin + forwarded.path, { headers })
  expect(direct.status).toBe(200)
  await direct.arrayBuffer()
  expect(forwarded.observed[0]?.headers[RELEASE_COMBO_DIGEST_HEADER]).toBeUndefined()
  const response = await fetch(forwarded.origin + forwarded.path, { headers: {
    ...headers, 'x-dsh-target-node': forwarded.admission.placement.environment.node.id,
  } })
  expect(response.status).toBe(200)
  await response.arrayBuffer()
  expect(forwarded.observed[1]?.headers[RELEASE_COMBO_DIGEST_HEADER]).toBe(digest)
})

it('caches immutable assets for one authorized Runtime, generation and account', async () => {
  const f = await fixture({ remote: true })
  const payload = 'export const plugin = ' + JSON.stringify('x'.repeat(2048)) + '\n'
  f.forward.mockImplementation(async (_req, res, _actor, _placement, _generation, delivery) => {
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      etag: '"remote-v1"',
      'cache-control': 'private, no-store',
    })
    res.end(payload)
    delivery?.capture?.onComplete({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      freshUntil: Date.now() + 60_000,
      etag: '"remote-v1"',
      body: Buffer.from(payload, 'utf8'),
    })
    return true
  })

  const first = await fetch(f.origin + f.path, { headers: f.headers })
  expect(first.status).toBe(200)
  expect(await first.text()).toBe(payload)
  expect(f.forward).toHaveBeenCalledTimes(1)
  expect(f.assets.diagnostics()).toMatchObject({ remoteCacheHits: 0, remoteCacheMisses: 1, remoteCacheEntries: 1 })

  // Second request serves from Center cache (zero remote forward) while still re-running admission + monitor sync.
  const second = await fetch(f.origin + f.path, { headers: { ...f.headers, 'accept-encoding': 'br, gzip' } })
  expect(second.status).toBe(200)
  expect(second.headers.get('etag')).toBe('W/"remote-v1"')
  expect(second.headers.get('cache-control')).toBe('private, no-store')
  expect(await second.text()).toBe(payload)
  expect(f.forward).toHaveBeenCalledTimes(1)
  expect(f.admit).toHaveBeenCalledTimes(2)
  expect(f.assets.diagnostics().remoteCacheHits).toBe(1)

  const otherRuntimeId = randomUUID() as RuntimeId
  const otherPath = f.path.replace(f.admission.placement.environment!.id, otherRuntimeId)
  f.admit.mockResolvedValueOnce({
    ...f.admission,
    placement: {
      ...f.admission.placement,
      environment: { ...f.admission.placement.environment!, id: otherRuntimeId },
    },
    snapshot: { ...f.admission.snapshot, target: { ...f.admission.snapshot.target, runtimeId: otherRuntimeId } },
  })
  const other = await fetch(f.origin + otherPath, { headers: f.headers })
  expect(other.status).toBe(200)
  await other.arrayBuffer()
  expect(f.forward).toHaveBeenCalledTimes(2)
  f.admit.mockResolvedValueOnce({ ...f.admission, snapshot: { ...f.admission.snapshot, generation: 8 } })
  const restarted = await fetch(f.origin + f.path, { headers: f.headers })
  expect(restarted.status).toBe(200)
  await restarted.arrayBuffer()
  expect(f.forward).toHaveBeenCalledTimes(3)

  // Conditional ETag check answers 304 directly from Center cache for both strong and weakened forms.
  const notModified = await fetch(f.origin + f.path, { headers: { ...f.headers, 'if-none-match': '"remote-v1"' } })
  expect(notModified.status).toBe(304)
  await notModified.arrayBuffer()
  const notModifiedWeak = await fetch(f.origin + f.path, { headers: { ...f.headers, 'if-none-match': 'W/"remote-v1"' } })
  expect(notModifiedWeak.status).toBe(304)
  await notModifiedWeak.arrayBuffer()
  expect(f.forward).toHaveBeenCalledTimes(3)

  // Authority change STILL refuses even when bytes are warm in cache.
  const originalSync = f.monitor.synchronizeTo
  f.monitor.synchronizeTo = async () => false
  const refused = await fetch(f.origin + f.path, { headers: f.headers })
  expect(refused.status).toBe(503)
  await refused.arrayBuffer()
  f.monitor.synchronizeTo = originalSync

  await f.invalidate({ userId: f.actor.id })
  expect(f.assets.diagnostics().remoteCacheEntries).toBe(0)
  const afterEvict = await fetch(f.origin + f.path, { headers: f.headers })
  expect(afterEvict.status).toBe(200)
  await afterEvict.arrayBuffer()
  expect(f.forward).toHaveBeenCalledTimes(4)
  await f.invalidate({ nodeId: f.admission.placement.environment.node.id })
  expect(f.assets.diagnostics().remoteCacheEntries).toBe(0)
})

it('caches deterministic Brotli-9 and gzip-6 bytes by release sha256 without caching authority', async () => {
  const snippet = Array.from({ length: 400 }, (_, i) => `export function fn_${String(i)}(value){return value+"-${String(i).padStart(4, '0')}-payload";}\n`).join('')
  const body = Buffer.from(snippet, 'utf8')
  const sha256 = createHash('sha256').update(body).digest('hex')
  const releaseCombo = vi.fn(async (_path: string) => ({ body, sha256 }))
  const f = await fixture({ remote: true, releaseCombo })
  const expectedBr = brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } })
  const br4 = brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
  expect(expectedBr.byteLength).toBeLessThan(br4.byteLength)

  let forwardCalls = 0
  f.forward.mockImplementation(async (_req, _res, _actor, _placement, _generation, delivery) => {
    forwardCalls += 1
    expect(delivery?.release?.sha256).toBe(sha256)
    await delivery!.release!.serve(new AbortController().signal)
    return true
  })

  // First br request warms and caches Brotli-9 bytes.
  const first = await fetch(f.origin + f.path, { headers: { ...f.headers, 'accept-encoding': 'br' } })
  expect(first.status).toBe(200)
  expect(first.headers.get('content-encoding')).toBe('br')
  expect(first.headers.get('cache-control')).toBe('private, no-store')
  expect(Number(first.headers.get('content-length'))).toBe(expectedBr.byteLength)
  expect(Buffer.from(await first.arrayBuffer())).toEqual(body)
  expect(f.assets.diagnostics()).toMatchObject({
    releaseEncodedHits: 0,
    releaseEncodedMisses: 1,
    releaseEncodedEntries: 1,
    releaseEncodedBytes: expectedBr.byteLength,
  })

  // Second br request reuses cached compressed bytes while still re-running full admission and owning-node attestation.
  const second = await fetch(f.origin + f.path, { headers: { ...f.headers, 'accept-encoding': 'br' } })
  expect(second.status).toBe(200)
  expect(second.headers.get('content-encoding')).toBe('br')
  expect(Number(second.headers.get('content-length'))).toBe(expectedBr.byteLength)
  expect(Buffer.from(await second.arrayBuffer())).toEqual(body)
  expect(forwardCalls).toBe(2)
  expect(f.admit).toHaveBeenCalledTimes(4)
  expect(f.assets.diagnostics()).toMatchObject({
    releaseEncodedHits: 1,
    releaseEncodedMisses: 1,
    releaseEncodedEntries: 1,
  })

  // Gzip coding caches independently under the same sha256.
  const gz = await fetch(f.origin + f.path, { headers: { ...f.headers, 'accept-encoding': 'gzip' } })
  expect(gz.status).toBe(200)
  expect(gz.headers.get('content-encoding')).toBe('gzip')
  expect(Buffer.from(await gz.arrayBuffer())).toEqual(body)
  expect(f.assets.diagnostics()).toMatchObject({
    releaseEncodedHits: 1,
    releaseEncodedMisses: 2,
    releaseEncodedEntries: 2,
  })

  // Revocation still refuses delivery even though compressed release bytes stay warm.
  await f.invalidate({ userId: f.actor.id })
  f.admit.mockResolvedValueOnce(f.admission).mockResolvedValueOnce({ ...f.admission, accessRevision: '9' })
  const refused = await fetch(f.origin + f.path, { headers: { ...f.headers, 'accept-encoding': 'br' } })
  expect(refused.status).toBe(409)
  expect(await refused.json()).toEqual({ error: 'runtime-asset/authority-changed' })

  await f.assets.close()
  expect(f.assets.diagnostics()).toMatchObject({ releaseEncodedEntries: 0, releaseEncodedBytes: 0 })
})

it.each([
  ['job count', 2, 16 * 1024],
  ['raw byte budget', 1, 5 * 1024 * 1024],
] as const)('serves authorized identity bytes when release compression reaches its %s', async (_limit, heldCount, bodyBytes) => {
  const releaseCompression = barrier()
  const candidates = Array.from({ length: heldCount + 1 }, (_value, index) => {
    const body = Buffer.alloc(bodyBytes, 32 + index)
    const sha256 = createHash('sha256').update(body).digest('hex')
    const path = `/plugins/combo.js??fixture${index}/client.js&rev=012345abcdef`
    return { body, sha256, path }
  })
  const available = candidates.at(-1)!
  const f = await fixture({ remote: true, releaseCombo: async path => candidates.find(candidate => candidate.path === path) })
  const compress = vi.spyOn(httpCompression, 'compressImmutableBuffer').mockImplementation(async raw => {
    if (raw !== available.body) await releaseCompression.promise
    return httpCompression.compressBuffer(raw, 'br')
  })
  f.forward.mockImplementation(async (_req, res, _actor, _placement, _generation, delivery) => {
    if (delivery?.release?.sha256 === available.sha256) await delivery.release.serve(new AbortController().signal)
    else res.end('owning Gateway copy')
    return true
  })
  const fetchCombo = (path: string) => fetch(`${f.origin}${path}&dshRuntime=${f.admission.placement.environment.id}`,
    { headers: { ...f.headers, 'accept-encoding': 'br' } })
  try {
    for (const candidate of candidates.slice(0, heldCount)) {
      const res = await fetchCombo(candidate.path)
      expect(await res.text()).toBe('owning Gateway copy')
    }
    const skipped = await fetchCombo(available.path)
    expect(skipped.status).toBe(200)
    expect(skipped.headers.get('content-encoding')).toBeNull()
    expect(createHash('sha256').update(Buffer.from(await skipped.arrayBuffer())).digest('hex')).toBe(available.sha256)
    expect(compress).toHaveBeenCalledTimes(heldCount)
    expect(f.assets.diagnostics()).toMatchObject({ releaseEncodingInFlight: heldCount, releaseEncodingInFlightBytes: heldCount * bodyBytes })

    releaseCompression.resolve()
    await expect.poll(() => f.assets.diagnostics().releaseEncodingInFlight).toBe(0)
    const resumed = await fetchCombo(available.path)
    expect(resumed.headers.get('content-encoding')).toBe('br')
    expect(createHash('sha256').update(Buffer.from(await resumed.arrayBuffer())).digest('hex')).toBe(available.sha256)
    expect(compress).toHaveBeenCalledTimes(heldCount + 1)
  } finally {
    releaseCompression.resolve()
    await f.assets.close()
    compress.mockRestore()
  }
})

it('joins detached release compression at close without caching its result or accepting new work', async () => {
  const body = Buffer.from('window.__combo_detached = ' + JSON.stringify('abc123'.repeat(2000)))
  const f = await fixture({ remote: true, releaseCombo: async () => ({ body, sha256: createHash('sha256').update(body).digest('hex') }) })
  const releaseCompression = barrier()
  const compress = vi.spyOn(httpCompression, 'compressImmutableBuffer').mockImplementation(async raw => {
    await releaseCompression.promise
    return httpCompression.compressBuffer(raw, 'br')
  })
  const fetchCombo = () => fetch(f.origin + f.path, { headers: { ...f.headers, 'accept-encoding': 'br' } })
  let closed = false
  let closing: Promise<void> | undefined
  try {
    const response = await fetchCombo()
    expect(await response.text()).toBe('remote-resource')
    expect(compress).toHaveBeenCalledOnce()
    const close = f.assets.close()
    closing = close.then(() => { closed = true })
    expect(f.assets.close()).toBe(close)
    expect(f.subscribers()).toBe(0)
    const refused = await fetchCombo()
    expect(refused.status).toBe(503)
    await refused.arrayBuffer()
    expect(closed).toBe(false)
    expect(compress).toHaveBeenCalledOnce()
    expect(f.forward).toHaveBeenCalledOnce()
    expect(f.assets.diagnostics()).toMatchObject({ releaseEncodingInFlight: 1, releaseEncodingInFlightBytes: body.byteLength })
  } finally {
    releaseCompression.resolve()
    await (closing ?? f.assets.close())
    compress.mockRestore()
  }
  expect(closed).toBe(true)
  expect(f.assets.diagnostics()).toMatchObject({
    releaseEncodingInFlight: 0, releaseEncodingInFlightBytes: 0, releaseEncodedEntries: 0, releaseEncodedBytes: 0,
  })
})

it.each(['br, identity;q=0', 'gzip, *;q=0'])('uses owning-node delivery when %s forbids identity', async encoding => {
  const body = Buffer.from('export const fixture = true')
  const releaseCombo = vi.fn(async () => ({ body, sha256: createHash('sha256').update(body).digest('hex') }))
  const f = await fixture({ remote: true, releaseCombo })
  const res = await fetch(f.origin + f.path, { headers: { ...f.headers, 'accept-encoding': encoding } })
  expect(await res.text()).toBe('remote-resource')
  expect(f.forward.mock.lastCall?.[5]?.release).toBeUndefined()
  expect(releaseCombo).not.toHaveBeenCalled()
})

it('shares release compression across concurrent waiters after one disconnects', async () => {
  const body = Buffer.from('window.__combo_singleflight = ' + JSON.stringify('abc123'.repeat(2000)) + ';\n')
  const sha256 = createHash('sha256').update(body).digest('hex')
  const f = await fixture({ remote: true, releaseCombo: async () => ({ body, sha256 }) })
  const firstEntered = barrier(), secondEntered = barrier(), firstLeft = barrier(), releaseCompression = barrier()
  const compress = vi.spyOn(httpCompression, 'compressImmutableBuffer').mockImplementation(async (raw, coding) => {
    await releaseCompression.promise
    return httpCompression.compressBuffer(raw, coding)
  })
  let calls = 0
  f.forward.mockImplementation(async (_req, _res, _actor, _placement, _generation, delivery) => {
    const first = ++calls === 1
    const entered = first ? firstEntered : secondEntered
    const serving = delivery!.release!.serve(new AbortController().signal)
    entered.resolve()
    try { await serving; return true }
    finally { if (first) firstLeft.resolve() }
  })
  const fetchCombo = (signal?: AbortSignal) => fetch(f.origin + f.path, { signal, headers: { ...f.headers, 'accept-encoding': 'br' } })
  const client = new AbortController()
  const interrupted = fetchCombo(client.signal).then(res => ({ status: res.status }), error => ({ error }))
  try {
    await firstEntered.promise
    const healthy = fetchCombo().then(async res => ({ status: res.status, body: Buffer.from(await res.arrayBuffer()) }), error => ({ error }))
    await secondEntered.promise
    client.abort()
    expect(await interrupted).toMatchObject({ error: { name: 'AbortError' } })
    await firstLeft.promise
    expect(compress).toHaveBeenCalledOnce()
    expect(f.assets.diagnostics()).toMatchObject({ releaseEncodingInFlight: 1, releaseEncodingInFlightBytes: body.byteLength })
    releaseCompression.resolve()
    expect(await healthy).toEqual({ status: 200, body })
    expect(compress).toHaveBeenCalledOnce()
    expect(f.assets.diagnostics()).toMatchObject({ releaseEncodedMisses: 1, releaseEncodedEntries: 1, releaseEncodingInFlight: 0 })
  } finally {
    client.abort()
    releaseCompression.resolve()
    await f.assets.close()
    compress.mockRestore()
  }
})
