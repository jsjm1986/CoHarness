import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { GatewayTunnelAccess, type TunnelAccessDeps } from '../src/tunnel-access.ts'
import { TunnelCredentialCipher, type TunnelAccessRow } from '../src/postgres/tunnel-access-service.ts'
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
afterEach(() => { vi.useRealTimers() })

function fakeProc(url: string | null = null): TunnelProc & { exitedResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void; terminated: () => boolean } {
  let terminated = false
  let exitedResolve!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { exitedResolve = resolve })
  return {
    publicUrl: url,
    ready: Promise.resolve(),
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
    cipher: overrides.cipher ?? cipher,
    organizationId: 'org-1',
    nodeId: 'node-1',
    target: 'http://127.0.0.1:8899',
    stateDir: '/state/tunnel', startupTimeoutMs: 30000, closeTimeoutMs: 5000, probeIntervalMs: 25,
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
  it('cancels binary preparation before allocating another connector', async () => {
    let entered!: () => void, release!: () => void, received: AbortSignal | undefined
    const prepared = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const spawn = vi.fn(() => fakeProc())
    const { deps } = makeDeps({ resolveBinary: async (signal?: AbortSignal) => {
      received = signal; entered(); await blocked; return binary
    }, spawnQuick: spawn })
    const access = new GatewayTunnelAccess(deps), starting = access.startQuick()
    await prepared
    const stopping = access.stop()
    try { expect(received?.aborted).toBe(true) }
    finally { release(); await Promise.allSettled([starting, stopping]) }
    expect(spawn).not.toHaveBeenCalled()
  })

  it('aborts a pending Cloudflare request when Stop supersedes named preparation', async () => {
    let entered!: () => void, fail!: (error: Error) => void, received: AbortSignal | null | undefined
    const requested = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<Response>((_resolve, reject) => { fail = reject })
    const { deps } = makeDeps({ fetchImpl: (_url, init) => {
      received = init?.signal
      received?.addEventListener('abort', () => { fail(new Error('fixture aborted')) }, { once: true })
      entered(); return blocked
    }, initialRow: { mode: 'named', hostname: 'team.example.com', domain: 'example.com',
      zoneId: 'zone-1', accountId: 'account-1', tunnelId: 'tunnel-1', apiTokenCipher: Buffer.from('enc:synthetic') } })
    const access = new GatewayTunnelAccess(deps), starting = access.startNamed({ hostname: 'team.example.com' })
    await requested
    const stopping = access.stop()
    try { expect(received?.aborted).toBe(true) }
    finally { fail(new Error('fixture released')); await Promise.allSettled([starting, stopping]) }
  })

  it('cancels an accepted binary installation before shutdown drains it', async () => {
    let entered!: () => void, release!: () => void, received: AbortSignal | undefined
    const prepared = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const { deps } = makeDeps({ install: async (_state: string, signal?: AbortSignal) => {
      received = signal; entered(); await blocked; return binary
    } })
    const access = new GatewayTunnelAccess(deps), installing = access.install()
    await prepared
    const shuttingDown = access.shutdown()
    try { expect(received?.aborted).toBe(true) }
    finally { release(); await Promise.allSettled([installing, shuttingDown]) }
  })

  it('persists an acknowledged create id before cancellation prevents token retrieval', async () => {
    let entered!: () => void, release!: () => void
    const publishing = new Promise<void>(resolve => { entered = resolve })
    const commit = new Promise<void>(resolve => { release = resolve })
    const fetchImpl = vi.fn<typeof fetch>(async () => cfResponse({ id: 'acknowledged-tunnel' }))
    const spawn = vi.fn(() => fakeProc())
    const { deps, store } = makeDeps({ fetchImpl, spawnNamed: spawn, initialRow: {
      mode: 'named', hostname: 'team.example.com', domain: 'example.com', zoneId: 'zone-1', accountId: 'account-1',
      apiTokenCipher: Buffer.from('enc:synthetic-api'),
    } })
    const update = deps.store.update.bind(deps.store)
    deps.store.update = async (patch) => {
      if (patch.tunnel_id === 'acknowledged-tunnel') { entered(); await commit }
      return update(patch)
    }
    const access = new GatewayTunnelAccess(deps), starting = access.startNamed({ hostname: 'team.example.com' })
    await publishing
    const stopping = access.stop()
    try {
      const cancelled = expect(starting).rejects.toMatchObject({ status: 409 })
      release(); await cancelled; await stopping
      expect(store.snapshot().tunnelId).toBe('acknowledged-tunnel')
      expect(store.snapshot().state).toBe('stopped')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(spawn).not.toHaveBeenCalled()
    } finally { release(); await Promise.allSettled([starting, stopping]) }
  })

  it('keeps a named tunnel starting until its connector confirms registration', async () => {
    vi.useFakeTimers()
    let registered!: () => void
    const ready = new Promise<void>(resolve => { registered = resolve })
    const proc = Object.assign(fakeProc(), { ready })
    const { deps, store } = makeDeps({ spawnNamed: () => proc, initialRow: {
      mode: 'named', hostname: 'team.example.com', domain: 'example.com', zoneId: 'zone-1', accountId: 'acct-1', tunnelId: 'tun-1',
      runTokenCipher: Buffer.from('enc:synthetic-run'),
    } })
    const starting = new GatewayTunnelAccess(deps).startNamed({ hostname: 'team.example.com' })
    let published = false
    void starting.then(() => { published = true })
    try {
      await vi.advanceTimersByTimeAsync(3001)
      expect(store.snapshot().state).toBe('starting')
      expect(published).toBe(false)
    } finally { registered(); await starting }
    expect(store.snapshot().state).toBe('running')
  })

  it('retains failed startup cleanup and permits retry while refusing another allocation', async () => {
    const failure = new Error('connector did not register'), proc = Object.assign(fakeProc(), { ready: Promise.reject(failure) })
    const terminate = vi.fn().mockRejectedValueOnce(new Error('closure unavailable')).mockResolvedValue(undefined)
    proc.terminate = terminate
    const spawnNamed = vi.fn(() => proc), { deps, store } = makeDeps({ spawnNamed, initialRow: {
      mode: 'named', hostname: 'team.example.com', domain: 'example.com', zoneId: 'zone-1', accountId: 'acct-1', tunnelId: 'tun-1',
      runTokenCipher: Buffer.from('enc:synthetic-run'),
    } })
    const access = new GatewayTunnelAccess(deps)
    await expect(access.startNamed({ hostname: 'team.example.com' })).rejects.toMatchObject({ status: 502, message: 'tunnel-stop-unconfirmed' })
    expect(store.snapshot().state).toBe('error'); expect(spawnNamed).toHaveBeenCalledOnce()
    await access.stop()
    expect(terminate).toHaveBeenCalledTimes(2); expect(store.snapshot().state).toBe('stopped')
  })

  it('cancels current registration and earlier queued starts as soon as Stop is requested', async () => {
    let allocated!: () => void, register!: () => void, cancelled = false, allocations = 0
    const creating = new Promise<void>(resolve => { allocated = resolve })
    const spawnNamed = vi.fn<NonNullable<TunnelAccessDeps['spawnNamed']>>((_bin, _token, options) => {
      if (++allocations > 1) return fakeProc()
      const ready = new Promise<void>((resolve, reject) => {
        register = resolve
        options.signal!.addEventListener('abort', () => { cancelled = true; reject(options.signal!.reason) }, { once: true })
      })
      allocated()
      return Object.assign(fakeProc(), { ready })
    })
    const { deps, store } = makeDeps({ spawnNamed, initialRow: {
      mode: 'named', hostname: 'team.example.com', domain: 'example.com', zoneId: 'zone-1', accountId: 'acct-1', tunnelId: 'tun-1',
      runTokenCipher: Buffer.from('enc:synthetic-run'),
    } }), access = new GatewayTunnelAccess(deps)
    const input = { hostname: 'team.example.com' }
    const first = access.startNamed(input).catch(error => error)
    await creating
    const queued = access.startNamed(input).catch(error => error)
    const stopping = access.stop()
    try { expect(cancelled).toBe(true) } finally { register(); await first; await queued; await stopping }
    expect(spawnNamed).toHaveBeenCalledOnce()
    expect(store.snapshot().desired).toBe('stopped'); expect(store.snapshot().state).toBe('stopped')
  })

  it('does not revive an explicit stop after a previously started resume read completes', async () => {
    let entered!: () => void, release!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const spawnQuick = vi.fn(async () => fakeProc('https://fixture.trycloudflare.com'))
    const { deps, store } = makeDeps({ spawnQuick, initialRow: { mode: 'quick', desired: 'running' } })
    const get = deps.store.get.bind(deps.store), stale = await get()
    let first = true
    deps.store.get = async () => { if (first) { first = false; entered(); await gate; return stale } return get() }
    const access = new GatewayTunnelAccess(deps), resuming = access.resume()
    await reading
    await access.stop()
    release(); await resuming
    expect(spawnQuick).not.toHaveBeenCalled()
    expect(store.snapshot().desired).toBe('stopped'); expect(store.snapshot().state).toBe('stopped')
  })

  it('retains failed termination for retry and refuses a replacement until cleanup succeeds', async () => {
    const proc = fakeProc('https://fixture.trycloudflare.com')
    const terminate = vi.fn().mockRejectedValueOnce(new Error('closure unavailable')).mockRejectedValueOnce(new Error('still unavailable')).mockResolvedValue(undefined)
    proc.terminate = terminate
    const spawnQuick = vi.fn(async () => proc), { deps, store } = makeDeps({ spawnQuick })
    const access = new GatewayTunnelAccess(deps)
    await access.startQuick()
    await expect(access.stop()).rejects.toMatchObject({ status: 502, message: 'tunnel-stop-unconfirmed' })
    expect(store.snapshot().desired).toBe('stopped'); expect(store.snapshot().state).toBe('error')
    await expect(access.startQuick()).rejects.toMatchObject({ status: 502, message: 'tunnel-stop-unconfirmed' })
    expect(spawnQuick).toHaveBeenCalledTimes(1)
    await access.stop()
    expect(terminate).toHaveBeenCalledTimes(3)
    expect(store.snapshot().state).toBe('stopped')
  })

  it('drains a quick startup accepted before shutdown and rejects later allocation', async () => {
    let entered!: () => void, release!: (value: TunnelProc) => void
    const allocated = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<TunnelProc>(resolve => { release = resolve })
    const proc = fakeProc('https://fixture.trycloudflare.com'), spawnQuick = vi.fn(async () => { entered(); return pending })
    const { deps } = makeDeps({ spawnQuick }), access = new GatewayTunnelAccess(deps)
    const starting = access.startQuick()
    const outcome = starting.then(() => 'published', () => 'refused')
    await allocated
    const closing = access.shutdown()
    release(proc)
    await closing
    expect(await outcome).toBe('refused')
    expect(proc.terminated()).toBe(true)
    await expect(access.startQuick()).rejects.toMatchObject({ status: 503, message: 'tunnel-shutting-down' })
    expect(spawnQuick).toHaveBeenCalledTimes(1)
  })

  it('serializes a pending exit-state write before a replacement starts', async () => {
    const old = fakeProc('https://old.trycloudflare.com'), next = fakeProc('https://next.trycloudflare.com')
    const spawnQuick = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next)
    const { deps, store } = makeDeps({ spawnQuick }), update = deps.store.update.bind(deps.store)
    let entered!: () => void, release!: () => void
    const writing = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    deps.store.update = async patch => {
      if (patch.state === 'error') { entered(); await gate }
      return update(patch)
    }
    const access = new GatewayTunnelAccess(deps)
    await access.startQuick(); old.exitedResolve({ code: 1, signal: null }); await writing
    const restart = access.startQuick()
    try {
      const first = await Promise.race([restart.then(() => 'restarted'), new Promise<string>(resolve => { setImmediate(() => resolve('pending')) })])
      expect(first).toBe('pending')
      expect(spawnQuick).toHaveBeenCalledTimes(1)
    } finally { release(); await restart }
    expect(store.snapshot().state).toBe('running'); expect(store.snapshot().publicUrl).toBe(next.publicUrl)
  })

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
    expect(spawnQuick).toHaveBeenCalledWith(binary.path, 'http://127.0.0.1:8899', expect.objectContaining({ startupTimeoutMs: 30000 }))
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
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      calls.push({ method: init?.method ?? 'GET', url: path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      if (path.endsWith('/accounts')) return cfResponse([{ id: 'acct-1', name: 'Org' }])
      if (path.includes('/zones?')) return cfResponse([{ id: 'zone-1', name: 'example.com', account: { id: 'acct-1' } }])
      if (path.endsWith('/cfd_tunnel')) return cfResponse({ id: 'tun-1' })
      if (path.endsWith('/token')) return cfResponse('RUNTOKEN')
      if (path.includes('/configurations')) return cfResponse({})
      if (path.includes('/dns_records?')) return cfResponse([])
      if (path.endsWith('/dns_records')) return cfResponse({ id: 'rec-1' })
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${path}`)
    })
    const proc = fakeProc()
    const spawnNamed = vi.fn(() => proc)
    const actualCipher = new TunnelCredentialCipher(randomBytes(32))
    const { deps, store } = makeDeps({ fetchImpl, spawnNamed, cipher: actualCipher })
    const view = await new GatewayTunnelAccess(deps).startNamed({
      hostname: 'team.example.com', domain: 'example.com', apiToken: 'CF-TOKEN',
    })
    expect(view.state).toBe('running')
    expect(view.publicUrl).toBe('https://team.example.com')
    expect(spawnNamed).toHaveBeenCalledWith(binary.path, 'RUNTOKEN', expect.objectContaining({ startupTimeoutMs: 30000 }))
    const methods = calls.map(call => `${call.method} ${call.url}`)
    expect(methods.some(m => m.includes('POST') && m.includes('cfd_tunnel'))).toBe(true)
    expect(methods.some(m => m.includes('PUT') && m.includes('configurations'))).toBe(true)
    expect(methods.some(m => m.includes('POST') && m.includes('dns_records'))).toBe(true)
    const row = store.snapshot()
    expect(actualCipher.decrypt('org-1', 'node-1', 'api-token', row.apiTokenCipher!)).toBe('CF-TOKEN')
    expect(actualCipher.decrypt('org-1', 'node-1', 'run-token', row.runTokenCipher!)).toBe('RUNTOKEN')
    expect(row.tunnelId).toBe('tun-1')
  })

  it('reuses stored named credentials without Cloudflare calls', async () => {
    const actualCipher = new TunnelCredentialCipher(randomBytes(32))
    const store = memoryStore({
      mode: 'named', hostname: 'team.example.com', zoneId: 'zone-1', accountId: 'acct-1', tunnelId: 'tun-1',
      apiTokenCipher: actualCipher.encrypt('org-1', 'node-1', 'api-token', 'CF-TOKEN'),
      runTokenCipher: actualCipher.encrypt('org-1', 'node-1', 'run-token', 'RUNTOKEN'),
    })
    const fetchImpl = vi.fn<typeof fetch>()
    const proc = fakeProc()
    const spawnNamed = vi.fn(() => proc)
    const access = new GatewayTunnelAccess({
      store, cipher: actualCipher, organizationId: 'org-1', nodeId: 'node-1',
      target: 'http://127.0.0.1:8899', stateDir: '/state/tunnel', startupTimeoutMs: 30000, closeTimeoutMs: 5000, probeIntervalMs: 25,
      resolveBinary: async () => binary, fetchImpl, spawnNamed,
    })
    const view = await access.startNamed({ hostname: 'team.example.com' })
    expect(view.state).toBe('running')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(spawnNamed).toHaveBeenCalledWith(binary.path, 'RUNTOKEN', expect.objectContaining({ startupTimeoutMs: 30000 }))
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

  it('validates a replacement domain before deleting any existing Cloudflare resources', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => String(input).includes('/dns_records?') ? cfResponse([]) : cfResponse({}))
    const { deps, store } = makeDeps({ fetchImpl, initialRow: {
      mode: 'named', desired: 'running', state: 'running', hostname: 'old.example.com', domain: 'example.com',
      zoneId: 'zone-1', accountId: 'acct-1', tunnelId: 'old-tunnel',
      apiTokenCipher: Buffer.from('enc:synthetic-api'), runTokenCipher: Buffer.from('enc:synthetic-run'),
    } })
    await expect(new GatewayTunnelAccess(deps).startNamed({ hostname: 'new.other.com', domain: 'example.com' }))
      .rejects.toMatchObject({ status: 400, message: 'hostname-must-end-under-domain' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.snapshot().tunnelId).toBe('old-tunnel')
    expect(store.snapshot().state).toBe('running')
  })

  it('retains created ids and tokens across interrupted provisioning without duplicate creation', async () => {
    let creates = 0, tokens = 0, configurations = 0
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path.includes('/zones?')) return cfResponse([{ id: 'zone-1', name: 'example.com', account: { id: 'zone-account' } }])
      if (path.endsWith('/cfd_tunnel') && init?.method === 'POST') {
        expect(path).toContain('/accounts/zone-account/'); creates++; return cfResponse({ id: 'durable-tunnel' })
      }
      if (path.endsWith('/token')) {
        tokens++
        if (tokens === 1) return new Response(JSON.stringify({ success: false, errors: [{ message: 'retry token' }], result: null }), { status: 503 })
        return cfResponse('synthetic-run')
      }
      if (path.endsWith('/configurations')) {
        configurations++
        if (configurations === 1) return new Response(JSON.stringify({ success: false, errors: [{ message: 'retry configuration' }], result: null }), { status: 503 })
        return cfResponse({})
      }
      if (path.includes('/dns_records?')) return cfResponse([])
      if (path.endsWith('/dns_records')) return cfResponse({})
      throw new Error('Unexpected provisioning request')
    })
    const { deps, store } = makeDeps({ fetchImpl, spawnNamed: () => fakeProc() }), access = new GatewayTunnelAccess(deps)
    const input = { hostname: 'fixture.example.com', apiToken: 'synthetic-api' }
    await expect(access.startNamed(input)).rejects.toMatchObject({ status: 502 })
    expect(store.snapshot().tunnelId).toBe('durable-tunnel'); expect(store.snapshot().runTokenCipher).toBeNull()
    await expect(access.startNamed(input)).rejects.toMatchObject({ status: 502 })
    expect(store.snapshot().tunnelId).toBe('durable-tunnel'); expect(store.snapshot().runTokenCipher).not.toBeNull()
    await expect(access.startNamed(input)).resolves.toMatchObject({ state: 'running' })
    expect(creates).toBe(1); expect(tokens).toBe(2); expect(configurations).toBe(2)
  })

  it.each(['bad..example.com', '-bad.example.com', `${'x'.repeat(64)}.example.com`])('rejects malformed DNS names before remote work (%s)', async hostname => {
    const fetchImpl = vi.fn<typeof fetch>(), { deps } = makeDeps({ fetchImpl })
    await expect(new GatewayTunnelAccess(deps).startNamed({ hostname, apiToken: 'synthetic-api' }))
      .rejects.toMatchObject({ status: 400, message: 'invalid-named-tunnel-input' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('clears retained named resources while the current execution mode is quick', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => String(input).includes('/dns_records?') ? cfResponse([]) : cfResponse({}))
    const { deps, store } = makeDeps({ fetchImpl, initialRow: {
      mode: 'quick', hostname: 'fixture.example.com', domain: 'example.com', zoneId: 'zone-1', accountId: 'acct-1', tunnelId: 'retained-tunnel',
      apiTokenCipher: Buffer.from('enc:synthetic-api'), runTokenCipher: Buffer.from('enc:synthetic-run'),
    } })
    await new GatewayTunnelAccess(deps).clear()
    expect(fetchImpl.mock.calls.some(([url, init]) => String(url).endsWith('/retained-tunnel') && init?.method === 'DELETE')).toBe(true)
    expect(store.snapshot().mode).toBe('off'); expect(store.snapshot().tunnelId).toBeNull()
  })

  it('clears stored credentials and Cloudflare-side resources', async () => {
    const store = memoryStore({
      mode: 'named', desired: 'stopped', state: 'stopped',
      hostname: 'team.example.com', zoneId: 'zone-1', accountId: 'acct-1', tunnelId: 'tun-1',
      apiTokenCipher: Buffer.from('enc:CF-TOKEN'), runTokenCipher: Buffer.from('enc:RUNTOKEN'),
    })
    const calls: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      if (String(input).includes('/dns_records?')) return cfResponse([{ id: 'rec-1', content: 'tun-1.cfargotunnel.com' }])
      return cfResponse({})
    })
    const access = new GatewayTunnelAccess({
      store, cipher, organizationId: 'org-1', nodeId: 'node-1',
      target: 'http://127.0.0.1:8899', stateDir: '/state/tunnel', startupTimeoutMs: 30000, closeTimeoutMs: 5000, probeIntervalMs: 25,
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
      target: 'http://127.0.0.1:8899', stateDir: '/state/tunnel', startupTimeoutMs: 30000, closeTimeoutMs: 5000, probeIntervalMs: 25,
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
    expect(install).toHaveBeenCalledWith('/state/tunnel', expect.any(AbortSignal))
    expect(view.binary).toEqual(binary)
  })
})
