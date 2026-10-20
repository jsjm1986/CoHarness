/**
 * Tests for the managed-credential RFB handshake: the browser leg negotiates
 * `security type None` while the provider authenticates host-side against the
 * endpoint, plus the serveStream integration that selects that path for
 * `passwordRef` endpoints. Peer ends are scripted in-memory duplexes.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteDesktopGrantInput } from '@deepseek-ai/dsh-remote-desktop'
import { managedHandshake } from '../src/managed.ts'
import { VncRemoteDesktop } from '../src/index.ts'

const ADMIN = { principal: 'root', admin: true }
const RFB_38 = Buffer.from('RFB 003.008\n', 'latin1')
const KEY_EVENT = Buffer.from([3, 1, 0, 0, 0, 0, 0, 0x61])

/** One end of an in-memory socket pair: writes push to `peer`; destroy closes both ends. */
class Loopback extends Duplex {
  peer!: Loopback

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.peer.push(chunk)
    callback()
  }

  override _read(_size: number): void {}

  override _final(callback: (error?: Error | null) => void): void {
    this.peer.push(null)
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.peer.destroyed) this.peer.destroy()
    callback(error)
  }
}

/** A connected pair of in-memory duplexes: writing to one reads on the other. */
function duplexPair(): [Duplex, Duplex] {
  const a = new Loopback()
  const b = new Loopback()
  a.peer = b
  b.peer = a
  return [a, b]
}

/** Read exactly n bytes the function wrote toward this scripted peer. */
function take(socket: Duplex, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let buffered = 0
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
      buffered += chunk.length
      if (buffered >= n) {
        socket.off('data', onData)
        socket.off('close', onEnd)
        const head = Buffer.concat(chunks)
        resolve(head.subarray(0, n))
        const rest = head.subarray(n)
        if (rest.length > 0) socket.unshift(rest)
      }
    }
    const onEnd = (): void => {
      reject(new Error(`peer closed after ${String(buffered)} of ${String(n)} bytes`))
    }
    socket.on('data', onData)
    socket.once('close', onEnd)
  })
}

/** ServerInit head carrying the given desktop name. */
function serverInit(name: string): Buffer {
  const head = Buffer.alloc(24)
  head.writeUInt32BE(name.length, 20)
  return Buffer.concat([head, Buffer.from(name, 'latin1')])
}

class TestVnc extends VncRemoteDesktop {
  readonly servers: Duplex[] = []
  protected override dial(): Promise<Duplex> {
    const [upstreamEnd, serverEnd] = duplexPair()
    this.servers.push(serverEnd)
    return Promise.resolve(upstreamEnd)
  }
}

function grantInput(overrides: Partial<RemoteDesktopGrantInput> = {}): RemoteDesktopGrantInput {
  return {
    target: { nodeId: 'n1' },
    principal: 'alice',
    level: 'view',
    scope: { kind: 'machine' },
    recording: false,
    grantedBy: 'root',
    ...overrides,
  }
}

describe('managedHandshake', () => {
  it('negotiates None toward the browser and relays ClientInit/ServerInit with residuals', async () => {
    const [clientPeer, client] = duplexPair()
    const [upstream, serverPeer] = duplexPair()
    const handshake = managedHandshake(client, upstream, { password: 's3cret' })

    const server = (async () => {
      serverPeer.write(RFB_38)
      expect((await take(serverPeer, 12)).toString('latin1')).toBe('RFB 003.008\n')
      serverPeer.write(Buffer.from([1, 1]))
      expect((await take(serverPeer, 1)).readUInt8(0)).toBe(1)
      serverPeer.write(Buffer.alloc(4))
      expect((await take(serverPeer, 1)).readUInt8(0)).toBe(1)
      serverPeer.write(Buffer.concat([serverInit('desk'), Buffer.from([0xaa])]))
    })()

    const browser = (async () => {
      expect((await take(clientPeer, 12)).toString('latin1')).toBe('RFB 003.008\n')
      clientPeer.write(RFB_38)
      expect((await take(clientPeer, 2)).equals(Buffer.from([1, 1]))).toBe(true)
      clientPeer.write(Buffer.from([1]))
      expect((await take(clientPeer, 4)).equals(Buffer.alloc(4))).toBe(true)
      clientPeer.write(Buffer.from([1, 0xbb]))
      const init = await take(clientPeer, 28)
      expect(init.subarray(24).toString('latin1')).toBe('desk')
    })()

    const result = await handshake
    await server
    await browser
    expect(result.upstreamResidual.equals(Buffer.from([0xaa]))).toBe(true)
    expect(result.clientResidual.equals(Buffer.from([0xbb]))).toBe(true)
  })

  it('surfaces the upstream refusal reason verbatim', async () => {
    const [, client] = duplexPair()
    const [upstream, serverPeer] = duplexPair()
    const handshake = managedHandshake(client, upstream, { password: 's3cret' })
    serverPeer.write(RFB_38)
    await take(serverPeer, 12)
    const reason = Buffer.from('too busy', 'utf8')
    const head = Buffer.alloc(5)
    head.writeUInt32BE(reason.length, 1)
    serverPeer.write(Buffer.concat([head, reason]))
    await expect(handshake).rejects.toThrow('refused security negotiation: too busy')
  })

  it('fails loud when the upstream offers no manageable security type', async () => {
    const [, client] = duplexPair()
    const [upstream, serverPeer] = duplexPair()
    const handshake = managedHandshake(client, upstream, { password: 's3cret' })
    serverPeer.write(RFB_38)
    await take(serverPeer, 12)
    serverPeer.write(Buffer.from([2, 2, 16]))
    await expect(handshake).rejects.toThrow('no manageable security type')
  })

  it('fails loud when only ARD is offered without a configured username', async () => {
    const [, client] = duplexPair()
    const [upstream, serverPeer] = duplexPair()
    const handshake = managedHandshake(client, upstream, { password: 's3cret' })
    serverPeer.write(RFB_38)
    await take(serverPeer, 12)
    serverPeer.write(Buffer.from([1, 30]))
    await expect(handshake).rejects.toThrow('offers only ARD authentication but the endpoint configures no username')
  })

  it('rejects with FORBIDDEN when the server refuses the credential', async () => {
    const [, client] = duplexPair()
    const [upstream, serverPeer] = duplexPair()
    const handshake = managedHandshake(client, upstream, { password: 's3cret' })
    serverPeer.write(RFB_38)
    await take(serverPeer, 12)
    serverPeer.write(Buffer.from([1, 1]))
    await take(serverPeer, 1)
    const rejected = Buffer.alloc(4)
    rejected.writeUInt32BE(1, 0)
    serverPeer.write(rejected)
    await expect(handshake).rejects.toThrow('rejected the configured credential')
  })

  it('rejects a bad upstream banner and a browser preamble that is not RFB', async () => {
    const [, client] = duplexPair()
    const [upstream, serverPeer] = duplexPair()
    const handshake = managedHandshake(client, upstream, { password: 's3cret' })
    serverPeer.write(Buffer.from('NOPE 000.000\n', 'latin1'))
    await expect(handshake).rejects.toThrow('bad RFB banner')

    const [clientPeer2, client2] = duplexPair()
    const [upstream2, serverPeer2] = duplexPair()
    const second = managedHandshake(client2, upstream2, { password: 's3cret' })
    serverPeer2.write(RFB_38)
    await take(serverPeer2, 12)
    serverPeer2.write(Buffer.from([1, 1]))
    await take(serverPeer2, 1)
    serverPeer2.write(Buffer.alloc(4))
    await take(clientPeer2, 12)
    clientPeer2.write(Buffer.from('HTTP/1.1 400\n', 'latin1'))
    await expect(second).rejects.toThrow('browser sent a bad RFB preamble')
  })
})

