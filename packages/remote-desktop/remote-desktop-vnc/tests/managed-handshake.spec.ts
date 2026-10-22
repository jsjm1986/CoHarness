/**
 * Tests for the managed-credential RFB handshake and its serveStream
 * integration: a scripted in-memory VNC server performs the real Apple Remote
 * Desktop crypto (DH + MD5 + AES-128-ECB) and verifies the decrypted
 * credential blob, while the browser side negotiates only `None`.
 * The dial seam is faked with in-memory duplexes; no ports or listeners.
 */

import { describe, expect, it, vi } from 'vitest'
import { Duplex } from 'node:stream'
import { createDecipheriv, createDiffieHellman, createHash, getDiffieHellman } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { RemoteDesktopError } from '@deepseek-ai/dsh-remote-desktop'
import type { RemoteDesktopGrantInput } from '@deepseek-ai/dsh-remote-desktop'
import { VncRemoteDesktop } from '../src/index.ts'
import { managedHandshake } from '../src/managed.ts'

const ADMIN = { principal: 'root', admin: true }
const KEY_EVENT = Buffer.from([3, 1, 0, 0, 0, 0, 0, 0x61])
const FB_UPDATE_REQUEST = Buffer.from([2, 0, 0, 0, 0, 0, 4, 0, 3, 0])

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

/** Sequential byte puller for test scripts: buffers `data` until `n` bytes arrive. */
function reader(socket: Duplex): { take(n: number): Promise<Buffer> } {
  const chunks: Buffer[] = []
  let buffered = 0
  let pending: { n: number; resolve: (chunk: Buffer) => void } | undefined
  const consume = (n: number): Buffer => {
    const head = Buffer.concat(chunks.splice(0))
    buffered -= n
    if (head.length > n) chunks.push(head.subarray(n))
    return Buffer.from(head.subarray(0, n))
  }
  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    buffered += chunk.length
    if (pending !== undefined && buffered >= pending.n) {
      const done = pending
      pending = undefined
      done.resolve(consume(done.n))
    }
  })
  return {
    take(n: number): Promise<Buffer> {
      if (buffered >= n) return Promise.resolve(consume(n))
      return new Promise((resolve) => {
        pending = { n, resolve }
      })
    },
  }
}

function serverInit(name: string): Buffer {
  const head = Buffer.alloc(24)
  head.writeUInt16BE(640, 0)
  head.writeUInt16BE(480, 2)
  // pixel-format fields stay zeroed — the test asserts framing, not pixels.
  head.writeUInt32BE(Buffer.byteLength(name), 20)
  return Buffer.concat([head, Buffer.from(name, 'utf8')])
}

/**
 * A scripted VNC server speaking Apple Remote Desktop auth for real: it does
 * the server half of the DH exchange, decrypts the credential blob, and
 * asserts the stored username/password arrived byte-exact.
 */
async function ardServer(peer: Duplex, expectCreds: { username: string; password: string }): Promise<void> {
  const r = reader(peer)
  const dhGroup = getDiffieHellman('modp1')
  const prime = Buffer.from(dhGroup.getPrime())
  const generator = Buffer.from(dhGroup.getGenerator())
  const dh = createDiffieHellman(prime, generator)
  const serverPublic = dh.generateKeys()
  peer.write(Buffer.from('RFB 003.889\n', 'latin1'))
  expect((await r.take(12)).toString('latin1')).toBe('RFB 003.008\n')
  peer.write(Buffer.concat([Buffer.from([4, 30, 33, 35, 36])]))
  expect((await r.take(1)).readUInt8(0)).toBe(30)
  const keyLength = prime.length
  const genField = generator.length >= 2
    ? generator.subarray(generator.length - 2)
    : Buffer.concat([Buffer.alloc(2 - generator.length), generator])
  const challenge = Buffer.concat([
    genField,
    Buffer.from([keyLength >> 8, keyLength & 0xff]),
    prime,
    serverPublic,
  ])
  peer.write(challenge)
  const response = await r.take(128 + keyLength)
  const encrypted = response.subarray(0, 128)
  const clientPublic = response.subarray(128)
  const secret = dh.computeSecret(clientPublic)
  const padded = secret.length >= keyLength
    ? secret
    : Buffer.concat([Buffer.alloc(keyLength - secret.length), secret])
  const key = createHash('md5').update(padded).digest()
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(false)
  const blob = Buffer.concat([decipher.update(encrypted), decipher.final()])
  const userEnd = blob.indexOf(0, 0)
  const passEnd = blob.indexOf(0, 64)
  expect(blob.subarray(0, userEnd === -1 ? 64 : userEnd).toString('utf8')).toBe(expectCreds.username)
  expect(blob.subarray(64, passEnd === -1 ? 128 : passEnd).toString('utf8')).toBe(expectCreds.password)
  peer.write(Buffer.alloc(4))
  const clientInit = await r.take(1)
  expect(clientInit.readUInt8(0)).toBe(1)
  peer.write(serverInit('fake-desktop'))
}

