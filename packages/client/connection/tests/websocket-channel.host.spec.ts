/** Full branch and lifecycle coverage for ConnectionWebSocketChannel and shared ws-upgrade helpers. */
import { EventEmitter, once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type WebSocketServer } from 'ws'
import { ConnectionWebSocketChannel, type ConnectionWebSocket } from '../src/websocket-channel.ts'
import { buildConnectionRequestBoundary, createUpgradeRouteHandler } from '../src/ws-upgrade.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function startChannelServer(
  channel: ConnectionWebSocketChannel,
  onSocket: (socket: ConnectionWebSocket, req: IncomingMessage) => void | Promise<void>,
) {
  const server = createServer()
  server.on('upgrade', (req, socket, head) => {
    const ac = new AbortController()
    socket.once('close', () => { ac.abort() })
    void channel.upgrade(req, socket, head, ac.signal, onSocket)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const close = async (): Promise<void> => {
    await channel.close()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  cleanups.push(close)
  return { url: `ws://127.0.0.1:${String(port)}/api/test`, close }
}

describe('ConnectionWebSocketChannel', () => {
  it('validates maxMessageBytes and rejects upgrades when closing, aborted, or socket destroyed', async () => {
    expect(() => new ConnectionWebSocketChannel(30_000, 0)).toThrow(RangeError)
    expect(() => new ConnectionWebSocketChannel(30_000, -5)).toThrow(RangeError)
    expect(() => new ConnectionWebSocketChannel(30_000, 1.5)).toThrow(RangeError)

    const channel = new ConnectionWebSocketChannel()
    const aborted = new AbortController()
    aborted.abort()
    const socket1 = new PassThrough()
    const chunks1: Buffer[] = []
    socket1.on('data', (chunk: Buffer | string) => { chunks1.push(Buffer.from(chunk)) })
    await channel.upgrade({} as IncomingMessage, socket1, Buffer.alloc(0), aborted.signal, () => {})
    expect(Buffer.concat(chunks1).toString('utf8')).toContain('403 Forbidden')

    await channel.close()
    const socket2 = new PassThrough()
    const chunks2: Buffer[] = []
    socket2.on('data', (chunk: Buffer | string) => { chunks2.push(Buffer.from(chunk)) })
    await channel.upgrade({} as IncomingMessage, socket2, Buffer.alloc(0), new AbortController().signal, () => {})
    expect(Buffer.concat(chunks2).toString('utf8')).toContain('403 Forbidden')
  })

  it('exercises readyState, send/close/onMessage/onClose, rawData conversions, binary 1003, and error paths', async () => {
    const channel = new ConnectionWebSocketChannel(60_000, 1024)
    const captured: ConnectionWebSocket[] = []
    const received: string[] = []
    let closeCalls = 0
    const host = await startChannelServer(channel, (socket) => {
      captured.push(socket)
      expect(socket.readyState).toBe('open')
      const unsubMsg = socket.onMessage((data) => {
        received.push(data)
        if (data === 'echo') socket.send('pong')
        if (data === 'unsub') unsubMsg()
        if (data === 'close-default') socket.close()
        if (data === 'close-code') socket.close(1000, 'bye')
      })
      const unsubClose = socket.onClose(() => { closeCalls += 10 })
      unsubClose()
      socket.onClose(() => { closeCalls += 1 })
    })

    // Client 1: text echo, unsubscribe, and default close.
    const c1 = new WebSocket(host.url)
    await once(c1, 'open')
    const reply = once(c1, 'message')
    c1.send('echo')
    expect(String((await reply)[0])).toBe('pong')

    // Exercise rawDataToUtf8 string, Buffer[], ArrayBuffer branches directly on accepted ws.
    const server: WebSocketServer = channel['server']
    const accepted = [...server.clients][0]!
    accepted.emit('message', 'plain-str', false)
    accepted.emit('message', [Buffer.from('buf-'), Buffer.from('arr')], false)
    const ab = new TextEncoder().encode('ab-str').buffer
    accepted.emit('message', ab, false)
    expect(received).toEqual(['echo', 'plain-str', 'buf-arr', 'ab-str'])

    // Unsubscribe message listener then verify subsequent message ignored.
    const serverSocket = captured[0]!
    accepted.emit('message', 'unsub', false)
    accepted.emit('message', 'ignored-after-unsub', false)
    expect(received).toEqual(['echo', 'plain-str', 'buf-arr', 'ab-str', 'unsub'])

    // Trigger send callback error -> terminates socket.
    const terminateSpy = vi.spyOn(accepted, 'terminate')
    const sendSpy = vi.spyOn(accepted, 'send').mockImplementationOnce(((_data: unknown, cb?: (err?: Error) => void) => {
      cb?.(new Error('write failure'))
    }) as never)
    serverSocket.send('boom')
    expect(sendSpy).toHaveBeenCalledOnce()
    expect(terminateSpy).toHaveBeenCalledOnce()
    // Emit error after close (or vice versa) to cover idempotent notifyClose guard.
    accepted.emit('error', new Error('late'))
    await once(c1, 'close')
    accepted.emit('close')
    expect(closeCalls).toBe(1)

    // Operations after close are no-ops / immediate callback.
    expect(serverSocket.readyState).toBe('closed')
    serverSocket.send('noop-after-close')
    serverSocket.close()
    const lateClose = vi.fn()
    serverSocket.onClose(lateClose)()
    expect(lateClose).toHaveBeenCalledOnce()
    serverSocket.onMessage(vi.fn())()

    // Client 2: binary frame closes with 1003.
    const c2 = new WebSocket(host.url)
    await once(c2, 'open')
    const c2Closed = once(c2, 'close')
    c2.send(Buffer.from([1, 2, 3]), { binary: true })
    expect((await c2Closed)[0]).toBe(1003)

    // Client 3: closing readyState + close() without code and with code.
    const c3 = new WebSocket(host.url)
    await once(c3, 'open')
    const s3 = captured[2]!
    const c3Closed = once(c3, 'close')
    s3.close()
    expect(s3.readyState).toBe('closing')
    s3.close(1000, 'ignored-second-close')
    await c3Closed

    // Client 4: close(code, reason) branch.
    const c4 = new WebSocket(host.url)
    await once(c4, 'open')
    const c4Closed = once(c4, 'close')
    captured[3]!.close(1000, 'bye')
    const [code4, reason4] = await c4Closed as [number, Buffer]
    expect(code4).toBe(1000)
    expect(String(reason4)).toBe('bye')
  })

  it('closes with 1011 when handler throws synchronously or rejects asynchronously, and handles closing race', async () => {
    let mode: 'sync' | 'async' | 'async-already-closed' | 'sync-already-closed' = 'sync'
    const channel = new ConnectionWebSocketChannel(20, 1024)
    const host = await startChannelServer(channel, (socket) => {
      if (mode === 'sync') throw new Error('sync boom')
      if (mode === 'sync-already-closed') {
        socket.close(1000, 'early')
        throw new Error('sync after close')
      }
      if (mode === 'async') return Promise.reject(new Error('async boom'))
      socket.close(1000, 'early')
      return Promise.reject(new Error('async after close'))
    })

    const cSync = new WebSocket(host.url)
    const syncClose = once(cSync, 'close')
    expect((await syncClose)[0]).toBe(1011)

    mode = 'sync-already-closed'
    const cSyncClosed = new WebSocket(host.url)
    expect((await once(cSyncClosed, 'close'))[0]).toBe(1000)

    mode = 'async'
    const cAsync = new WebSocket(host.url)
    expect((await once(cAsync, 'close'))[0]).toBe(1011)

    mode = 'async-already-closed'
    const cAsyncClosed = new WebSocket(host.url)
    expect((await once(cAsyncClosed, 'close'))[0]).toBe(1000)

    // Race close() while handleUpgrade is mid-callback -> terminates ws cleanly.
    const raceChannel = new ConnectionWebSocketChannel(60_000, 1024)
    const terminate = vi.fn()
    const fakeWs: Pick<WebSocket, 'terminate' | 'readyState'> =
      Object.assign(new EventEmitter(), { terminate, readyState: WebSocket.OPEN })
    const raceServer: WebSocketServer = raceChannel['server']
    vi.spyOn(raceServer, 'handleUpgrade').mockImplementation((_req, _sock, _head, cb) => {
      void raceChannel.close()
      cb(fakeWs as WebSocket, {} as IncomingMessage)
    })
    await raceChannel.upgrade({} as IncomingMessage, new PassThrough(), Buffer.alloc(0), new AbortController().signal, () => {})
    expect(terminate).toHaveBeenCalledOnce()

    // Propagate server.close error and return cached closePromise on repeated close().
    const errChannel = new ConnectionWebSocketChannel(60_000, 1024)
    const errServer: WebSocketServer = errChannel['server']
    vi.spyOn(errServer, 'close').mockImplementation((cb) => {
      cb?.(new Error('close failure'))
      return errServer
    })
    const firstClose = errChannel.close()
    expect(errChannel.close()).toBe(firstClose)
    await expect(firstClose).rejects.toThrow('close failure')
  })

  it('terminates unresponsive sockets after missed heartbeats and handles ws-upgrade helpers', async () => {
    const channel = new ConnectionWebSocketChannel(20, 1024)
    const host = await startChannelServer(channel, () => {})
    const client = new WebSocket(host.url, { autoPong: false })
    await once(client, 'open')
    const closed = once(client, 'close')
    await once(client, 'ping')
    await once(client, 'ping')
    await closed

    // Heartbeat skips and untracks sockets that transitioned out of OPEN before the next tick.
    const channel2 = new ConnectionWebSocketChannel(15, 1024)
    const host2 = await startChannelServer(channel2, () => {})
    const client2 = new WebSocket(host2.url)
    await once(client2, 'open')
    const server2: WebSocketServer = channel2['server']
    const accepted2 = [...server2.clients][0]!
    Object.defineProperty(accepted2, 'readyState', { value: WebSocket.CLOSING, configurable: true })
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    client2.terminate()

    // Cover buildConnectionRequestBoundary optional fields and createUpgradeRouteHandler branches.
    const minimal = buildConnectionRequestBoundary('http', { headers: {} } as IncomingMessage)
    expect(minimal).toEqual({ kind: 'http', headers: {}, pathname: '/' })

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const handler = createUpgradeRouteHandler({
      owner: ctx,
      isRejected: req => req.url === '/reject',
      rejectOnError: true,
      onAccepted: async () => { throw new Error('upgrade failed') },
    })

    // Rejected before waterfall.
    const sReject = new PassThrough()
    const rejectChunks: Buffer[] = []
    sReject.on('data', (c: Buffer | string) => { rejectChunks.push(Buffer.from(c)) })
    void handler({ url: '/reject', headers: {} } as IncomingMessage, sReject, Buffer.alloc(0))
    expect(Buffer.concat(rejectChunks).toString('utf8')).toContain('403 Forbidden')

    // Error during waterfall writes 403 when socket is open.
    const sErr = new PassThrough()
    const errChunks: Buffer[] = []
    sErr.on('data', (c: Buffer | string) => { errChunks.push(Buffer.from(c)) })
    await expect(handler({ url: '/err', method: 'GET', headers: {} } as IncomingMessage, sErr, Buffer.alloc(0)))
      .rejects.toThrow('upgrade failed')
    expect(Buffer.concat(errChunks).toString('utf8')).toContain('403 Forbidden')

    // Already-destroyed socket triggers immediate abort and skips 403 write on error.
    const sDestroyed = new PassThrough()
    sDestroyed.destroy()
    await expect(handler({ url: '/err', headers: {} } as IncomingMessage, sDestroyed, Buffer.alloc(0)))
      .rejects.toThrow('upgrade failed')

    // Post-handoff waterfall error destroys the upgraded socket without writing raw HTTP 403 bytes.
    const postCtx = new Context()
    cleanups.push(() => postCtx.fiber.dispose())
    postCtx.on('connection/request', async (_boundary, next) => {
      await next()
      throw new Error('post-handoff failure')
    })
    const postHandler = createUpgradeRouteHandler({
      owner: postCtx,
      isRejected: () => false,
      rejectOnError: true,
      onAccepted: async () => {},
    })
    const sHandedOff = new PassThrough()
    const handedOffChunks: Buffer[] = []
    sHandedOff.on('data', (c: Buffer | string) => { handedOffChunks.push(Buffer.from(c)) })
    await expect(postHandler({ url: '/ok', headers: {} } as IncomingMessage, sHandedOff, Buffer.alloc(0)))
      .rejects.toThrow('post-handoff failure')
    expect(sHandedOff.destroyed).toBe(true)
    expect(handedOffChunks).toEqual([])
  })
})
