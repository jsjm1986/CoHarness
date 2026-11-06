/** Center-served release assets: byte-deterministic dist files skip the runtime hop. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { testConfig } from './test-config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { ProjectService } from '../src/projects.ts'
import { ReleaseAssets, releaseAssetRoot } from '../src/release-assets.ts'
import { createGatewayServer, type GatewayDeps, type ProxyHandler } from '../src/server.ts'
import { UserService } from '../src/users.ts'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from '../src/runtime-router.ts'
import type { RuntimeCatalogEntry, RuntimeId, RuntimeNodeId } from '../src/runtime-catalog.ts'

const environment: RuntimeCatalogEntry = {
  id: '10111111-1111-4111-8111-111111111111' as RuntimeId, owner: { kind: 'personal', id: 1, name: 'root-admin' },
  node: { id: '61f22202-1c02-4a3c-8d34-f11222333444' as RuntimeNodeId, name: 'Local', status: 'active', lastHeartbeatAt: null },
  routing: 'local', observedState: 'ready', generation: 1,
}

let closer: (() => Promise<void>) | undefined
afterEach(async () => { const close = closer; closer = undefined; await close?.() })

/** A release payload root holding the `dist` directory a same-release Runtime would serve byte-for-byte. */
function makePayload(): string {
  const payload = mkdtempSync(join(tmpdir(), 'hgw-release-payload-'))
  const dist = join(payload, 'dist')
  mkdirSync(join(dist, 'assets', 'langs'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<html>shell</html>')
  writeFileSync(join(dist, 'favicon.svg'), '<svg>icon</svg>')
  writeFileSync(join(dist, 'assets', 'app-Ab3dEf9h.js'), 'BUNDLE_BYTES')
  writeFileSync(join(dist, 'assets', 'langs', 'php-7hPT7E-H.js'), 'LANG_BYTES')
  writeFileSync(join(dist, 'assets', 'plain.json'), '{}')
  return payload
}

async function setup(payload: string) {
  const root = mkdtempSync(join(tmpdir(), 'hgw-release-assets-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = testConfig(root, {
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_STATE_ROOT: join(root, 'state'),
    HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
  })
  const resolveForAccount = vi.fn(async () => environment)
  const page = { items: [environment], nextCursor: null }
  const catalog = { resolveForAccount, resolveForOwner: async () => environment, resolveForLanding: async () => environment,
    pageForAccount: async () => page, pageForAdministrator: async () => page }
  const proxy = vi.fn<ProxyHandler>(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('runtime-path')
  })
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    projects: new ProjectService(db, cfg),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
    runtimeCatalog: catalog,
    releaseAssets: new ReleaseAssets(join(payload, 'dist')),
  }
  deps.runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter(deps), {
    localNodeId: environment.node.id,
    catalog,
  })
  const admin = await deps.users.create({ username: 'root-admin', password: 'pw-12345678', role: 'admin' })
  await deps.users.changeOwnPassword(admin.id, 'pw-12345678')
  const server = createGatewayServer(deps, { proxy })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cfg.publicOrigins.push(base)
  closer = async () => {
    server.closeAllConnections()
    const outcomes = await Promise.allSettled([
      deps.instances.stopAll(),
      new Promise<void>((ready, reject) => { server.close(error => { if (error) reject(error); else ready() }) }),
    ])
    try { db.close() }
    finally { rmSync(root, { recursive: true, force: true }); rmSync(payload, { recursive: true, force: true }) }
    const failures = outcomes.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'Gateway release-assets fixture cleanup failed')
  }
  const login = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username: 'root-admin', password: 'pw-12345678' }),
  })
  expect(login.status).toBe(302)
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { base, cookie, proxy, resolveForAccount }
}