/** The browser-side exchange: banner → version → None list → selection → result → ClientInit → ServerInit. */
async function browserPreamble(peer: Duplex): Promise<void> {
  const r = reader(peer)
  expect((await r.take(12)).toString('latin1')).toBe('RFB 003.008\n')
  peer.write(Buffer.from('RFB 003.008\n', 'latin1'))
  const types = await r.take(2)
  expect(types.readUInt8(0)).toBe(1)
  expect(types.readUInt8(1)).toBe(1)
  peer.write(Buffer.from([1]))
  expect((await r.take(4)).readUInt32BE(0)).toBe(0)
  peer.write(Buffer.from([1]))
  expect((await r.take(24 + 12)).equals(serverInit('fake-desktop'))).toBe(true)
}

describe('managedHandshake', () => {
  it('authenticates ARD host-side while the browser negotiates None', async () => {
    const [client, browserEnd] = duplexPair()
    const [upstream, serverEnd] = duplexPair()
    const server = ardServer(serverEnd, { username: 'admin', password: 's3cret' })
    const browser = browserPreamble(browserEnd)
    const result = await managedHandshake(client, upstream, { username: 'admin', password: 's3cret' })
    await Promise.all([server, browser])
    expect(result.clientResidual.length).toBe(0)
    expect(result.upstreamResidual.length).toBe(0)
    client.destroy()
    upstream.destroy()
  }, 15_000)

  it('rejects when the VNC server refuses the credential', async () => {
    const [client, browserEnd] = duplexPair()
    const [upstream, serverEnd] = duplexPair()
    const r = reader(serverEnd)
    void (async () => {
      serverEnd.write(Buffer.from('RFB 003.889\n', 'latin1'))
      await r.take(12)
      serverEnd.write(Buffer.from([1, 1]))
      await r.take(1)
      const result = Buffer.alloc(4)
      result.writeUInt32BE(1, 0)
      serverEnd.write(result)
    })()
    await expect(managedHandshake(client, upstream, { password: 'x' })).rejects.toThrow(RemoteDesktopError)
    browserEnd.destroy()
  }, 15_000)

  it('rejects when the upstream offers no manageable security type', async () => {
    const [client] = duplexPair()
    const [upstream, serverEnd] = duplexPair()
    const r = reader(serverEnd)
    void (async () => {
      serverEnd.write(Buffer.from('RFB 003.889\n', 'latin1'))
      await r.take(12)
      serverEnd.write(Buffer.from([2, 33, 36]))
    })()
    await expect(managedHandshake(client, upstream, { username: 'u', password: 'x' }))
      .rejects.toThrow(/no manageable security type/)
    client.destroy()
    upstream.destroy()
  })

  it('rejects ARD-only servers when no username is configured', async () => {
    const [client] = duplexPair()
    const [upstream, serverEnd] = duplexPair()
    const r = reader(serverEnd)
    void (async () => {
      serverEnd.write(Buffer.from('RFB 003.889\n', 'latin1'))
      await r.take(12)
      serverEnd.write(Buffer.from([1, 30]))
    })()
    await expect(managedHandshake(client, upstream, { password: 'x' }))
      .rejects.toThrow(/no username/)
    client.destroy()
    upstream.destroy()
  })

  it('returns bytes buffered past ClientInit and ServerInit as residuals', async () => {
    const [client, browserEnd] = duplexPair()
    const [upstream, serverEnd] = duplexPair()
    const server = reader(serverEnd)
    const browser = reader(browserEnd)
    const serverScript = (async () => {
      serverEnd.write(Buffer.from('RFB 003.889\n', 'latin1'))
      await server.take(12)
      serverEnd.write(Buffer.from([1, 1]))
      await server.take(1)
      serverEnd.write(Buffer.alloc(4))
      await server.take(1)
      serverEnd.write(Buffer.concat([serverInit('desk'), Buffer.from([0xaa])]))
    })()
    const browserScript = (async () => {
      await browser.take(12)
      browserEnd.write(Buffer.from('RFB 003.008\n', 'latin1'))
      await browser.take(2)
      browserEnd.write(Buffer.from([1]))
      await browser.take(4)
      browserEnd.write(Buffer.from([1, 0xbb]))
      await browser.take(28)
    })()
    const result = await managedHandshake(client, upstream, { password: 'x' })
    await Promise.all([serverScript, browserScript])
    expect(result.upstreamResidual.equals(Buffer.from([0xaa]))).toBe(true)
    expect(result.clientResidual.equals(Buffer.from([0xbb]))).toBe(true)
    client.destroy()
    upstream.destroy()
  }, 15_000)

  it('surfaces the upstream refusal reason verbatim', async () => {
    const [client] = duplexPair()
    const [upstream, serverEnd] = duplexPair()
    const r = reader(serverEnd)
    void (async () => {
      serverEnd.write(Buffer.from('RFB 003.889\n', 'latin1'))
      await r.take(12)
      const reason = Buffer.from('too busy', 'utf8')
      const head = Buffer.alloc(5)
      head.writeUInt32BE(reason.length, 1)
      serverEnd.write(Buffer.concat([head, reason]))
    })()
    await expect(managedHandshake(client, upstream, { password: 'x' }))
      .rejects.toThrow('refused security negotiation: too busy')
    client.destroy()
    upstream.destroy()
  }, 15_000)

  it('rejects a bad upstream banner and a browser preamble that is not RFB', async () => {
    const [client] = duplexPair()
    const [upstream, serverEnd] = duplexPair()
    void (async () => {
      serverEnd.write(Buffer.from('NOPE 000.000\n', 'latin1'))
    })()
    await expect(managedHandshake(client, upstream, { password: 'x' }))
      .rejects.toThrow('bad RFB banner')
    client.destroy()
    upstream.destroy()

    const [client2, browserEnd2] = duplexPair()
    const [upstream2, serverEnd2] = duplexPair()
    const r = reader(serverEnd2)
    const b = reader(browserEnd2)
    const script = (async () => {
      serverEnd2.write(Buffer.from('RFB 003.889\n', 'latin1'))
      await r.take(12)
      serverEnd2.write(Buffer.from([1, 1]))
      await r.take(1)
      serverEnd2.write(Buffer.alloc(4))
      await b.take(12)
      browserEnd2.write(Buffer.from('HTTP/1.1 400\n', 'latin1'))
    })()
    await expect(managedHandshake(client2, upstream2, { password: 'x' }))
      .rejects.toThrow('browser sent a bad RFB preamble')
    await script
    client2.destroy()
    upstream2.destroy()
  })
})

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

