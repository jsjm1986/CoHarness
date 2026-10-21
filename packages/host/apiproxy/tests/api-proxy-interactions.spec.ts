/**
 * Connection interaction-participation mode: a request scope bound to 'none'
 * never receives answerable or settlement mux frames, forwarded remote events
 * stop arriving on the host stream, `respond` refuses before the pending
 * registries, and two answer-capable claims on one interaction resolve
 * atomically with exactly one winner.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId as mintRpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { bindRequestInteractions, requestInteractions } from '../src/api/request-scope.ts'
import type { ConnectionInteractions } from '../src/api/interactions.ts'
import { createApiProxy } from '../src/api-proxy.ts'

async function harness(): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ApprovalService)
  ctx.provide('workspaceRegistry', {
    list: () => [],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    archiveRevision: 0,
    archiveSnapshot: () => ({ revision: 0, archivedSessionIds: [] }),
  } as never)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { ctx, api }
}

/** A minimal agent stand-in inside an open turn (the service only reaches `.session`). */
function agentOf(ctx: Context): Agent {
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  return { id: session.id, session, status: 'idle' } as Agent
}

/** Call one api method inside a bound interaction scope, like the Connection waterfall does. */
async function scoped<T>(interactions: ConnectionInteractions, run: () => Promise<T>): Promise<T> {
  let result: T | undefined
  await bindRequestInteractions(interactions, async () => { result = await run() })
  return result as T
}

/** Open a mux stream inside a bound scope and capture frames into an array. */
async function openMux(
  api: ApiProxy,
  interactions: ConnectionInteractions,
  abort: AbortController,
): Promise<{ frames: MuxFrame[]; envelopes: RpcRequest<MuxFrame>[] }> {
  const frames: MuxFrame[] = []
  const envelopes: RpcRequest<MuxFrame>[] = []
  const stream = await scoped(interactions, () => Promise.resolve(api.events.mux({ rpcId: mintRpcId('t-mux'), payload: {} }, abort.signal)))
  void (async () => {
    for await (const envelope of stream) {
      frames.push(envelope.payload)
      envelopes.push(envelope)
    }
  })()
  return { frames, envelopes }
}

/** Open a host stream inside a bound scope and capture frames into an array. */
async function openHost(
  api: ApiProxy,
  interactions: ConnectionInteractions,
  abort: AbortController,
): Promise<{ frames: HostFrame[] }> {
  const frames: HostFrame[] = []
  const stream = await scoped(interactions, () => Promise.resolve(api.events.host({ rpcId: mintRpcId('t-host'), payload: {} }, abort.signal)))
  void (async () => {
    for await (const envelope of stream) frames.push(envelope.payload)
  })()
  return { frames }
}

