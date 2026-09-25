/** Addressed Tool history preserves turn context and the ordinary authorization path. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { CollaborationError } from '@deepseek-ai/dsh-collaboration'
import { createApiProxy } from '../src/api-proxy.ts'
import { RpcId } from '../src/api/rpc.ts'
import { sessionHistoryRequestSchema } from '../src/api/sessions.schema.ts'
import { subagentHistoryRequestSchema } from '../src/api/subagents.schema.ts'
import { toolHistoryTurn } from '../src/fetch/tool-history.ts'

const SID = SessionId('tool-history-session')
const CALL = ToolCallId('tool-history-call')
// Only lookup fields are relevant to these raw-window tests; production events
// enter through the Session log decoder, which owns complete payload validation.
function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, data, seq: SessionSeq(seq), time: seq } as SessionEvent
}
const events = [
  event('turn/start', { turn: 1 }, 0),
  event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1),
  event('turn/start', { turn: 2 }, 2),
  event('tool/call', { callId: CALL, name: 'read', arguments: '{"path":"old.txt"}', turn: 2, step: 1 }, 3),
  event('tool/ptc-dispatch-start', { rootCallId: CALL, subCallId: ToolCallId('nested') }, 4),
  event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 5),
  event('turn/start', { turn: 3 }, 6),
]

async function harness(parentSession?: ReturnType<typeof SessionId>) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  const release = vi.fn()
  const observe = vi.fn(async () => ({
    source: 'prepared' as const,
    header: { version: SESSION_FORMAT_VERSION, id: SID, createdAt: 0, cwd: '/workspace', isSeeded: false, ...(parentSession === undefined ? {} : { parentSession }) },
    inheritedEventCount: SessionLogOffset(0), events, cursor: SessionSeq(6),
    [Symbol.dispose]: release,
  }))
  ctx.provide('sessionQuery', { observeSession: observe } as never)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/workspace' })
  return { ctx, api, observe, release }
}
const request = () => ({ rpcId: RpcId('tool-read'), payload: { sessionId: SID, toolCallId: CALL } })

describe('Tool history selection', () => {
  it('returns only the complete owning turn for root and nested calls', () => {
    expect(toolHistoryTurn(events, CALL)).toEqual(events.slice(2, 6))
    expect(toolHistoryTurn(events, ToolCallId('nested'))).toEqual(events.slice(2, 6))
    expect(toolHistoryTurn(events, ToolCallId('missing'))).toEqual([])
    expect(toolHistoryTurn(events.slice(0, 5), CALL)).toEqual(events.slice(2, 5))
  })

  it.each([sessionHistoryRequestSchema, subagentHistoryRequestSchema])('rejects mixed call and page selectors on the wire', (schema) => {
    const base = { sessionId: SID, parentSessionId: SID, childSessionId: SessionId('child'), mode: 'continuable', toolCallId: CALL }
    expect(schema.safeParse(base).success).toBe(true)
    for (const extra of [{ beforeSeq: 20 }, { maxMessages: 2 }, { detail: 'conversation' }, { toolCallId: '' }]) {
      expect(schema.safeParse({ ...base, ...extra }).success).toBe(false)
    }
  })

  it('reads a prepared Session without creating an Agent or changing the ordinary window', async () => {
    const { ctx, api, observe, release } = await harness()
    try {
      const result = await api.sessions.history(request())
      expect(result.result).toEqual({ ok: true, value: { events: events.slice(2, 6).map(event => ({ event })), hasMore: false } })
      expect(observe).toHaveBeenCalledWith(SID, { projectionMode: 'none' })
      expect(release).toHaveBeenCalledOnce()
      expect(ctx.agents.get(SID)).toBeUndefined()
      expect(ctx.sessions.get(SID)).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects unauthorized calls before loading a cold Session', async () => {
    const { ctx, api, observe } = await harness()
    ctx.provide('collaboration', { capture: () => ({ authorize: () => { throw new CollaborationError('forbidden') } }) } as never)
    try {
      expect((await api.sessions.history(request())).result).toMatchObject({ ok: false, error: { code: 'collaboration-forbidden' } })
      expect(observe).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('disposes a completed observation when cancellation arrives during the read', async () => {
    const { ctx, api, observe, release } = await harness()
    const original = observe.getMockImplementation()!
    const controller = new AbortController()
    observe.mockImplementation(async () => {
      const observation = await original()
      controller.abort()
      return observation
    })
    try {
      expect((await api.sessions.history(request(), controller.signal)).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
      expect(release).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
  it('checks both parent and child authority before an addressed child read', async () => {
    const parent = SessionId('parent')
    const { ctx, api, observe, release } = await harness(parent)
    const authorize = vi.fn(async () => undefined)
    ctx.provide('collaboration', { capture: () => ({ authorize }) } as never)
    ctx.provide('subagents', { listChildren: async () => [{ kind: 'child', id: SID, mode: 'continuable' }] } as never)
    const payload = { parentSessionId: parent, childSessionId: SID, mode: 'continuable' as const, toolCallId: CALL }
    try {
      expect((await api.subagents.history({ rpcId: RpcId('child-read'), payload })).result).toMatchObject({ ok: true, value: { hasMore: false } })
      expect(authorize.mock.calls).toEqual([[parent, 'read'], [SID, 'read']])
      expect(release).toHaveBeenCalledOnce()
      authorize.mockImplementation(async () => { throw new CollaborationError('forbidden') })
      observe.mockClear()
      expect((await api.subagents.history({ rpcId: RpcId('denied-child-read'), payload })).result.ok).toBe(false)
      expect(observe).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses a child whose durable parent changed after catalog lookup', async () => {
    const { ctx, api, release } = await harness(SessionId('other-parent'))
    ctx.provide('subagents', { listChildren: async () => [{ kind: 'child', id: SID, mode: 'continuable' }] } as never)
    try {
      expect((await api.subagents.history({ rpcId: RpcId('wrong-parent'), payload: {
        parentSessionId: SessionId('parent'), childSessionId: SID, mode: 'continuable', toolCallId: CALL,
      } })).result.ok).toBe(false)
      expect(release).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })

})