describe('releaseAssetRoot', () => {
  it('finds the workspace and managed-release dist and declines other layouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-root-'))
    closer = async () => { rmSync(root, { recursive: true, force: true }) }
    expect(releaseAssetRoot({ dshRepoRoot: root, dshCommand: [] })).toBeUndefined()
    mkdirSync(join(root, 'apps', 'web', 'dist'), { recursive: true })
    expect(releaseAssetRoot({ dshRepoRoot: root, dshCommand: [] })).toBeUndefined()
    writeFileSync(join(root, 'apps', 'web', 'dist', 'index.html'), '<html></html>')
    expect(releaseAssetRoot({ dshRepoRoot: root, dshCommand: [] })).toBe(join(root, 'apps', 'web', 'dist'))
  })

  it('resolves the frontend through the runtime entry dependency chain', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-chain-'))
    closer = async () => { rmSync(root, { recursive: true, force: true }) }
    const bin = join(root, 'bin.js')
    writeFileSync(bin, '')
    const webApp = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app')
    const frontend = join(webApp, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
    mkdirSync(join(frontend, 'dist'), { recursive: true })
    writeFileSync(join(webApp, 'package.json'), '{"name":"@deepseek-ai/dsh-web-app"}')
    writeFileSync(join(frontend, 'package.json'), '{"name":"@deepseek-ai/dsh-web-frontend"}')
    expect(releaseAssetRoot({ dshRepoRoot: join(root, 'empty'), dshCommand: ['node', bin, 'web', '--no-open'] })).toBeUndefined()
    writeFileSync(join(frontend, 'dist', 'index.html'), '<html></html>')
    expect(releaseAssetRoot({ dshRepoRoot: join(root, 'empty'), dshCommand: ['node', bin, 'web', '--no-open'] }))
      .toBe(realpathSync(join(frontend, 'dist')))
    expect(releaseAssetRoot({ dshRepoRoot: join(root, 'empty'), dshCommand: ['dsh', 'web', '--no-open'] })).toBeUndefined()
  })
})

