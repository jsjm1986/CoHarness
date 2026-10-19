/**
 * Connection interaction mode on the client: install defaults (page 'answer',
 * programmatic 'none'), fail-fast answer helpers under 'none', fixture parity
 * for suppressed interaction frames, and the operator transport's token/mode
 * declaration on every carrier URL.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOperatorTransport, installConnection, type ConnectionHandle } from '../src/client/index.ts'
import type { ClientResponse, MuxFrame } from '../src/client/api.ts'
import { RpcId } from '../src/client/api.ts'
import { FixtureApiClient } from '../src/client/fixture.ts'

type Win = { location?: { hostname: string; search: string; origin?: string } }
type WebSocketGlobal = { WebSocket?: typeof WebSocket }

const originalWebSocket = globalThis.WebSocket
const sockets: FakeWebSocket[] = []

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readonly url: string
  readyState = FakeWebSocket.CONNECTING

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    sockets.push(this)
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return
      this.readyState = FakeWebSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

const mountedContexts: Context[] = []
afterEach(async () => {
  for (const ctx of mountedContexts.splice(0).reverse()) await ctx.fiber.dispose()
  delete (globalThis as Win).location
  sockets.length = 0
  vi.unstubAllGlobals()
  if (originalWebSocket === undefined) delete (globalThis as WebSocketGlobal).WebSocket
  else globalThis.WebSocket = originalWebSocket
})

function install(options: Parameters<typeof installConnection>[1]): ConnectionHandle {
  const ctx = new Context()
  mountedContexts.push(ctx)
  installConnection(ctx, options)
  const handle = ctx.get('connection') as ConnectionHandle | undefined
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle
}

function responseMessage(rpcId: ReturnType<typeof RpcId>): ClientResponse {
  return { type: 'client-response', rpcId, result: { ok: true, value: { sessionId: 's-1', approvalId: 'a-1', outcome: 'allowed-once' } } }
}

/** Read the fixture mux baseline: collect until `done`, a quiet period after the first frames, or a hard deadline. */
async function collectMux(client: FixtureApiClient, done: (frames: MuxFrame[]) => boolean): Promise<MuxFrame[]> {
  const abort = new AbortController()
  const frames: MuxFrame[] = []
  const pump = (async () => {
    for await (const envelope of client.events.mux({}, abort.signal)) frames.push(envelope.payload)
  })()
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && !done(frames)) {
    const before = frames.length
    await new Promise(resolve => setTimeout(resolve, 40))
    if (frames.length > 0 && frames.length === before) break
  }
  abort.abort()
  await pump.catch(() => {})
  return frames
}

describe('connection interaction mode', () => {
  it('defaults non-page installs to none and page installs to answer', () => {
    const page = { hostname: 'localhost', search: '', origin: 'http://localhost:3080' }
    expect(install({}).interactions).toBe('none')
    expect(install({ location: page }).interactions).toBe('answer')
    // An explicit declaration wins over the ambient default in both directions.
    expect(install({ interactions: 'answer' }).interactions).toBe('answer')
    expect(install({ interactions: 'none', location: page }).interactions).toBe('none')
  })

  it('fails respond fast on a none connection before any wire traffic', async () => {
    const handle = install({})
    await expect(handle.api.respond(responseMessage(RpcId('t-respond'))))
      .rejects.toThrow(/'none' connection/)
  })

  it('keeps fixture parity: a none fixture suppresses interaction frames and refuses respond', async () => {
    const client = new FixtureApiClient('none')
    const frames = await collectMux(client, framesSeen => framesSeen.some(frame => frame.type === 'approval/requested'))
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.filter(frame => frame.type.startsWith('approval/') || frame.type.startsWith('question/'))).toEqual([])
    await expect(client.respond(responseMessage(RpcId('t-fixture-respond'))))
      .rejects.toThrow(/'none' connection/)
  })

  it('delivers fixture interaction frames to an answer connection', async () => {
    const client = new FixtureApiClient('answer')
    const frames = await collectMux(
      client,
      framesSeen => framesSeen.some(frame => frame.type === 'approval/requested')
        && framesSeen.some(frame => frame.type === 'question/requested'),
    )
    expect(frames.some(frame => frame.type === 'approval/requested')).toBe(true)
    expect(frames.some(frame => frame.type === 'question/requested')).toBe(true)
  })
})

describe('createOperatorTransport', () => {
  it('declares the launch token and resolved mode on generic-RPC requests', async () => {
    const transport = createOperatorTransport('http://127.0.0.1:3080', 'tok-123')
    const seen: URL[] = []
    vi.stubGlobal('fetch', vi.fn((input: URL) => {
      seen.push(input)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }))
    transport.createApiClient?.('answer')
    await transport.fetch?.(new URL('http://dsh.internal/api/session.list?x=1'), { method: 'POST' })
    expect(seen).toHaveLength(1)
    const url = seen[0] as URL
    expect(url.origin).toBe('http://127.0.0.1:3080')
    expect(url.pathname).toBe('/api/session.list')
    expect(url.searchParams.get('x')).toBe('1')
    expect(url.searchParams.get('token')).toBe('tok-123')
    expect(url.searchParams.get('interactions')).toBe('answer')
  })

  it('carries the token and mode on the mux WebSocket upgrade URL', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const transport = createOperatorTransport('http://127.0.0.1:3080', 'tok-123')
    const api = transport.createApiClient?.('none')
    if (api === undefined) throw new Error('operator transport must build an api client')
    const abort = new AbortController()
    const iterator = api.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    await new Promise(resolve => setTimeout(resolve, 20))
    abort.abort()
    first.catch(() => {})
    expect(sockets).toHaveLength(1)
    const url = new URL(sockets[0]!.url)
    expect(url.protocol).toBe('ws:')
    expect(url.host).toBe('127.0.0.1:3080')
    expect(url.searchParams.get('token')).toBe('tok-123')
    expect(url.searchParams.get('interactions')).toBe('none')
    await expect(api.respond(responseMessage(RpcId('t-operator-respond'))))
      .rejects.toThrow(/'none' connection/)
  })
})
