import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import * as ArchiveGateway from '../src/index.ts'

interface ResponseState { status: number; body: string }

function response(): { value: ServerResponse; state: ResponseState } {
  const state: ResponseState = { status: 0, body: '' }
  return {
    state,
    value: {
      writeHead(status: number) { state.status = status; return this },
      end(body?: string) { state.body = body ?? ''; return this },
    } as unknown as ServerResponse,
  }
}

function event(type: SessionEvent['type'], seq: number, text: string): SessionEvent {
  return {
    type,
    seq,
    time: seq + 1,
    data: type === 'user/message'
      ? { content: [{ type: 'text', text }] }
      : { message: { content: [{ type: 'text', text }] } },
  } as SessionEvent
}

describe('archive-gateway runtime reader', () => {
  it('reads a root and its child sessions through the loopback route', async () => {
    const root = SessionId('archive-root')
    const child = SessionId('archive-child')
    const headers: SessionHeader[] = [
      { id: root, version: 0, createdAt: 1 },
      { id: child, version: 0, createdAt: 2, parentSession: root },
    ]
    const events = new Map<string, SessionEvent[]>([
      [root, [event('user/message', 0, 'hello')]],
      [child, [event('assistant/message', 0, 'world')]],
    ])
    const register = vi.fn()
    const ctx = new Context()
    ctx.provide('connection', { http: { handlePrefix: register } } as never)
    ctx.provide('gatewayRuntime', {
      requireCurrent: () => ({ claims: { user: { role: 'admin' }, purpose: 'archive-read' } }),
    } as never)
    ctx.provide('workspaceRegistry', {
      archiveSnapshot: () => ({ revision: 1, archivedSessionIds: [root] }),
      archivedEntries: async () => [],
      archivedSessionIds: [],
    } as never)
    ctx.provide('sessionPersistence', {
      list: async () => headers,
      readFrom: async (id: SessionId) => {
        const meta = headers.find(header => header.id === id)
        if (meta === undefined) throw new Error(`missing ${String(id)}`)
        return { meta, events: events.get(id) ?? [] }
      },
    } as never)
    await ctx.plugin(ArchiveGateway).await()
    const handler = register.mock.calls[0]?.[1] as (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const output = response()
    await handler({ method: 'GET', url: '/api/internal/archive/read?sessionId=archive-root&limit=10' } as IncomingMessage, output.value)
    expect(output.state.status).toBe(200)
    expect(JSON.parse(output.state.body)).toMatchObject({
      descendants: [
        { sessionId: 'archive-child', parentSessionId: 'archive-root' },
        { sessionId: 'archive-root', parentSessionId: null },
      ],
      events: [
        { sessionId: 'archive-child', data: { message: { content: [{ text: 'world', type: 'text' }] } } },
        { sessionId: 'archive-root', data: { content: [{ text: 'hello', type: 'text' }] } },
      ],
      hasMore: false,
    })
  })

  it('rejects a route call without the archive capability', async () => {
    const register = vi.fn()
    const ctx = new Context()
    ctx.provide('connection', { http: { handlePrefix: register } } as never)
    ctx.provide('gatewayRuntime', {
      requireCurrent: () => ({ claims: { user: { role: 'user' }, purpose: 'archive-read' } }),
    } as never)
    ctx.provide('workspaceRegistry', { archiveSnapshot: () => ({ revision: 0, archivedSessionIds: [] }), archivedEntries: async () => [] } as never)
    ctx.provide('sessionPersistence', { list: async () => [], readFrom: async () => ({ meta: {}, events: [] }) } as never)
    await ctx.plugin(ArchiveGateway).await()
    const handler = register.mock.calls[0]?.[1] as (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const output = response()
    await handler({ method: 'GET', url: '/api/internal/archive/read?sessionId=missing' } as IncomingMessage, output.value)
    expect(output.state).toEqual({ status: 403, body: JSON.stringify({ error: 'forbidden' }) })
  })
})