describe('managed serveStream path', () => {
  let ctx: Context
  let svc: TestVnc
  let fiber: Awaited<ReturnType<Context['plugin']>>

  afterEach(async () => {
    await fiber?.dispose()
  })

  it('rejects a config endpoint with username but no passwordRef at load', async () => {
    ctx = new Context()
    await expect(ctx.plugin(TestVnc, {
      endpoints: [{ nodeId: 'n1', host: '127.0.0.1', port: 5900, username: 'alice' }],
      grantsFile: ':memory:',
    })).rejects.toThrow('username without passwordRef')
  })

  it('fails the stream when a passwordRef endpoint has no credentials provider', async () => {
    ctx = new Context()
    fiber = await ctx.plugin(TestVnc, {
      endpoints: [{ nodeId: 'n1', host: '127.0.0.1', port: 5900, passwordRef: 'VNC_PASSWORD' }],
      grantsFile: ':memory:',
    })
    svc = ctx.remoteDesktop as TestVnc
    await svc.grant(grantInput(), ADMIN)
    const request = { principal: 'alice', target: { nodeId: 'n1' }, level: 'view' as const }
    await svc.confirm(request)
    const session = await svc.attach(request)
    const [browserEnd, clientEnd] = duplexPair()
    await expect(svc.serveStream(session.stream.token, clientEnd)).rejects.toThrow('no credentials provider')
    browserEnd.destroy()
  })

  it('authenticates host-side, presents None to the browser, and filters view input from the frame phase', async () => {
    ctx = new Context()
    ctx.provide('credentials', { resolve: async () => ({ value: 's3cret', source: 'test' }) })
    fiber = await ctx.plugin(TestVnc, {
      endpoints: [{ nodeId: 'n1', host: '127.0.0.1', port: 5900, passwordRef: 'VNC_PASSWORD' }],
      grantsFile: ':memory:',
    })
    svc = ctx.remoteDesktop as TestVnc
    await svc.grant(grantInput(), ADMIN)
    const request = { principal: 'alice', target: { nodeId: 'n1' }, level: 'view' as const }
    await svc.confirm(request)
    const session = await svc.attach(request)
    const [browserEnd, clientEnd] = duplexPair()
    const done = svc.serveStream(session.stream.token, clientEnd)
    await new Promise(resolve => setImmediate(resolve))
    const server = svc.servers[0]!
    const upstreamReceived: Buffer[] = []
    server.on('data', (chunk: Buffer) => upstreamReceived.push(chunk))

    const serverScript = (async () => {
      server.write(RFB_38)
      expect((await take(server, 12)).toString('latin1')).toBe('RFB 003.008\n')
      server.write(Buffer.from([1, 1]))
      expect((await take(server, 1)).readUInt8(0)).toBe(1)
      server.write(Buffer.alloc(4))
      expect((await take(server, 1)).readUInt8(0)).toBe(1)
      server.write(serverInit('desk'))
    })()

    expect((await take(browserEnd, 12)).toString('latin1')).toBe('RFB 003.008\n')
    browserEnd.write(RFB_38)
    await take(browserEnd, 2)
    browserEnd.write(Buffer.from([1]))
    await take(browserEnd, 4)
    browserEnd.write(Buffer.concat([Buffer.from([1]), KEY_EVENT]))
    const init = await take(browserEnd, 28)
    expect(init.subarray(24).toString('latin1')).toBe('desk')
    await serverScript

    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const upstream = Buffer.concat(upstreamReceived)
    expect(upstream.subarray(0, 4).toString('latin1')).toBe('RFB ')
    expect(upstream.includes(0x61)).toBe(false)
    browserEnd.destroy()
    await done
  })
})