describe('center-served release assets', () => {
  it('answers content-hashed assets with private immutable caching', async () => {
    const { base, cookie, proxy } = await setup(makePayload())
    const identity = await fetch(`${base}/assets/app-Ab3dEf9h.js`, { headers: { cookie, 'accept-encoding': 'identity' } })
    expect(identity.status).toBe(200)
    expect(identity.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(identity.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(identity.headers.get('vary')).toBe('accept-encoding')
    expect(identity.headers.get('content-encoding')).toBeNull()
    expect(await identity.text()).toBe('BUNDLE_BYTES')
    expect(proxy).not.toHaveBeenCalled()
    const head = await fetch(`${base}/assets/app-Ab3dEf9h.js`, { method: 'HEAD', headers: { cookie } })
    expect(head.status).toBe(200)
    expect(head.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(await head.text()).toBe('')
  })

  it('answers nested hashed assets and non-hashed files with their own cache rules', async () => {
    const { base, cookie } = await setup(makePayload())
    const nested = await fetch(`${base}/assets/langs/php-7hPT7E-H.js`, { headers: { cookie, 'accept-encoding': 'identity' } })
    expect(nested.status).toBe(200)
    expect(nested.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(await nested.text()).toBe('LANG_BYTES')
    const plain = await fetch(`${base}/assets/plain.json`, { headers: { cookie, 'accept-encoding': 'identity' } })
    expect(plain.status).toBe(200)
    expect(plain.headers.get('cache-control')).toBeNull()
    expect(await plain.text()).toBe('{}')
    const favicon = await fetch(`${base}/favicon.svg`, { headers: { cookie, 'accept-encoding': 'identity' } })
    expect(favicon.status).toBe(200)
    expect(favicon.headers.get('content-type')).toBe('image/svg+xml')
    expect(favicon.headers.get('cache-control')).toBeNull()
    expect(await favicon.text()).toBe('<svg>icon</svg>')
  })

  it('serves the brotli and gzip variants once they settle', async () => {
    const { base, cookie } = await setup(makePayload())
    // The first request schedules the variants and may answer with either coding.
    const first = await fetch(`${base}/assets/app-Ab3dEf9h.js`, { headers: { cookie, 'accept-encoding': 'br' } })
    expect(['br', null]).toContain(first.headers.get('content-encoding'))
    expect(await first.text()).toBe('BUNDLE_BYTES')
    await vi.waitFor(async () => {
      const probe = await fetch(`${base}/assets/app-Ab3dEf9h.js`, { headers: { cookie, 'accept-encoding': 'br' } })
      expect(probe.headers.get('content-encoding')).toBe('br')
      expect(await probe.text()).toBe('BUNDLE_BYTES')
    })
    const gzipped = await fetch(`${base}/assets/app-Ab3dEf9h.js`, { headers: { cookie, 'accept-encoding': 'gzip' } })
    expect(gzipped.headers.get('content-encoding')).toBe('gzip')
    expect(await gzipped.text()).toBe('BUNDLE_BYTES')
  })

  it('answers pinned and Referer-selected asset URLs locally without forwarding', async () => {
    const { base, cookie, proxy, resolveForAccount } = await setup(makePayload())
    const referer = `${base}/?dshRuntime=${environment.id}`
    const pinned = await fetch(`${base}/assets/app-Ab3dEf9h.js?dshRuntime=${environment.id}`, {
      headers: { cookie, 'accept-encoding': 'identity' },
    })
    expect(pinned.status).toBe(200)
    expect(await pinned.text()).toBe('BUNDLE_BYTES')
    const referred = await fetch(`${base}/assets/app-Ab3dEf9h.js`, {
      headers: { cookie, 'accept-encoding': 'identity', referer },
    })
    expect(referred.status).toBe(200)
    expect(await referred.text()).toBe('BUNDLE_BYTES')
    expect(proxy).not.toHaveBeenCalled()
    expect(resolveForAccount).not.toHaveBeenCalled()
  })

  it('leaves plugin paths, missing files, traversal, and non-GET methods on the runtime path', async () => {
    const payload = makePayload()
    writeFileSync(join(payload, 'secret.txt'), 'NOT_AN_ASSET')
    const { base, cookie, proxy } = await setup(payload)
    const headers = { cookie, 'accept-encoding': 'identity', referer: `${base}/?dshRuntime=${environment.id}` }
    const combo = await fetch(`${base}/plugins/combo.js??x%2Fclient.js&rev=abc`, { headers })
    expect(combo.status).toBe(200)
    expect(await combo.text()).toBe('runtime-path')
    const missing = await fetch(`${base}/assets/gone-Zz9yXx8w.js?dshRuntime=${environment.id}`, { headers: { cookie } })
    expect(await missing.text()).toBe('runtime-path')
    const traversal = await fetch(`${base}/assets/..%2F..%2Fsecret.txt`, { headers: { cookie } })
    expect(await traversal.text()).not.toBe('NOT_AN_ASSET')
    const posted = await fetch(`${base}/assets/app-Ab3dEf9h.js?dshRuntime=${environment.id}`, { method: 'POST', headers: { cookie, origin: base } })
    expect(await posted.text()).toBe('runtime-path')
    expect(proxy).toHaveBeenCalledTimes(4)
  })

  it('keeps the Referer pin redirect for unrevisioned live plugin paths', async () => {
    const { base, cookie, proxy } = await setup(makePayload())
    const events = await fetch(`${base}/plugins/events`, {
      redirect: 'manual',
      headers: { cookie, referer: `${base}/?dshRuntime=${environment.id}` },
    })
    expect(events.status).toBe(302)
    expect(events.headers.get('location')).toBe(`/plugins/events?dshRuntime=${environment.id}`)
    await events.arrayBuffer()
    expect(proxy).not.toHaveBeenCalled()
  })

  it('still requires an authenticated session', async () => {
    const { base } = await setup(makePayload())
    const anonymous = await fetch(`${base}/assets/app-Ab3dEf9h.js`, { headers: { 'accept-encoding': 'identity' } })
    expect(anonymous.status).toBe(401)
    expect(await anonymous.text()).not.toBe('BUNDLE_BYTES')
  })
})
