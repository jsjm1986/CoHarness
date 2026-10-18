import { describe, expect, it, vi } from 'vitest'
import { GatewayTunnelAccess, type TunnelAccessDeps } from '../src/tunnel-access.ts'
import type { TunnelAccessRow } from '../src/postgres/tunnel-access-service.ts'
import type { TunnelProc } from '../src/tunnel-supervisor.ts'

const BASE_ROW: TunnelAccessRow = {
  mode: 'off', desired: 'stopped', state: 'stopped',
  publicUrl: null, hostname: null, domain: null, zoneId: null, accountId: null, tunnelId: null,
  apiTokenCipher: null, runTokenCipher: null, lastError: null,
  revision: 1, startedAt: null, updatedAt: '2026-01-01T00:00:00Z',
}

const SNAKE: Record<string, keyof TunnelAccessRow> = {
  mode: 'mode', desired: 'desired', state: 'state', public_url: 'publicUrl',
  hostname: 'hostname', domain: 'domain', zone_id: 'zoneId', account_id: 'accountId', tunnel_id: 'tunnelId',
  api_token_cipher: 'apiTokenCipher', run_token_cipher: 'runTokenCipher',
  last_error: 'lastError', started_at: 'startedAt',
}

function memoryStore(initial: Partial<TunnelAccessRow> = {}) {
  let row: TunnelAccessRow = { ...BASE_ROW, ...initial }
  return {
    get: async () => row,
    update: async (patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) {
        const field = SNAKE[key]
        if (field === undefined) throw new Error(`unexpected patch field ${key}`)
        row = { ...row, [field]: value, revision: row.revision + 1 }
      }
      return row
    },
    snapshot: () => row,
  }
}

const cipher = {
  encrypt: (_org: string, _node: string, _field: string, value: string) => Buffer.from(`enc:${value}`),
  decrypt: (_org: string, _node: string, _field: string, packed: Buffer) => packed.toString().replace(/^enc:/u, ''),
}

const binary = { path: '/managed/bin/cloudflared', version: '2026.9.3', source: 'state-dir' as const }

function fakeProc(url: string | null = null): TunnelProc & { exitedResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void; terminated: () => boolean } {
  let terminated = false
  let exitedResolve!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { exitedResolve = resolve })
  return {
    publicUrl: url,
    exited,
    exitedResolve,
    terminated: () => terminated,
    hasExited: () => false,
    terminate: async () => { terminated = true },
  }
}

function makeDeps(overrides: Partial<TunnelAccessDeps> & { initialRow?: Partial<TunnelAccessRow> } = {}) {
  const store = memoryStore(overrides.initialRow)
  const deps: TunnelAccessDeps = {
    store,
    cipher,
    organizationId: 'org-1',
    nodeId: 'node-1',
    target: 'http://127.0.0.1:8899',
    stateDir: '/state/tunnel',
    resolveBinary: overrides.resolveBinary ?? (async () => binary),
    spawnQuick: overrides.spawnQuick,
    spawnNamed: overrides.spawnNamed,
    fetchImpl: overrides.fetchImpl,
    install: overrides.install,
  }
  return { store, deps }
}

function cfResponse(result: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ success: true, errors: [], result: result }), { status: 200 }))
}