describe('serveStream with managed credentials', () => {
  it('rejects a config endpoint with username but no passwordRef at load', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(TestVnc, {
      endpoints: [{ nodeId: 'n1', host: '127.0.0.1', port: 5900, username: 'alice' }],
      grantsFile: ':memory:',
    })).rejects.toThrow('username without passwordRef')
  })

  it('splices a credential-managed stream and drops view-level input', async () => {
    const ctx = new Context()
    ctx.provide('credentials', {
      resolve: async (ref: unknown) => ref === 'VNC_PASS' ? { value: 's3cret', source: 'test' } : undefined,
    } as never)
    const fiber = await ctx.plugin(TestVnc, {
      endpoints: [{ nodeId: 'n1', host: '127.0.0.1', port: 5900, username: 'admin', passwordRef: 'VNC_PASS' }],
      grantsFile: ':memory:',
    })
    const svc = ctx.remoteDesktop as TestVnc
    try {
      await svc.grant(grantInput(), ADMIN)
      const request = { principal: 'alice', target: { nodeId: 'n1' }, level: 'view' as const }
      await svc.confirm(request)
      const session = await svc.attach(request)
      const [browserEnd, clientEnd] = duplexPair()
      const done = svc.serveStream(session.stream.token, clientEnd)
      await vi.waitFor(() => { expect(svc.servers.length).toBe(1) })
      const server = ardServer(svc.servers[0]!, { username: 'admin', password: 's3cret' })
      await browserPreamble(browserEnd)
      await server
      const upstreamReceived: Buffer[] = []
      svc.servers[0]!.on('data', (chunk: Buffer) => upstreamReceived.push(chunk))
      browserEnd.write(Buffer.concat([KEY_EVENT, FB_UPDATE_REQUEST]))
      await new Promise(resolve => setImmediate(resolve))
      expect(Buffer.concat(upstreamReceived).equals(FB_UPDATE_REQUEST)).toBe(true)
      browserEnd.destroy()
      await done
    } finally {
      await fiber.dispose()
    }
  }, 15_000)

  it('fails loud when passwordRef is set but no credentials provider resolves it', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(TestVnc, {
      endpoints: [{ nodeId: 'n1', host: '127.0.0.1', port: 5900, passwordRef: 'VNC_PASS' }],
      grantsFile: ':memory:',
    })
    const svc = ctx.remoteDesktop as TestVnc
    try {
      await svc.grant(grantInput(), ADMIN)
      const request = { principal: 'alice', target: { nodeId: 'n1' }, level: 'view' as const }
      await svc.confirm(request)
      const session = await svc.attach(request)
      const [, clientEnd] = duplexPair()
      await expect(svc.serveStream(session.stream.token, clientEnd))
        .rejects.toThrow(/no credentials provider/)
      expect(clientEnd.destroyed).toBe(true)
      expect((await svc.status({ principal: 'alice', admin: false }, { nodeId: 'n1' })).attachments).toBe(0)
    } finally {
      await fiber.dispose()
    }
  })
})
