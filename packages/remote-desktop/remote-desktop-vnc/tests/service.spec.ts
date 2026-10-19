/**
 * Tests for the VNC provider through `ctx.remoteDesktop`: admin-gated grant
 * administration, resolve/attach enforcement, the filtered view-only stream,
 * token single-use, detach bookkeeping, and principal-scoped audit queries.
 * The dial seam is faked with in-memory duplexes; no ports or listeners.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteDesktopError } from '@deepseek-ai/dsh-remote-desktop'
import type { RemoteDesktopGrantInput } from '@deepseek-ai/dsh-remote-desktop'
import { VncRemoteDesktop } from '../src/index.ts'

const ADMIN = { principal: 'root', admin: true }
const HANDSHAKE = Buffer.concat([Buffer.from('RFB 003.008\n', 'latin1'), Buffer.from([1, 1])])
const KEY_EVENT = Buffer.from([3, 1, 0, 0, 0, 0, 0, 0x61])
const FB_UPDATE_REQUEST = Buffer.from([2, 0, 0, 0, 0, 0, 4, 0, 3, 0])

/** One end of an in-memory socket pair: writes push to `peer`; destroy closes both ends. */
class Loopback extends Duplex {
  peer!: Loopback

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.peer.push(chunk)
    callback()
  }

  _read(_size: number): void {}

  _final(callback: (error?: Error | null) => void): void {
    this.peer.push(null)
    callback()
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
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

describe('VncRemoteDesktop', () => {
  let ctx: Context
  let svc: TestVnc
  let fiber: Awaited<ReturnType<Context['plugin']>>

  beforeEach(async () => {
    ctx = new Context()
    fiber = await ctx.plugin(TestVnc, {
      endpoints: [{ nodeId: 'n1', host: '127.0.0.1', port: 5900 }],
      grantsFile: ':memory:',
    })
    svc = ctx.remoteDesktop as TestVnc
  })
  afterEach(async () => {
    await fiber.dispose()
  })

  it('rejects grant administration from a non-admin actor', async () => {
    await expect(svc.grant(grantInput(), { principal: 'mallory', admin: false })).rejects.toThrow(RemoteDesktopError)
  })

  it('rejects attach without a grant and widened level requests', async () => {
    const request = { principal: 'alice', target: { nodeId: 'n1' }, level: 'view' as const }
    await expect(svc.resolve(request)).rejects.toThrow(RemoteDesktopError)
    await svc.grant(grantInput(), ADMIN)
    await expect(svc.resolve({ ...request, level: 'control' })).rejects.toThrow(RemoteDesktopError)
    expect((await svc.resolve(request)).level).toBe('view')
  })

  it('enforces session-scoped grants by session address and expiry', async () => {
    await svc.grant(grantInput({
      scope: { kind: 'session', sessionId: SessionId('s1'), expiresAt: Date.now() + 60_000 },
    }), ADMIN)
    const base = { principal: 'alice', target: { nodeId: 'n1' }, level: 'view' as const }
    await expect(svc.resolve(base)).rejects.toThrow(RemoteDesktopError)
    await expect(svc.resolve({ ...base, sessionId: SessionId('s2') })).rejects.toThrow(RemoteDesktopError)
    expect((await svc.resolve({ ...base, sessionId: SessionId('s1') })).grants).toHaveLength(1)
  })

  it('drops input frames on a view attachment and records the lifecycle', async () => {
    await svc.grant(grantInput(), ADMIN)
    const session = await svc.attach({ principal: 'alice', target: { nodeId: 'n1' }, level: 'view' })
    const [browserEnd, clientEnd] = duplexPair()
    const done = svc.serveStream(session.stream.token, clientEnd)
    await new Promise(resolve => setImmediate(resolve))
    const received: Buffer[] = []
    svc.servers[0].on('data', (chunk: Buffer) => received.push(chunk))
    browserEnd.write(Buffer.concat([HANDSHAKE, KEY_EVENT, FB_UPDATE_REQUEST]))
    await new Promise(resolve => setImmediate(resolve))
    expect(Buffer.concat(received).equals(Buffer.concat([HANDSHAKE, FB_UPDATE_REQUEST]))).toBe(true)
    browserEnd.destroy()
    await done
    const kinds = (await svc.audit(ADMIN)).map(e => e.kind)
    expect(kinds).toEqual(['detach', 'attach', 'grant'])
    expect((await svc.status({ principal: 'alice', admin: false }, { nodeId: 'n1' })).attachments).toBe(0)
  })

  it('passes input frames through on a control attachment', async () => {
    await svc.grant(grantInput({ level: 'control' }), ADMIN)
    const session = await svc.attach({ principal: 'alice', target: { nodeId: 'n1' }, level: 'control' })
    const [browserEnd, clientEnd] = duplexPair()
    const done = svc.serveStream(session.stream.token, clientEnd)
    await new Promise(resolve => setImmediate(resolve))
    const received: Buffer[] = []
    svc.servers[0].on('data', (chunk: Buffer) => received.push(chunk))
    browserEnd.write(Buffer.concat([HANDSHAKE, KEY_EVENT]))
    await new Promise(resolve => setImmediate(resolve))
    expect(Buffer.concat(received).equals(Buffer.concat([HANDSHAKE, KEY_EVENT]))).toBe(true)
    browserEnd.destroy()
    await done
  })

  it('consumes attach tokens exactly once', async () => {
    await svc.grant(grantInput(), ADMIN)
    const session = await svc.attach({ principal: 'alice', target: { nodeId: 'n1' }, level: 'view' })
    const [browserEnd, clientEnd] = duplexPair()
    const done = svc.serveStream(session.stream.token, clientEnd)
    const [otherBrowserEnd, otherClientEnd] = duplexPair()
    await expect(svc.serveStream(session.stream.token, otherClientEnd)).rejects.toThrow(RemoteDesktopError)
    otherBrowserEnd.destroy()
    browserEnd.destroy()
    await done
  })

  it('scopes listGrants and audit to the caller for non-admin actors', async () => {
    await svc.grant(grantInput(), ADMIN)
    await svc.grant(grantInput({ principal: 'bob' }), ADMIN)
    expect(await svc.listGrants({ principal: 'alice', admin: false })).toHaveLength(1)
    expect(await svc.listGrants(ADMIN)).toHaveLength(2)
    const aliceEvents = await svc.audit({ principal: 'alice', admin: false })
    expect(aliceEvents).toHaveLength(0)
  })

  it('revokes access and audits set-level escalation over a live attachment', async () => {
    const row = await svc.grant(grantInput(), ADMIN)
    const session = await svc.attach({ principal: 'alice', target: { nodeId: 'n1' }, level: 'view' })
    await svc.setLevel(row.id, 'control', ADMIN)
    const events = await svc.audit(ADMIN)
    expect(events.map(e => e.kind)).toEqual(['level-escalate', 'set-level', 'attach', 'grant'])
    await svc.revoke(row.id, ADMIN)
    await expect(svc.resolve({ principal: 'alice', target: { nodeId: 'n1' }, level: 'view' })).rejects.toThrow(RemoteDesktopError)
    await session.detach()
  })

  it('reports endpoint availability through status', async () => {
    await svc.grant(grantInput(), ADMIN)
    const status = await svc.status({ principal: 'alice', admin: false }, { nodeId: 'n1' })
    expect(status).toEqual({ target: { nodeId: 'n1' }, available: true, attachments: 0 })
  })

  it('fails a stream when the grant requires recording without a sink', async () => {
    await svc.grant(grantInput({ recording: true }), ADMIN)
    const session = await svc.attach({ principal: 'alice', target: { nodeId: 'n1' }, level: 'view' })
    const [, clientEnd] = duplexPair()
    await expect(svc.serveStream(session.stream.token, clientEnd)).rejects.toThrow(RemoteDesktopError)
  })
})