/** Bounded wait until `count` frames of `type` were delivered. */
async function waitForCount(mux: { frames: MuxFrame[] }, type: MuxFrame['type'], count: number): Promise<void> {
  for (let i = 0; i < 200 && mux.frames.filter(frame => frame.type === type).length < count; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(mux.frames.filter(frame => frame.type === type).length).toBeGreaterThanOrEqual(count)
}

/** Give asynchronous publications a bounded window to (not) arrive. */
async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

function answer(rpcId: RpcId, sessionId: unknown, approvalId: ApprovalRequestId, outcome: 'allowed-once' | 'rejected'): Parameters<ApiProxy['respond']>[0] {
  return { type: 'client-response', rpcId, result: { ok: true, value: { sessionId, approvalId, outcome } } }
}

describe('connection interaction-participation scope', () => {
  it('delivers no answerable or settlement mux frames to a none scope', async () => {
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const noneMux = await openMux(api, 'none', abort)
    const answerMux = await openMux(api, 'answer', abort)
    const agent = agentOf(ctx)

    const asked = ctx.approval.request({ agent, toolName: 'bash', reason: 'escalate' })
    await waitForCount(answerMux, 'approval/requested', 1)
    await settled()
    // The 'none' stream still carries ordinary session traffic — only the
    // interaction family is suppressed.
    expect(noneMux.frames.some(frame => frame.type === 'session/subscribed')).toBe(true)
    expect(noneMux.frames.filter(frame => frame.type.startsWith('approval/') || frame.type.startsWith('question/'))).toEqual([])

    const envelope = answerMux.envelopes.find(e => e.payload.type === 'approval/requested') as RpcRequest<MuxFrame>
    const requested = envelope.payload as Extract<MuxFrame, { type: 'approval/requested' }>
    const receipt = await api.respond(answer(envelope.rpcId, requested.sessionId, requested.approvalId, 'allowed-once'))
    expect(receipt).toEqual({ accepted: true })
    await expect(asked).resolves.toBe('allowed-once')
    await waitForCount(answerMux, 'approval/resolved', 1)
    await settled()
    expect(noneMux.frames.filter(frame => frame.type.startsWith('approval/'))).toEqual([])
    abort.abort()
  })

  it('replays a still-pending interaction to an answer scope but never to a none scope', async () => {
    const { ctx, api } = await harness()
    const agent = agentOf(ctx)
    const asked = ctx.approval.request({ agent, toolName: 'bash', reason: 'escalate' })
    asked.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 20))

    const noneMux = await openMux(api, 'none', new AbortController())
    const answerMux = await openMux(api, 'answer', new AbortController())
    await waitForCount(answerMux, 'approval/requested', 1)
    await settled()
    expect(noneMux.frames.filter(frame => frame.type === 'approval/requested')).toEqual([])
    asked.catch(() => {})
  })

  it('refuses respond under a none scope before reaching the pending registry', async () => {
    const { ctx, api } = await harness()
    const agent = agentOf(ctx)
    const answerMux = await openMux(api, 'answer', new AbortController())
    const asked = ctx.approval.request({ agent, toolName: 'bash', reason: 'escalate' })
    asked.catch(() => {})
    await waitForCount(answerMux, 'approval/requested', 1)
    const envelope = answerMux.envelopes.find(e => e.payload.type === 'approval/requested') as RpcRequest<MuxFrame>
    const requested = envelope.payload as Extract<MuxFrame, { type: 'approval/requested' }>

    // A 'none' connection answering directly by rpcId reads exactly like a
    // late or forged id — it never reaches payload validation.
    const denied = await scoped('none', () => api.respond(answer(envelope.rpcId, requested.sessionId, requested.approvalId, 'allowed-once')))
    expect(denied).toEqual({ accepted: false, reason: 'not-pending' })

    // The pending entry is untouched: an answer-capable claimant still wins.
    const receipt = await api.respond(answer(envelope.rpcId, requested.sessionId, requested.approvalId, 'allowed-once'))
    expect(receipt).toEqual({ accepted: true })
    await expect(asked).resolves.toBe('allowed-once')
  })

  it('settles one pending interaction atomically: exactly one of two claims wins', async () => {
    const { ctx, api } = await harness()
    const agent = agentOf(ctx)
    const answerMux = await openMux(api, 'answer', new AbortController())
    const asked = ctx.approval.request({ agent, toolName: 'bash', reason: 'escalate' })
    asked.catch(() => {})
    await waitForCount(answerMux, 'approval/requested', 1)
    const envelope = answerMux.envelopes.find(e => e.payload.type === 'approval/requested') as RpcRequest<MuxFrame>
    const requested = envelope.payload as Extract<MuxFrame, { type: 'approval/requested' }>

    const [first, second] = await Promise.all([
      api.respond(answer(envelope.rpcId, requested.sessionId, requested.approvalId, 'allowed-once')),
      api.respond(answer(envelope.rpcId, requested.sessionId, requested.approvalId, 'rejected')),
    ])
    const outcomes = [first, second].map(receipt => receipt.accepted)
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    const loser = first.accepted ? second : first
    expect(loser).toEqual({ accepted: false, reason: 'not-pending' })
    await expect(asked).resolves.toBe(first.accepted ? 'allowed-once' : 'rejected')
  })

  it('forwards remote events only to answer-capable host streams', async () => {
    const { ctx, api } = await harness()
    const agent = agentOf(ctx)
    const noneHost = await openHost(api, 'none', new AbortController())
    const answerHost = await openHost(api, 'answer', new AbortController())
    // Emit an allowlisted event the way the owning Host plugin would.
    ctx.emit('goal/activation-changed', { sessionId: agent.session.id })
    await settled()
    expect(answerHost.frames.filter(frame => frame.type === 'host/remote-event')).not.toEqual([])
    expect(noneHost.frames.filter(frame => frame.type === 'host/remote-event')).toEqual([])
  })

  it('reports answer outside a bound request scope', () => {
    expect(requestInteractions()).toBe('answer')
  })
})
