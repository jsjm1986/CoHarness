/** Real Cordis consumers retain in-flight VNC transports and audit writes through provider withdrawal. */
import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { RemoteDesktopToken, type RemoteDesktop } from '@deepseek-ai/dsh-remote-desktop'
import { describe, expect, it, vi } from 'vitest'
import { VncRemoteDesktop } from '../src/index.ts'
import { VncAuditLog } from '../src/audit.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, appendFile: vi.fn(actual.appendFile) }
})

class Transport extends Duplex {
  override _read(): void {}
  override _write(_bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void { done() }
}

const request = { principal: 'alice', target: { nodeId: 'fixture' }, level: 'view' as const }

async function authorize(service: RemoteDesktop) {
  await service.grant({ ...request, scope: { kind: 'machine' }, recording: false, grantedBy: 'root' }, { principal: 'root', admin: true })
  await service.confirm(request)
  return service.attach(request)
}

async function consume(ctx: Context): Promise<RemoteDesktop> {
  let service!: RemoteDesktop
  const consumer = (scope: Context) => { service = scope.remoteDesktop }
  consumer.inject = ['remoteDesktop']
  await ctx.plugin(consumer)
  return service
}

describe('VNC provider shutdown', () => {
  it('refuses new work and waits for a delayed dial without installing a late pump', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const disposing = Promise.withResolvers<undefined>(), upstream = new Transport(), browser = new Transport(), late = new Transport()
    class DelayedVnc extends VncRemoteDesktop {
      protected override async dial(): Promise<Duplex> { entered.resolve(undefined); await release.promise; return upstream }
    }
    await using owner = { ctx: new Context(), async [Symbol.asyncDispose]() { await this.ctx.fiber.dispose() } }
    const ctx = owner.ctx
    const provider = await ctx.plugin(DelayedVnc, { endpoints: [{ nodeId: 'fixture', host: '127.0.0.1', port: 5900 }] })
    provider.ctx.effect(() => () => { disposing.resolve(undefined) })
    const service = await consume(ctx), session = await authorize(service)
    const stream = Promise.allSettled([service.serveStream(session.stream.token, browser)])
    let closed = false
    let closing: Promise<void> | undefined
    try {
      await entered.promise
      closing = provider.dispose().then(() => { closed = true })
      await disposing.promise
      await expect(service.attach(request)).rejects.toMatchObject({ code: 'REMOTE_DESKTOP_TARGET_UNAVAILABLE' })
      await expect(service.serveStream(RemoteDesktopToken('late-token'), late)).rejects.toMatchObject({ code: 'REMOTE_DESKTOP_TARGET_UNAVAILABLE' })
      expect(late.destroyed).toBe(true)
      expect(closed).toBe(false)
      release.resolve(undefined)
      await Promise.all([closing, stream])
      expect(upstream.destroyed).toBe(true)
      expect(browser.destroyed).toBe(true)
      expect(upstream.listenerCount('data')).toBe(0)
      expect(browser.listenerCount('data')).toBe(0)
      expect(ctx.get('remoteDesktop')).toBeUndefined()
    } finally {
      release.resolve(undefined); upstream.destroy(); browser.destroy(); late.destroy()
      await stream; await closing
    }
  })

  it('cancels a managed-credential handshake before a stream pump starts', async () => {
    const credentialsEntered = Promise.withResolvers<undefined>(), releaseCredentials = Promise.withResolvers<undefined>()
    const disposing = Promise.withResolvers<undefined>(), upstream = new Transport(), browser = new Transport()
    class ConnectedVnc extends VncRemoteDesktop {
      protected override dial(): Promise<Duplex> { return Promise.resolve(upstream) }
    }
    await using owner = { ctx: new Context(), async [Symbol.asyncDispose]() { await this.ctx.fiber.dispose() } }
    const ctx = owner.ctx
    ctx.provide('credentials', { resolve: async () => {
      credentialsEntered.resolve(undefined); await releaseCredentials.promise
      return { value: 'fixture-secret' }
    } } as never)
    const provider = await ctx.plugin(ConnectedVnc, {
      endpoints: [{ nodeId: 'fixture', host: '127.0.0.1', port: 5900, passwordRef: 'FIXTURE_VNC_PASSWORD' }],
    })
    provider.ctx.effect(() => () => { disposing.resolve(undefined) })
    const service = await consume(ctx), session = await authorize(service)
    const stream = Promise.allSettled([service.serveStream(session.stream.token, browser)])
    let closed = false
    let closing: Promise<void> | undefined
    try {
      await credentialsEntered.promise
      closing = provider.dispose().then(() => { closed = true })
      await disposing.promise
      expect(closed).toBe(false)
      expect(browser.destroyed).toBe(true)
      expect(upstream.destroyed).toBe(true)
      releaseCredentials.resolve(undefined)
      await Promise.all([closing, stream])
      expect(upstream.listenerCount('data')).toBe(0)
      expect(browser.listenerCount('data')).toBe(0)
    } finally {
      releaseCredentials.resolve(undefined); upstream.destroy(); browser.destroy()
      await stream; await closing
    }
  })

  it('does not finish provider disposal before its queued audit record reaches disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-vnc-audit-drain-')), file = join(root, 'audit.jsonl')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const draining = Promise.withResolvers<undefined>()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const append = vi.mocked(appendFile).mockImplementation(async (...args) => {
      if (args[0] === file) { entered.resolve(undefined); await release.promise }
      await actual.appendFile(...args)
    })
    const originalDrain = Object.getOwnPropertyDescriptor(VncAuditLog.prototype, 'drain')?.value as
      ((this: VncAuditLog) => Promise<void>) | undefined
    if (originalDrain === undefined) throw new Error('Missing VNC audit drain method')
    const observation = vi.spyOn(VncAuditLog.prototype, 'drain').mockImplementation(async function (this: VncAuditLog) {
      draining.resolve(undefined); await originalDrain.call(this)
    })
    const ctx = new Context()
    let closing: Promise<void> | undefined
    try {
      const provider = await ctx.plugin(VncRemoteDesktop, { auditFile: file })
      const service = await consume(ctx)
      await service.grant({ ...request, scope: { kind: 'machine' }, recording: false, grantedBy: 'root' }, { principal: 'root', admin: true })
      await entered.promise
      let closed = false
      closing = provider.dispose().then(() => { closed = true })
      await draining.promise
      expect(closed).toBe(false)
      await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      release.resolve(undefined)
      await closing
      const rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string })
      expect(rows.map(row => row.kind)).toEqual(['grant'])
    } finally {
      release.resolve(undefined); await closing; await ctx.fiber.dispose()
      observation.mockRestore(); append.mockImplementation(actual.appendFile)
      await rm(root, { recursive: true, force: true })
    }
  })
})
