/**
 * Real-composition guard: the shipped provider boots from a test-only
 * cordis.yml through the actual Loader + Include path, persists grants to its
 * JSONL store, converges on external rewrites of both file contracts, and
 * enforces the view filter over a real TCP dial — no hand-built ctx.plugin.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type Server, type Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { RemoteDesktopError } from '@deepseek-ai/dsh-remote-desktop'
import VncRemoteDesktop from '../src/index.ts'

const HANDSHAKE = Buffer.concat([Buffer.from('RFB 003.008\n', 'latin1'), Buffer.from([1, 1])])
const KEY_EVENT = Buffer.from([3, 1, 0, 0, 0, 0, 0, 0x61])

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

function duplexPair(): [Duplex, Duplex] {
  const a = new Loopback()
  const b = new Loopback()
  a.peer = b
  b.peer = a
  return [a, b]
}

let root: string | undefined
let context: Context | undefined
const servers: Server[] = []
const sockets: Socket[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => { resolve() }))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A real TCP listener standing in for a VNC endpoint; returns its port and received-byte log. */
async function fakeVnc(): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = []
  const server = createServer((socket) => {
    sockets.push(socket)
    socket.on('data', (chunk: Buffer) => received.push(chunk))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('listener has no port')
  return { port: address.port, received }
}

async function loadComposition(): Promise<{ ctx: Context; grantsFile: string; endpointsFile: string; auditFile: string }> {
  const ctx = context = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-remote-desktop-vnc', VncRemoteDesktop]])
  const unreachable = (name: string) => () => { throw new Error(`unreachable ModuleLoader.${name}`) }
  ctx.loader.internal = {
    version: 'v2',
    loadCache: new Map(),
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register: unreachable('register'),
    getOrCreateModuleJob: unreachable('getOrCreateModuleJob'),
    resolveSync: unreachable('resolveSync'),
    load: unreachable('load'),
  }
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(root!, 'cordis.yml')).href },
  })
  await ctx.loader.await()
  return { ctx, grantsFile: join(root!, 'grants.jsonl'), endpointsFile: join(root!, 'endpoints.json'), auditFile: join(root!, 'audit.jsonl') }
}

