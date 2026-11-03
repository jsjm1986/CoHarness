/** Refused archive snapshots release their real HTTP response before a later sync. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import ArchiveGateway from '../src/index.ts'

it('closes an unfinished refused snapshot response while synchronization remains active', async () => {
  const ctx = new Context()
  const sockets = new Set<Socket>()
  const closed = vi.fn()
  let snapshots = 0
  const server = createServer((request, response) => {
    request.resume()
    if (request.url?.endsWith('/snapshot') === true && ++snapshots === 1) {
      response.once('close', closed)
      response.writeHead(503, { 'content-type': 'application/json' })
      response.flushHeaders()
      response.write('{"unfinished":')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ commands: [] }))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
  })
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Archive fixture requires a loopback port')
    ctx.provide('connection', { http: { handlePrefix: () => () => {} } } as never)
    ctx.provide('gatewayRuntime', { request: (path: string, init: RequestInit) => fetch(`http://127.0.0.1:${address.port}${path}`, init) } as never)
    ctx.provide('workspaceRegistry', { archiveSnapshot: () => ({ revision: 1, archivedSessionIds: [] }),
      archivedEntries: async () => [], archivedSessionIds: [] } as never)
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    await ctx.plugin(ArchiveGateway, { commandPollMs: 60_000 })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive snapshot rejected with HTTP 503')) })
    await vi.waitFor(() => { expect(closed).toHaveBeenCalledOnce() })
    ctx.emit('workspace/archive-changed', { revision: 2, archivedSessionIds: [] } as never)
    await vi.waitFor(() => { expect(snapshots).toBe(2) })
    expect(warn).toHaveBeenCalledOnce()
  } finally {
    try { await ctx.fiber.dispose() } finally {
      warn.mockRestore()
      for (const socket of sockets) socket.destroy()
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error !== undefined) reject(error); else resolve() })
      })
    }
  }
})

it.each(['snapshot', 'ack', 'pending'] as const)('retains the %s HTTP refusal when unused-body cancellation rejects', async (operation) => {
  const ctx = new Context(), root = SessionId('archive-cleanup-root')
  const cancelled = vi.fn()
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const request = async (path: string): Promise<Response> => {
    if (path.endsWith(`/${operation}`)) return new Response(new ReadableStream({
      cancel: () => { cancelled(); throw new Error('response cleanup failed') },
    }), { status: 503 })
    return Response.json(path.endsWith('/pending') ? { pending: false }
      : path.endsWith('/ack') ? { acknowledged: true }
        : { commands: operation === 'ack' ? [{ id: 'restore', rootSessionId: root, action: 'restore' }] : [] })
  }
  try {
    ctx.provide('connection', { http: { handlePrefix: () => () => {} } } as never)
    ctx.provide('gatewayRuntime', { request } as never)
    ctx.provide('workspaceRegistry', { archiveSnapshot: () => ({ revision: 1, archivedSessionIds: [] }),
      archivedEntries: async () => [], archivedSessionIds: [root], unarchiveSession: async () => {} } as never)
    ctx.provide('sessionPersistence', { list: async () => [{ header: { id: root } }] } as never)
    await ctx.plugin(ArchiveGateway, { commandPollMs: 10 })
    const message = operation === 'snapshot' ? 'archive snapshot rejected' : operation === 'ack'
      ? 'archive command acknowledgement failed' : 'archive command probe rejected'
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${message} with HTTP 503`)) })
    expect(cancelled).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join('\n')).not.toContain('response cleanup failed')
  } finally { try { await ctx.fiber.dispose() } finally { warn.mockRestore() } }
})