describe('GatewayTunnelAccess', () => {
  it('reports the off defaults before any configuration', async () => {
    const { deps } = makeDeps()
    const view = await new GatewayTunnelAccess(deps).view()
    expect(view.mode).toBe('off')
    expect(view.state).toBe('stopped')
    expect(view.desired).toBe('stopped')
    expect(view.binary).toEqual(binary)
    expect(view.apiTokenConfigured).toBe(false)
  })

  it('fails a quick start when no cloudflared binary resolves', async () => {
    const { deps, store } = makeDeps({ resolveBinary: async () => null })
    await expect(new GatewayTunnelAccess(deps).startQuick()).rejects.toMatchObject({ status: 503, message: 'cloudflared-not-installed' })
    expect(store.snapshot().state).toBe('stopped')
  })

  it('starts a quick tunnel and publishes the random URL', async () => {
    const proc = fakeProc('https://lime-cat-run.trycloudflare.com')
    const spawnQuick = vi.fn(async () => proc)
    const { deps, store } = makeDeps({ spawnQuick })
    const view = await new GatewayTunnelAccess(deps).startQuick()
    expect(spawnQuick).toHaveBeenCalledWith(binary.path, 'http://127.0.0.1:8899')
    expect(view.state).toBe('running')
    expect(view.publicUrl).toBe('https://lime-cat-run.trycloudflare.com')
    expect(view.mode).toBe('quick')
    expect(store.snapshot().desired).toBe('running')
  })

  it('records an error state when the quick tunnel child fails to report a URL', async () => {
    const { deps, store } = makeDeps({
      spawnQuick: async () => { throw new Error('spawn blew up') },
    })
    await expect(new GatewayTunnelAccess(deps).startQuick()).rejects.toThrow('spawn blew up')
    expect(store.snapshot().state).toBe('error')
    expect(store.snapshot().lastError).toBe('spawn blew up')
  })

  it('marks an unexpectedly exited process as error while keeping intent', async () => {
    const proc = fakeProc('https://a-b-c.trycloudflare.com')
    const { deps, store } = makeDeps({ spawnQuick: async () => proc })
    const access = new GatewayTunnelAccess(deps)
    await access.startQuick()
    proc.exitedResolve({ code: 1, signal: null })
    await vi.waitFor(() => { expect(store.snapshot().state).toBe('error') })
    expect(store.snapshot().desired).toBe('running')
    expect(store.snapshot().lastError).toContain('cloudflared exited')
  })

  it('stops the child and clears the public URL', async () => {
    const proc = fakeProc('https://a-b-c.trycloudflare.com')
    const { deps, store } = makeDeps({ spawnQuick: async () => proc })
    const access = new GatewayTunnelAccess(deps)
    await access.startQuick()
    const view = await access.stop()
    expect(proc.terminated()).toBe(true)
    expect(view.state).toBe('stopped')
    expect(view.desired).toBe('stopped')
    expect(store.snapshot().publicUrl).toBeNull()
  })

  it('provisions a named tunnel through the Cloudflare API on first start', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url)
      calls.push({ method: init?.method ?? 'GET', url: path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      if (path.endsWith('/accounts')) return cfResponse([{ id: 'acct-1', name: 'Org' }])
      if (path.includes('/zones?')) return cfResponse([{ id: 'zone-1', name: 'example.com' }])
      if (path.endsWith('/cfd_tunnel')) return cfResponse({ id: 'tun-1', token: 'RUNTOKEN' })
      if (path.includes('/configurations')) return cfResponse({})
      if (path.includes('/dns_records?')) return cfResponse([])
      if (path.endsWith('/dns_records')) return cfResponse({ id: 'rec-1' })
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${path}`)
    }) as unknown as typeof fetch
    const proc = fakeProc()
    const spawnNamed = vi.fn(() => proc)
    const { deps, store } = makeDeps({ fetchImpl, spawnNamed })
    const view = await new GatewayTunnelAccess(deps).startNamed({
      hostname: 'team.example.com', domain: 'example.com', apiToken: 'CF-TOKEN',
    })
    expect(view.state).toBe('running')
    expect(view.publicUrl).toBe('https://team.example.com')
    expect(spawnNamed).toHaveBeenCalledWith(binary.path, 'RUNTOKEN')
    const methods = calls.map(call => `${call.method} ${call.url}`)
    expect(methods.some(m => m.includes('POST') && m.includes('cfd_tunnel'))).toBe(true)
    expect(methods.some(m => m.includes('PUT') && m.includes('configurations'))).toBe(true)
    expect(methods.some(m => m.includes('POST') && m.includes('dns_records'))).toBe(true)
    const row = store.snapshot()
    expect(row.apiTokenCipher?.toString()).toBe('enc:CF-TOKEN')
    expect(row.runTokenCipher?.toString()).toBe('enc:RUNTOKEN')
    expect(row.tunnelId).toBe('tun-1')
  })

  it('reuses stored named credentials without Cloudflare calls', async () => {
    const store = memoryStore({
      mode: 'named', hostname: 'team.example.com', zoneId: 'zone-1', accountId: 'acct-1', tunnelId: 'tun-1',
      apiTokenCipher: Buffer.from('enc:CF-TOKEN'), runTokenCipher: Buffer.from('enc:RUNTOKEN'),
    })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const proc = fakeProc()
    const spawnNamed = vi.fn(() => proc)
    const access = new GatewayTunnelAccess({
      store, cipher, organizationId: 'org-1', nodeId: 'node-1',
      target: 'http://127.0.0.1:8899', stateDir: '/state/tunnel',
      resolveBinary: async () => binary, fetchImpl, spawnNamed,
    })
    const view = await access.startNamed({ hostname: 'team.example.com' })
    expect(view.state).toBe('running')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(spawnNamed).toHaveBeenCalledWith(binary.path, 'RUNTOKEN')
  })

  it('requires an API token when no named tunnel was provisioned', async () => {
    const { deps } = makeDeps()
    await expect(new GatewayTunnelAccess(deps).startNamed({ hostname: 'team.example.com' }))
      .rejects.toMatchObject({ status: 400, message: 'cloudflare-api-token-required' })
  })

  it('rejects a hostname outside the declared zone domain', async () => {
    const { deps } = makeDeps()
    await expect(new GatewayTunnelAccess(deps).startNamed({ hostname: 'team.other.com', domain: 'example.com', apiToken: 'T' }))
      .rejects.toMatchObject({ status: 400, message: 'hostname-must-end-under-domain' })
  })

  it('clears stored credentials and Cloudflare-side resources', async () => {
    const store = memoryStore({
      mode: 'named', desired: 'stopped', state: 'stopped',
      hostname: 'team.example.com', zoneId: 'zone-1', accountId: 'acct-1', tunnelId: 'tun-1',
      apiTokenCipher: Buffer.from('enc:CF-TOKEN'), runTokenCipher: Buffer.from('enc:RUNTOKEN'),
    })
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`)
      if (String(url).includes('/dns_records?')) return cfResponse([{ id: 'rec-1', content: 'tun-1.cfargotunnel.com' }])
      return cfResponse({})
    }) as unknown as typeof fetch
    const access = new GatewayTunnelAccess({
      store, cipher, organizationId: 'org-1', nodeId: 'node-1',
      target: 'http://127.0.0.1:8899', stateDir: '/state/tunnel',
      resolveBinary: async () => binary, fetchImpl,
    })
    const view = await access.clear()
    expect(view.mode).toBe('off')
    expect(view.apiTokenConfigured).toBe(false)
    expect(calls.some(call => call.startsWith('DELETE') && call.includes('rec-1'))).toBe(true)
    expect(calls.some(call => call.startsWith('DELETE') && call.includes('cfd_tunnel'))).toBe(true)
  })

  it('resumes a quick tunnel left running across a gateway restart', async () => {
    const store = memoryStore({ mode: 'quick', desired: 'running', state: 'stopped' })
    const proc = fakeProc('https://new-url.trycloudflare.com')
    const access = new GatewayTunnelAccess({
      store, cipher, organizationId: 'org-1', nodeId: 'node-1',
      target: 'http://127.0.0.1:8899', stateDir: '/state/tunnel',
      resolveBinary: async () => binary,
      spawnQuick: async () => proc,
    })
    await access.resume()
    expect(store.snapshot().state).toBe('running')
    expect(store.snapshot().publicUrl).toBe('https://new-url.trycloudflare.com')
  })

  it('installs the pinned binary through the injectable installer', async () => {
    const install = vi.fn(async () => binary)
    const { deps } = makeDeps({ install })
    const view = await new GatewayTunnelAccess(deps).install()
    expect(install).toHaveBeenCalledWith('/state/tunnel')
    expect(view.binary).toEqual(binary)
  })
})