describe('remote-desktop-vnc real composition', () => {
  it('boots from cordis.yml, converges on external file writes, and filters a real stream', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-remote-desktop-composition-'))
    const upstream = await fakeVnc()
    const endpointsFile = join(root, 'endpoints.json')
    const grantsFile = join(root, 'grants.jsonl')
    const auditFile = join(root, 'audit.jsonl')
    await writeFile(endpointsFile, JSON.stringify({ endpoints: [{ nodeId: 'n1', host: '127.0.0.1', port: upstream.port }] }) + '\n')
    await writeFile(join(root, 'cordis.yml'), [
      '- id: remote-desktop-vnc',
      "  name: '@deepseek-ai/dsh-remote-desktop-vnc'",
      '  config:',
      `    endpointsFile: ${JSON.stringify(endpointsFile)}`,
      `    grantsFile: ${JSON.stringify(grantsFile)}`,
      `    auditFile: ${JSON.stringify(auditFile)}`,
    ].join('\n'))

    const { ctx } = await loadComposition()
    const svc = ctx.remoteDesktop
    expect(svc).toBeInstanceOf(VncRemoteDesktop)
    const admin = { principal: 'root', admin: true }

    // Grant administration commits to the JSONL store.
    const row = await svc.grant({
      target: { nodeId: 'n1' }, principal: 'alice', level: 'view',
      scope: { kind: 'machine' }, recording: false, grantedBy: 'root',
    }, admin)
    const stored = await readFile(grantsFile, 'utf8')
    expect(stored).toContain(`"id":"${row.id}"`)

    // An external writer replacing grants.jsonl converges through refresh: a
    // foreign row becomes visible without a restart.
    await writeFile(grantsFile, stored + JSON.stringify({
      id: 'external-1', target: { nodeId: 'n1' }, principal: 'carol', level: 'control',
      scope: { kind: 'machine' }, recording: false, grantedBy: 'root', createdAt: Date.now(),
    }) + '\n')
    expect((await svc.resolve({ principal: 'carol', target: { nodeId: 'n1' }, level: 'control' })).grants).toHaveLength(1)

    // An external endpoints.json rewrite converges the same way: resolve for
    // the newly published target dials its freshly configured endpoint.
    const second = await fakeVnc()
    await writeFile(endpointsFile, JSON.stringify({ endpoints: [
      { nodeId: 'n1', host: '127.0.0.1', port: upstream.port },
      { nodeId: 'n2', host: '127.0.0.1', port: second.port },
    ] }) + '\n')
    await svc.grant({
      target: { nodeId: 'n2' }, principal: 'alice', level: 'view',
      scope: { kind: 'machine' }, recording: false, grantedBy: 'root',
    }, admin)
    const request = { principal: 'alice', target: { nodeId: 'n2' }, level: 'view' as const }
    await svc.confirm(request)
    const session = await svc.attach(request)
    const [browserEnd, clientEnd] = duplexPair()
    const done = svc.serveStream(session.stream.token, clientEnd)
    browserEnd.write(Buffer.concat([HANDSHAKE, KEY_EVENT]))
    await vi.waitFor(() => { expect(Buffer.concat(second.received).length).toBeGreaterThanOrEqual(HANDSHAKE.length) }, { timeout: 2_000 })
    browserEnd.destroy()
    await done
    const received = Buffer.concat(second.received)
    expect(received.includes(KEY_EVENT)).toBe(false)
    expect((await readFile(auditFile, 'utf8'))).toContain('"attach"')
  })

  it('fails loud on a corrupt endpoints file without losing the last good map', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-remote-desktop-composition-'))
    const upstream = await fakeVnc()
    const endpointsFile = join(root, 'endpoints.json')
    const grantsFile = join(root, 'grants.jsonl')
    await writeFile(endpointsFile, JSON.stringify({ endpoints: [{ nodeId: 'n1', host: '127.0.0.1', port: upstream.port }] }) + '\n')
    await writeFile(join(root, 'cordis.yml'), [
      '- id: remote-desktop-vnc',
      "  name: '@deepseek-ai/dsh-remote-desktop-vnc'",
      '  config:',
      `    endpointsFile: ${JSON.stringify(endpointsFile)}`,
      `    grantsFile: ${JSON.stringify(grantsFile)}`,
    ].join('\n'))

    const { ctx } = await loadComposition()
    const svc = ctx.remoteDesktop
    const admin = { principal: 'root', admin: true }
    await svc.grant({
      target: { nodeId: 'n1' }, principal: 'alice', level: 'view',
      scope: { kind: 'machine' }, recording: false, grantedBy: 'root',
    }, admin)
    expect((await svc.status({ principal: 'alice', admin: false }, { nodeId: 'n1' })).available).toBe(true)

    // Corrupt rewrite: every call retries and keeps failing loudly until the
    // file parses again — a bad write cannot silently empty the endpoint table.
    await writeFile(endpointsFile, '{"endpoints": ')
    await expect(svc.status({ principal: 'alice', admin: false }, { nodeId: 'n1' })).rejects.toThrow(RemoteDesktopError)
    await expect(svc.status({ principal: 'alice', admin: false }, { nodeId: 'n1' })).rejects.toThrow(RemoteDesktopError)

    // The next good write recovers the endpoint without a restart.
    await writeFile(endpointsFile, JSON.stringify({ endpoints: [{ nodeId: 'n1', host: '127.0.0.1', port: upstream.port }] }) + '\n')
    expect((await svc.status({ principal: 'alice', admin: false }, { nodeId: 'n1' })).available).toBe(true)
  })
})
