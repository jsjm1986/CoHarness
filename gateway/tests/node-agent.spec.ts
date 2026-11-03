/** Outbound node configuration, durable enrollment recovery and cancellation. */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadNodeAgentConfig, runNodeAgent, type NodeAgentEvent } from '../src/node-agent.ts'
import type { NodeEnrollmentToken } from '../src/node-access.ts'

const releases: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const release of releases.splice(0).reverse()) {
    try { await release() } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Node agent fixture cleanup failed')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'hgw-node-agent-'))
  releases.push(() => rm(value, { recursive: true, force: true }))
  return value
}

async function listener(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server: Server = createServer(handler)
  releases.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

function ticket(): NodeEnrollmentToken { return `dsh_enroll_${randomBytes(32).toString('base64url')}` as NodeEnrollmentToken }

it('requires a credential-free HTTPS origin and permits HTTP only on loopback', () => {
  expect(loadNodeAgentConfig({ HGW_NODE_CENTER_URL: 'https://example.invalid/' }).centerUrl).toBe('https://example.invalid')
  expect(loadNodeAgentConfig({ HGW_NODE_CENTER_URL: 'http://[::1]:3010' }).centerUrl).toBe('http://[::1]:3010')
  for (const url of [undefined, 'http://192.168.1.2', 'https://u:p@example.invalid', 'https://example.invalid/path', 'https://example.invalid?token=a']) {
    expect(() => loadNodeAgentConfig({ HGW_NODE_CENTER_URL: url })).toThrow()
  }
})

it.each(['0', '-1', '1.5', '2147483648'])('refuses invalid outbound timing %s', value => {
  expect(() => loadNodeAgentConfig({ HGW_NODE_CENTER_URL: 'https://example.invalid', HGW_NODE_AGENT_REQUEST_TIMEOUT_MS: value })).toThrow()
})

describe.skipIf(process.platform === 'win32')('POSIX node agent lifecycle', () => {
  it.each([
    { name: 'enrollment response interruption', phase: 'enroll', status: 200, interrupted: true, retry: true,
      reason: 'node-agent/transport-unavailable' },
    { name: 'connection response interruption', phase: 'connect', status: 200, interrupted: true, retry: true,
      reason: 'node-agent/transport-unavailable' },
    { name: 'heartbeat response interruption', phase: 'heartbeat', status: 200, interrupted: true, retry: true,
      reason: 'node-agent/transport-unavailable' },
    { name: 'oversized service-unavailable response', phase: 'heartbeat', status: 503, interrupted: false, retry: true,
      reason: 'node-agent/center-refused' },
    { name: 'oversized rate-limit response', phase: 'heartbeat', status: 429, interrupted: false, retry: true,
      reason: 'node-agent/center-refused' },
    { name: 'unauthorized response interruption', phase: 'heartbeat', status: 401, interrupted: true, retry: false,
      reason: 'node-agent/center-refused' },
    { name: 'forbidden response interruption', phase: 'heartbeat', status: 403, interrupted: true, retry: false,
      reason: 'node-agent/center-refused' },
  ])('handles $name without replacing its credential or lease owner', async (fault) => {
    const directory = await root(), stateFile = join(directory, 'access.json')
    const identity = { protocolVersion: 1, organizationId: randomUUID(), nodeId: randomUUID(), executionReady: false }
    const headersReceived = deferred<void>(), stop = new AbortController()
    const events: NodeAgentEvent[] = [], fixtureErrors: unknown[] = []
    const calls: Array<{ path: string; connectionId?: string; epoch?: string }> = []
    const credentials: string[] = []
    let interrupted: ServerResponse | undefined, deadline: AbortSignal | null | undefined
    let faultSent = false, observedHeaders = false
    const base = await listener((req, res) => {
      void (async () => {
        let raw = ''
        for await (const chunk of req) raw += String(chunk)
        const input = JSON.parse(raw) as { credential?: string; connectionId?: string; epoch?: string }
        const path = req.url!.slice('/internal/nodes/'.length)
        calls.push({ path, connectionId: input.connectionId, epoch: input.epoch })
        if (path === 'disconnect') { res.writeHead(204); res.end(); return }
        if (!['enroll', 'connect', 'heartbeat'].includes(path)) throw new Error('Unexpected node control request')
        if (path === 'enroll') credentials.push(input.credential!)
        const value = path === 'enroll' ? identity : { ...identity, connectionId: input.connectionId,
          epoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(), heartbeatMs: 1 }
        if (path === fault.phase && !faultSent) {
          faultSent = true
          if (fault.interrupted) {
            const complete = JSON.stringify(value)
            interrupted = res
            res.writeHead(fault.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(complete) })
            res.write('{"protocolVersion":')
          } else {
            const body = '<html>' + 'x'.repeat(4096) + '</html>'
            res.writeHead(fault.status, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) })
            res.end(body)
          }
          return
        }
        res.end(JSON.stringify(value))
      })().catch(error => { fixtureErrors.push(error); res.destroy(error as Error) })
    })
    const nativeFetch = globalThis.fetch
    const observer = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await nativeFetch(input, init)
      if (!observedHeaders && input === base + '/internal/nodes/' + fault.phase) {
        observedHeaders = true
        deadline = init?.signal
        headersReceived.resolve()
      }
      return response
    })
    releases.push(async () => { observer.mockRestore() })
    const running = runNodeAgent({ centerUrl: base, stateFile, enrollmentToken: ticket(),
      requestTimeoutMs: 10_000, retryMs: 1 }, stop.signal, event => {
      events.push(event)
      if (event.status === 'connected' && events.some(value => value.status === 'degraded')) stop.abort()
    })
    const completion = running.then(() => ({ state: 'stopped' }), (error: unknown) => ({
      state: 'failed',
      code: (error as { code?: string }).code,
      retryable: (error as { retryable?: boolean }).retryable,
      cause: (error as Error).cause instanceof Error ? ((error as Error).cause as Error).name : undefined,
    }))
    releases.push(async () => { stop.abort(); await completion })
    const arrival = await Promise.race([
      headersReceived.promise.then(() => ({ state: 'headers' })),
      completion,
    ])
    expect(arrival).toEqual({ state: 'headers' })
    expect(deadline?.aborted).toBe(false)
    if (fault.interrupted) interrupted!.destroy()
    const outcome = await completion
    if (fault.retry) {
      expect(outcome).toEqual({ state: 'stopped' })
      expect(events).toContainEqual({ status: 'degraded', reason: fault.reason })
    } else {
      expect(outcome).toMatchObject({ state: 'failed', code: fault.reason, retryable: false })
      expect(events.filter(event => event.status === 'degraded')).toEqual([])
    }
    expect(fixtureErrors).toEqual([])
    expect(events.at(-1)).toEqual({ status: 'stopped' })
    expect(calls.filter(call => call.path === fault.phase)).toHaveLength(fault.retry ? 2 : 1)
    expect(calls.filter(call => call.path === 'disconnect')).toHaveLength(1)
    expect(new Set(calls.filter(call => call.path === 'connect').map(call => call.connectionId)).size).toBe(1)
    expect(new Set(calls.filter(call => call.path !== 'enroll').map(call => call.connectionId)).size).toBe(1)
    expect(calls.filter(call => call.path === 'heartbeat').every(call => call.epoch === '1')).toBe(true)
    expect(new Set(credentials).size).toBe(1)
    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as { identity: unknown; enrollmentToken: string | null }
    expect(saved.identity).toEqual(identity)
    expect(saved.enrollmentToken).toBeNull()
  })

  it.each([
    { name: 'malformed JSON', body: '{', declared: true },
    { name: 'missing lease fields', body: '{}', declared: true },
    { name: 'oversized declared JSON', body: JSON.stringify({ padding: 'x'.repeat(4096) }), declared: true },
    { name: 'oversized streamed JSON', body: JSON.stringify({ padding: 'x'.repeat(4096) }), declared: false },
  ])('refuses $name on an HTTP success without retrying', async (reply) => {
    const directory = await root(), events: NodeAgentEvent[] = []
    const identity = { protocolVersion: 1, organizationId: randomUUID(), nodeId: randomUUID(), executionReady: false }
    const calls: string[] = []
    const base = await listener((req, res) => {
      req.resume()
      calls.push(req.url!)
      if (req.url === '/internal/nodes/enroll') { res.end(JSON.stringify(identity)); return }
      res.writeHead(200, { 'content-type': 'application/json',
        ...(reply.declared ? { 'content-length': Buffer.byteLength(reply.body) } : {}) })
      if (!reply.declared) { res.write(reply.body.slice(0, 2048)); res.end(reply.body.slice(2048)) }
      else res.end(reply.body)
    })
    await expect(runNodeAgent({ centerUrl: base, stateFile: join(directory, 'access.json'),
      enrollmentToken: ticket(), requestTimeoutMs: 10_000, retryMs: 1 },
    new AbortController().signal, event => { events.push(event) }))
      .rejects.toMatchObject({ code: 'node-agent/invalid-response', retryable: false })
    expect(calls).toEqual(['/internal/nodes/enroll', '/internal/nodes/connect'])
    expect(events.at(-1)).toEqual({ status: 'stopped-lease-uncertain' })
  })

  it('refuses an enrollment for another local computer before acquiring a managed lease', async () => {
    const directory = await root()
    const identity = { protocolVersion: 1, organizationId: randomUUID(), nodeId: randomUUID(), executionReady: false }
    const calls: string[] = []
    const base = await listener((req, res) => { calls.push(req.url!); req.resume(); res.end(JSON.stringify(identity)) })
    await expect(runNodeAgent({ centerUrl: base, stateFile: join(directory, 'access.json'), enrollmentToken: ticket(),
      requestTimeoutMs: 2000, retryMs: 1000, expectedIdentity: { organizationId: identity.organizationId, nodeId: randomUUID() } as NonNullable<import('../src/node-agent.ts').NodeAgentConfig['expectedIdentity']> },
    new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'node-agent/center-identity-mismatch' })
    expect(calls).toEqual(['/internal/nodes/enroll'])
  })

  it('ends the agent cleanly when the saved managed credential has explicitly detached', async () => {
    const directory = await root(), events: NodeAgentEvent[] = []
    const identity = { protocolVersion: 1, organizationId: randomUUID(), nodeId: randomUUID(), executionReady: false }
    const base = await listener((req, res) => {
      req.resume()
      if (req.url === '/internal/nodes/enroll') res.end(JSON.stringify(identity))
      else { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'node-access/detached' })) }
    })
    await runNodeAgent({ centerUrl: base, stateFile: join(directory, 'access.json'), enrollmentToken: ticket(), requestTimeoutMs: 2000, retryMs: 1000 },
      new AbortController().signal, event => { events.push(event) })
    expect(events.at(-1)).toEqual({ status: 'stopped' })
    expect(events.filter(event => event.status === 'stopped')).toHaveLength(1)
  })

  it('recovers an enrollment response loss with the same durable credential after restart', async () => {
    const directory = await root(), stateFile = join(directory, 'access.json')
    const firstLost = deferred<void>(), connected = deferred<void>()
    const identity = { protocolVersion: 1, organizationId: randomUUID(), nodeId: randomUUID(), executionReady: false }
    const seen: string[] = []
    let durableBeforeExchange = true
    const base = await listener((req, res) => {
      void (async () => {
        let body = ''
        for await (const chunk of req) body += String(chunk)
        const value = JSON.parse(body) as { credential?: string; connectionId?: string }
        if (req.url === '/internal/nodes/enroll') {
          const saved = JSON.parse(await readFile(stateFile, 'utf8')) as { credential: string }
          durableBeforeExchange &&= saved.credential === value.credential
          seen.push(value.credential!)
          if (seen.length === 1) { res.destroy(); firstLost.resolve(); return }
          res.end(JSON.stringify(identity)); return
        }
        if (req.url === '/internal/nodes/disconnect') { res.writeHead(204); res.end(); return }
        res.end(JSON.stringify({ ...identity, connectionId: value.connectionId, epoch: '1', expiresAt: new Date(Date.now() + 30_000).toISOString(), heartbeatMs: 1000 }))
      })().catch(error => { res.destroy(error as Error) })
    })
    const config = { centerUrl: base, stateFile, enrollmentToken: ticket(), requestTimeoutMs: 2000, retryMs: 1000 }
    const first = new AbortController()
    const firstRun = runNodeAgent(config, first.signal, () => {})
    releases.push(async () => { first.abort(); await firstRun })
    await firstLost.promise
    first.abort()
    await firstRun
    const second = new AbortController(), events: NodeAgentEvent[] = []
    const secondRun = runNodeAgent({ ...config, enrollmentToken: undefined }, second.signal, event => {
      events.push(event)
      if (event.status === 'connected') connected.resolve()
    })
    releases.push(async () => { second.abort(); await secondRun })
    await connected.promise
    second.abort()
    await secondRun
    expect(durableBeforeExchange).toBe(true)
    expect(seen).toHaveLength(2)
    expect(seen[0] === seen[1]).toBe(true)
    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as { enrollmentToken: string | null; identity: unknown }
    expect(saved.enrollmentToken).toBeNull()
    expect(saved.identity).toEqual(identity)
    expect(events.at(-1)).toEqual({ status: 'stopped' })
  })

  it('cancels an unanswered connection acquisition and reports its uncertain lease', async () => {
    const directory = await root(), waiting = deferred<void>(), socketClosed = deferred<void>()
    const identity = { protocolVersion: 1, organizationId: randomUUID(), nodeId: randomUUID(), executionReady: false }
    const base = await listener((req, res) => {
      req.resume()
      if (req.url === '/internal/nodes/enroll') { res.end(JSON.stringify(identity)); return }
      res.once('close', () => { socketClosed.resolve() })
      waiting.resolve()
    })
    const controller = new AbortController(), events: NodeAgentEvent[] = []
    const running = runNodeAgent({ centerUrl: base, stateFile: join(directory, 'access.json'), enrollmentToken: ticket(), requestTimeoutMs: 10_000, retryMs: 1000 }, controller.signal, event => { events.push(event) })
    releases.push(async () => { controller.abort(); await running })
    await waiting.promise
    controller.abort()
    await running
    await socketClosed.promise
    expect(events.at(-1)).toEqual({ status: 'stopped-lease-uncertain' })
  })

  it('reports a declared connection refusal without claiming an uncertain acquisition', async () => {
    const directory = await root(), events: NodeAgentEvent[] = []
    const identity = { protocolVersion: 1, organizationId: randomUUID(), nodeId: randomUUID(), executionReady: false }
    const base = await listener((req, res) => {
      req.resume()
      if (req.url === '/internal/nodes/enroll') { res.end(JSON.stringify(identity)); return }
      res.writeHead(409); res.end(JSON.stringify({ error: 'node-access/already-connected' }))
    })
    await expect(runNodeAgent({ centerUrl: base, stateFile: join(directory, 'access.json'), enrollmentToken: ticket(), requestTimeoutMs: 2000, retryMs: 1000 }, new AbortController().signal, event => { events.push(event) }))
      .rejects.toMatchObject({ code: 'node-access/already-connected', refused: true })
    expect(events.at(-1)).toEqual({ status: 'stopped' })
  })

  it('refuses a lease for a different identity and retains acquisition uncertainty', async () => {
    const directory = await root(), events: NodeAgentEvent[] = []
    const identity = { protocolVersion: 1, organizationId: randomUUID(), nodeId: randomUUID(), executionReady: false }
    const base = await listener((req, res) => {
      void (async () => {
        let body = ''
        for await (const chunk of req) body += String(chunk)
        if (req.url === '/internal/nodes/enroll') { res.end(JSON.stringify(identity)); return }
        const value = JSON.parse(body) as { connectionId: string }
        res.end(JSON.stringify({ ...identity, nodeId: randomUUID(), connectionId: value.connectionId,
          epoch: '1', expiresAt: new Date(Date.now() + 30_000).toISOString(), heartbeatMs: 1000 }))
      })().catch(error => { res.destroy(error as Error) })
    })
    await expect(runNodeAgent({ centerUrl: base, stateFile: join(directory, 'access.json'), enrollmentToken: ticket(), requestTimeoutMs: 2000, retryMs: 1000 }, new AbortController().signal, event => { events.push(event) }))
      .rejects.toMatchObject({ code: 'node-agent/center-identity-mismatch' })
    expect(events.at(-1)).toEqual({ status: 'stopped-lease-uncertain' })
  })

  it('refuses redirects without forwarding the enrollment bearer to another origin', async () => {
    const directory = await root()
    let forwarded = 0
    const destination = await listener((req, res) => { forwarded += 1; req.resume(); res.end('{}') })
    const base = await listener((req, res) => { req.resume(); res.writeHead(307, { location: destination }); res.end() })
    await expect(runNodeAgent({ centerUrl: base, stateFile: join(directory, 'access.json'), enrollmentToken: ticket(), requestTimeoutMs: 2000, retryMs: 1000 }, new AbortController().signal, () => {}))
      .rejects.toMatchObject({ code: 'node-agent/center-refused', retryable: false })
    expect(forwarded).toBe(0)
  })

  it('refuses a credential file readable by other users before sending an enrollment request', async () => {
    const directory = await root(), stateFile = join(directory, 'access.json')
    const base = await listener((req, res) => { req.resume(); res.writeHead(401); res.end('{}') })
    const config = { centerUrl: base, stateFile, enrollmentToken: ticket(), requestTimeoutMs: 2000, retryMs: 1000 }
    await expect(runNodeAgent(config, new AbortController().signal, () => {})).rejects.toThrow()
    await chmod(stateFile, 0o644)
    await expect(runNodeAgent(config, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'node-agent/state-must-be-private' })
  })
})
